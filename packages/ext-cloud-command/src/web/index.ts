import './overview';
import './microsoft';
import './connect';
import './google';
import './threecx-dashboard';
import './threecx-call-log';
import { bindThreeCxDetail, detailStyles, detailTab, isDirty, renderThreeCxDetail, type DetailTab } from './threecx-detail';
import { hasForwardingChanges, mountForwardingEditors } from './threecx-detail-forwarding';
import type { ThreeCxDetail, ThreeCxDetailChanges } from '../threecx/detail-contract';
import {
  dispatchExtensionHostEvent,
  parseExtensionPageContextV1,
  type ExtensionPageContextV1,
} from '@breeze/extension-web-sdk';

const ELEMENT = 'cloudcommand-threecx-page';
export type CloudCommandThreeCxMode = 'configuration' | 'directory' | 'combined';

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
  /** Keeps an empty completed directory distinct from a directory not yet read. */
  private usersLoaded = false;
  private nextSkip: number | null = null;
  private userSearch = '';
  private detailId: number | null = null;
  private detail: ThreeCxDetail | null = null;
  private detailTab: DetailTab = 'general';
  private detailDraft: ThreeCxDetailChanges = {};
  private detailRequest = 0;
  private focusReturnIndex: number | null = null;
  private busy = false;
  private statusMessage = '';
  private statusIsError = false;
  private generation = 0;
  private microsoftNavigationVisible = false;
  /** The Connect shell embeds only setup; the operational route embeds only the directory. */
  private mode: CloudCommandThreeCxMode = 'directory';

  set displayMode(mode: CloudCommandThreeCxMode) {
    if (mode !== 'configuration' && mode !== 'directory' && mode !== 'combined') {
      throw new Error('Invalid Cloud Command 3CX display mode');
    }
    if (this.mode === mode) return;
    this.mode = mode;
    this.setAttribute('data-display-mode', mode);
    if (this.isConnected) this.render();
  }

  get displayMode(): CloudCommandThreeCxMode { return this.mode; }

  set context(input: unknown) {
    const context = parseExtensionPageContextV1(input);
    if (context.extensionName !== 'cloudcommand') throw new Error('Cloud Command received the wrong extension context');
    const previousOrganization = this.pageContext?.organizationId;
    const changedOrganization = previousOrganization !== context.organizationId;
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
      this.usersLoaded = false;
      this.nextSkip = null;
      this.userSearch = '';
      this.clearDetail();
      this.focusReturnIndex = null;
      this.busy = false;
      this.statusMessage = '';
      this.statusIsError = false;
      if (previousOrganization && this.mode !== 'configuration' && window.location.hash.includes('extension=')) window.location.hash = '';
      if (this.isConnected) this.render(false);
    }
    // A same-organization context refresh must not replace an unsaved draft.
    if (this.isConnected && changedOrganization) void this.loadConnection();
    else if (this.isConnected) { this.render(); if (this.mode !== 'configuration') void this.loadMicrosoftNavigation(this.generation, context); }
  }

  get context(): ExtensionPageContextV1 | null { return this.pageContext; }

  set hostApi(api: CloudCommandHostApi) {
    if (!api || typeof api.request !== 'function') throw new Error('Cloud Command requires the host API bridge');
    this.api = api;
    if (this.isConnected && this.pageContext) void this.loadConnection();
  }

  connectedCallback(): void {
    this.render();
    window.addEventListener('hashchange', this.onHashChange);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    if (this.mode !== 'configuration') this.applyHash();
    if (this.pageContext) void this.loadConnection();
  }

  disconnectedCallback(): void {
    this.generation += 1;
    this.busy = false;
    window.removeEventListener('hashchange', this.onHashChange);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
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
      if (this.mode !== 'configuration') void this.loadMicrosoftNavigation(generation, context);
      if (this.mode !== 'configuration' && connection.connected && connection.enabled !== false) {
        await this.loadUsers(true);
      }
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
    if (this.detailId !== null && /^(Loading connection|Connection loaded|Loading extensions|\d+ extension)/.test(message)) return;
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
      this.usersLoaded = false;
      this.nextSkip = null;
      this.clearDetail();
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
    }
  }

  private async loadUsers(reset: boolean): Promise<void> {
    if (!this.connection.connected || this.connection.enabled === false) return;
    const skip = reset ? 0 : this.nextSkip;
    if (skip === null) return;
    const generation = this.generation;
    const context = this.pageContext;
    this.setStatus('Loading extensions…');
    await this.withBusy(async () => {
      const page = await this.request<{ items: User[]; nextSkip: number | null; truncated: boolean }>(this.url('/users', { skip }));
      if (!this.isCurrent(generation, context)) return;
      this.users = reset ? page.items : [...this.users, ...page.items];
      this.nextSkip = page.nextSkip;
      this.usersLoaded = true;
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
    const user = this.users[index];
    if (!user) return;
    this.focusReturnIndex = index;
    window.location.hash = `extension=${encodeURIComponent(String(user.Id))}&tab=general`;
  }

  private clearDetail(): void {
    this.detailRequest += 1;
    this.detailId = null;
    this.detail = null;
    this.detailDraft = {};
    this.detailTab = 'general';
  }

  private closeDetails(force = false): void {
    if (!force && isDirty(this.detailDraft) && !window.confirm('Discard unsaved extension changes?')) return;
    const returnIndex = this.focusReturnIndex;
    this.clearDetail();
    if (window.location.hash.includes('extension=')) window.location.hash = '';
    this.render();
    if (returnIndex !== null) {
      queueMicrotask(() => this.root.querySelector<HTMLButtonElement>(`[data-detail-index="${returnIndex}"]`)?.focus());
    }
  }

  private readonly onHashChange = (): void => this.applyHash();
  private readonly onBeforeUnload = (event: BeforeUnloadEvent): void => { if (isDirty(this.detailDraft)) { event.preventDefault(); event.returnValue = ''; } };

  private applyHash(): void {
    if (this.mode === 'configuration') return;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const rawId = params.get('extension');
    const id = rawId && /^\d+$/.test(rawId) ? Number(rawId) : null;
    const tab = detailTab(params.get('tab'));
    if (id === this.detailId) { if (this.detailTab !== tab) { this.detailTab = tab; this.render(); } return; }
    if (isDirty(this.detailDraft) && !window.confirm('Discard unsaved extension changes?')) {
      window.location.hash = this.detailId === null ? '' : `extension=${this.detailId}&tab=${this.detailTab}`;
      return;
    }
    if (id === null) { this.clearDetail(); this.render(); return; }
    this.detailId = id;
    this.detailTab = tab;
    this.detail = null;
    this.detailDraft = {};
    this.render();
    void this.loadDetail(id);
  }

  private async loadDetail(id: number, afterSave = false): Promise<void> {
    const generation = this.generation;
    const context = this.pageContext;
    const request = ++this.detailRequest;
    this.setStatus('Loading extension details…');
    try {
      const detail = await this.request<ThreeCxDetail>(this.url(`/users/${id}`));
      if (!this.isCurrent(generation, context) || this.detailId !== id || request !== this.detailRequest) return;
      this.detail = detail;
      this.setStatus(afterSave ? 'Extension changes saved.' : 'Extension loaded.');
      this.render();
    } catch (error) {
      if (this.isCurrent(generation, context) && this.detailId === id && request === this.detailRequest) this.setStatus(error instanceof Error ? error.message : 'Could not load extension details.', true);
    }
  }

  private changeDetail(key: keyof ThreeCxDetailChanges, value: string | boolean): void {
    if (!this.detail || this.busy) return;
    const existing = this.detail.user[key];
    if (existing === value || (existing == null && value === '')) delete this.detailDraft[key];
    else this.detailDraft[key] = value as never;
    const dirty = this.root.querySelector<HTMLElement>('[data-detail-dirty]');
    if (dirty) dirty.textContent = isDirty(this.detailDraft) ? 'Pending changes' : '';
    this.root.querySelector<HTMLButtonElement>('#detail-discard')?.toggleAttribute('disabled', !isDirty(this.detailDraft));
    this.root.querySelector<HTMLButtonElement>('#detail-save')?.toggleAttribute('disabled', !isDirty(this.detailDraft));
  }

  private changeForwarding(profiles: NonNullable<ThreeCxDetailChanges['ForwardingProfiles']>): void {
    if (this.busy) return;
    this.detailDraft.ForwardingProfiles = profiles.length ? profiles : undefined;
    if (!profiles.length) delete this.detailDraft.ForwardingProfiles;
    const dirty = this.root.querySelector<HTMLElement>('[data-detail-dirty]');
    if (dirty) dirty.textContent = isDirty(this.detailDraft) ? 'Pending changes' : '';
    this.root.querySelector<HTMLButtonElement>('#detail-discard')?.toggleAttribute('disabled', !isDirty(this.detailDraft));
    this.root.querySelector<HTMLButtonElement>('#detail-save')?.toggleAttribute('disabled', !isDirty(this.detailDraft));
  }

  private discardDetail(): void { this.detailDraft = {}; this.setStatus('Extension changes discarded.'); this.render(); }

  private async saveDetail(): Promise<void> {
    if (this.busy) return;
    for (const input of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-detail-field], [data-forwarding-field]')) {
      if (!input.disabled && !input.reportValidity()) return;
    }
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-detail-field]:not(:disabled)').forEach((input) => this.changeDetail(input.dataset.detailField as keyof ThreeCxDetailChanges, input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value));
    if (!this.detail || !isDirty(this.detailDraft)) return;
    const forwarding = hasForwardingChanges(this.detailDraft);
    const scalar = Object.keys(this.detailDraft).some((key) => key !== 'ForwardingProfiles');
    if (forwarding && scalar) { this.setStatus('Save or discard forwarding changes before saving other settings.', true); return; }
    if (this.detailDraft.VMEmailOptions === 'AttachmentAndDelete' && !window.confirm('Attach recording and delete removes the PBX copy after email delivery. Save this change?')) return;
    const id = this.detailId;
    const generation = this.generation;
    const context = this.pageContext;
    await this.withBusy(async () => {
      await this.request<{ success: true }>(this.url(`/users/${this.detail!.user.Id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: this.detail!.revision, changes: this.detailDraft }) });
      if (!this.isCurrent(generation, context) || this.detailId !== id) return;
      this.detailDraft = {};
      this.setStatus('Extension changes saved.');
      await this.loadDetail(id!, true);
    }, 'Could not save extension changes.', generation, context);
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

  private filterLoadedUsers(): void {
    const query = this.userSearch.trim().toLocaleLowerCase();
    let visible = 0;
    this.root.querySelectorAll<HTMLTableRowElement>('tr[data-user-index]').forEach((row) => {
      const user = this.users[Number(row.dataset.userIndex)];
      if (!user) return;
      const haystack = [user.Number, user.FirstName, user.LastName, user.EmailAddress,
        user.CurrentProfileName, user.IsRegistered === true ? 'registered' : user.IsRegistered === false ? 'unregistered' : '',
        user.Enabled ? 'enabled' : 'disabled'].filter(Boolean).join(' ').toLocaleLowerCase();
      row.hidden = Boolean(query) && !haystack.includes(query);
      if (!row.hidden) visible += 1;
    });
    const count = this.root.querySelector<HTMLElement>('#search-count');
    if (count) count.textContent = query ? `${visible} matching loaded extensions` : `${this.users.length} loaded extensions`;
    const empty = this.root.querySelector<HTMLElement>('#search-empty');
    if (empty) empty.hidden = visible !== 0 || !query;
  }

  private render(captureCurrentDraft = true): void {
    if (captureCurrentDraft) this.captureDraft();
    const connected = this.connection.connected === true;
    const canManage = this.connection.canManage === true;
    const connectionEnabled = this.connection.enabled !== false;
    const canReadUsers = connected && connectionEnabled;
    const showConfiguration = this.mode !== 'directory';
    const showDirectory = this.mode !== 'configuration';
    const draft = this.draft ?? this.draftFromConnection(this.connection, '');
    const selectedDepartment = draft.departmentId;
    const groupsMatchDraft = this.groupsFor?.origin === draft.origin && this.groupsFor.clientId === draft.clientId;
    const groups = groupsMatchDraft ? this.groups : typeof this.connection.departmentId === 'number' && this.connection.origin === draft.origin && this.connection.clientId === draft.clientId ? [{ id: this.connection.departmentId, name: `Department ${this.connection.departmentId}` }] : [];
    const detail = this.detail;
    this.root.innerHTML = `
      <style>${styles}${detailStyles}${directoryStyles}${this.mode === 'configuration' ? ':host([data-display-mode="configuration"]) main{max-width:none;margin:0;padding:0}' : ''}</style>
      <main aria-labelledby="${detail || this.detailId !== null ? 'detail-title' : 'title'}">
        ${detail ? renderThreeCxDetail(detail, this.detailTab, this.detailDraft, this.busy, this.statusMessage, this.statusIsError) : this.detailId !== null ? `<section class="threecx-detail" aria-labelledby="detail-title"><button class="secondary compact" id="detail-back" type="button">Back to extensions</button><h2 id="detail-title">Extension details</h2><p class="status" data-status data-error="${this.statusIsError}" aria-live="polite">${escapeHtml(this.statusMessage || 'Loading extension details…')}</p><button class="secondary" id="detail-retry" type="button">Retry</button></section>` : `<header><div><p class="eyebrow">Cloud Command</p><h1 id="title">${showConfiguration && !showDirectory ? 'Connect 3CX' : '3CX extensions'}</h1><p class="subtle">${showConfiguration && !showDirectory ? 'Connect one organization’s 3CX PBX and select its access scope.' : 'Review extensions from the configured 3CX scope.'}</p></div><span class="badge ${connected && connectionEnabled ? 'ok' : connected ? 'disabled' : ''}">${connected ? (connectionEnabled ? 'Connected' : 'Disabled') : 'Not connected'}</span></header>
        <nav aria-label="Cloud Command providers">${showDirectory ? '<button class="secondary compact" id="go-dashboard" type="button">Dashboard</button><button class="secondary compact" id="go-call-log" type="button">Call Log</button>' : ''}${this.microsoftNavigationVisible ? '<button class="secondary compact" id="go-microsoft" type="button">Microsoft 365</button>' : ''}</nav>
        <p class="status" data-status data-error="${this.statusIsError}" aria-live="polite">${escapeHtml(this.statusMessage)}</p>
        ${showConfiguration ? `<section class="card" aria-labelledby="connection-heading">
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
        </section>` : ''}
        ${showDirectory ? `<section class="card" aria-labelledby="extensions-heading">
          <div class="section-title"><div><h2 id="extensions-heading">Extensions</h2><p>Read-only view from the configured 3CX scope.</p></div><button class="secondary" id="refresh-users" type="button" ${!canReadUsers || this.busy ? 'disabled' : ''}>Refresh</button></div>
          ${this.users.length ? `<div class="directory-tools"><label>Search loaded extensions<input id="search-users" type="search" value="${escapeAttr(this.userSearch)}" placeholder="Name, extension, email, or status"></label><span id="search-count" aria-live="polite"></span></div><div class="table-wrap"><table><thead><tr><th>User</th><th>Extension</th><th>Email</th><th>Registration</th><th>Status</th><th>Account</th><th><span class="sr-only">Details</span></th></tr></thead><tbody>${this.users.map((user, index) => `<tr data-user-index="${index}"><td>${escapeHtml([user.FirstName, user.LastName].filter(Boolean).join(' ') || '—')}</td><td>${escapeHtml(user.Number)}</td><td>${escapeHtml(user.EmailAddress || '—')}</td><td>${user.IsRegistered === true ? 'Registered' : user.IsRegistered === false ? 'Unregistered' : 'Unknown'}</td><td>${escapeHtml(user.CurrentProfileName || '—')}</td><td><span class="state ${user.Enabled ? 'on' : ''}">${user.Enabled ? 'Enabled' : 'Disabled'}</span></td><td><button class="secondary compact" type="button" data-detail-index="${index}">View details</button></td></tr>`).join('')}</tbody></table></div><p id="search-empty" class="empty" hidden>No matching extensions in loaded results.</p>${this.nextSkip !== null ? '<p class="hint">Search covers loaded extensions only. Load more to include additional records.</p>' : ''}` : `<div class="empty">${connected ? connectionEnabled ? this.usersLoaded ? 'No extensions found.' : 'No extensions loaded yet.' : 'This connection is disabled.' : 'Save a connection to view extensions.'}</div>`}
          ${this.nextSkip !== null ? `<button class="secondary more" id="more-users" type="button" ${!canReadUsers || this.busy ? 'disabled' : ''}>Load more</button>` : ''}
        </section>` : ''}
        `}
      </main>`;
    this.root.querySelector('#full-pbx')?.addEventListener('change', () => { const select = this.requireInput('departmentId'); select.toggleAttribute('disabled', this.root.querySelector<HTMLInputElement>('#full-pbx')!.checked); });
    this.root.querySelector('#test')?.addEventListener('click', () => void this.testConnection());
    this.root.querySelector('#save')?.addEventListener('click', () => void this.saveConnection());
    this.root.querySelector('#refresh-users')?.addEventListener('click', () => void this.loadUsers(true));
    this.root.querySelector('#more-users')?.addEventListener('click', () => void this.loadUsers(false));
    this.root.querySelector<HTMLInputElement>('#search-users')?.addEventListener('input', (event) => { this.userSearch = (event.currentTarget as HTMLInputElement).value; this.filterLoadedUsers(); });
    this.filterLoadedUsers();
    this.root.querySelector('#go-dashboard')?.addEventListener('click', () => dispatchExtensionHostEvent(this, { version: 1, type: 'navigate', path: '/extensions/cloudcommand/threecx-dashboard' }));
    this.root.querySelector('#go-call-log')?.addEventListener('click', () => dispatchExtensionHostEvent(this, { version: 1, type: 'navigate', path: '/extensions/cloudcommand/threecx-call-log' }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-detail-index]').forEach((button) => button.addEventListener('click', () => this.openDetails(Number(button.dataset.detailIndex))));
    if (detail) bindThreeCxDetail(this.root, { back: () => this.closeDetails(), discard: () => this.discardDetail(), save: () => void this.saveDetail(), tab: (tab) => { this.detailTab = tab; if (this.detailId !== null) window.location.hash = `extension=${this.detailId}&tab=${tab}`; this.render(); }, change: (key, value) => this.changeDetail(key, value) });
    if (detail && this.detailTab === 'forwarding') {
      const scalarDirty = Object.keys(this.detailDraft).some((key) => key !== 'ForwardingProfiles');
      mountForwardingEditors(this.root, detail.forwardingProfiles, this.detailDraft, detail.editable.forwarding, scalarDirty, (profiles) => this.changeForwarding(profiles));
    }
    if (this.busy) this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-detail-field], [data-forwarding-field]').forEach(input => { input.disabled = true; });
    if (detail && hasForwardingChanges(this.detailDraft) && this.detailTab !== 'forwarding') {
      this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-detail-field]').forEach((input) => { input.disabled = true; });
      this.root.querySelector('.detail-panel')?.insertAdjacentHTML('afterbegin', '<p class="readonly-note">Save or discard forwarding changes before editing other settings.</p>');
    }
    if (detail?.notices.length) this.root.querySelector('.detail-panel')?.insertAdjacentHTML('afterbegin', detail.notices.map((notice) => `<p class="readonly-note">${escapeHtml(notice)}</p>`).join(''));
    if (!detail) this.root.querySelector('#detail-back')?.addEventListener('click', () => this.closeDetails());
    this.root.querySelector('#detail-retry')?.addEventListener('click', () => { if (this.detailId !== null) void this.loadDetail(this.detailId); });
    this.root.querySelector('#go-microsoft')?.addEventListener('click', () => dispatchExtensionHostEvent(this, { version: 1, type: 'navigate', path: '/extensions/cloudcommand/microsoft' }));
  }
}

function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!); }
function escapeAttr(value: string): string { return escapeHtml(value); }

const directoryStyles = `.directory-tools{display:flex;align-items:end;gap:1rem;margin-top:.8rem;flex-wrap:wrap}.directory-tools label{min-width:min(100%,18rem)}.directory-tools input{min-height:2.25rem}.directory-tools span{color:hsl(var(--muted-foreground));font-size:.8rem;padding-bottom:.55rem}.table-wrap table{min-width:800px;font-size:.84rem}.table-wrap th,.table-wrap td{padding:.55rem .6rem}.table-wrap tr[hidden],#search-empty[hidden]{display:none}`;

// CSS custom properties inherit through a shadow root. Every colour here is a
// Breeze global token, so light/dark themes and customer appearance settings
// continue to apply without a copied palette.
const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}main{max-width:1100px;margin:0 auto;padding:1.5rem}header,.section-title,.actions,.drawer-header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}h1,h2,p{margin:0}h1{font-size:1.5rem;line-height:2rem;font-weight:600}h2{font-size:1.125rem;line-height:1.75rem;font-weight:600}.eyebrow{color:hsl(var(--primary));font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.subtle,.section-title p,.hint,.optional,.readonly-note{color:hsl(var(--muted-foreground));font-size:.875rem;margin-top:.35rem}.badge,.state{border-radius:999px;padding:.25rem .6rem;background:hsl(var(--muted));font-size:.8rem;font-weight:650;white-space:nowrap}.badge.ok,.state.on{background:hsl(var(--success) / .16);color:hsl(var(--success))}.badge.disabled{background:hsl(var(--warning) / .18);color:hsl(var(--warning-strong))}.card{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);box-shadow:0 1px 2px hsl(var(--foreground) / .04);margin-top:1.25rem;padding:1.25rem}.status{min-height:1.35rem;margin-top:.75rem;color:hsl(var(--muted-foreground));font-size:.9rem}.status[data-error="true"]{color:hsl(var(--destructive))}.fields{display:grid;align-items:start;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;margin-top:1.25rem}label{display:grid;gap:.42rem;font-size:.875rem;font-weight:500}input,select{min-height:2.5rem;width:100%;border:1px solid hsl(var(--input));border-radius:calc(var(--radius,.5rem) - 2px);padding:.5rem .65rem;background:hsl(var(--background));color:inherit;font:inherit;font-weight:400}input:focus,select:focus,button:focus,summary:focus{outline:2px solid hsl(var(--ring));outline-offset:2px}details{margin-top:1.15rem;border-top:1px solid hsl(var(--border));padding-top:1rem}summary{cursor:pointer;font-weight:700}.scope{display:grid;gap:.8rem;margin-top:1rem;max-width:420px}.check{display:flex;align-items:center;gap:.55rem}.check input{height:1rem;width:1rem}.actions{justify-content:flex-end;margin-top:1.25rem}button{border:0;border-radius:calc(var(--radius,.5rem) - 2px);background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer;font:inherit;font-weight:700;min-height:2.5rem;padding:.5rem .85rem}button.secondary{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground))}button.compact{min-height:2rem;padding:.3rem .6rem;font-size:.8rem}button:disabled{cursor:not-allowed;opacity:.6}.table-wrap{overflow:auto;margin-top:1rem}table{color:hsl(var(--foreground));border-collapse:collapse;width:100%;min-width:680px;font-size:.9rem}th,td{border-bottom:1px solid hsl(var(--border));padding:.7rem;text-align:left}th{color:hsl(var(--muted-foreground));font-size:.75rem;letter-spacing:.04em;text-transform:uppercase}.more{margin-top:1rem}.empty{border:1px dashed hsl(var(--border));border-radius:var(--radius,.5rem);color:hsl(var(--muted-foreground));margin-top:1rem;padding:1.5rem;text-align:center}.sr-only{height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute;width:1px;clip:rect(0,0,0,0);white-space:nowrap}.drawer-layer{align-items:stretch;background:hsl(var(--foreground) / .32);display:flex;inset:0;justify-content:flex-end;position:fixed;z-index:20}.drawer{background:hsl(var(--card));box-shadow:-8px 0 24px hsl(var(--foreground) / .16);max-width:min(100%,30rem);overflow:auto;padding:1.5rem;width:100%}.detail-list{display:grid;gap:0;margin:1.5rem 0}.detail-list div{border-bottom:1px solid hsl(var(--border));display:grid;gap:.3rem;padding:.8rem 0}.detail-list dt{color:hsl(var(--muted-foreground));font-size:.78rem;font-weight:700;text-transform:uppercase}.detail-list dd{margin:0;overflow-wrap:anywhere}@media(max-width:600px){main{padding:1rem}header,.section-title{align-items:flex-start;flex-direction:column}.actions{justify-content:stretch}.actions button{flex:1}.drawer{max-width:100%}}`;

if (!customElements.get(ELEMENT)) customElements.define(ELEMENT, CloudCommandThreeCxPage);
