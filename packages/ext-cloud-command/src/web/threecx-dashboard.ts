import { dispatchExtensionHostEvent, parseExtensionPageContextV1, type ExtensionPageContextV1 } from '@breeze/extension-web-sdk';

type Status = {
  Version: string | null; CallsActive: number | null; MaxSimCalls: number | null;
  TrunksRegistered: number | null; TrunksTotal: number | null;
  HasNotRunningServices: boolean | null; BackupScheduled: boolean | null;
  LastBackupDateTime: string | null; FreeDiskSpace: number | null; TotalDiskSpace: number | null;
};
type Dashboard = {
  scope: 'department' | 'full_pbx'; extensions: { total: number; registered: number; complete: boolean };
  status: Status | null; statusAvailability: 'available' | 'department_scoped' | 'permission_limited'; checkedAt: string;
};
type HostApi = { request(path: string): Promise<Response> };
const ELEMENT = 'cloudcommand-threecx-dashboard-page';
const safe = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const count = (value: number | null | undefined) => value == null ? 'Unavailable' : String(value);

export class CloudCommandThreeCxDashboardPage extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private contextValue: ExtensionPageContextV1 | null = null;
  private api: HostApi | null = null;
  private generation = 0;
  private busy = false;
  private dashboard: Dashboard | null = null;
  private error = '';
  set context(input: unknown) {
    const context = parseExtensionPageContextV1(input);
    if (context.extensionName !== 'cloudcommand') throw new Error('Wrong extension context');
    this.contextValue = context;
    this.dashboard = null;
    this.error = '';
    this.generation += 1;
    this.render();
    if (this.isConnected && this.api) void this.load();
  }
  set hostApi(api: HostApi) {
    if (!api || typeof api.request !== 'function') throw new Error('Authenticated host API required');
    this.api = api;
    if (this.isConnected && this.contextValue) void this.load();
  }
  connectedCallback() { this.render(); if (this.contextValue && this.api) void this.load(); }
  disconnectedCallback() { this.generation += 1; }
  private async load() {
    const generation = ++this.generation;
    this.busy = true;
    this.error = '';
    this.render();
    try {
      const response = await this.api!.request('/threecx/dashboard');
      if (!response.ok) throw new Error('Could not load 3CX dashboard.');
      const dashboard = await response.json() as Dashboard;
      if (generation !== this.generation) return;
      if (!dashboard || !dashboard.extensions || !['department', 'full_pbx'].includes(dashboard.scope)) throw new Error('Invalid 3CX dashboard response.');
      this.dashboard = dashboard;
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : 'Could not load 3CX dashboard.';
    } finally {
      if (generation === this.generation) { this.busy = false; this.render(); }
    }
  }
  private render() {
    const data = this.dashboard;
    const health = data?.status;
    const statusNotice = data?.statusAvailability === 'department_scoped'
      ? 'PBX-wide status is hidden because this organization is restricted to a department.'
      : data?.statusAvailability === 'permission_limited'
        ? 'PBX-wide status is unavailable with this API account or PBX version.' : '';
    this.root.innerHTML = `<style>${styles}</style><main><header><div><p class="eyebrow">Cloud Command / 3CX</p><h1>Dashboard</h1><p class="muted">${data?.scope === 'department' ? 'Selected department' : 'Full PBX'}${data?.extensions.complete === false ? ' · Partial extension count' : ''}</p></div><button id="refresh" ${this.busy ? 'disabled' : ''}>Refresh</button></header><nav><button id="extensions" class="secondary">Extensions</button></nav><p role="status">${safe(this.error || (this.busy ? 'Loading dashboard…' : ''))}</p>${data ? `<section class="metrics" aria-label="Extension counts"><article><span>Extensions</span><strong>${count(data.extensions.total)}</strong></article><article><span>Registered</span><strong>${count(data.extensions.registered)}</strong></article></section>${!data.extensions.complete ? '<p class="notice">Counts cover the first 1,000 PBX extensions. More records may exist.</p>' : ''}<section class="card" aria-label="PBX status"><h2>PBX status</h2>${health ? `<div class="grid"><div><span>Version</span><strong>${safe(health.Version ?? 'Unavailable')}</strong></div><div><span>Active calls</span><strong>${count(health.CallsActive)}</strong></div><div><span>Concurrent-call limit</span><strong>${count(health.MaxSimCalls)}</strong></div><div><span>Registered trunks</span><strong>${count(health.TrunksRegistered)} / ${count(health.TrunksTotal)}</strong></div><div><span>Services</span><strong>${health.HasNotRunningServices == null ? 'Unavailable' : health.HasNotRunningServices ? 'Needs attention' : 'Running'}</strong></div><div><span>Backup scheduled</span><strong>${health.BackupScheduled == null ? 'Unavailable' : health.BackupScheduled ? 'Yes' : 'No'}</strong></div></div>` : `<p class="notice">${safe(statusNotice)}</p>`}</section><p class="muted">Checked ${safe(data.checkedAt)}</p>` : ''}</main>`;
    this.root.querySelector('#refresh')?.addEventListener('click', () => { void this.load(); });
    this.root.querySelector('#extensions')?.addEventListener('click', () => dispatchExtensionHostEvent(this, { version: 1, type: 'navigate', path: '/extensions/cloudcommand/threecx' }));
  }
}
const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}main{max-width:1100px;margin:auto;padding:1rem 1.5rem}header{display:flex;align-items:start;justify-content:space-between;gap:1rem}h1{font-size:1.5rem;margin:.1rem 0}h2{font-size:1rem;margin:0 0 .65rem}.eyebrow{font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:hsl(var(--primary));margin:0}.muted,.notice{color:hsl(var(--muted-foreground));font-size:.85rem;line-height:1.45}.notice{margin:.75rem 0}nav{display:flex;gap:.5rem;margin:.75rem 0}button{min-height:2.25rem;padding:.35rem .7rem;border:0;border-radius:var(--radius,.5rem);background:hsl(var(--primary));color:hsl(var(--primary-foreground));font:inherit;font-size:.85rem;font-weight:600;cursor:pointer}button.secondary{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground))}button:disabled{opacity:.6;cursor:not-allowed}button:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}p[role=status]{min-height:1.25rem;color:hsl(var(--destructive));font-size:.85rem}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.7rem}.metrics article,.card{border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);background:hsl(var(--card));padding:.85rem}.metrics article{display:grid;gap:.35rem}.metrics span,.grid span{color:hsl(var(--muted-foreground));font-size:.78rem}.metrics strong{font-size:1.45rem}.card{margin-top:.7rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.8rem}.grid div{display:grid;gap:.2rem}.grid strong{font-size:.9rem;overflow-wrap:anywhere}@media(max-width:600px){main{padding:1rem}}`;
if (!customElements.get(ELEMENT)) customElements.define(ELEMENT, CloudCommandThreeCxDashboardPage);
