import {
  dispatchExtensionHostEvent,
  parseExtensionPageContextV1,
  type ExtensionPageContextV1,
} from '@breeze/extension-web-sdk';

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
type ThreeCxNavigationStatus = { connected: boolean; canManage?: boolean; enabled?: boolean };
type ResourceRow = { id: string; values: Record<string, string | number | boolean | null> };
type ResourceData = {
  items: ResourceRow[];
  columns: Array<{ key: string; label: string }>;
  complete: boolean;
  checkedAt: string;
};
type DetailKind = 'read' | 'user' | 'group';
type MicrosoftRecord = Record<string, unknown>;
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
  private drawerMessage = '';
  private drawerError = false;
  private membershipUserId = '';
  private membershipAction: 'add' | 'remove' = 'add';
  private membershipConfirmed = false;
  private returnFocus: string | null = null;
  private message = '';
  private error = false;
  private generation = 0;
  private busy = false;
  private resourceRequest = 0;
  private threeCxNavigationVisible = false;

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
  }

  private onHashChange = (): void => {
    const next = this.resourceFromHash();
    if (next !== this.resource) {
      this.resource = next;
      this.data = null;
      this.detail = null;
      this.userVerificationRequest += 1;
      this.busy = false;
      this.filter = '';
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
    this.threeCxNavigationVisible = false;
    this.data = null;
    this.detail = null;
    this.detailRecord = null;
    this.detailRequest += 1;
    this.userVerificationRequest += 1;
    this.drawerMessage = '';
    this.drawerError = false;
    this.membershipUserId = '';
    this.membershipAction = 'add';
    this.membershipConfirmed = false;
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
      this.setMessage(result.reason || (result.connected ? 'Microsoft connection loaded.' : 'Connect Microsoft 365 in Extensions > Connect.'));
      this.render();
      void this.loadThreeCxNavigation(generation, context);
      if (this.canRead()) void this.loadResource();
    } catch (e) {
      if (generation === this.generation && context === this.contextValue) {
        this.setMessage(e instanceof Error ? e.message : 'Could not load Microsoft connection.', true);
        this.render();
      }
    }
  }
  private async loadThreeCxNavigation(
    generation: number,
    context: ExtensionPageContextV1 | null,
  ): Promise<void> {
    try {
      const status = await this.request<ThreeCxNavigationStatus>('/threecx/connection');
      if (generation !== this.generation || context !== this.contextValue) return;
      this.threeCxNavigationVisible =
        (status.connected === true && status.enabled === true) || status.canManage === true;
      this.render();
    } catch {
      if (generation !== this.generation || context !== this.contextValue) return;
      this.threeCxNavigationVisible = false;
      this.render();
    }
  }
  private async loadResource(): Promise<void> {
    if (!this.canRead()) return;
    const generation = this.generation;
    const resource = this.resource;
    const request = ++this.resourceRequest;
    this.data = null;
    this.detail = null;
    this.render();
    try {
      const raw = await this.request<unknown>(this.path(`/resources/${resource}`));
      const data = parseResourceData(raw);
      if (generation !== this.generation || resource !== this.resource || request !== this.resourceRequest)
        return;
      this.data = data;
      this.setMessage(
        data.items.length
          ? `${labels[resource]} loaded.`
          : `No ${labels[resource].toLowerCase()} are available for this tenant.`,
      );
    } catch (e) {
      if (generation === this.generation && resource === this.resource && request === this.resourceRequest)
        this.setMessage(e instanceof Error ? e.message : 'Could not load Microsoft resource.', true);
    } finally {
      if (generation === this.generation && request === this.resourceRequest) this.render();
    }
  }
  private async run(action: () => Promise<void>, fallback: string): Promise<void> {
    if (this.busy) return;
    const generation = this.generation;
    this.busy = true;
    this.render();
    try {
      await action();
    } catch (e) {
      if (generation === this.generation) this.setMessage(e instanceof Error ? e.message : fallback, true);
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.render();
      }
    }
  }
  private navigate(path: string): void {
    dispatchExtensionHostEvent(this, { version: 1, type: 'navigate', path });
  }
  private openDetail(row: ResourceRow): void {
    this.busy = false;
    this.detail = row;
    this.detailKind = this.resource === 'users' ? 'user' : this.resource === 'groups' ? 'group' : 'read';
    this.detailRecord = null;
    this.userVerificationRequest += 1;
    this.drawerMessage = '';
    this.drawerError = false;
    this.membershipUserId = '';
    this.membershipAction = 'add';
    this.membershipConfirmed = false;
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
    this.busy = false;
    this.drawerMessage = '';
    this.drawerError = false;
    this.membershipUserId = '';
    this.membershipAction = 'add';
    this.membershipConfirmed = false;
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
      this.render();
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
        if (this.userMatchesUpdate(readback, update)) { this.drawerError = false; this.drawerMessage = 'User changes saved and verified.'; return; }
        if (attempt < USER_VERIFY_READS - 1) await new Promise<void>(resolve => setTimeout(resolve, USER_VERIFY_DELAY_MS));
        if (!this.userVerificationIsCurrent(id, generation, context, verification)) return;
      }
      this.drawerError = true; this.drawerMessage = 'Update was accepted, but the user readback did not confirm every change. Review the current values before trying again.';
    } catch (error) {
      if (this.userVerificationIsCurrent(id, generation, context, verification)) { this.drawerError = true; this.drawerMessage = error instanceof Error ? error.message : 'User update could not be completed. Its outcome is uncertain; do not retry automatically.'; }
    } finally { if (this.userVerificationIsCurrent(id, generation, context, verification)) { this.busy = false; this.render(); } }
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
    let content: string;
    if (this.detailKind === 'read') {
      content = `<dl>${Object.entries(detail.values).map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(String(value ?? '—'))}</dd></div>`).join('')}</dl>`;
    } else if (!record) {
      content = `<p class="subtle">Loading current ${this.detailKind} details…</p>${feedback}`;
    } else if (this.detailKind === 'user') {
      const field = (name: typeof USER_FIELDS[number], label: string) => `<label>${label}<input id="user-${name}" value="${esc(String(record[name] ?? ''))}" ${this.busy || !canManage ? 'disabled' : ''}></label>`;
      content = `<p class="meta">User ID: ${esc(detail.id)}</p>${field('displayName', 'Display name')}${field('givenName', 'Given name')}${field('surname', 'Surname')}${field('department', 'Department')}${field('jobTitle', 'Job title')}${field('officeLocation', 'Office location')}<label class="check"><input id="user-account-enabled" type="checkbox" ${record.accountEnabled === true ? 'checked' : ''} ${this.busy || !canManage ? 'disabled' : ''}> Account enabled</label>${canManage ? `<div class="actions"><button id="user-save" ${this.busy ? 'disabled' : ''}>Save and verify user</button></div>` : '<p class="read-only">An organization administrator can edit this user.</p>'}${feedback}`;
    } else {
      content = `<p class="meta">Group ID: ${esc(detail.id)}</p><p class="meta">${record.displayName ? `Group: ${esc(String(record.displayName))}` : 'Group details loaded.'}</p>${canManage ? `<label>Member user ID<input id="group-member-user-id" value="${esc(this.membershipUserId)}" autocomplete="off" ${this.busy ? 'disabled' : ''}></label><label>Membership action<select id="group-member-action" ${this.busy ? 'disabled' : ''}><option value="add" ${this.membershipAction === 'add' ? 'selected' : ''}>Add member</option><option value="remove" ${this.membershipAction === 'remove' ? 'selected' : ''}>Remove member</option></select></label><label class="check"><input id="group-member-confirm" type="checkbox" ${this.membershipConfirmed ? 'checked' : ''} ${this.busy ? 'disabled' : ''}> I confirm this membership change</label><div class="actions"><button id="group-member-submit" ${this.busy ? 'disabled' : ''}>Confirm membership change</button></div>` : '<p class="read-only">An organization administrator can change group membership.</p>'}${feedback}`;
    }
    return `<div class="backdrop" data-backdrop><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title"><div class="heading"><h2 id="detail-title">${this.detailKind === 'user' ? 'Edit user' : this.detailKind === 'group' ? 'Group membership' : 'Resource details'}</h2><button class="secondary compact" id="detail-close">Close</button></div>${content}</aside></div>`;
  }

  private render(): void {
    const connection = this.connection;
    const canManage = connection?.canManage === true;
    const canRead = this.canRead();
    const filtered =
      this.data?.items.filter((row) =>
        JSON.stringify(row.values).toLowerCase().includes(this.filter.toLowerCase()),
      ) ?? [];
    this.root.innerHTML = `<style>${styles}</style><main><header><div><p class="eyebrow">Cloud Command</p><h1>Microsoft 365</h1><p class="subtle">${canManage ? 'Manage supported Microsoft users and group membership for this organization.' : 'Read-only Microsoft tenant inventory for this organization.'}</p></div><span class="badge ${canRead ? 'ok' : ''}">${connection?.available === false ? 'Unavailable' : connection?.connected ? (connection.enabled === false ? 'Disabled' : 'Connected') : 'Not configured'}</span></header><p class="status" data-testid="status" data-error="${this.error}" aria-live="polite">${esc(this.message)}</p><nav aria-label="Cloud Command providers">${this.threeCxNavigationVisible ? '<button class="secondary compact" data-testid="go-threecx">3CX</button>' : ''}<button class="secondary compact" data-testid="go-microsoft">Microsoft 365</button></nav><section class="card"><div class="heading"><div><h2>${connection?.available === false ? 'Provider unavailable' : 'Microsoft connection'}</h2><p class="subtle">${esc(connection?.reason || (connection?.connected ? `Connected${connection.tenantName ? ` to ${connection.tenantName}` : ''}.` : 'Connect Microsoft 365 in Extensions > Connect to enable inventory.'))}</p>${connection?.status ? `<p class="meta">Status: ${esc(connection.status)}</p>` : ''}</div>${canManage ? '<a class="setup-link" id="setup-integrations" href="/extensions/cloudcommand/connect#microsoft">Open Connect</a>' : ''}</div></section><section class="card"><div class="heading"><div><h2>Directory and service inventory</h2><p class="subtle">Only the available read resources are shown.</p></div><button class="secondary compact" id="refresh-resource" ${!canRead ? 'disabled' : ''}>Refresh</button></div><div class="resource-nav"><span>Identity</span><button data-resource="users" class="secondary compact ${this.resource === 'users' ? 'selected' : ''}" ${!canRead ? 'disabled' : ''}>Users</button><button data-resource="groups" class="secondary compact ${this.resource === 'groups' ? 'selected' : ''}" ${!canRead ? 'disabled' : ''}>Groups</button><span>Tenant</span><button data-resource="licenses" class="secondary compact ${this.resource === 'licenses' ? 'selected' : ''}" ${!canRead ? 'disabled' : ''}>Licenses</button><span>Teams &amp; SharePoint</span><button data-resource="sites" class="secondary compact ${this.resource === 'sites' ? 'selected' : ''}" ${!canRead ? 'disabled' : ''}>Sites</button></div>${canRead ? `<label class="filter">Filter ${labels[this.resource]}<input id="filter" data-testid="filter" value="${esc(this.filter)}" placeholder="Filter loaded rows"></label>${this.data ? `<p class="meta">${this.data.complete ? 'Complete' : 'Partial'} · checked ${esc(this.data.checkedAt)}</p>${filtered.length ? `<div class="table-wrap"><table><thead><tr>${this.data.columns.map((column) => `<th>${esc(column.label)}</th>`).join('')}<th><span class="sr-only">Details</span></th></tr></thead><tbody>${filtered.map((row) => `<tr>${this.data!.columns.map((column) => `<td>${esc(String(row.values[column.key] ?? '—'))}</td>`).join('')}<td><button class="secondary compact" data-testid="row-${esc(row.id)}" data-detail="${esc(row.id)}">View details</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No rows match this filter.</div>'}` : '<div class="empty">Select a resource to load its current read-only inventory.</div>'}` : `<div class="empty">${connection?.connected && connection.enabled === false ? 'Enable this connection before loading inventory.' : 'Connect Microsoft 365 in Extensions > Connect before loading inventory.'}</div>`}</section>${
      this.detail ? this.renderDrawer(canManage) : ''
    }</main>`;
    this.root
      .querySelector('[data-testid="go-threecx"]')
      ?.addEventListener('click', () => this.navigate('/extensions/cloudcommand/threecx'));
    this.root
      .querySelector('[data-testid="go-microsoft"]')
      ?.addEventListener('click', () => this.navigate('/extensions/cloudcommand/microsoft'));
    this.root.querySelector('#refresh-resource')?.addEventListener('click', () => void this.loadResource());
    this.root
      .querySelectorAll<HTMLButtonElement>('[data-resource]')
      .forEach((button) =>
        button.addEventListener('click', () => this.setResource(button.dataset.resource as Resource)),
      );
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
    this.root.querySelectorAll<HTMLButtonElement>('[data-detail]').forEach((button) =>
      button.addEventListener('click', () => {
        const row = this.data?.items.find((item) => item.id === button.dataset.detail);
        if (row) this.openDetail(row);
      }),
    );
    this.root.querySelector('#detail-close')?.addEventListener('click', () => this.closeDetail());
    this.root.querySelector('#user-save')?.addEventListener('click', () => void this.saveUser());
    this.root.querySelector('#group-member-submit')?.addEventListener('click', () => void this.changeMembership());
    this.root.querySelector('[data-backdrop]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) this.closeDetail();
    });
    this.root.querySelector<HTMLElement>('[role="dialog"]')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeDetail();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        this.root.querySelector<HTMLButtonElement>('#detail-close')?.focus();
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
const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}main{max-width:1100px;margin:auto;padding:1.5rem}header,.heading,.actions{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start}h1,h2,p{margin:0}h1{font-size:1.5rem}h2{font-size:1.1rem}.eyebrow{color:hsl(var(--primary));font-weight:700;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em}.subtle,.read-only,.meta{color:hsl(var(--muted-foreground));font-size:.875rem;margin-top:.35rem}.status{min-height:1.4rem;margin-top:.75rem;color:hsl(var(--muted-foreground))}.status[data-error="true"],.drawer-feedback.error{color:hsl(var(--destructive))}.badge,.state{background:hsl(var(--muted));border-radius:999px;font-size:.8rem;font-weight:700;padding:.25rem .6rem}.badge.ok,.state.on{background:hsl(var(--success) / .16);color:hsl(var(--success))}.setup-link{display:inline-block;background:hsl(var(--secondary));color:hsl(var(--secondary-foreground));border-radius:var(--radius,.5rem);padding:.5rem .85rem;text-decoration:none;font-weight:700}.card{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);margin-top:1.25rem;padding:1.25rem}nav,.resource-nav{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:1rem}.resource-nav span{color:hsl(var(--muted-foreground));font-size:.8rem;font-weight:700;margin-left:.5rem}.resource-nav button.selected{background:transparent;border-bottom:2px solid hsl(var(--primary));border-radius:0;color:hsl(var(--primary));padding-bottom:calc(.3rem - 2px)}label{display:grid;gap:.4rem;font-size:.875rem;font-weight:500;margin-top:1rem;max-width:440px}select,input{background:hsl(var(--background));border:1px solid hsl(var(--input));border-radius:calc(var(--radius,.5rem) - 2px);color:inherit;font:inherit;min-height:2.5rem;padding:.5rem .65rem}.check{display:flex;align-items:center;gap:.5rem}.check input{min-height:auto;width:1rem}.actions{justify-content:flex-end;margin-top:1rem}button{background:hsl(var(--primary));border:0;border-radius:calc(var(--radius,.5rem) - 2px);color:hsl(var(--primary-foreground));cursor:pointer;font:inherit;font-weight:700;min-height:2.5rem;padding:.5rem .85rem}button.secondary{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground))}button.compact{font-size:.8rem;min-height:2rem;padding:.3rem .6rem}button:disabled{opacity:.6;cursor:not-allowed}button:focus,input:focus,select:focus{outline:2px solid hsl(var(--ring));outline-offset:2px}.filter{max-width:320px}.table-wrap{overflow:auto;margin-top:1rem}table{color:hsl(var(--foreground));border-collapse:collapse;min-width:640px;width:100%}th,td{border-bottom:1px solid hsl(var(--border));padding:.7rem;text-align:left}th{color:hsl(var(--muted-foreground));font-size:.75rem;text-transform:uppercase}.empty{border:1px dashed hsl(var(--border));border-radius:var(--radius,.5rem);color:hsl(var(--muted-foreground));margin-top:1rem;padding:1.25rem;text-align:center}.sr-only{clip:rect(0,0,0,0);height:1px;margin:-1px;overflow:hidden;position:absolute;width:1px}.backdrop{background:hsl(var(--foreground) / .32);display:flex;inset:0;justify-content:flex-end;position:fixed;z-index:20}.drawer{background:hsl(var(--card));box-shadow:-8px 0 24px hsl(var(--foreground) / .16);max-width:min(100%,30rem);overflow:auto;padding:1.5rem;width:100%}.drawer-feedback{margin-top:1rem;min-height:1.4rem}dl{margin:1.5rem 0}dl div{border-bottom:1px solid hsl(var(--border));padding:.75rem 0}dt{color:hsl(var(--muted-foreground));font-size:.75rem;font-weight:700}dd{margin:.25rem 0 0;overflow-wrap:anywhere}@media(max-width:600px){main{padding:1rem}header,.heading{flex-direction:column}}`;
if (!customElements.get(ELEMENT)) customElements.define(ELEMENT, CloudCommandMicrosoftPage);
