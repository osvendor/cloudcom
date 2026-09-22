import { parseExtensionPageContextV1, type ExtensionPageContextV1 } from '@breeze/extension-web-sdk';

const ELEMENT = 'cloudcommand-microsoft-page';
const RESOURCES = ['users', 'groups', 'licenses', 'sites'] as const;
type Resource = (typeof RESOURCES)[number];
type HostApi = { request(path: string, init?: RequestInit): Promise<Response> };
type Connection = {
  available: boolean;
  connected: boolean;
  canManage: boolean;
  enabled?: boolean;
  tenantId?: string;
  tenantName?: string;
  status?: string;
  reason?: string;
};
type ResourceRow = { id: string; values: Record<string, string | number | boolean | null> };
type ResourceData = {
  items: ResourceRow[];
  columns: Array<{ key: string; label: string }>;
  complete: boolean;
  checkedAt: string;
};
type DetailKind = 'read' | 'user' | 'group';
type UserSecurityAction = 'reset-password' | 'revoke-sessions';
type MicrosoftRecord = Record<string, unknown>;
type UserDraft = Partial<Record<(typeof USER_FIELDS)[number], string>> & { accountEnabled?: boolean };
const USER_FIELDS = ['displayName', 'givenName', 'surname', 'department', 'jobTitle', 'officeLocation'] as const;
const USER_VERIFY_READS = 4;
const USER_VERIFY_DELAY_MS = 1000;

const labels: Record<Resource, string> = {
  users: 'Users',
  groups: 'Groups',
  licenses: 'Licenses',
  sites: 'Sites',
};

export class CloudCommandMicrosoftPage extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private contextValue: ExtensionPageContextV1 | null = null;
  private api: HostApi | null = null;
  private connection: Connection | null = null;
  private resource: Resource = 'users';
  private data: ResourceData | null = null;
  private filter = '';
  private detail: ResourceRow | null = null;
  private detailKind: DetailKind = 'read';
  private detailRecord: MicrosoftRecord | null = null;
  private detailRequest = 0;
  private userVerificationRequest = 0;
  private userSecurityRequest = 0;
  private userSecurityAction: UserSecurityAction | null = null;
  private userSecurityConfirmed = false;
  private temporaryPassword: string | null = null;
  private drawerMessage = '';
  private drawerError = false;
  private membershipUserId = '';
  private membershipAction: 'add' | 'remove' = 'add';
  private membershipConfirmed = false;
  private userDraft: UserDraft = {};
  private visibleColumns: string[] = [];
  private expandedRowId: string | null = null;
  private returnFocus: string | null = null;
  private message = '';
  private error = false;
  private generation = 0;
  private busy = false;
  private resourceRequest = 0;

  set context(input: unknown) {
    const context = parseExtensionPageContextV1(input);
    if (context.extensionName !== 'cloudcommand')
      throw new Error('Cloud Command received the wrong extension context');
    this.contextValue = context;
    this.resetForOrganization();
  }
  get context(): ExtensionPageContextV1 | null {
    return this.contextValue;
  }
  set hostApi(api: HostApi) {
    if (!api || typeof api.request !== 'function')
      throw new Error('Cloud Command requires the host API bridge');
    this.api = api;
    if (this.isConnected && this.contextValue) void this.loadConnection();
  }

  connectedCallback(): void {
    this.resource = this.resourceFromHash();
    window.addEventListener('hashchange', this.onHashChange);
    this.render();
    if (this.contextValue) void this.loadConnection();
  }
  disconnectedCallback(): void {
    window.removeEventListener('hashchange', this.onHashChange);
    this.generation += 1;
    this.userVerificationRequest += 1;
    this.userSecurityRequest += 1;
    this.temporaryPassword = null;
    this.userSecurityAction = null;
  }

  private onHashChange = (): void => {
    const next = this.resourceFromHash();
    if (next !== this.resource) {
      this.resource = next;
      this.data = null;
      this.detail = null;
      this.detailRecord = null;
      this.detailRequest += 1;
      this.userVerificationRequest += 1;
      this.userSecurityRequest += 1;
      this.userSecurityAction = null; this.userSecurityConfirmed = false; this.temporaryPassword = null;
      this.busy = false;
      this.filter = '';
      this.userDraft = {};
      this.expandedRowId = null;
      this.visibleColumns = [];
      this.render();
      if (this.canRead()) void this.loadResource();
    }
  };
  private resourceFromHash(): Resource {
    const value = window.location.hash.slice(1);
    return (RESOURCES as readonly string[]).includes(value) ? (value as Resource) : 'users';
  }
  private setResource(resource: Resource): void {
    window.location.hash = resource;
    if (this.resource === resource) this.onHashChange();
  }
  private resetForOrganization(): void {
    this.generation += 1;
    this.resourceRequest += 1;
    this.busy = false;
    this.connection = null;
    this.data = null;
    this.detail = null;
    this.detailRecord = null;
    this.expandedRowId = null;
    this.visibleColumns = [];
    this.detailRequest += 1;
    this.userVerificationRequest += 1;
    this.userSecurityRequest += 1;
    this.userSecurityAction = null; this.userSecurityConfirmed = false; this.temporaryPassword = null;
    this.drawerMessage = '';
    this.drawerError = false;
    this.membershipUserId = '';
    this.membershipAction = 'add';
    this.membershipConfirmed = false;
    this.userDraft = {};
    this.filter = '';
    this.message = '';
    this.error = false;
    this.render();
    if (this.isConnected && this.api) void this.loadConnection();
  }
  private path(path: string): string {
    if (!this.contextValue) throw new Error('Microsoft integration needs an organization context');
    return `/microsoft${path}`;
  }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.api) throw new Error('The authenticated host API is unavailable.');
    const res = await this.api.request(path, init);
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok)
      throw new Error(
        body && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string'
          ? String((body as Record<string, unknown>).error)
          : 'Microsoft integration request failed.',
      );
    return body as T;
  }
  private setMessage(message: string, error = false): void {
    this.message = message;
    this.error = error;
  }
  private canRead(): boolean {
    return (
      this.connection?.available === true &&
      this.connection.connected === true &&
      this.connection.enabled !== false
    );
  }

  private async loadConnection(): Promise<void> {
    const generation = this.generation;
    const context = this.contextValue;
    try {
      const result = await this.request<Connection>(this.path('/connection'));
      if (generation !== this.generation || context !== this.contextValue) return;
      this.connection = result;
      this.setMessage(result.connected ? '' : (result.reason || 'Connect Microsoft 365 in Extensions > Connect.'));
      this.render();
      if (this.canRead()) void this.loadResource();
    } catch (e) {
      if (generation === this.generation && context === this.contextValue) {
        this.setMessage(e instanceof Error ? e.message : 'Could not load Microsoft connection.', true);
        this.render();
      }
    }
  }
  private async loadResource(): Promise<void> {
    if (!this.canRead()) return;
    const generation = this.generation;
    const resource = this.resource;
    const request = ++this.resourceRequest;
    this.data = null;
    this.detail = null;
    this.setMessage(`Loading ${labels[resource].toLowerCase()}…`);
    this.render();
    try {
      const raw = await this.request<unknown>(this.path(`/resources/${resource}`));
      const data = parseResourceData(raw);
      if (generation !== this.generation || resource !== this.resource || request !== this.resourceRequest)
        return;
      this.data = data;
      this.visibleColumns = this.visibleColumns.filter(key => data.columns.some(column => column.key === key));
      if (!this.visibleColumns.length) this.visibleColumns = data.columns.map(column => column.key);
      this.setMessage(data.items.length ? '' : `No ${labels[resource].toLowerCase()} are available for this tenant.`);
    } catch (e) {
      if (generation === this.generation && resource === this.resource && request === this.resourceRequest)
        this.setMessage(e instanceof Error ? e.message : 'Could not load Microsoft resource.', true);
    } finally {
      if (generation === this.generation && request === this.resourceRequest) this.render();
    }
  }
  private openDetail(row: ResourceRow): void {
    this.busy = false;
    this.detail = row;
    this.detailKind = this.resource === 'users' ? 'user' : this.resource === 'groups' ? 'group' : 'read';
    this.detailRecord = null;
    this.userVerificationRequest += 1;
    this.userSecurityRequest += 1;
    this.userSecurityAction = null; this.userSecurityConfirmed = false; this.temporaryPassword = null;
    this.drawerMessage = '';
    this.drawerError = false;
    this.membershipUserId = '';
    this.membershipAction = 'add';
    this.membershipConfirmed = false;
    this.userDraft = {};
    this.returnFocus = `row-${row.id}`;
    this.render();
    queueMicrotask(() => this.root.querySelector<HTMLButtonElement>('#detail-close')?.focus());
    if (this.detailKind !== 'read') void this.loadDetailRecord(row.id, this.detailKind);
  }
  private closeDetail(): void {
    const id = this.returnFocus;
    this.detail = null;
    this.detailRecord = null;
    this.detailRequest += 1;
    this.userVerificationRequest += 1;
    this.userSecurityRequest += 1;
    this.userSecurityAction = null; this.userSecurityConfirmed = false; this.temporaryPassword = null;
    this.busy = false;
    this.drawerMessage = '';
    this.drawerError = false;
    this.membershipUserId = '';
    this.membershipAction = 'add';
    this.membershipConfirmed = false;
    this.userDraft = {};
    this.render();
    if (id)
      queueMicrotask(() =>
        Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-testid]'))
          .find((button) => button.dataset.testid === id)
          ?.focus(),
      );
  }

  private async loadDetailRecord(id: string, kind: Exclude<DetailKind, 'read'>): Promise<MicrosoftRecord | null> {
    const generation = this.generation;
    const context = this.contextValue;
    const request = ++this.detailRequest;
    try {
      const body = await this.request<unknown>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: `${kind}.get`, id }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.detailRequest || this.detail?.id !== id || this.detailKind !== kind) return null;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`Invalid Microsoft ${kind} response.`);
      this.detailRecord = body as MicrosoftRecord;
      this.userDraft = {};
      this.render();
      queueMicrotask(() => this.root.querySelector<HTMLButtonElement>('#detail-close')?.focus());
      return this.detailRecord;
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && request === this.detailRequest && this.detail?.id === id && this.detailKind === kind) {
        this.drawerError = true;
        this.drawerMessage = error instanceof Error ? error.message : `Could not load Microsoft ${kind}.`;
        this.render();
      }
      return null;
    }
  }

  private userUpdate(): Record<string, string | boolean> | null {
    const update: Record<string, string | boolean> = {};
    for (const field of USER_FIELDS) {
      const input = this.root.querySelector<HTMLInputElement>(`#user-${field}`);
      if (!input) return null;
      update[field] = input.value;
    }
    const enabled = this.root.querySelector<HTMLInputElement>('#user-account-enabled');
    if (!enabled) return null;
    update.accountEnabled = enabled.checked;
    return update;
  }
  private userUpdateHasChanges(update: Record<string, string | boolean>): boolean {
    if (!this.detailRecord) return false;
    return USER_FIELDS.some(field => String(this.detailRecord?.[field] ?? '') !== update[field])
      || (this.detailRecord.accountEnabled === true) !== update.accountEnabled;
  }
  private updateVisibleColumns(key: string): void {
    const columns = this.data?.columns ?? [];
    const identity = columns[0]?.key;
    if (key === identity) return;
    this.visibleColumns = this.visibleColumns.includes(key)
      ? this.visibleColumns.filter(column => column !== key)
      : [...this.visibleColumns, key];
    this.render();
  }
  private resetVisibleColumns(): void {
    this.visibleColumns = this.data?.columns.map(column => column.key) ?? [];
    this.render();
  }
  private rowIdentity(row: ResourceRow, column: { key: string; label: string }): string {
    if (this.resource !== 'users') return esc(String(row.values[column.key] ?? '—'));
    const name = row.values.displayName ?? row.values[column.key] ?? row.id;
    const email = row.values.userPrincipalName ?? row.values.mail;
    return `<strong>${esc(String(name))}</strong>${email && String(email) !== String(name) ? `<span>${esc(String(email))}</span>` : ''}`;
  }
  private formatCheckedAt(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
  private userVerificationIsCurrent(id: string, generation: number, context: ExtensionPageContextV1 | null, request: number): boolean {
    return this.isConnected && generation === this.generation && context === this.contextValue
      && request === this.userVerificationRequest && this.detail?.id === id && this.detailKind === 'user';
  }
  private async readUserForVerification(id: string, generation: number, context: ExtensionPageContextV1 | null, request: number): Promise<MicrosoftRecord | null> {
    const body = await this.request<unknown>(this.path('/administration'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user.get', id }),
    });
    if (!this.userVerificationIsCurrent(id, generation, context, request)) return null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid Microsoft user response.');
    return body as MicrosoftRecord;
  }
  private userMatchesUpdate(user: MicrosoftRecord, update: Record<string, string | boolean>): boolean {
    return USER_FIELDS.every(field => String(user[field] ?? '') === update[field]) && user.accountEnabled === update.accountEnabled;
  }
  private async saveUser(): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'user' || this.busy) return;
    const update = this.userUpdate(); if (!update) return;
    // The security actions in this drawer are independent of profile editing. In
    // particular, clicking Save after a password reset must not issue a redundant
    // PATCH or replace the successful reset notice with an unrelated error.
    if (!this.userUpdateHasChanges(update)) return;
    const id = this.detail.id; const generation = this.generation; const context = this.contextValue; const verification = ++this.userVerificationRequest;
    this.busy = true; this.drawerError = false; this.drawerMessage = 'Saving user changes…'; this.render();
    try {
      const result = await this.request<{ accepted?: boolean }>(this.path('/administration'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user.update', id, update }) });
      if (result.accepted !== true) throw new Error('Microsoft did not accept the user update.');
      if (!this.userVerificationIsCurrent(id, generation, context, verification)) return;
      for (let attempt = 0; attempt < USER_VERIFY_READS; attempt += 1) {
        const readback = await this.readUserForVerification(id, generation, context, verification);
        if (!readback || !this.userVerificationIsCurrent(id, generation, context, verification)) return;
        this.detailRecord = readback;
        if (this.userMatchesUpdate(readback, update)) {
          this.detailRecord = readback;
          const row = this.data?.items.find(item => item.id === id);
          if (row) for (const field of [...USER_FIELDS, 'accountEnabled'] as const) {
            if (field in readback && typeof readback[field] !== 'object') row.values[field] = readback[field] as string | number | boolean | null;
          }
          this.userDraft = {};
          this.drawerError = false; this.drawerMessage = 'User changes saved and verified.'; return;
        }
        if (attempt < USER_VERIFY_READS - 1) await new Promise<void>(resolve => setTimeout(resolve, USER_VERIFY_DELAY_MS));
        if (!this.userVerificationIsCurrent(id, generation, context, verification)) return;
      }
      this.drawerError = true; this.drawerMessage = 'Update was accepted, but the user readback did not confirm every change. Review the current values before trying again.';
    } catch (error) {
      if (this.userVerificationIsCurrent(id, generation, context, verification)) { this.drawerError = true; this.drawerMessage = error instanceof Error ? error.message : 'User update could not be completed. Its outcome is uncertain; do not retry automatically.'; }
    } finally { if (this.userVerificationIsCurrent(id, generation, context, verification)) { this.busy = false; this.render(); } }
  }
  private async performUserSecurityAction(): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'user' || this.busy || !this.userSecurityAction) return;
    if (!this.userSecurityConfirmed) {
      this.drawerError = true; this.drawerMessage = 'Confirm this security action before continuing.'; this.render(); return;
    }
    const id = this.detail.id; const generation = this.generation; const context = this.contextValue;
    const request = ++this.userSecurityRequest; const action = this.userSecurityAction;
    this.temporaryPassword = null; this.busy = true; this.drawerError = false;
    this.drawerMessage = action === 'reset-password' ? 'Resetting password…' : 'Signing out user sessions…'; this.render();
    const current = () => this.isConnected && generation === this.generation && context === this.contextValue
      && request === this.userSecurityRequest && this.detail?.id === id && this.detailKind === 'user';
    try {
      const result = await this.request<{ accepted?: boolean; temporaryPassword?: string; forceChangePasswordNextSignIn?: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: action === 'reset-password' ? 'user.password.reset' : 'user.sessions.revoke', id }),
      });
      if (!current()) return;
      if (result.accepted !== true) throw new Error('Microsoft did not confirm the security action. Refresh before trying again.');
      if (action === 'reset-password') {
        if (typeof result.temporaryPassword !== 'string' || result.forceChangePasswordNextSignIn !== true)
          throw new Error('Microsoft accepted the reset, but the one-time password could not be safely displayed. Do not retry before checking the account.');
        this.temporaryPassword = result.temporaryPassword;
        this.drawerError = false; this.drawerMessage = 'Password reset. Share this temporary password securely; the user must change it at next sign-in.';
      } else {
        this.drawerError = false; this.drawerMessage = 'Sign-out request accepted. Microsoft may take a few minutes to revoke existing sessions.';
      }
      this.userSecurityAction = null; this.userSecurityConfirmed = false;
    } catch (error) {
      if (current()) { this.drawerError = true; this.drawerMessage = error instanceof Error ? error.message : 'Security action outcome is uncertain. Refresh the account before retrying.'; }
    } finally { if (current()) { this.busy = false; this.render(); } }
  }
  private async changeMembership(): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'group' || this.busy) return;
    const userId = this.root.querySelector<HTMLInputElement>('#group-member-user-id')?.value.trim() ?? this.membershipUserId;
    const action = this.root.querySelector<HTMLSelectElement>('#group-member-action')?.value ?? this.membershipAction;
    const confirmed = this.root.querySelector<HTMLInputElement>('#group-member-confirm')?.checked ?? this.membershipConfirmed;
    this.membershipUserId = userId;
    if (action === 'add' || action === 'remove') this.membershipAction = action;
    this.membershipConfirmed = confirmed;
    if (!userId || (action !== 'add' && action !== 'remove') || !confirmed) { this.drawerError = true; this.drawerMessage = 'Enter a user ID and confirm this membership change.'; this.render(); return; }
    const id = this.detail.id; const generation = this.generation; const context = this.contextValue;
    this.busy = true; this.drawerError = false; this.drawerMessage = 'Submitting membership change…'; this.render();
    try {
      const result = await this.request<{ accepted?: boolean }>(this.path('/administration'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: action === 'add' ? 'group.member.add' : 'group.member.remove', groupId: id, userId }) });
      if (result.accepted !== true) throw new Error('Microsoft did not accept the membership change.');
      if (generation !== this.generation || context !== this.contextValue || this.detail?.id !== id || this.detailKind !== 'group') return;
      const readback = await this.loadDetailRecord(id, 'group');
      if (generation !== this.generation || context !== this.contextValue || this.detail?.id !== id || this.detailKind !== 'group') return;
      const members = readback?.members;
      if (Array.isArray(members)) {
        const present = members.some(member => (typeof member === 'string' ? member : member && typeof member === 'object' && String((member as MicrosoftRecord).id ?? '') === userId));
        const verified = action === 'add' ? present : !present;
        this.drawerError = !verified;
        this.drawerMessage = verified ? 'Membership change accepted and verified.' : 'Membership change was accepted, but readback did not confirm it. Review the group before trying again.';
      } else { this.drawerError = false; this.drawerMessage = 'Membership change accepted. Membership verification is pending because member listing is not available.'; }
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && this.detail?.id === id) { this.drawerError = true; this.drawerMessage = error instanceof Error ? error.message : 'Membership change could not be completed. Its outcome is uncertain; do not retry automatically.'; }
    } finally { if (generation === this.generation) { this.busy = false; this.render(); } }
  }

  private renderDrawer(canManage: boolean): string {
    const detail = this.detail!;
    const record = this.detailRecord;
    const feedback = `<p class="drawer-feedback ${this.drawerError ? 'error' : ''}" data-testid="detail-mutation-feedback" role="${this.drawerError ? 'alert' : 'status'}">${esc(this.drawerMessage)}</p>`;
    const userName = String(record?.displayName ?? detail.values.displayName ?? detail.id);
    const userEmail = record?.userPrincipalName ?? detail.values.userPrincipalName ?? detail.values.mail;
    const subtitle = this.detailKind === 'user' ? `${esc(userName)}${userEmail && String(userEmail) !== userName ? ` · ${esc(String(userEmail))}` : ''}` : '';
    let content: string;
    if (this.detailKind === 'read') {
      content = `<div class="drawer-body"><dl>${Object.entries(detail.values).map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(String(value ?? '—'))}</dd></div>`).join('')}</dl></div><footer class="drawer-footer">${feedback}</footer>`;
    } else if (!record) {
      content = `<div class="drawer-body"><p class="subtle">Loading current ${this.detailKind} details…</p></div><footer class="drawer-footer">${feedback}</footer>`;
    } else if (this.detailKind === 'user') {
      const field = (name: typeof USER_FIELDS[number], label: string) => `<label><span>${label}</span><input id="user-${name}" value="${esc(String(this.userDraft[name] ?? record[name] ?? ''))}" ${this.busy || !canManage ? 'disabled' : ''}></label>`;
      const enabled = this.userDraft.accountEnabled ?? record.accountEnabled;
      const securityConfirmation = this.userSecurityAction ? `<div class="security-confirmation" role="group" aria-label="Confirm security action"><p>${this.userSecurityAction === 'reset-password' ? 'Microsoft will set a new temporary password and require the user to change it at next sign-in.' : 'Microsoft will invalidate refresh tokens and browser session cookies. Users may need to sign in again; revocation can take a few minutes.'}</p><label class="check"><input id="user-security-confirm" type="checkbox" ${this.userSecurityConfirmed ? 'checked' : ''} ${this.busy ? 'disabled' : ''}> I confirm this security action</label><div class="actions"><button class="secondary" id="user-security-cancel" ${this.busy ? 'disabled' : ''}>Cancel</button><button id="user-security-submit" ${this.busy ? 'disabled' : ''}>${this.userSecurityAction === 'reset-password' ? 'Reset password' : 'Sign out all sessions'}</button></div></div>` : '';
      const passwordDisplay = this.temporaryPassword ? `<div class="one-time-secret" role="status"><strong>Temporary password</strong><code id="temporary-password">${esc(this.temporaryPassword)}</code><p>It is shown only in this drawer. Copy it now; closing the drawer clears it.</p><button class="secondary compact" id="copy-temporary-password">Copy password</button><button class="secondary compact" id="hide-temporary-password">Hide password</button></div>` : '';
      content = `<div class="drawer-body"><p class="meta">User ID: ${esc(detail.id)}</p><section class="drawer-section"><h3>Profile</h3><div class="field-grid">${field('displayName', 'Display name')}${field('givenName', 'Given name')}${field('surname', 'Surname')}${field('department', 'Department')}${field('jobTitle', 'Job title')}${field('officeLocation', 'Office location')}</div></section><section class="drawer-section"><h3>Account access</h3><label class="check"><input id="user-account-enabled" type="checkbox" ${enabled === true ? 'checked' : ''} ${this.busy || !canManage ? 'disabled' : ''}> Account enabled</label></section>${canManage ? `<section class="drawer-section"><h3>Security</h3><div class="actions"><button class="secondary" id="user-password-reset-start" ${this.busy ? 'disabled' : ''}>Reset password</button><button class="secondary" id="user-sessions-revoke-start" ${this.busy ? 'disabled' : ''}>Sign out of all sessions</button></div>${securityConfirmation}${passwordDisplay}</section>` : ''}</div>${canManage ? `<footer class="drawer-footer"><div class="actions"><button id="user-save" ${this.busy ? 'disabled' : ''}>Save profile changes</button></div>${feedback}</footer>` : `<footer class="drawer-footer"><p class="read-only">An organization administrator can edit this user.</p>${feedback}</footer>`}`;
    } else {
      content = `<div class="drawer-body"><p class="meta">Group ID: ${esc(detail.id)}</p><p class="meta">${record.displayName ? `Group: ${esc(String(record.displayName))}` : 'Group details loaded.'}</p>${canManage ? `<label>Member user ID<input id="group-member-user-id" value="${esc(this.membershipUserId)}" autocomplete="off" ${this.busy ? 'disabled' : ''}></label><label>Membership action<select id="group-member-action" ${this.busy ? 'disabled' : ''}><option value="add" ${this.membershipAction === 'add' ? 'selected' : ''}>Add member</option><option value="remove" ${this.membershipAction === 'remove' ? 'selected' : ''}>Remove member</option></select></label><label class="check"><input id="group-member-confirm" type="checkbox" ${this.membershipConfirmed ? 'checked' : ''} ${this.busy ? 'disabled' : ''}> I confirm this membership change</label>` : '<p class="read-only">An organization administrator can change group membership.</p>'}</div><footer class="drawer-footer">${canManage ? `<div class="actions"><button id="group-member-submit" ${this.busy ? 'disabled' : ''}>Confirm membership change</button></div>` : ''}${feedback}</footer>`;
    }
    const title = this.detailKind === 'user' ? (canManage ? 'Edit account' : 'View account') : this.detailKind === 'group' ? 'Manage members' : 'Resource details';
    return `<div class="backdrop" data-backdrop><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title"><div class="heading drawer-heading"><div><h2 id="detail-title">${title}</h2>${subtitle ? `<p class="subtle">${subtitle}</p>` : ''}</div><button class="secondary compact" id="detail-close">Close</button></div>${content}</aside></div>`;
  }

  private render(): void {
    const connection = this.connection;
    const canManage = connection?.canManage === true;
    const canRead = this.canRead();
    const filtered = this.data?.items.filter(row => JSON.stringify(row.values).toLowerCase().includes(this.filter.toLowerCase())) ?? [];
    const columns = this.data?.columns.filter((column, index) => (index === 0 || this.visibleColumns.includes(column.key)) && !(this.resource === 'users' && column.key === 'userPrincipalName')) ?? [];
    const loadedCount = this.data ? `${this.data.items.length}${this.data.complete ? '' : ' loaded'}` : '—';
    const tenant = connection?.tenantName || 'Microsoft 365 tenant';
    const tabs = (['users', 'groups', 'licenses'] as const).map(resource => `<button data-resource="${resource}" role="tab" aria-selected="${this.resource === resource}" class="resource-tab" ${!canRead ? 'disabled' : ''}>${labels[resource]}</button>`).join('');
    const chips = this.data ? `<div class="column-tools"><span>Columns</span>${this.data.columns.filter(column => !(this.resource === 'users' && column.key === 'userPrincipalName')).map((column, index) => `<button class="column-chip" data-column="${esc(column.key)}" aria-pressed="${index === 0 || this.visibleColumns.includes(column.key)}" ${index === 0 ? 'disabled' : ''}>${esc(column.label)}</button>`).join('')}<button class="secondary compact" id="reset-columns">Reset</button></div>` : '';
    const rows = filtered.map(row => {
      const expanded = this.expandedRowId === row.id;
      const cells = columns.map((column, index) => `<td class="${index === 0 ? 'identity' : ''}">${index === 0 ? this.rowIdentity(row, column) : typeof row.values[column.key] === 'boolean' ? `<span class="state ${row.values[column.key] ? 'on' : ''}">${row.values[column.key] ? 'Enabled' : 'Disabled'}</span>` : esc(String(row.values[column.key] ?? '—'))}</td>`).join('');
      const action = this.resource === 'users' ? `<button class="secondary compact" data-testid="row-${esc(row.id)}" data-expand="${esc(row.id)}" aria-expanded="${expanded}">${canManage ? 'Account' : 'View account'} <span aria-hidden="true">${expanded ? '⌃' : '⌄'}</span></button>` : `<button class="secondary compact" data-testid="row-${esc(row.id)}" data-detail="${esc(row.id)}">${this.resource === 'groups' ? 'Manage members' : 'View details'}</button>`;
      const expandedRow = this.resource === 'users' && expanded ? `<tr class="row-actions"><td colspan="${columns.length + 1}"><div><span>Account</span><button class="secondary compact" data-detail="${esc(row.id)}">${canManage ? 'Edit account' : 'View account'}</button></div></td></tr>` : '';
      return `<tr class="${this.detail?.id === row.id || expanded ? 'selected-row' : ''}">${cells}<td class="row-control">${action}</td></tr>${expandedRow}`;
    }).join('');
    const inventory = !canRead ? `<div class="empty">${connection?.connected && connection.enabled === false ? 'Enable this connection before loading inventory.' : 'Connect Microsoft 365 in Extensions > Connect before loading inventory.'}</div>` : !this.data ? `<div class="empty">${this.error ? `Could not load ${labels[this.resource].toLowerCase()}. Use Refresh to try again.` : `Loading current ${labels[this.resource].toLowerCase()}…`}</div>` : !filtered.length ? `<div class="empty">${this.filter ? 'No rows match this search.' : `No ${labels[this.resource].toLowerCase()} are available for this tenant.`}</div>` : `<div class="table-wrap"><table><thead><tr>${columns.map(column => `<th>${esc(column.label)}</th>`).join('')}<th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    this.root.innerHTML = `<style>${styles}</style><main><header><div><p class="eyebrow">Microsoft 365</p><h1>Directory</h1><p class="subtle">${esc(tenant)} · ${labels[this.resource]}: ${loadedCount}</p></div><span class="badge ${canRead ? 'ok' : ''}">${connection?.available === false ? 'Unavailable' : connection?.connected ? (connection.enabled === false ? 'Disabled' : 'Connected') : 'Not configured'}</span></header>${this.message ? `<p class="status" data-testid="status" data-error="${this.error}" aria-live="polite">${esc(this.message)}</p>` : '<p class="status" data-testid="status" aria-live="polite"></p>'}<section class="directory"><div class="directory-top">${canRead ? `<label class="filter"><span class="sr-only">Search ${labels[this.resource]}</span><input id="filter" data-testid="filter" value="${esc(this.filter)}" placeholder="${this.resource === 'users' ? 'Search name or email' : `Search ${labels[this.resource].toLowerCase()}`}"></label>` : ''}<nav class="resource-nav" role="tablist" aria-label="Microsoft directory resources">${tabs}</nav><button class="secondary compact" id="refresh-resource" ${!canRead ? 'disabled' : ''}>Refresh</button></div>${canRead ? `${chips}${this.data ? `<p class="meta">${this.data.complete ? 'Complete inventory' : 'Partial inventory'} · checked ${esc(this.formatCheckedAt(this.data.checkedAt))}</p>` : ''}${inventory}` : inventory}</section>${this.detail ? this.renderDrawer(canManage) : ''}</main>`;
    this.root.querySelector('#refresh-resource')?.addEventListener('click', () => void this.loadResource());
    this.root
      .querySelectorAll<HTMLButtonElement>('[data-resource]')
      .forEach((button) =>
        button.addEventListener('click', () => this.setResource(button.dataset.resource as Resource)),
      );
    this.root.querySelectorAll<HTMLButtonElement>('[data-column]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.column!;
      this.updateVisibleColumns(key);
      queueMicrotask(() => Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-column]')).find(next => next.dataset.column === key)?.focus());
    }));
    this.root.querySelector('#reset-columns')?.addEventListener('click', () => {
      this.resetVisibleColumns();
      queueMicrotask(() => this.root.querySelector<HTMLButtonElement>('#reset-columns')?.focus());
    });
    this.root.querySelector<HTMLInputElement>('#filter')?.addEventListener('input', (event) => {
      const input = event.target as HTMLInputElement;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      this.filter = input.value;
      this.render();
      queueMicrotask(() => {
        const next = this.root.querySelector<HTMLInputElement>('#filter');
        next?.focus();
        if (start !== null && end !== null) next?.setSelectionRange(start, end);
      });
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-expand]').forEach(button => button.addEventListener('click', () => {
      const id = button.dataset.expand!;
      this.expandedRowId = this.expandedRowId === id ? null : id;
      this.render();
      queueMicrotask(() => Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-expand]')).find(next => next.dataset.expand === id)?.focus());
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-detail]').forEach((button) =>
      button.addEventListener('click', () => {
        const row = this.data?.items.find((item) => item.id === button.dataset.detail);
        if (row) this.openDetail(row);
      }),
    );
    this.root.querySelector('#detail-close')?.addEventListener('click', () => this.closeDetail());
    this.root.querySelector('#user-save')?.addEventListener('click', () => void this.saveUser());
    this.root.querySelector('#user-password-reset-start')?.addEventListener('click', () => { this.userSecurityAction = 'reset-password'; this.userSecurityConfirmed = false; this.temporaryPassword = null; this.drawerError = false; this.drawerMessage = ''; this.render(); this.root.querySelector<HTMLInputElement>('#user-security-confirm')?.focus(); });
    this.root.querySelector('#user-sessions-revoke-start')?.addEventListener('click', () => { this.userSecurityAction = 'revoke-sessions'; this.userSecurityConfirmed = false; this.temporaryPassword = null; this.drawerError = false; this.drawerMessage = ''; this.render(); this.root.querySelector<HTMLInputElement>('#user-security-confirm')?.focus(); });
    this.root.querySelector<HTMLInputElement>('#user-security-confirm')?.addEventListener('change', event => { this.userSecurityConfirmed = (event.target as HTMLInputElement).checked; });
    this.root.querySelector('#user-security-cancel')?.addEventListener('click', () => { this.userSecurityRequest += 1; this.userSecurityAction = null; this.userSecurityConfirmed = false; this.drawerError = false; this.drawerMessage = ''; this.render(); });
    this.root.querySelector('#user-security-submit')?.addEventListener('click', () => void this.performUserSecurityAction());
    this.root.querySelector('#hide-temporary-password')?.addEventListener('click', () => { this.temporaryPassword = null; this.render(); });
    this.root.querySelector('#copy-temporary-password')?.addEventListener('click', () => {
      if (!this.temporaryPassword) return;
      if (!navigator.clipboard?.writeText) { this.drawerError = true; this.drawerMessage = 'Clipboard access is unavailable. Select the temporary password to copy it manually.'; this.render(); return; }
      void navigator.clipboard.writeText(this.temporaryPassword).then(() => { this.drawerError = false; this.drawerMessage = 'Temporary password copied. Share it securely.'; this.render(); }).catch(() => { this.drawerError = true; this.drawerMessage = 'Clipboard access failed. Select the temporary password to copy it manually.'; this.render(); });
    });
    this.root.querySelectorAll<HTMLInputElement>('[id^="user-"]').forEach(input => input.addEventListener('input', () => {
      const field = input.id.slice('user-'.length) as typeof USER_FIELDS[number];
      if ((USER_FIELDS as readonly string[]).includes(field)) this.userDraft[field] = input.value;
    }));
    this.root.querySelector('#user-account-enabled')?.addEventListener('change', event => {
      this.userDraft.accountEnabled = (event.target as HTMLInputElement).checked;
    });
    this.root.querySelector<HTMLInputElement>('#group-member-user-id')?.addEventListener('input', event => {
      this.membershipUserId = (event.target as HTMLInputElement).value;
    });
    this.root.querySelector<HTMLSelectElement>('#group-member-action')?.addEventListener('change', event => {
      const action = (event.target as HTMLSelectElement).value;
      if (action === 'add' || action === 'remove') this.membershipAction = action;
    });
    this.root.querySelector<HTMLInputElement>('#group-member-confirm')?.addEventListener('change', event => {
      this.membershipConfirmed = (event.target as HTMLInputElement).checked;
    });
    this.root.querySelector('#group-member-submit')?.addEventListener('click', () => void this.changeMembership());
    this.root.querySelector('[data-backdrop]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) this.closeDetail();
    });
    this.root.querySelector<HTMLElement>('[role="dialog"]')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeDetail();
      } else if (event.key === 'Tab') {
        const focusable = Array.from(this.root.querySelectorAll<HTMLElement>('[role="dialog"] button:not(:disabled),[role="dialog"] input:not(:disabled),[role="dialog"] select:not(:disabled)'));
        const index = focusable.indexOf(this.root.activeElement as HTMLElement);
        const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index === focusable.length - 1 ? 0 : index + 1);
        if (focusable.length && (index === -1 || next !== index + (event.shiftKey ? -1 : 1))) { event.preventDefault(); focusable[next]?.focus(); }
      }
    });
  }
}

function esc(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!,
  );
}
function parseResourceData(input: unknown): ResourceData {
  if (!input || typeof input !== 'object') throw new Error('Invalid Microsoft resource response.');
  const value = input as Record<string, unknown>;
  if (
    !Array.isArray(value.items) ||
    !Array.isArray(value.columns) ||
    typeof value.complete !== 'boolean' ||
    typeof value.checkedAt !== 'string'
  )
    throw new Error('Invalid Microsoft resource response.');
  if (
    !value.items.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).id === 'string' &&
        (item as Record<string, unknown>).values &&
        typeof (item as Record<string, unknown>).values === 'object',
    ) ||
    !value.columns.every(
      (column) =>
        column &&
        typeof column === 'object' &&
        typeof (column as Record<string, unknown>).key === 'string' &&
        typeof (column as Record<string, unknown>).label === 'string',
    )
  )
    throw new Error('Invalid Microsoft resource response.');
  return value as unknown as ResourceData;
}
const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}main{max-width:1200px;margin:auto;padding:1.5rem}header,.directory-top,.heading,.actions{align-items:flex-start;display:flex;gap:1rem;justify-content:space-between}h1,h2,h3,p{margin:0}h1{font-size:1.55rem}h2{font-size:1.1rem}h3{font-size:.9rem}.eyebrow{color:hsl(var(--primary));font-size:.75rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.subtle,.read-only,.meta{color:hsl(var(--muted-foreground));font-size:.875rem;margin-top:.35rem}.status{color:hsl(var(--muted-foreground));min-height:1.4rem;margin-top:.75rem}.status:empty{display:none}.status[data-error="true"],.drawer-feedback.error{color:hsl(var(--destructive))}.badge,.state{background:hsl(var(--muted));border-radius:999px;font-size:.8rem;font-weight:700;padding:.25rem .6rem}.badge.ok,.state.on{background:hsl(var(--success) / .16);color:hsl(var(--success))}.directory{border-top:1px solid hsl(var(--border));margin-top:1.25rem;padding-top:.8rem}.resource-nav{display:flex;gap:.15rem}.resource-tab{background:transparent;border-radius:0;color:hsl(var(--muted-foreground));min-height:2.45rem;padding:.45rem .8rem}.resource-tab[aria-selected="true"]{border-bottom:2px solid hsl(var(--primary));color:hsl(var(--foreground))}label{display:grid;gap:.4rem;font-size:.875rem;font-weight:600;margin-top:1rem}select,input{background:hsl(var(--background));border:1px solid hsl(var(--input));border-radius:calc(var(--radius,.5rem) - 2px);color:inherit;font:inherit;min-height:2.5rem;padding:.5rem .65rem}.filter{margin:0;flex:1;max-width:420px;min-width:180px}.directory-top{align-items:center;flex-wrap:wrap}.directory-top .resource-nav{margin-right:auto}.column-tools{align-items:center;display:flex;flex-wrap:wrap;gap:.4rem;margin-top:1rem}.column-tools>span{color:hsl(var(--muted-foreground));font-size:.8rem;font-weight:700;margin-right:.15rem}.column-chip{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground));font-size:.78rem;min-height:2rem;padding:.25rem .55rem}.column-chip[aria-pressed="false"]{background:transparent;border:1px solid hsl(var(--border));color:hsl(var(--muted-foreground))}.check{align-items:center;display:flex;gap:.5rem}.check input{min-height:auto;width:1rem}.actions{justify-content:flex-end;margin-top:1rem}button{background:hsl(var(--primary));border:0;border-radius:calc(var(--radius,.5rem) - 2px);color:hsl(var(--primary-foreground));cursor:pointer;font:inherit;font-weight:700;min-height:2.5rem;padding:.5rem .85rem}button.secondary{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground))}button.compact{font-size:.8rem;min-height:2rem;padding:.3rem .6rem}button:disabled{cursor:not-allowed;opacity:.6}button:focus,input:focus,select:focus{outline:2px solid hsl(var(--ring));outline-offset:2px}.table-wrap{margin-top:1rem;overflow:auto}table{border-collapse:collapse;color:hsl(var(--foreground));min-width:700px;width:100%}th,td{border-bottom:1px solid hsl(var(--border));padding:.75rem;text-align:left;vertical-align:middle}th{color:hsl(var(--muted-foreground));font-size:.75rem;text-transform:uppercase}.identity strong,.identity span{display:block}.identity span{color:hsl(var(--muted-foreground));font-size:.84rem;margin-top:.15rem}.row-control{text-align:right}.selected-row td{background:hsl(var(--accent) / .42)}.row-actions td{background:hsl(var(--accent) / .28)}.row-actions td>div{align-items:center;display:flex;gap:.7rem}.empty{border:1px dashed hsl(var(--border));border-radius:var(--radius,.5rem);color:hsl(var(--muted-foreground));margin-top:1rem;padding:1.25rem;text-align:center}.sr-only{clip:rect(0,0,0,0);height:1px;margin:-1px;overflow:hidden;position:absolute;width:1px}.backdrop{background:hsl(var(--background) / .64);display:flex;inset:0;justify-content:flex-end;position:fixed;z-index:20}.drawer{background:hsl(var(--card));box-shadow:-8px 0 24px hsl(var(--foreground) / .16);display:flex;flex-direction:column;height:100%;max-width:min(100%,40rem);width:100%}.drawer-heading{border-bottom:1px solid hsl(var(--border));flex:0 0 auto;padding:1.25rem 1.5rem}.drawer-body{flex:1;min-height:0;overflow:auto;padding:1.25rem 1.5rem}.drawer-section{margin-top:1.25rem}.security-confirmation,.one-time-secret{background:hsl(var(--muted) / .28);border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);margin-top:1rem;padding:1rem}.security-confirmation p,.one-time-secret p{color:hsl(var(--muted-foreground));margin-bottom:.75rem}.one-time-secret code{display:block;background:hsl(var(--background));border-radius:.35rem;font-size:1rem;margin:.5rem 0;overflow-wrap:anywhere;padding:.65rem;user-select:all}.field-grid{display:grid;gap:.85rem;grid-template-columns:1fr}.field-grid label{align-items:center;display:grid;grid-template-columns:140px minmax(0,1fr);margin:0}.drawer-footer{border-top:1px solid hsl(var(--border));flex:0 0 auto;padding:1rem 1.5rem}.drawer-footer .actions{margin-top:0}.drawer-feedback{margin-top:.75rem;min-height:1.4rem}dl{margin:0}dl div{border-bottom:1px solid hsl(var(--border));padding:.75rem 0}dt{color:hsl(var(--muted-foreground));font-size:.75rem;font-weight:700}dd{margin:.25rem 0 0;overflow-wrap:anywhere}@media(max-width:600px){main{padding:1rem}.directory-top,.heading{flex-direction:column}.field-grid label{align-items:stretch;grid-template-columns:1fr}.drawer-heading{padding:1rem}.drawer-body,.drawer-footer{padding-left:1rem;padding-right:1rem}}`;
if (!customElements.get(ELEMENT)) customElements.define(ELEMENT, CloudCommandMicrosoftPage);
