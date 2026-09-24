import { dispatchExtensionHostEvent, parseExtensionPageContextV1, type ExtensionPageContextV1 } from '@breeze/extension-web-sdk';

type HostApi = { request(path: string): Promise<Response> };
type Call = Record<'CdrId' | 'CallId' | 'StartTime' | 'SourceDn' | 'SourceDisplayName' | 'DestinationDn' | 'DestinationDisplayName' | 'Status' | 'Direction' | 'RingingDuration' | 'TalkingDuration', string | null> & { Answered: boolean | null };
type Page = { items: Call[]; nextSkip: number | null; nextCursor: string | null; truncated: boolean; scope: 'full_pbx' };
const safe = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const csv = (value: unknown) => `"${String(value ?? '').replace(/^[=+\-@]/, "'$&").replaceAll('"', '""')}"`;
const local = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const filterStyles = `.loaded-tools{display:flex;align-items:end;flex-wrap:wrap;gap:.7rem;margin:.8rem 0}.loaded-tools label{min-width:min(100%,18rem)}.loaded-tools span{color:hsl(var(--muted-foreground));font-size:.82rem;padding-bottom:.55rem}.table-wrap tr[hidden],#filter-empty[hidden]{display:none}`;
const ELEMENT = 'cloudcommand-threecx-call-log-page';

export class CloudCommandThreeCxCallLogPage extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private contextValue: ExtensionPageContextV1 | null = null;
  private api: HostApi | null = null;
  private generation = 0;
  private items: Call[] = [];
  private truncated = false;
  private nextSkip: number | null = null;
  private nextCursor: string | null = null;
  private range: { start: string; end: string } | null = null;
  private busy = false;
  private error = '';
  private searched = false;
  private filter = '';
  private start = local(new Date(Date.now() - 86400000));
  private end = local(new Date());
  set context(input: unknown) {
    const context = parseExtensionPageContextV1(input);
    if (context.extensionName !== 'cloudcommand') throw new Error('Wrong extension context');
    this.contextValue = context;
    this.generation += 1;
    this.items = []; this.nextSkip = null; this.nextCursor = null; this.range = null; this.searched = false; this.error = ''; this.filter = '';
    this.render();
  }
  set hostApi(api: HostApi) { if (!api || typeof api.request !== 'function') throw new Error('Authenticated host API required'); this.api = api; }
  connectedCallback() { this.render(); }
  disconnectedCallback() { this.generation += 1; }

  private async search() {
    if (!this.contextValue || !this.api || this.busy) return;
    this.start = this.root.querySelector<HTMLInputElement>('#start')!.value;
    this.end = this.root.querySelector<HTMLInputElement>('#end')!.value;
    const startDate = new Date(this.start), endDate = new Date(this.end);
    const duration = endDate.getTime() - startDate.getTime();
    if (!Number.isFinite(duration) || duration <= 0 || duration > 31 * 86400000) {
      this.error = 'Choose a range of up to 31 days.'; this.render(); return;
    }
    this.range = { start: startDate.toISOString(), end: endDate.toISOString() };
    this.items = []; this.nextSkip = null; this.nextCursor = null; this.truncated = false; this.searched = false; this.filter = '';
    await this.load(0);
  }
  private async load(skip: number) {
    if (!this.range || !this.api || this.busy) return;
    const generation = ++this.generation;
    this.busy = true; this.error = ''; this.render();
    try {
      const query = new URLSearchParams({ ...this.range, skip: String(skip) });
      if (skip > 0 && this.nextCursor) query.set('cursor', this.nextCursor);
      const response = await this.api.request(`/threecx/call-log?${query}`);
      const body = await response.json() as Page & { code?: string };
      if (!response.ok) throw new Error(body.code === 'report_scope_unverified' ? 'Call Log is unavailable for department-scoped connections until PBX report isolation is verified.' : 'Could not load 3CX call events.');
      if (generation !== this.generation) return;
      if (!Array.isArray(body.items) || body.items.length > 100 || body.scope !== 'full_pbx' ||
        (body.nextSkip !== null && (body.nextSkip !== skip + 100 || typeof body.nextCursor !== 'string' || !/^[0-9]{13}\.[a-f0-9]{64}$/.test(body.nextCursor)))) throw new Error('Invalid 3CX call report.');
      this.items = skip === 0 ? body.items : [...this.items, ...body.items];
      this.nextSkip = this.items.length < 1000 ? body.nextSkip : null;
      this.nextCursor = this.nextSkip === null ? null : body.nextCursor;
      this.truncated = Boolean(body.truncated) || this.nextSkip !== null;
      this.searched = true;
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : 'Could not load 3CX call events.';
    } finally {
      if (generation === this.generation) { this.busy = false; this.render(); }
    }
  }
  private exportLoaded() {
    const keys = ['StartTime', 'SourceDn', 'SourceDisplayName', 'DestinationDn', 'DestinationDisplayName', 'Status', 'Answered', 'TalkingDuration', 'Direction', 'CallId'] as const;
    const content = [keys.map(csv).join(','), ...this.filteredItems().map(row => keys.map(key => csv(row[key])).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv' }));
    const link = document.createElement('a'); link.href = url; link.download = 'threecx-loaded-call-events.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private filteredItems(): Call[] {
    const query = this.filter.trim().toLocaleLowerCase();
    if (!query) return this.items;
    return this.items.filter(row => Object.values(row).some(value => String(value ?? '').toLocaleLowerCase().includes(query)));
  }
  private answeredCount(): number {
    return this.items.filter(row => row.Answered === true).length;
  }
  private applyFilter(): void {
    const matches = new Set(this.filteredItems());
    let visible = 0;
    this.root.querySelectorAll<HTMLTableRowElement>('tr[data-call-index]').forEach(row => {
      row.hidden = !matches.has(this.items[Number(row.dataset.callIndex)]);
      if (!row.hidden) visible += 1;
    });
    const count = this.root.querySelector<HTMLElement>('#filter-count');
    if (count) count.textContent = this.filter.trim() ? `${visible} matching loaded events` : `${this.items.length} loaded events`;
    const empty = this.root.querySelector<HTMLElement>('#filter-empty');
    if (empty) empty.hidden = visible !== 0;
    const exportButton = this.root.querySelector<HTMLButtonElement>('#export');
    if (exportButton) exportButton.disabled = visible === 0;
  }
  private render() {
    const columns: Array<[keyof Call, string]> = [['StartTime', 'Started'], ['SourceDn', 'From'], ['DestinationDn', 'To'], ['Status', 'Result'], ['TalkingDuration', 'Talking duration'], ['Direction', 'Direction']];
    this.root.innerHTML = `<style>${styles}</style><main><header><div><p class="eyebrow">Cloud Command / 3CX</p><h1>Call Log</h1><p class="muted">Full-PBX reports only. Department-scoped call reporting requires verified isolation.</p></div><button id="extensions" class="secondary" type="button">Extensions</button></header><form id="filters"><label>From<input id="start" type="datetime-local" required value="${safe(this.start)}"></label><label>To<input id="end" type="datetime-local" required value="${safe(this.end)}"></label><button type="submit" ${this.busy ? 'disabled' : ''}>Search calls</button></form><p class="muted">Search at most 31 days. Call events may include multiple legs.</p><p role="status">${safe(this.error || (this.busy ? 'Loading call events…' : this.searched ? `${this.items.length} events loaded · ${this.answeredCount()} answered among loaded events${this.truncated ? this.nextSkip !== null ? ' · More events available' : this.items.length >= 1000 ? ' · More events may exist; loaded-result limit reached' : ' · More events may exist; continuation is unavailable until PBX paging is verified' : ''}` : 'Choose a range and search.'))}</p>${this.items.length ? `<div class="loaded-tools"><label>Filter loaded events<input id="filter" type="search" value="${safe(this.filter)}" placeholder="Number, name, status, or call ID"></label><span id="filter-count" aria-live="polite"></span><button id="export" class="secondary" type="button">Export matching loaded results</button></div><p class="muted">Filtering and export include only ${this.items.length} loaded events${this.truncated ? '; more events may exist' : ''}.</p><div class="table-wrap"><table><thead><tr>${columns.map(([, title]) => `<th>${title}</th>`).join('')}<th>Details</th></tr></thead><tbody>${this.items.map((row, index) => `<tr data-call-index="${index}">${columns.map(([key]) => `<td>${safe(row[key] ?? '—')}</td>`).join('')}<td><details><summary>View</summary><dl><dt>Call ID</dt><dd>${safe(row.CallId ?? 'Unavailable')}</dd><dt>Started</dt><dd>${safe(row.StartTime ?? 'Unavailable')}</dd><dt>From</dt><dd>${safe([row.SourceDn, row.SourceDisplayName].filter(Boolean).join(' · ') || 'Unavailable')}</dd><dt>To</dt><dd>${safe([row.DestinationDn, row.DestinationDisplayName].filter(Boolean).join(' · ') || 'Unavailable')}</dd><dt>Result</dt><dd>${safe(row.Status ?? 'Unavailable')}</dd><dt>Answered</dt><dd>${row.Answered == null ? 'Unavailable' : row.Answered ? 'Yes' : 'No'}</dd><dt>Talking duration</dt><dd>${safe(row.TalkingDuration ?? 'Unavailable')}</dd><dt>Ringing duration</dt><dd>${safe(row.RingingDuration ?? 'Unavailable')}</dd><dt>Direction</dt><dd>${safe(row.Direction ?? 'Unavailable')}</dd></dl></details></td></tr>`).join('')}</tbody></table></div><p id="filter-empty" hidden>No matching loaded call events.</p>${this.nextSkip !== null ? `<button id="more" type="button" ${this.busy ? 'disabled' : ''}>Load more calls</button>` : ''}` : this.searched ? '<p>No call events in this range.</p>' : ''}</main>`;
    this.root.querySelector('#filters')?.addEventListener('submit', event => { event.preventDefault(); void this.search(); });
    this.root.querySelector('style')!.textContent += filterStyles;
    this.root.querySelector('#export')?.addEventListener('click', () => this.exportLoaded());
    this.root.querySelector('#more')?.addEventListener('click', () => { if (this.nextSkip !== null) void this.load(this.nextSkip); });
    this.root.querySelector<HTMLInputElement>('#filter')?.addEventListener('input', event => { this.filter = (event.currentTarget as HTMLInputElement).value; this.applyFilter(); });
    this.applyFilter();
    this.root.querySelector('#extensions')?.addEventListener('click', () => dispatchExtensionHostEvent(this, { version: 1, type: 'navigate', path: '/extensions/cloudcommand/threecx' }));
  }
}
const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}main{max-width:1200px;margin:auto;padding:1rem 1.5rem}header{display:flex;justify-content:space-between;align-items:start;gap:1rem}h1{font-size:1.5rem;margin:.1rem 0}.eyebrow{font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:hsl(var(--primary));margin:0}.muted{color:hsl(var(--muted-foreground));font-size:.85rem;line-height:1.45}button{min-height:2.25rem;padding:.35rem .7rem;border:0;border-radius:var(--radius,.5rem);background:hsl(var(--primary));color:hsl(var(--primary-foreground));font:inherit;font-size:.85rem;font-weight:600;cursor:pointer}button.secondary{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground))}button:disabled{opacity:.6;cursor:not-allowed}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}form{display:flex;flex-wrap:wrap;align-items:end;gap:.6rem;margin:1rem 0}label{display:grid;gap:.25rem;font-size:.82rem}input{height:2.25rem;border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);background:hsl(var(--background));color:hsl(var(--foreground));padding:.35rem .55rem}p[role=status]{min-height:1.3rem;font-size:.85rem}.table-wrap{max-width:100%;overflow:auto;border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem)}table{border-collapse:collapse;min-width:850px;width:100%;font-size:.82rem}td,th{text-align:left;padding:.55rem .65rem;border-bottom:1px solid hsl(var(--border));vertical-align:top}th{background:hsl(var(--muted))}dl{display:grid;grid-template-columns:auto 1fr;gap:.3rem .7rem;margin:.5rem 0}dt{color:hsl(var(--muted-foreground))}dd{margin:0;overflow-wrap:anywhere}summary{cursor:pointer}#more{margin-top:.7rem}@media(max-width:600px){main{padding:1rem}header{flex-direction:column}}`;
if (!customElements.get(ELEMENT)) customElements.define(ELEMENT, CloudCommandThreeCxCallLogPage);
