import { parseExtensionPageContextV1, type ExtensionPageContextV1 } from '@breeze/extension-web-sdk';
import type { CloudCommandHostApi } from './index';

type Row = Record<string, any>;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pretty = (v: unknown) => esc(JSON.stringify(v, null, 2));
const tabs = ['Devices', 'Plans', 'Groups', 'Deployment', 'Activity', 'Connection'] as const;
type Tab = typeof tabs[number];

export class CloudCommandIDrivePage extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private ctx: ExtensionPageContextV1 | null = null;
  private api: CloudCommandHostApi | null = null;
  private generation = 0;
  private state: Row = {};
  private inventory: Row = { devices: [], plans: [], groups: [], attention: [] };
  private history: Row[] = [];
  private tab: Tab = 'Devices';
  private message = '';
  private busy = false;
  private editor: Row | null = null;
  private preview: Row | null = null;
  private result: unknown = null;
  private installer: Row | null = null;
  private discovery: Row | null = null;
  set context(input: unknown) {
    const ctx = parseExtensionPageContextV1(input);
    if (ctx.extensionName !== 'cloudcommand') throw new Error('Wrong extension context');
    if (ctx.organizationId !== this.ctx?.organizationId) {
      this.generation++; this.api = null; this.state = {}; this.editor = this.preview = this.installer = this.discovery = null;
      this.inventory = { devices: [], plans: [], groups: [], attention: [] }; this.history = []; this.result = null; this.message = ''; this.busy = false;
    }
    this.ctx = ctx; this.render();
  }
  set hostApi(api: CloudCommandHostApi) { this.api = api; if (this.isConnected && this.ctx) void this.load(); }
  connectedCallback() { this.render(); if (this.ctx && this.api) void this.load(); }
  disconnectedCallback() { this.generation++; }
  private async request(path: string, data?: unknown, method = 'POST') {
    const api = this.api!; const generation = this.generation;
    const response = await api.request('/idrive/' + path, data === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const body = await response.json();
    if (generation !== this.generation || api !== this.api) throw new Error('Organization changed; reload the selected client.');
    if (!response.ok || body.success === false || body.ok === false) throw new Error(body.error || body.code || 'IDrive request failed');
    return body;
  }
  private async action(work: () => Promise<void>) {
    if (this.busy) return;
    const generation = this.generation; this.busy = true; this.message = 'Working…'; this.render();
    try { await work(); } catch (error) { if (generation === this.generation) this.message = error instanceof Error ? error.message : 'Request failed'; }
    finally { if (generation === this.generation) { this.busy = false; this.render(); } }
  }
  private async load() {
    await this.action(async () => {
      this.state = await this.request('connection');
      if (this.state.connected && this.state.enabled) {
        const [inventory, history] = await Promise.all([this.request('inventory'), this.request('history')]);
        this.inventory = inventory; this.history = history.operations;
      } else this.tab = 'Connection';
      this.message = this.state.enabled ? 'Updated just now.' : 'Connect this client to its IDrive company and group.';
    });
  }
  private input(id: string) { return this.root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('#' + id)!.value; }
  private edit(action: Row) { this.editor = action; this.preview = null; this.result = null; this.render(); }
  private deviceOptions() { return this.inventory.devices.map((d: Row) => `<option value="${esc(d.device_id)}">${esc(d.name)}</option>`).join(''); }
  private editorFields() {
    const action = this.editor!;
    if (action.kind === 'device.edit' && 'custom_tag' in action.data) return `<label>Tag<input id="edit-tag" value="${esc(action.data.custom_tag)}"></label>`;
    if (action.kind === 'notifications.edit') return `<div class="fields"><label>Backup set<select id="edit-set">${['DEFAULT','LOCAL','ENTIRE_MACHINE','MAPPED_DRIVE','EXPRESS'].map(v => `<option ${action.data.backup_set === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>Send email<select id="edit-notification">${['ON_FAILURE','ALWAYS','NEVER'].map(v => `<option ${action.data.type === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>Email addresses (comma separated)<input id="edit-emails" value="${esc(action.data.emails.join(', '))}"></label></div>`;
    return '';
  }
  private table(headers: string[], rows: string[]) { return `<div class="table"><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${headers.length}">Nothing reported for this client.</td></tr>`}</tbody></table></div>`; }
  private content() {
    const data = this.inventory; const manage = this.state.canManage;
    if (this.tab === 'Devices') return `<label>Find a device <input id="filter" type="search" placeholder="Name, status or tag"></label>${this.table(['Computer', 'Backup', 'Last reported backup', 'Actions'], data.devices.map((d: Row, i: number) => {
      const attention = data.attention.find((a: Row) => a.deviceId === d.device_id);
      return `<tr data-device-row><td><strong>${esc(d.name)}</strong><small>${esc(d.os)} · ${esc(d.status)}<br>${esc(d.custom_tag)}</small></td><td>${esc(d.backup_status)}${attention ? `<small class="warning">${esc(attention.reason)}</small>` : ''}</td><td>${esc(d.last_backup || 'Not reported')}<small>Next: ${esc(d.next_backup || 'Not reported')}</small></td><td><button data-inspect="${i}">Details</button>${manage ? `<button data-tag="${i}">Edit tag</button><button data-notify="${i}">Notifications</button><button data-metadata="${i}">Metadata</button><button data-clear-metadata="${i}">Remove metadata</button>` : ''}</td></tr>`;
    }))}<p class="muted">Times are shown as IDrive reports them. A timestamp without a timezone is not converted. Recency is a reporting check, not proof of a recoverable backup.</p>`;
    if (this.tab === 'Plans') return `${manage ? '<button id="new-plan">New backup plan</button>' : ''}${data.sharedPlansHidden ? '<p class="warning">A shared plan also affects other clients. Manage that plan from the account-wide IDrive console.</p>' : ''}${this.table(['Plan', 'Schedule', 'Status', 'Actions'], data.plans.map((p: Row, i: number) => `<tr><td>${esc(p.name)}</td><td>${esc(p.schedule_info?.frequency_type ?? p.scheduler?.frequency_type ?? 'See details')}</td><td>${p.is_enabled === false ? 'Disabled' : 'Enabled'}</td><td><button data-plan-details="${i}">Details</button>${manage ? `<button data-plan-edit="${i}">Edit</button><button data-plan-toggle="${i}">${p.is_enabled === false ? 'Enable' : 'Disable'}</button>` : ''}</td></tr>`))}`;
    if (this.tab === 'Groups') return `${manage && this.state.groupId === null ? '<button id="new-group">New group</button><button id="new-company">New subcompany</button>' : ''}${this.table(['Group', 'Devices', 'Actions'], data.groups.map((g: Row, i: number) => `<tr><td>${esc(g.name)}</td><td>${esc(g.devices_count ?? g.device_ids?.length)}</td><td>${manage ? `<button data-group-edit="${i}">Edit</button>` : ''}</td></tr>`))}`;
    if (this.tab === 'Deployment') return `<h2>Install IDrive 360</h2><p>Generate the installer configured for this IDrive company.</p>${this.state.groupId !== null ? '<p class="warning">The API creates a company installer. After installation, assign the computer to this client’s group in IDrive before it will appear here.</p>' : ''}<div class="fields"><label>Package<select id="build">${['MSI','WIN','MAC','PKG','DEB','RPM'].map(x => `<option>${x}</option>`).join('')}</select></label><label>Client<select id="full"><option value="true">Full client</option><option value="false">Thin client</option></select></label><label>Encryption<select id="encryption"><option value="false">Default encryption</option><option value="true">Private encryption</option></select></label></div><button id="installer" ${!manage ? 'disabled' : ''}>Generate download link</button>${this.installer ? `<p><a href="${esc(this.installer.setupLink)}" target="_blank" rel="noopener noreferrer">Download configured installer</a></p><p>Configuration ID: <code>${esc(this.installer.configurationId)}</code></p>` : ''}<p class="muted">Restores and browsing backup files remain in the IDrive console; the published API does not expose those operations.</p>`;
    if (this.tab === 'Activity') return this.table(['Operation', 'Result', 'Started'], this.history.map(o => `<tr><td>${esc(o.kind)}</td><td>${esc(o.status === 'running' ? 'Dispatched; outcome not yet confirmed' : o.status === 'failed' ? 'Not confirmed — check IDrive before retrying' : o.status)}</td><td>${esc(o.created_at)}</td></tr>`));
    return `<h2>Client connection</h2><p>${esc(this.state.companyName ?? 'Not configured')}${this.state.groupName ? ' / ' + esc(this.state.groupName) : ''}</p>${this.state.canConfigure ? `<form id="connection"><div class="fields"><label>API key<input id="key" type="password" autocomplete="new-password" placeholder="${this.state.connected ? 'Leave blank to keep stored key' : 'IDrive API key'}"></label><label>Company ID<input id="company" type="number" min="1" value="${esc(this.state.companyId)}" required></label><label>Group ID<input id="group" type="number" min="1" value="${esc(this.state.groupId)}" placeholder="Blank: operator-only company view"></label><label>Stale after (hours)<input id="stale" type="number" min="1" max="2160" value="${esc(this.state.staleHours ?? 48)}" required></label><label>Connection<select id="enabled"><option value="true" ${this.state.enabled !== false ? 'selected' : ''}>Enabled</option><option value="false" ${this.state.enabled === false ? 'selected' : ''}>Disabled</option></select></label></div><button type="submit">Verify and save</button><button type="button" id="discover">Find companies and groups</button></form>${this.discovery ? `<pre>${pretty(this.discovery)}</pre>` : ''}` : '<p>Only a platform administrator can change the company/group mapping.</p>'}`;
  }
  private render() {
    const count = this.inventory.devices.length;
    this.root.innerHTML = `<style>${styles}</style><main><header><div><p class="eyebrow">Cloud Command</p><h1>IDrive 360</h1><p>${esc(this.state.groupName || this.state.companyName || 'Backups for the selected client')}</p></div><button id="refresh">Refresh</button></header><p role="status">${esc(this.message)}</p>${this.state.enabled ? `<div class="metrics"><span><strong>${count}</strong> computers</span><span><strong>${this.inventory.attention.length}</strong> need attention</span><span><strong>${this.inventory.plans.length}</strong> backup plans</span></div>` : ''}<nav>${tabs.map(t => `<button data-tab="${t}" aria-selected="${t === this.tab}">${t}</button>`).join('')}</nav><section>${this.content()}</section>${this.editor ? `<section class="editor"><h2>Prepare ${esc(this.editor.kind)}</h2><p>Review the values below. The server verifies every target belongs to this client.</p>${this.editorFields() || `<label>Advanced change (JSON)<textarea id="action-json" spellcheck="false">${pretty(this.editor)}</textarea></label>`}<button id="preview">Preview change</button><button id="cancel">Cancel</button></section>` : ''}${this.preview ? `<section class="preview"><h2>Confirm change</h2><p>${esc(this.preview.companyName)} / ${esc(this.preview.groupName ?? 'Whole company')}</p><pre>${pretty(this.preview.action)}</pre><h3>Provider preview</h3><pre>${pretty(this.preview.providerPreview)}</pre><p>Applying can change backup coverage or schedules. Preview expires in 10 minutes.</p><button id="apply">Apply this change</button><button id="cancel-preview">Cancel</button></section>` : ''}${this.result !== null ? `<section><h2>Result / details</h2><pre>${pretty(this.result)}</pre><button id="dismiss">Close details</button></section>` : ''}</main>`;
    this.root.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled ||= this.busy);
    this.root.querySelector('#refresh')?.addEventListener('click', () => void this.load());
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.onclick = () => { this.tab = b.dataset.tab as Tab; this.render(); });
    const on = (id: string, fn: () => void) => this.root.querySelector('#' + id)?.addEventListener('click', fn);
    on('dismiss', () => { this.result = null; this.render(); });
    on('cancel', () => { this.editor = null; this.preview = null; this.render(); });
    on('cancel-preview', () => { this.preview = null; this.render(); });
    this.root.querySelector('#filter')?.addEventListener('input', () => { const q = this.input('filter').toLowerCase(); this.root.querySelectorAll<HTMLElement>('[data-device-row]').forEach(row => row.hidden = !row.textContent?.toLowerCase().includes(q)); });
    const rows = (attribute: string, fn: (i: number) => void) => this.root.querySelectorAll<HTMLButtonElement>(`[data-${attribute}]`).forEach(b => b.onclick = () => fn(Number(b.getAttribute('data-' + attribute))));
    rows('inspect', i => { this.result = this.inventory.devices[i]; this.render(); });
    rows('tag', i => { const d = this.inventory.devices[i]; this.edit({ kind: 'device.edit', data: { device_id: d.device_id, custom_tag: d.custom_tag || '' } }); });
    rows('notify', i => this.edit({ kind: 'notifications.edit', data: { device_id: this.inventory.devices[i].device_id, backup_set: 'DEFAULT', type: 'ON_FAILURE', emails: [] } }));
    rows('metadata', i => this.edit({ kind: 'device.edit', data: { device_id: this.inventory.devices[i].device_id, metadata: {} } }));
    rows('clear-metadata', i => this.edit({ kind: 'metadata.delete', data: { device_id: this.inventory.devices[i].device_id, delete_metadata: false, keys_to_delete: [] } }));
    rows('plan-details', i => { this.result = this.inventory.plans[i]; this.render(); });
    rows('plan-toggle', i => { const p = this.inventory.plans[i]; this.edit({ kind: 'plan.edit', id: Number(p.id), data: { is_enabled: p.is_enabled === false } }); });
    rows('plan-edit', i => { const p = this.inventory.plans[i]; this.edit({ kind: 'plan.edit', id: Number(p.id), data: { name: p.name } }); });
    rows('group-edit', i => { const g = this.inventory.groups[i]; this.edit({ kind: 'group.edit', id: Number(g.id), data: { name: g.name, add_device_ids: [], remove_device_ids: [] } }); });
    on('new-group', () => this.edit({ kind: 'group.create', data: { name: '', device_ids: [] } }));
    on('new-company', () => this.edit({ kind: 'company.create', data: { name: '' } }));
    on('new-plan', () => this.edit({ kind: 'plan.create', data: { name: '', group_ids: this.state.groupId ? [this.state.groupId] : [], device_ids: [], backup_details: { what_to_backup: 'FILE_FOLDER', where_to_backup: 'CLOUD', items_to_backup: [] }, scheduler: { frequency_type: 'DAILY', time: '22:00:00', daily_mode: 'ALL_DAYS', start_missed_backup: true } } }));
    on('preview', () => {
      let action: Row; try { action = this.root.querySelector('#action-json') ? JSON.parse(this.input('action-json')) : structuredClone(this.editor!); if (this.root.querySelector('#edit-tag')) action.data.custom_tag = this.input('edit-tag'); if (this.root.querySelector('#edit-emails')) { action.data.emails = this.input('edit-emails').split(',').map(v => v.trim()).filter(Boolean); action.data.type = this.input('edit-notification'); action.data.backup_set = this.input('edit-set'); } } catch { this.message = 'Enter valid JSON for the change.'; this.render(); return; }
      this.editor = action; void this.action(async () => { this.preview = await this.request('preview', action); this.message = 'Preview ready. Nothing has been applied.'; });
    });
    on('apply', () => { const id = this.preview!.previewId; this.preview = null; void this.action(async () => { this.result = await this.request('execute', { previewId: id, confirmed: true }); this.editor = null; this.message = 'IDrive responded. Review the result before assuming every target succeeded.'; this.history = (await this.request('history')).operations; this.inventory = await this.request('inventory'); }); });
    on('installer', () => { const query = new URLSearchParams({ build_type: this.input('build'), full_client: this.input('full'), private_encryption: this.input('encryption') }); void this.action(async () => { this.installer = await this.request('installer?' + query); this.message = 'Installer link ready.'; }); });
    on('discover', () => { const apiKey = this.input('key'); const company = Number(this.input('company')); void this.action(async () => { this.discovery = await this.request('discover', { apiKey, ...(company ? { companyId: company } : {}) }); this.message = 'Select the matching company and group IDs. The supplied key was cleared from the form.'; }); });
    this.root.querySelector('#connection')?.addEventListener('submit', e => {
      e.preventDefault(); const apiKey = this.input('key'); const group = this.input('group');
      const data = { ...(apiKey ? { apiKey } : {}), companyId: Number(this.input('company')), groupId: group ? Number(group) : null, staleHours: Number(this.input('stale')), enabled: this.input('enabled') === 'true', version: this.state.version ?? null };
      void this.action(async () => { this.state = await this.request('connection', data, 'PUT'); this.message = 'Client mapping verified and saved. Refresh to load backups.'; });
    });
  }
}
const styles = `:host{display:block;color:hsl(var(--foreground));font:14px/1.5 var(--font-sans,system-ui)}*{box-sizing:border-box}main{max-width:1350px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;align-items:start;gap:16px}h1,h2,h3,p{margin:0 0 12px}h1{font-size:26px}h2{font-size:18px}h3{font-size:15px}.eyebrow,.muted,small,label{color:hsl(var(--muted-foreground))}.eyebrow{text-transform:uppercase;font-size:11px;letter-spacing:.12em}small{display:block;max-width:320px}.metrics{display:flex;gap:24px;padding:16px;border:1px solid hsl(var(--border));border-radius:8px;margin-bottom:20px}.metrics strong{font-size:23px;display:block}nav{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid hsl(var(--border));margin-bottom:20px}nav button{border:0;background:none;border-bottom:3px solid transparent;border-radius:0}nav button[aria-selected=true]{border-color:hsl(var(--primary));color:hsl(var(--primary))}button,a{cursor:pointer}button,input,select,textarea{font:inherit;color:inherit;border:1px solid hsl(var(--border));border-radius:6px;background:hsl(var(--card));padding:8px 12px}button{margin:3px}button:hover{background:hsl(var(--muted))}button:disabled{opacity:.5;cursor:wait}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid hsl(var(--ring))}a{color:hsl(var(--primary))}label{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.table{overflow:auto;margin:16px 0}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:12px;border-bottom:1px solid hsl(var(--border));vertical-align:top}th{background:hsl(var(--muted));font-size:12px}td button{font-size:12px}section{margin:16px 0}.editor,.preview{padding:20px;border:1px solid hsl(var(--primary));border-radius:8px}textarea{min-height:270px;width:100%;font:13px/1.5 monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:440px;overflow:auto;background:hsl(var(--muted));padding:16px;border-radius:6px}p[role=status]{min-height:22px}.warning{color:#ca8627}[hidden]{display:none!important}@media(max-width:650px){main{padding:12px}.metrics{gap:12px}.fields{grid-template-columns:1fr}}`;
if (!customElements.get('cloudcommand-idrive-page')) customElements.define('cloudcommand-idrive-page', CloudCommandIDrivePage);
