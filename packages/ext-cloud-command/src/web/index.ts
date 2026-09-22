import './overview';
import './microsoft';
import {
  dispatchExtensionHostEvent,
  parseExtensionPageContextV1,
  type ExtensionPageContextV1,
} from '@breeze/extension-web-sdk';

const ELEMENT = 'cloudcommand-threecx-page';

type Connection = {
  connected: boolean;
  /** The API decides whether this actor can change connection configuration. */
  canManage?: boolean;
  origin?: string;
  clientId?: string;
  departmentId?: number | null;
  enabled?: boolean;
  version?: number | null;
  lastVerifiedAt?: string | null;
};

type Group = { id: number; name: string };
type MicrosoftNavigationStatus = { available: boolean; connected: boolean; canManage: boolean; enabled?: boolean };
type ConnectionDraft = {
  origin: string;
  clientId: string;
  secret: string;
  departmentId: string;
  fullPbx: boolean;
  enabled: boolean;
};
type User = {
  Id: number;
  Number: string;
  FirstName: string | null;
  LastName: string | null;
  EmailAddress: string | null;
  Mobile: string | null;
  Enabled: boolean | null;
  IsRegistered: boolean | null;
  CurrentProfileName: string | null;
};

export interface CloudCommandHostApi {
  /** Authenticated host bridge. Paths stay below this extension's route namespace. */
  request(path: string, init?: RequestInit): Promise<Response>;
}

function value(input: HTMLInputElement | HTMLSelectElement): string { return input.value.trim(); }

function errorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const record = body as Record<string, unknown>;
  return typeof record.error === 'string' ? record.error : typeof record.code === 'string' ? record.code : fallback;
}

export class CloudCommandThreeCxPage extends HTMLElement {
  private pageContext: ExtensionPageContextV1 | null = null;
  private api: CloudCommandHostApi | null = null;
  private root = this.attachShadow({ mode: 'open' });
  private connection: Connection = { connected: false };
  private groups: Group[] = [];
  /** Identity used to discover groups; never apply these to another PBX/client. */
  private groupsFor: Pick<ConnectionDraft, 'origin' | 'clientId'> | null = null;
  private draft: ConnectionDraft | null = null;
  private users: User[] = [];
  private nextSkip: number | null = null;
  private detailIndex: number | null = null;
  private focusReturnIndex: number | null = null;
  private busy = false;
  private statusMessage = '';
  private statusIsError = false;
  private generation = 0;
  private microsoftNavigationVisible = false;

  set context(input: unknown) {
    const context = parseExtensionPageContextV1(input);
    if (context.extensionName !== 'cloudcommand') throw new Error('Cloud Command received the wrong extension context');
    const changedOrganization = this.pageContext?.organizationId !== context.organizationId;
    this.generation += 1;
    this.pageContext = context;
    this.microsoftNavigationVisible = false;
    this.busy = false;
    if (changedOrganization) {
      // Do not capture the prior organization's rendered inputs while resetting.
      this.connection = { connected: false };
      this.groups = [];
      this.groupsFor = null;
      this.draft = null;
      this.users = [];
      this.nextSkip = null;
      this.detailIndex = null;
      this.focusReturnIndex = null;
      this.busy = false;
      this.statusMessage = '';
      this.statusIsError = false;
      if (this.isConnected) this.render(false);
    }
    // A same-organization context refresh must not replace an unsaved draft.
    if (this.isConnected && changedOrganization) void this.loadConnection();
    else if (this.isConnected) { this.render(); void this.loadMicrosoftNavigation(this.generation, context); }
  }

  get context(): ExtensionPageContextV1 | null { return this.pageContext; }

  set hostApi(api: CloudCommandHostApi) {
    if (!api || typeof api.request !== 'function') throw new Error('Cloud Command requires the host API bridge');
    this.api = api;
    if (this.isConnected && this.pageContext) void this.loadConnection();
  }

  connectedCallback(): void {
    this.render();
    if (this.pageContext) void this.loadConnection();
  }

  disconnectedCallback(): void {
    this.generation += 1;
    this.busy = false;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.api) throw new Error('The authenticated host API is unavailable.');
    const response = await this.api.request(path, init);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorMessage(body, 'The Cloud Command request failed.'));
    return body as T;
  }

  private url(path: string, extra: Record<string, string | number | undefined> = {}): string {
    if (!this.pageContext) throw new Error('Cloud Command needs an organization context');
    const params = new URLSearchParams();
    for (const [key, raw] of Object.entries(extra)) if (raw !== undefined) params.set(key, String(raw));
    const suffix = params.toString();
    return `/threecx${path}${suffix ? `?${suffix}` : ''}`;
  }

  private async loadConnection(): Promise<void> {
    const generation = this.generation;
    const context = this.pageContext;
    try {
      this.setStatus('Loading connection…');
      const connection = await this.request<Connection>(this.url('/connection'));
      if (generation !== this.generation || context !== this.pageContext) return;
      this.connection = connection;
      this.draft = this.draftFromConnection(connection, this.draft?.secret ?? '');
      this.setStatus(connection.connected ? 'Connection loaded.' : 'No 3CX connection is configured.');
      this.render();
      void this.loadMicrosoftNavigation(generation, context);
    } catch (error) {
      if (generation === this.generation && context === this.pageContext) this.setStatus(error instanceof Error ? error.message : 'Could not load the 3CX connection.', true);
    }
  }

  private async loadMicrosoftNavigation(generation: number, context: ExtensionPageContextV1 | null): Promise<void> {
    try {
      const status = await this.request<MicrosoftNavigationStatus>('/microsoft/connection');
      if (generation !== this.generation || context !== this.pageContext) return;
      this.microsoftNavigationVisible = status.available === true && ((status.connected === true && status.enabled === true) || status.canManage === true);
      this.render();
    } catch {
      if (generation !== this.generation || context !== this.pageContext) return;
      this.microsoftNavigationVisible = false;
      this.render();
    }
  }

  private setStatus(message: string, error = false): void {
    this.statusMessage = message;
    this.statusIsError = error;
    const node = this.root.querySelector<HTMLElement>('[data-status]');
    if (node) { node.textContent = message; node.dataset.error = String(error); }
  }

  private formData(forTest = false): { origin: string; clientId: string; secret?: string; departmentId: number | null; enabled: boolean; version: number | null } | null {
    this.captureDraft();
    const draft = this.draft!;
    const { origin, clientId, secret, fullPbx } = draft;
    const department = draft.departmentId;
    const version = this.connection.version ?? null;
    if (!origin || !clientId) { this.setStatus('PBX URL and client ID are required.', true); return null; }
    try {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    } catch {
      this.setStatus('Enter a plain HTTPS PBX URL, for example https://pbx.example.com:5001.', true);
      return null;
    }
    const departmentId = Number(department);
    const hasDepartment = /^\d+$/.test(department) && Number.isSafeInteger(departmentId);
    const testedForCurrentConnection = this.groupsFor?.origin === origin && this.groupsFor.clientId === clientId;
    const savedForCurrentConnection = this.connection.origin === origin
      && this.connection.clientId === clientId
      && this.connection.departmentId === departmentId;
    const departmentIsInScope = hasDepartment && ((testedForCurrentConnection && this.groups.some((group) => group.id === departmentId)) || savedForCurrentConnection);
    // A test is allowed before the first department is known. It discovers the
    // available groups; saving remains impossible until an explicit scope is
    // selected (a department or the full-PBX acknowledgement).
    if (!forTest && !fullPbx && !departmentIsInScope) {
      this.setStatus('Select a department or explicitly enable full PBX access.', true); return null;
    }
    return {
      origin,
      clientId,
      ...(secret ? { secret } : {}),
      departmentId: fullPbx || !hasDepartment ? null : departmentId,
      enabled: draft.enabled,
      version,
    };
  }

  private requireInput(id: string): HTMLInputElement | HTMLSelectElement {
    const input = this.root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
    if (!input) throw new Error(`Missing ${id}`);
    return input;
  }

  private async testConnection(): Promise<void> {
    const body = this.formData(true);
    if (!body) return;
    const generation = this.generation;
    const context = this.pageContext;
    await this.withBusy(async () => {
      const result = await this.request<{ success: true; groups: Group[] }>(this.url('/test'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!this.isCurrent(generation, context)) return;
      this.groups = result.groups;
      this.groupsFor = { origin: body.origin, clientId: body.clientId };
      this.setStatus(`Connection succeeded. ${result.groups.length} department${result.groups.length === 1 ? '' : 's'} found.`);
      this.render();
    }, 'Could not test the 3CX connection.', generation, context);
  }

  private async saveConnection(): Promise<void> {
    const body = this.formData();
    if (!body) return;
    const generation = this.generation;
    const context = this.pageContext;
    let saved = false;
    await this.withBusy(async () => {
      const connection = await this.request<Connection>(this.url('/connection'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!this.isCurrent(generation, context)) return;
      this.connection = connection;
      saved = true;
      // A save can change the PBX, client credentials, department, or enabled
      // state. Never leave rows or a drawer from the previous scope onscreen.
      this.users = [];
      this.nextSkip = null;
      this.detailIndex = null;
      this.focusReturnIndex = null;
      // The only browser copy of a secret is a pending form draft. Erase it
      // after the server accepted the update; retain it on all failed saves.
      this.draft = { ...(this.draft ?? this.draftFromConnection(this.connection, '')), secret: '' };
      this.setStatus('3CX connection saved.');
      // Do not capture the old input node here: it still contains the secret
      // that just succeeded, and would overwrite the deliberate draft reset.
      this.render(false);
    }, 'Could not save the 3CX connection.', generation, context);
    if (saved && this.isCurrent(generation, context)) {
      await this.loadConnection();
      if (this.isCurrent(generation, context) && this.connection.connected && this.connection.enabled !== false) await this.loadUsers(true);
    }
  }

  private async loadUsers(reset: boolean): Promise<void> {
    if (!this.connection.connected || this.connection.enabled === false) return;
    const skip = reset ? 0 : this.nextSkip;
    if (skip === null) return;
    const generation = this.generation;
    const context = this.pageContext;
    await this.withBusy(async () => {
      const page = await this.request<{ items: User[]; nextSkip: number | null; truncated: boolean }>(this.url('/users', { skip }));
      if (!this.isCurrent(generation, context)) return;
      this.users = reset ? page.items : [...this.users, ...page.items];
      this.nextSkip = page.nextSkip;
      this.render();
      this.setStatus(page.truncated ? 'Extension list is truncated at the service limit.' : `${this.users.length} extension${this.users.length === 1 ? '' : 's'} loaded.`);
    }, 'Could not load extensions.', generation, context);
  }

  private isCurrent(generation: number, context: ExtensionPageContextV1 | null): boolean {
    return generation === this.generation && context === this.pageContext;
  }

  private async withBusy(action: () => Promise<void>, fallback: string, generation = this.generation, context = this.pageContext): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try { await action(); } catch (error) { if (this.isCurrent(generation, context)) this.setStatus(error instanceof Error ? error.message : fallback, true); } finally { if (this.isCurrent(generation, context)) { this.busy = false; this.render(); } }
  }

  private openDetails(index: number): void {
    if (!this.users[index]) return;
    this.detailIndex = index;
    this.focusReturnIndex = index;
    this.render();
    queueMicrotask(() => this.root.querySelector<HTMLButtonElement>('#details-close')?.focus());
  }

  private closeDetails(): void {
    const returnIndex = this.focusReturnIndex;
    this.detailIndex = null;
    this.render();
    if (returnIndex !== null) {
      queueMicrotask(() => this.root.querySelector<HTMLButtonElement>(`[data-detail-index="${returnIndex}"]`)?.focus());
    }
  }

  private draftFromConnection(connection: Connection, secret: string): ConnectionDraft {
    return {
      origin: connection.origin ?? '',
      clientId: connection.clientId ?? '',
      secret,
      departmentId: typeof connection.departmentId === 'number' ? String(connection.departmentId) : '',
      fullPbx: connection.departmentId === null,
      enabled: connection.enabled !== false,
    };
  }

  private captureDraft(): void {
    const origin = this.root.querySelector<HTMLInputElement>('#origin');
    if (!origin) return;
    this.draft = {
      origin: value(origin),
      clientId: value(this.requireInput('clientId')),
      secret: value(this.requireInput('secret')),
      departmentId: value(this.requireInput('departmentId')),
      fullPbx: this.root.querySelector<HTMLInputElement>('#full-pbx')!.checked,
      enabled: this.root.querySelector<HTMLInputElement>('#enabled')!.checked,
    };
  }

  private render(captureCurrentDraft = true): void {
    if (captureCurrentDraft) this.captureDraft();
    const connected = this.connection.connected === true;
    const canManage = this.connection.canManage === true;
    const connectionEnabled = this.connection.enabled !== false;
    const canReadUsers = connected && connectionEnabled;
    const draft = this.draft ?? this.draftFromConnection(this.connection, '');
    const selectedDepartment = draft.departmentId;
    const groupsMatchDraft = this.groupsFor?.origin === draft.origin && this.groupsFor.clientId === draft.clientId;
    const groups = groupsMatchDraft ? this.groups : typeof this.connection.departmentId === 'number' && this.connection.origin === draft.origin && this.connection.clientId === draft.clientId ? [{ id: this.connection.departmentId, name: `Department ${this.connection.departmentId}` }] : [];
    const detail = this.detailIndex === null ? null : this.users[this.detailIndex] ?? null;
    this.root.innerHTML = `
      <style>${styles}</style>
      <main aria-labelledby="title">
        <header><div><p class="eyebrow">Cloud Command</p><h1 id="title">3CX extensions</h1><p class="subtle">Connect one organization’s 3CX PBX, select its scope, and review extensions.</p></div><span class="badge ${connected && connectionEnabled ? 'ok' : connected ? 'disabled' : ''}">${connected ? connectionEnabled ? 'Connected' : 'Disabled' : 'Not connected'}</span></header>
        <nav aria-label="Cloud Command providers">${this.microsoftNavigationVisible ? '<button class="secondary compact" id="go-microsoft" type="button">Microsoft 365</button>' : ''}</nav>
        <p class="status" data-status data-error="${this.statusIsError}" aria-live="polite">${escapeHtml(this.statusMessage)}</p>
        <section class="card" aria-labelledby="connection-heading">
          <div class="section-title"><div><h2 id="connection-heading">Connection</h2><p>${canManage ? 'Credentials are encrypted server-side. The secret is never returned to this page.' : 'You have read-only access to this organization’s 3CX connection.'}</p></div></div>
          ${canManage ? `<div class="fields">
            <label>HTTPS PBX URL<input id="origin" type="url" autocomplete="url" placeholder="https://pbx.example.com:5001" value="${escapeAttr(draft.origin)}" required></label>
            <label>Client ID<input id="clientId" type="text" autocomplete="username" value="${escapeAttr(draft.clientId)}" required></label>
            <label>Client secret<input id="secret" type="password" autocomplete="new-password" value="${escapeAttr(draft.secret)}" placeholder="${connected ? 'Leave blank to keep the saved secret' : 'Enter client secret'}"><span class="optional">${connected ? 'Leave blank to keep the saved secret.' : 'Required for a new connection.'}</span></label>
          </div>
          <details open><summary>Access scope</summary><div class="scope">
            <label class="check"><input id="full-pbx" type="checkbox" ${draft.fullPbx ? 'checked' : ''}>Allow this connection to read the full PBX</label>
            <p class="hint">Full PBX access is explicit. Otherwise the extension list is limited to the selected department.</p>
            <label>Department<select id="departmentId" ${draft.fullPbx ? 'disabled' : ''}><option value="">Select a department</option>${groups.map((group) => `<option value="${group.id}" ${String(group.id) === selectedDepartment ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}</select></label>
            <label class="check"><input id="enabled" type="checkbox" ${draft.enabled ? 'checked' : ''}>Enable this connection</label>
          </div></details>
          <div class="actions"><button class="secondary" id="test" type="button" ${this.busy ? 'disabled' : ''}>${this.busy ? 'Working…' : 'Test connection'}</button><button id="save" type="button" ${this.busy ? 'disabled' : ''}>Save connection</button></div>` : '<p class="readonly-note">Connection configuration is available to organization managers.</p>'}
        </section>
        <section class="card" aria-labelledby="extensions-heading">
          <div class="section-title"><div><h2 id="extensions-heading">Extensions</h2><p>Read-only view from the configured 3CX scope.</p></div><button class="secondary" id="refresh-users" type="button" ${!canReadUsers || this.busy ? 'disabled' : ''}>Refresh</button></div>
          ${this.users.length ? `<div class="table-wrap"><table><thead><tr><th>Extension</th><th>Name</th><th>Email</th><th>Status</th><th><span class="sr-only">Details</span></th></tr></thead><tbody>${this.users.map((user, index) => `<tr><td>${escapeHtml(user.Number)}</td><td>${escapeHtml([user.FirstName, user.LastName].filter(Boolean).join(' ') || '—')}</td><td>${escapeHtml(user.EmailAddress || '—')}</td><td><span class="state ${user.Enabled ? 'on' : ''}">${user.Enabled ? 'Enabled' : 'Disabled'}</span></td><td><button class="secondary compact" type="button" data-detail-index="${index}">View details</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">${connected ? connectionEnabled ? 'No extensions loaded yet.' : 'This connection is disabled.' : 'Save a connection to view extensions.'}</div>`}
          ${this.nextSkip !== null ? `<button class="secondary more" id="more-users" type="button" ${!canReadUsers || this.busy ? 'disabled' : ''}>Load more</button>` : ''}
        </section>
        ${detail ? `<div class="drawer-layer" data-details-backdrop><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="details-title"><div class="drawer-header"><div><p class="eyebrow">Extension</p><h2 id="details-title">${escapeHtml(detail.Number)}</h2></div><button class="secondary compact" id="details-close" type="button" aria-label="Close extension details">Close</button></div><dl class="detail-list"><div><dt>Name</dt><dd>${escapeHtml([detail.FirstName, detail.LastName].filter(Boolean).join(' ') || '—')}</dd></div><div><dt>Email</dt><dd>${escapeHtml(detail.EmailAddress || '—')}</dd></div><div><dt>Mobile</dt><dd>${escapeHtml(detail.Mobile || '—')}</dd></div><div><dt>Enabled</dt><dd>${detail.Enabled ? 'Enabled' : 'Disabled'}</dd></div><div><dt>Registered</dt><dd>${detail.IsRegistered ? 'Registered' : 'Not registered'}</dd></div><div><dt>Profile</dt><dd>${escapeHtml(detail.CurrentProfileName || '—')}</dd></div></dl></aside></div>` : ''}
      </main>`;
    this.root.querySelector('#full-pbx')?.addEventListener('change', () => { const select = this.requireInput('departmentId'); select.toggleAttribute('disabled', this.root.querySelector<HTMLInputElement>('#full-pbx')!.checked); });
    this.root.querySelector('#test')?.addEventListener('click', () => void this.testConnection());
    this.root.querySelector('#save')?.addEventListener('click', () => void this.saveConnection());
    this.root.querySelector('#refresh-users')?.addEventListener('click', () => void this.loadUsers(true));
    this.root.querySelector('#more-users')?.addEventListener('click', () => void this.loadUsers(false));
    this.root.querySelectorAll<HTMLButtonElement>('[data-detail-index]').forEach((button) => button.addEventListener('click', () => this.openDetails(Number(button.dataset.detailIndex))));
    this.root.querySelector('#details-close')?.addEventListener('click', () => this.closeDetails());
    this.root.querySelector('#go-microsoft')?.addEventListener('click', () => dispatchExtensionHostEvent(this, { version: 1, type: 'navigate', path: '/extensions/cloudcommand/microsoft' }));
    this.root.querySelector('[data-details-backdrop]')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) this.closeDetails(); });
    this.root.querySelector<HTMLElement>('[role="dialog"]')?.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); this.closeDetails(); } else if (event.key === 'Tab') { event.preventDefault(); this.root.querySelector<HTMLButtonElement>('#details-close')?.focus(); } });
  }
}

function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!); }
function escapeAttr(value: string): string { return escapeHtml(value); }

// CSS custom properties inherit through a shadow root. Every colour here is a
// Breeze global token, so light/dark themes and customer appearance settings
// continue to apply without a copied palette.
const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}main{max-width:1100px;margin:0 auto;padding:1.5rem}header,.section-title,.actions,.drawer-header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}h1,h2,p{margin:0}h1{font-size:1.5rem;line-height:2rem;font-weight:600}h2{font-size:1.125rem;line-height:1.75rem;font-weight:600}.eyebrow{color:hsl(var(--primary));font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.subtle,.section-title p,.hint,.optional,.readonly-note{color:hsl(var(--muted-foreground));font-size:.875rem;margin-top:.35rem}.badge,.state{border-radius:999px;padding:.25rem .6rem;background:hsl(var(--muted));font-size:.8rem;font-weight:650;white-space:nowrap}.badge.ok,.state.on{background:hsl(var(--success) / .16);color:hsl(var(--success))}.badge.disabled{background:hsl(var(--warning) / .18);color:hsl(var(--warning-strong))}.card{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);box-shadow:0 1px 2px hsl(var(--foreground) / .04);margin-top:1.25rem;padding:1.25rem}.status{min-height:1.35rem;margin-top:.75rem;color:hsl(var(--muted-foreground));font-size:.9rem}.status[data-error="true"]{color:hsl(var(--destructive))}.fields{display:grid;align-items:start;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;margin-top:1.25rem}label{display:grid;gap:.42rem;font-size:.875rem;font-weight:500}input,select{min-height:2.5rem;width:100%;border:1px solid hsl(var(--input));border-radius:calc(var(--radius,.5rem) - 2px);padding:.5rem .65rem;background:hsl(var(--background));color:inherit;font:inherit;font-weight:400}input:focus,select:focus,button:focus,summary:focus{outline:2px solid hsl(var(--ring));outline-offset:2px}details{margin-top:1.15rem;border-top:1px solid hsl(var(--border));padding-top:1rem}summary{cursor:pointer;font-weight:700}.scope{display:grid;gap:.8rem;margin-top:1rem;max-width:420px}.check{display:flex;align-items:center;gap:.55rem}.check input{height:1rem;width:1rem}.actions{justify-content:flex-end;margin-top:1.25rem}button{border:0;border-radius:calc(var(--radius,.5rem) - 2px);background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer;font:inherit;font-weight:700;min-height:2.5rem;padding:.5rem .85rem}button.secondary{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground))}button.compact{min-height:2rem;padding:.3rem .6rem;font-size:.8rem}button:disabled{cursor:not-allowed;opacity:.6}.table-wrap{overflow:auto;margin-top:1rem}table{color:hsl(var(--foreground));border-collapse:collapse;width:100%;min-width:680px;font-size:.9rem}th,td{border-bottom:1px solid hsl(var(--border));padding:.7rem;text-align:left}th{color:hsl(var(--muted-foreground));font-size:.75rem;letter-spacing:.04em;text-transform:uppercase}.more{margin-top:1rem}.empty{border:1px dashed hsl(var(--border));border-radius:var(--radius,.5rem);color:hsl(var(--muted-foreground));margin-top:1rem;padding:1.5rem;text-align:center}.sr-only{height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute;width:1px;clip:rect(0,0,0,0);white-space:nowrap}.drawer-layer{align-items:stretch;background:hsl(var(--foreground) / .32);display:flex;inset:0;justify-content:flex-end;position:fixed;z-index:20}.drawer{background:hsl(var(--card));box-shadow:-8px 0 24px hsl(var(--foreground) / .16);max-width:min(100%,30rem);overflow:auto;padding:1.5rem;width:100%}.detail-list{display:grid;gap:0;margin:1.5rem 0}.detail-list div{border-bottom:1px solid hsl(var(--border));display:grid;gap:.3rem;padding:.8rem 0}.detail-list dt{color:hsl(var(--muted-foreground));font-size:.78rem;font-weight:700;text-transform:uppercase}.detail-list dd{margin:0;overflow-wrap:anywhere}@media(max-width:600px){main{padding:1rem}header,.section-title{align-items:flex-start;flex-direction:column}.actions{justify-content:stretch}.actions button{flex:1}.drawer{max-width:100%}}`;

if (!customElements.get(ELEMENT)) customElements.define(ELEMENT, CloudCommandThreeCxPage);
