import { parseExtensionPageContextV1, type ExtensionPageContextV1 } from '@breeze/extension-web-sdk';
import type { AlertWorkload, AlertWorkloadGroup, AlertScriptMonitorWorkload } from '../server/health';

type HealthStatus = 'healthy' | 'attention' | 'critical' | 'unknown';
type HealthCard = { id: string; title: string; status: HealthStatus; value: string; detail: string };
type HealthPayload = { checkedAt: string; refreshSeconds: number; targetEndpoints: number; cards: HealthCard[]; enrolled: number | null; alertWorkload?: AlertWorkload };
type HostApi = { request(path: string): Promise<Response> };

const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const severity: Record<HealthStatus, number> = { healthy: 0, unknown: 1, attention: 2, critical: 3 };
const workloadGroups = new Set(['preparation', 'cpu_memory_disk', 'hardware', 'time_sync', 'patch_reboot', 'scripts', 'containers', 'network', 'other']);
const workloadColumns = [
  ['label', 'Group'], ['perMinute', 'Checks/min'], ['averageMs', 'Avg time'], ['totalMs', 'Total time'],
  ['dbElapsedMs', 'DB elapsed'], ['queryCount', 'Queries'], ['errors', 'Errors'],
] as const;
type WorkloadSort = typeof workloadColumns[number][0];
const numberText = (value: number, decimals = 0) => value.toLocaleString(undefined, { maximumFractionDigits: decimals });
const elapsedText = (value: number) => value >= 1000 ? `${numberText(value / 1000, 2)} s` : `${numberText(value, 1)} ms`;
const metricKeys = ['evaluations', 'perMinute', 'totalMs', 'averageMs', 'maxMs', 'errors', 'queryCount', 'dbElapsedMs'] as const;
function validMetrics(row: AlertWorkloadGroup | AlertScriptMonitorWorkload): boolean {
  return metricKeys.every(key => typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0);
}
/** Older hosts omit this optional field. Invalid telemetry must not imply zero load. */
function validWorkload(input: unknown): input is AlertWorkload {
  if (!input || typeof input !== 'object') return false;
  const data = input as AlertWorkload;
  if (data.windowMs !== 300_000 || data.bucketMs !== 5000 || !Number.isFinite(data.observedMs)
    || data.observedMs < 0 || data.observedMs > data.windowMs || !Array.isArray(data.groups)
    || data.groups.length > workloadGroups.size) return false;
  const seen = new Set<string>();
  return data.groups.every(row => {
    if (!row || !workloadGroups.has(row.group) || seen.has(row.group) || typeof row.label !== 'string') return false;
    seen.add(row.group);
    return validMetrics(row);
  });
}
function workloadHeaders(sort: WorkloadSort, descending: boolean, monitors = false): string {
  return workloadColumns.map(([key, label]) => `<th scope="col" aria-sort="${key === sort ? descending ? 'descending' : 'ascending' : 'none'}"><button class="sort" data-workload-sort="${key}">${monitors && key === 'label' ? 'Monitor' : label}${key === sort ? descending ? ' ↓' : ' ↑' : ''}</button></th>`).join('');
}
function workloadCells(row: AlertWorkloadGroup | AlertScriptMonitorWorkload): string {
  return `<td>${numberText(row.perMinute, 1)}</td><td>${elapsedText(row.averageMs)}</td><td>${elapsedText(row.totalMs)}</td><td>${elapsedText(row.dbElapsedMs)}</td><td>${numberText(row.queryCount)}</td><td class="${row.errors ? 'critical' : ''}">${numberText(row.errors)}</td>`;
}
function compareWorkload(a: AlertWorkloadGroup | AlertScriptMonitorWorkload, b: AlertWorkloadGroup | AlertScriptMonitorWorkload, sort: WorkloadSort, descending: boolean): number {
  const order = sort === 'label' ? a.label.localeCompare(b.label) : Number(a[sort]) - Number(b[sort]);
  return (descending ? -order : order) || a.label.localeCompare(b.label);
}
function scriptMonitorMarkup(input: AlertWorkload, sort: WorkloadSort, descending: boolean): string {
  const start = '<div class="monitor-breakdown"><h3>Scripts / RustDesk — individual monitors</h3>';
  const seen = new Set<string>();
  const valid = input.scriptMonitorLimit === 64 && Array.isArray(input.scriptMonitors) && input.scriptMonitors.length <= 65
    && input.scriptMonitors.every(row => {
      if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 160 || seen.has(row.id)
        || typeof row.label !== 'string' || row.label.length > 240) return false;
      seen.add(row.id);
      return validMetrics(row);
    });
  if (!valid) return `${start}<p class="subtle">Individual monitor telemetry is unavailable on this API process.</p></div>`;
  if (!input.scriptMonitors!.length) return `${start}<p class="subtle">No individual script monitors observed in this window.</p></div>`;
  const rows = [...input.scriptMonitors!].sort((a, b) => compareWorkload(a, b, sort, descending) || a.id.localeCompare(b.id));
  const labels = new Map<string, number>();
  for (const row of rows) labels.set(row.label, (labels.get(row.label) ?? 0) + 1);
  const body = rows.map(row => `<tr data-script-monitor="${escapeHtml(row.id)}"><th scope="row">${escapeHtml(row.label)}${(labels.get(row.label) ?? 0) > 1 ? `<small class="monitor-id">${escapeHtml(row.id)}</small>` : ''}</th>${workloadCells(row)}</tr>`).join('');
  return `${start}<p class="subtle">Included in the Scripts / RustDesk totals above, not additional work. Only monitors evaluated in this window appear; an absent monitor does not mean zero cost. These are saved-result evaluations, not script launches.</p><div class="table-scroll"><table><caption>Elapsed work by script monitor</caption><thead><tr>${workloadHeaders(sort, descending, true)}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}
function workloadMarkup(input: unknown, sort: WorkloadSort, descending: boolean): string {
  const heading = '<h2>Alert evaluation workload</h2>';
  if (!validWorkload(input)) return `<section class="workload" aria-label="Alert evaluation workload">${heading}<p class="subtle">Per-group telemetry is unavailable on this API process.</p></section>`;
  const rows = input.groups.filter(row => row.group !== 'preparation').sort((a, b) => compareWorkload(a, b, sort, descending));
  const preparation = input.groups.find(row => row.group === 'preparation');
  const observed = input.observedMs < input.windowMs ? ` · ${numberText(input.observedMs / 1000)} seconds observed since collection started` : '';
  const body = rows.map(row => `<tr data-workload-group="${escapeHtml(row.group)}"><th scope="row">${escapeHtml(row.label)}</th>${workloadCells(row)}</tr>`).join('');
  const preparationRow = preparation ? `<p class="preparation"><strong>Shared preparation</strong> · ${numberText(preparation.evaluations)} runs · ${numberText(preparation.perMinute, 1)} runs/min · ${elapsedText(preparation.totalMs)} total · ${elapsedText(preparation.dbElapsedMs)} DB · ${numberText(preparation.queryCount)} queries · ${numberText(preparation.errors)} errors. Device and policy setup; not counted as checks.</p>` : '';
  const empty = rows.every(row => row.evaluations === 0) ? '<p class="subtle">No alert-group evaluations recorded in this window.</p>' : '';
  return `<section class="workload" aria-label="Alert evaluation workload">${heading}<p class="subtle">Rolling 5 minutes${observed}. Scheduled monitor checks only; queue wait and other background work are excluded. Process-local measurements reset on restart; other API or worker processes are not included.</p><div class="table-scroll"><table><caption>Elapsed work by alert group</caption><thead><tr>${workloadHeaders(sort, descending)}</tr></thead><tbody>${body}</tbody></table></div>${empty}${scriptMonitorMarkup(input, sort, descending)}${preparationRow}<p class="subtle">Times measure elapsed work, including waits—not CPU percentages. DB elapsed includes driver and network waits; concurrent queries can overlap, so their sum can exceed total time. Checks/min uses the observed window.</p></section>`;
}

export class CloudCommandHealthPage extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private contextValue: ExtensionPageContextV1 | null = null;
  private api: HostApi | null = null;
  private timer: number | null = null;
  private requestInFlight = false;
  private connected = false;
  private visible = document.visibilityState !== 'hidden';
  private payload: HealthPayload | null = null;
  private error = '';
  private generation = 0;
  private workloadSort: WorkloadSort = 'totalMs';
  private workloadDescending = true;

  set context(input: unknown) {
    const context = parseExtensionPageContextV1(input);
    if (context.extensionName !== 'cloudcommand') throw new Error('Wrong Cloud Command context');
    this.contextValue = context;
    this.generation += 1;
    this.payload = null;
    this.error = '';
    this.render();
    this.schedule();
  }
  set hostApi(api: HostApi) {
    if (!api || typeof api.request !== 'function') throw new Error('Authenticated host API required');
    this.api = api;
    this.schedule();
  }
  connectedCallback() {
    this.connected = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.render();
    this.schedule();
  }
  disconnectedCallback() {
    this.connected = false;
    this.generation += 1;
    this.clearTimer();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
  private onVisibility = () => { this.visible = document.visibilityState !== 'hidden'; this.schedule(); };
  private clearTimer() { if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; } }
  private schedule() {
    this.clearTimer();
    if (!this.connected || !this.visible || !this.api || !this.contextValue || this.requestInFlight) return;
    void this.load();
  }
  private async load() {
    if (!this.api || this.requestInFlight) return;
    const generation = this.generation;
    this.requestInFlight = true;
    let timeout: number | undefined;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await this.api!.request('/health');
          const body: unknown = await response.json().catch(() => null);
          return { response, body };
        })(),
        new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error('Operations health request timed out.')), 10_000); }),
      ]);
      const { response, body } = result;
      if (response.status === 403) throw new Error('Operations health access is not assigned to this account.');
      if (!response.ok) throw new Error('Operations health is unavailable.');
      if (!body || typeof body !== 'object' || !Array.isArray((body as HealthPayload).cards) || typeof (body as HealthPayload).checkedAt !== 'string') throw new Error('Operations health returned an invalid response.');
      if (generation !== this.generation) return;
      this.payload = body as HealthPayload;
      this.error = '';
    } catch (reason) {
      if (generation !== this.generation) return;
      this.payload = null;
      this.error = reason instanceof Error ? reason.message : 'Operations health is unavailable.';
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
      this.requestInFlight = false;
      this.render();
      if (this.connected && this.visible) this.timer = window.setTimeout(() => this.schedule(), 30_000);
    }
  }
  private render() {
    const payload = this.payload;
    const cards = payload?.cards ?? [];
    let overall: HealthStatus = cards.length ? cards.reduce((worst, card) => severity[card.status] > severity[worst] ? card.status : worst, 'healthy' as HealthStatus) : 'unknown';
    const attention = cards.filter(card => card.status === 'attention').length;
    const unknown = cards.filter(card => card.status === 'unknown').length;
    const stale = payload ? Date.now() - Date.parse(payload.checkedAt) > 90_000 : false;
    if (stale && overall === 'healthy') overall = 'unknown';
    const checkedAt = payload ? new Date(payload.checkedAt).toLocaleString() : '';
    const counts = (['healthy', 'attention', 'critical', 'unknown'] as const).map(status => ({ status, count: cards.filter(card => card.status === status).length }));
    const meter = cards.length ? `<div class="meter" role="img" aria-label="Health summary: ${counts.map(item => `${item.count} ${item.status}`).join(', ')}">${counts.filter(item => item.count > 0).map(item => `<span class="${item.status}" style="width:${item.count / cards.length * 100}%" title="${item.count} ${item.status}"></span>`).join('')}</div>` : '';
    const enrollment = payload?.enrolled == null ? '' : `<section class="enrollment"><strong>Enrollment rollout</strong><span>${escapeHtml(payload.enrolled)} of ${escapeHtml(payload.targetEndpoints)} enrolled</span><small>This target describes rollout progress, not server capacity.</small></section>`;
    this.root.innerHTML = `<style>${styles}${workloadStyles}</style><main><header><div><p class="eyebrow">Cloud Command</p><h1>Operations health</h1><p class="subtle">Deployment-wide service signals for authorized operators.</p></div><button id="refresh" ${this.requestInFlight ? 'disabled' : ''}>Refresh</button></header>${this.error ? `<p class="status error" role="alert">${escapeHtml(this.error)}</p>` : `<p class="status" role="status">Overall status: <strong class="${overall}">${escapeHtml(overall)}</strong>${attention ? ` · ${attention} attention` : ''}${unknown ? ` · ${unknown} unknown` : ''}${stale ? ' · data is stale' : ''}${checkedAt ? ` · checked ${escapeHtml(checkedAt)}` : ''}</p>`}${meter}${enrollment}<section class="cards" aria-label="Operations health signals">${cards.map(card => `<article class="${escapeHtml(card.status)}"><div class="card-heading"><h2>${escapeHtml(card.title)}</h2><span>${escapeHtml(card.status)}</span></div><strong class="value">${escapeHtml(card.value)}</strong><p>${escapeHtml(card.detail)}</p></article>`).join('')}</section>${payload ? workloadMarkup(payload.alertWorkload, this.workloadSort, this.workloadDescending) : ''}${!cards.length && !this.error ? '<p class="empty">No health observations are available yet.</p>' : ''}</main>`;
    this.root.querySelector('#refresh')?.addEventListener('click', () => { this.clearTimer(); this.schedule(); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-workload-sort]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.workloadSort as WorkloadSort;
      if (!workloadColumns.some(([column]) => column === key)) return;
      this.workloadDescending = key === this.workloadSort ? !this.workloadDescending : key !== 'label';
      this.workloadSort = key;
      this.render();
    }));
  }
}

const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}main{max-width:1100px;margin:auto;padding:1.5rem}header{align-items:flex-start;display:flex;gap:1rem;justify-content:space-between}h1,h2,p{margin:0}h1{font-size:1.55rem}.eyebrow{color:hsl(var(--primary));font-size:.75rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.subtle,.status,small{color:hsl(var(--muted-foreground));font-size:.875rem;margin-top:.35rem}.status{min-height:1.4rem;margin-top:1rem}.status.error{color:hsl(var(--destructive))}.status strong{text-transform:capitalize}.healthy{color:hsl(var(--success))}.attention{color:#a87500}.critical{color:hsl(var(--destructive))}.unknown{color:hsl(var(--muted-foreground))}.meter{display:flex;background:hsl(var(--muted));border-radius:999px;height:.45rem;margin-top:.8rem;overflow:hidden}.meter span{display:block;height:100%;transition:width .2s}.meter .healthy{background:hsl(var(--success))}.meter .attention{background:#d9a441}.meter .unknown{background:hsl(var(--muted-foreground))}.meter .critical{background:hsl(var(--destructive))}button{background:hsl(var(--primary));border:0;border-radius:calc(var(--radius,.5rem) - 2px);color:hsl(var(--primary-foreground));cursor:pointer;font:inherit;font-weight:700;padding:.55rem .8rem}button:disabled{opacity:.6}.cards{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));margin-top:1rem}.cards article,.enrollment{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);padding:1rem}.cards article{border-top:3px solid hsl(var(--muted-foreground))}.cards article.attention{border-top-color:#d9a441}.cards article.critical{border-top-color:hsl(var(--destructive))}.cards article.healthy{border-top-color:hsl(var(--success))}.card-heading{align-items:center;display:flex;gap:.6rem;justify-content:space-between}.card-heading h2{font-size:1rem}.card-heading span{background:hsl(var(--muted));border-radius:999px;font-size:.72rem;padding:.2rem .5rem;text-transform:capitalize}.value{display:block;font-size:1.55rem;margin-top:1rem}.cards p{color:hsl(var(--muted-foreground));font-size:.875rem;line-height:1.45;margin-top:.5rem}.enrollment{display:grid;gap:.3rem;margin-top:1rem}.enrollment span{font-size:1.1rem;font-weight:700}.empty{border:1px dashed hsl(var(--border));color:hsl(var(--muted-foreground));margin-top:1rem;padding:1rem}@media(max-width:600px){main{padding:1rem}header{align-items:stretch;flex-direction:column}header button{align-self:flex-start}}`;
const workloadStyles = `.workload{margin-top:1rem;padding:1rem;border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);background:hsl(var(--card));color:hsl(var(--foreground))}.workload h2{font-size:1rem}.workload .subtle{line-height:1.4}.table-scroll{overflow-x:auto;margin-top:.75rem}.workload table{border-collapse:collapse;width:100%;font-size:.8rem;font-variant-numeric:tabular-nums}.workload caption{text-align:left;color:hsl(var(--muted-foreground));font-size:.75rem;padding-bottom:.35rem}.workload th,.workload td{padding:.5rem .6rem;border-bottom:1px solid hsl(var(--border));text-align:right;white-space:nowrap}.workload th:first-child{text-align:left}.workload tbody th{font-weight:500}.workload .sort{padding:0;background:transparent;color:inherit;font-size:inherit;border-radius:0}.workload .sort:focus-visible{outline:2px solid hsl(var(--primary));outline-offset:3px}.workload th[aria-sort=descending],.workload th[aria-sort=ascending]{color:hsl(var(--primary))}.preparation{margin-top:.65rem;font-size:.8rem;line-height:1.5;color:hsl(var(--muted-foreground))}.preparation strong{color:hsl(var(--foreground))}.monitor-breakdown{margin-top:1rem;padding-top:.75rem;border-top:1px solid hsl(var(--border))}.monitor-breakdown h3{font-size:.875rem;margin:0}.monitor-breakdown tbody th{white-space:normal;min-width:200px;max-width:360px}.monitor-id{display:block;font-size:.65rem;overflow-wrap:anywhere}`;
if (!customElements.get('cloudcommand-health-page')) customElements.define('cloudcommand-health-page', CloudCommandHealthPage);
