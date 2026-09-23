import { dispatchExtensionHostEvent, parseExtensionPageContextV1, type ExtensionPageContextV1 } from '@breeze/extension-web-sdk';

type HostApi = { request(path: string): Promise<Response> };
type Call = Record<'CdrId' | 'CallId' | 'StartTime' | 'SourceDn' | 'SourceDisplayName' | 'DestinationDn' | 'DestinationDisplayName' | 'Status' | 'Direction' | 'RingingDuration' | 'TalkingDuration', string | null> & { Answered: boolean | null };
type Page = { items: Call[]; nextSkip: number | null; truncated: boolean; scope: 'full_pbx' };
const safe = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const csv = (value: unknown) => `"${String(value ?? '').replace(/^[=+\-@]/, "'$&").replaceAll('"', '""')}"`;
const local = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const ELEMENT = 'cloudcommand-threecx-call-log-page';

export class CloudCommandThreeCxCallLogPage extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private contextValue: ExtensionPageContextV1 | null = null;
  private api: HostApi | null = null;
  private generation = 0;
  private items: Call[] = [];
  private truncated = false;
  private busy = false;
  private error = '';
  private searched = false;
  private start = local(new Date(Date.now() - 86400000));
  private end = local(new Date());
  set context(input: unknown) {
    const context = parseExtensionPageContextV1(input);
    if (context.extensionName !== 'cloudcommand') throw new Error('Wrong extension context');
    this.contextValue = context;
    this.generation += 1;
    this.items = []; this.searched = false; this.error = '';
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
    const start = startDate.toISOString();
    const end = endDate.toISOString();
    this.items = []; this.truncated = false; this.searched = false;
    const generation = ++this.generation;
    this.busy = true; this.error = ''; this.render();
    try {
      const query = new URLSearchParams({ start, end, skip: '0' });
      const response = await this.api.request(`/threecx/call-log?${query}`);
      const body = await response.json() as Page & { code?: string };
      if (!response.ok) throw new Error(body.code === 'report_scope_unverified' ? 'Call Log is unavailable for department-scoped connections until PBX report isolation is verified.' : 'Could not load 3CX call events.');
      if (generation !== this.generation) return;
      if (!Array.isArray(body.items) || body.scope !== 'full_pbx') throw new Error('Invalid 3CX call report.');
      this.items = body.items;
      this.truncated = body.truncated;
      this.searched = true;
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : 'Could not load 3CX call events.';
    } finally {
      if (generation === this.generation) { this.busy = false; this.render(); }
    }
  }
  private exportLoaded() {
    const keys = ['StartTime', 'SourceDn', 'SourceDisplayName', 'DestinationDn', 'DestinationDisplayName', 'Status', 'Answered', 'TalkingDuration', 'Direction', 'CallId'] as const;
    const content = [keys.map(csv).join(','), ...this.items.map(row => keys.map(key => csv(row[key])).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv' }));
    const link = document.createElement('a'); link.href = url; link.download = 'threecx-loaded-call-events.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private render() {
    const columns: Array<[keyof Call, string]> = [['StartTime', 'Started'], ['SourceDn', 'From'], ['DestinationDn', 'To'], ['Status', 'Result'], ['TalkingDuration', 'Talking duration'], ['Direction', 'Direction']];
    this.root.innerHTML = `<style>${styles}</style><main><header><div><p class="eyebrow">Cloud Command / 3CX</p><h1>Call Log</h1><p class="muted">Full-PBX reports only. Department-scoped call reporting requires verified isolation.</p></div><button id="extensions" class="secondary" type="button">Extensions</button></header><form id="filters"><label>From<input id="start" type="datetime-local" required value="${safe(this.start)}"></label><label>To<input id="end" type="datetime-local" required value="${safe(this.end)}"></label><button type="submit" ${this.busy ? 'disabled' : ''}>Search calls</button><button id="export" class="secondary" type="button" ${!this.items.length ? 'disabled' : ''}>Export loaded results</button></form><p class="muted">Search at most 31 days. Export includes only loaded results; call events may include multiple legs.</p><p role="status">${safe(this.error || (this.busy ? 'Loading call events…' : this.searched ? `${this.items.length} events loaded${this.truncated ? ' · More events may exist; continuation is unavailable until PBX paging is verified' : ''}` : 'Choose a range and search.'))}</p>${this.items.length ? `<div class="table-wrap"><table><thead><tr>${columns.map(([, title]) => `<th>${title}</th>`).join('')}<th>Details</th></tr></thead><tbody>${this.items.map(row => `<tr>${columns.map(([key]) => `<td>${safe(row[key] ?? '—')}</td>`).join('')}<td><details><summary>View</summary><dl><dt>Call ID</dt><dd>${safe(row.CallId ?? 'Unavailable')}</dd><dt>From</dt><dd>${safe(row.SourceDisplayName ?? row.SourceDn)}</dd><dt>To</dt><dd>${safe(row.DestinationDisplayName ?? row.DestinationDn)}</dd><dt>Answered</dt><dd>${row.Answered == null ? 'Unavailable' : row.Answered ? 'Yes' : 'No'}</dd><dt>Ringing duration</dt><dd>${safe(row.RingingDuration ?? 'Unavailable')}</dd></dl></details></td></tr>`).join('')}</tbody></table></div>` : this.searched ? '<p>No call events in this range.</p>' : ''}</main>`;
    this.root.querySelector('#filters')?.addEventListener('submit', event => { event.preventDefault(); void this.search(); });
    this.root.querySelector('#export')?.addEventListener('click', () => this.exportLoaded());
    this.root.querySelector('#extensions')?.addEventListener('click', () => dispatchExtensionHostEvent(this, { version: 1, type: 'navigate', path: '/extensions/cloudcommand/threecx' }));
  }
}
const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}main{max-width:1200px;margin:auto;padding:1rem 1.5rem}header{display:flex;justify-content:space-between;align-items:start;gap:1rem}h1{font-size:1.5rem;margin:.1rem 0}.eyebrow{font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:hsl(var(--primary));margin:0}.muted{color:hsl(var(--muted-foreground));font-size:.85rem;line-height:1.45}button{min-height:2.25rem;padding:.35rem .7rem;border:0;border-radius:var(--radius,.5rem);background:hsl(var(--primary));color:hsl(var(--primary-foreground));font:inherit;font-size:.85rem;font-weight:600;cursor:pointer}button.secondary{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground))}button:disabled{opacity:.6;cursor:not-allowed}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}form{display:flex;flex-wrap:wrap;align-items:end;gap:.6rem;margin:1rem 0}label{display:grid;gap:.25rem;font-size:.82rem}input{height:2.25rem;border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);background:hsl(var(--background));color:hsl(var(--foreground));padding:.35rem .55rem}p[role=status]{min-height:1.3rem;font-size:.85rem}.table-wrap{max-width:100%;overflow:auto;border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem)}table{border-collapse:collapse;min-width:850px;width:100%;font-size:.82rem}td,th{text-align:left;padding:.55rem .65rem;border-bottom:1px solid hsl(var(--border));vertical-align:top}th{background:hsl(var(--muted))}dl{display:grid;grid-template-columns:auto 1fr;gap:.3rem .7rem;margin:.5rem 0}dt{color:hsl(var(--muted-foreground))}dd{margin:0;overflow-wrap:anywhere}summary{cursor:pointer}#more{margin-top:.7rem}@media(max-width:600px){main{padding:1rem}header{flex-direction:column}}`;
if (!customElements.get(ELEMENT)) customElements.define(ELEMENT, CloudCommandThreeCxCallLogPage);
