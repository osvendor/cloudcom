import { parseExtensionPageContextV1, dispatchExtensionHostEvent, type ExtensionPageContextV1 } from '@breeze/extension-web-sdk';
import type { CloudCommandHostApi } from './index';

type Kind = 'users' | 'groups' | 'archived';
type Connection = { available: boolean; connected: boolean; enabled: boolean; canManage?: boolean; customerDomain?: string };
type Row = Record<string, string | boolean | null>;
type Page = { items: Row[]; nextPageToken: string | null; complete: boolean };
type MailboxSettings = { ok: true; email: string; forwardingEnabled: boolean | null; forwardingAddress: string | null;
  forwardingDisposition: string | null; vacationEnabled: boolean | null; vacationSubject: string | null;
  vacationStartMs: string | null; vacationEndMs: string | null };
type StorageItem = { email: string; gmailMb: number | null; driveMb: number | null; totalMb: number | null };
type StoragePage = { date: string; items: StorageItem[]; nextPageToken: string | null; partial: boolean; warning: string | null };
const mb = (value: number | null) => value === null ? 'Unavailable' : `${value.toLocaleString()} MB`;
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const userHeaders = [
  { key: 'name', label: 'User' }, { key: 'email', label: 'Email' }, { key: 'suspended', label: 'Status' },
  { key: 'admin', label: 'Administrator' }, { key: 'orgUnitPath', label: 'Org unit' },
  { key: 'lastLoginTime', label: 'Last sign-in' }, { key: 'twoStepVerificationEnrolled', label: '2-step enrolled' },
  { key: 'twoStepVerificationEnforced', label: '2-step enforced' },
] as const;
const headers: Record<Kind, readonly { key: string; label: string }[]> = {
  users: userHeaders,
  archived: userHeaders,
  groups: [{ key: 'name', label: 'Group' }, { key: 'email', label: 'Email' }, { key: 'members', label: 'Members' }, { key: 'description', label: 'Description' }],
};
function cell(row: Row, key: string): string {
  const raw = row[key];
  if (key === 'suspended') return row.archived === true ? 'Archived' : raw === true ? 'Suspended' : raw === false ? 'Active' : 'Unavailable';
  if (key === 'admin' || key.startsWith('twoStep')) return raw === true ? 'Yes' : raw === false ? 'No' : 'Unavailable';
  return escape(raw ?? '—');
}

export class CloudCommandGooglePage extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private contextValue: ExtensionPageContextV1 | null = null;
  private api: CloudCommandHostApi | null = null;
  private generation = 0;
  private connection: Connection | null = null;
  private kind: Kind = 'users';
  private rows: Row[] = [];
  private nextToken: string | null = null;
  private loading = false;
  private error = '';
  private query = '';
  private pendingAction: { userId: string; email: string; expectedSuspended: boolean; suspended: boolean } | null = null;
  private pendingProfile: { userId: string; email: string; expectedGivenName: string; expectedFamilyName: string; draftGivenName: string; draftFamilyName: string } | null = null;
  private memberGroup: { id: string; email: string; items: Row[]; nextToken: string | null } | null = null;
  private mailbox: { userId: string; email: string; settings: MailboxSettings | null } | null = null;
  private storageOpen = false;
  private storageDate = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  private storageRows: StorageItem[] = [];
  private storageNext: string | null = null;
  private storagePartial = false;
  private storageWarning: string | null = null;
  private storageLoaded = false;

  set context(input: unknown) {
    const context = parseExtensionPageContextV1(input);
    if (context.extensionName !== 'cloudcommand') throw new Error('Wrong extension context');
    if (context.organizationId !== this.contextValue?.organizationId) {
      this.generation++; this.rows = []; this.nextToken = null; this.connection = null; this.error = ''; this.query = ''; this.pendingAction = null; this.pendingProfile = null; this.memberGroup = null; this.mailbox = null; this.storageOpen = false; this.storageRows = []; this.storageNext = null; this.storagePartial = false; this.storageWarning = null; this.storageLoaded = false;
      // The existing capability belongs to the previous organization. Wait for
      // the host to provide the replacement before requesting any new data.
      this.api = null;
    }
    this.contextValue = context;
    this.render();
    if (this.isConnected && this.api) void this.loadConnection();
  }
  set hostApi(api: CloudCommandHostApi) {
    if (!api || typeof api.request !== 'function') throw new Error('Authenticated host API required');
    this.api = api;
    if (this.isConnected && this.contextValue) void this.loadConnection();
  }
  connectedCallback() { this.render(); if (this.api && this.contextValue) void this.loadConnection(); }
  disconnectedCallback() { this.generation++; }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.api) throw new Error('The authenticated host API is unavailable.');
    const response = await this.api.request(path, init);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : 'Google Workspace request failed.');
    return body as T;
  }
  private async loadConnection() {
    const generation = ++this.generation;
    this.loading = true; this.error = ''; this.render();
    try {
      const connection = await this.request<Connection>('/google/connection');
      if (generation !== this.generation) return;
      this.connection = connection;
      this.loading = false;
      this.render();
      if (connection.connected && connection.enabled) void this.loadPage(true);
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error instanceof Error ? error.message : 'Could not load Google Workspace.';
      this.loading = false; this.render();
    }
  }
  private async loadPage(reset: boolean) {
    if (this.loading || !this.connection?.enabled) return;
    const generation = this.generation;
    const token = reset ? null : this.nextToken;
    if (!reset && !token) return;
    this.loading = true; this.error = ''; this.render();
    try {
      const page = await this.request<Page>(`/google/directory/${this.kind}${token ? `?pageToken=${encodeURIComponent(token)}` : ''}`);
      if (generation !== this.generation) return;
      this.rows = reset ? page.items : [...this.rows, ...page.items];
      this.nextToken = page.nextPageToken;
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : 'Could not load directory.';
    }
    if (generation === this.generation) { this.loading = false; this.render(); }
  }
  private async loadMembers(reset: boolean) {
    const selected = this.memberGroup;
    if (!selected || this.loading || (!reset && !selected.nextToken)) return;
    const generation = this.generation;
    const token = reset ? null : selected.nextToken;
    this.loading = true; this.error = ''; this.render();
    try {
      const page = await this.request<Page>(`/google/groups/${encodeURIComponent(selected.id)}/members${token ? `?pageToken=${encodeURIComponent(token)}` : ''}`);
      if (generation !== this.generation || selected !== this.memberGroup) return;
      selected.items = reset ? page.items : [...selected.items, ...page.items];
      selected.nextToken = page.nextPageToken;
    } catch (error) {
      if (generation === this.generation && selected === this.memberGroup) this.error = error instanceof Error ? error.message : 'Could not load group members.';
    }
    if (generation === this.generation && selected === this.memberGroup) { this.loading = false; this.render(); }
  }
  private async loadMailbox() {
    const selected = this.mailbox;
    if (!selected || this.loading || !this.connection?.canManage) return;
    const generation = this.generation;
    this.loading = true; this.error = ''; this.render();
    try {
      const settings = await this.request<MailboxSettings>(`/google/users/${encodeURIComponent(selected.userId)}/mailbox-settings`);
      if (generation === this.generation && selected === this.mailbox) selected.settings = settings;
    } catch (error) {
      if (generation === this.generation && selected === this.mailbox) this.error = error instanceof Error ? error.message : 'Could not load Gmail settings.';
    }
    if (generation === this.generation && selected === this.mailbox) { this.loading = false; this.render(); }
  }
  private async loadStorage(reset: boolean) {
    if (!this.connection?.enabled || this.loading || (!reset && !this.storageNext)) return;
    const generation = this.generation;
    const token = reset ? null : this.storageNext;
    if (reset) { this.storageRows = []; this.storageNext = null; this.storagePartial = false; this.storageWarning = null; this.storageLoaded = false; }
    this.loading = true; this.error = ''; this.render();
    try {
      const page = await this.request<StoragePage>(`/google/reports/storage?date=${encodeURIComponent(this.storageDate)}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
      if (generation !== this.generation || !this.storageOpen) return;
      this.storageRows = reset ? page.items : [...this.storageRows, ...page.items];
      this.storageNext = page.nextPageToken;
      this.storagePartial = (reset ? false : this.storagePartial) || page.partial;
      this.storageWarning = page.warning ?? (reset ? null : this.storageWarning);
      this.storageLoaded = true;
    } catch (error) {
      if (generation === this.generation && this.storageOpen) this.error = error instanceof Error ? error.message : 'Could not load Google usage report.';
    }
    if (generation === this.generation && this.storageOpen) { this.loading = false; this.render(); }
  }
  private async applySuspension() {
    const action = this.pendingAction;
    const confirmation = this.root.querySelector<HTMLInputElement>('#confirm-email')?.value.trim() ?? '';
    if (!action || confirmation !== action.email || !this.connection?.canManage) return;
    const generation = this.generation;
    this.loading = true; this.error = ''; this.render();
    try {
      await this.request('/google/users/suspension', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...action, confirmation }) });
      if (generation !== this.generation) return;
      this.pendingAction = null; this.loading = false;
      await this.loadPage(true);
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error instanceof Error ? error.message : 'The account could not be changed. Refresh before retrying.';
      this.loading = false; this.render();
    }
  }
  private async saveProfile() {
    const profile = this.pendingProfile;
    const givenName = this.root.querySelector<HTMLInputElement>('#profile-given')?.value.trim() ?? '';
    const familyName = this.root.querySelector<HTMLInputElement>('#profile-family')?.value.trim() ?? '';
    if (!profile || !this.connection?.canManage) return;
    profile.draftGivenName = givenName; profile.draftFamilyName = familyName;
    if (!givenName || !familyName || givenName.length > 100 || familyName.length > 100
      || (givenName === profile.expectedGivenName && familyName === profile.expectedFamilyName)) {
      this.error = 'Enter a changed first or last name (up to 100 characters each).'; this.render(); return;
    }
    const generation = this.generation;
    this.loading = true; this.error = ''; this.render();
    try {
      await this.request('/google/users/profile', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: profile.userId, email: profile.email,
          expectedGivenName: profile.expectedGivenName, expectedFamilyName: profile.expectedFamilyName, givenName, familyName }) });
      if (generation !== this.generation) return;
      this.pendingProfile = null; this.loading = false;
      await this.loadPage(true);
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error instanceof Error ? error.message : 'The account could not be changed. Refresh before retrying.';
      this.loading = false; this.render();
    }
  }
  private userActions(row: Row): string {
    if (!this.connection?.canManage || this.kind !== 'users' || typeof row.id !== 'string' || typeof row.email !== 'string'
      || row.admin === true || row.archived === true) return '';
    const edit = typeof row.givenName === 'string' && typeof row.familyName === 'string'
      ? `<button data-profile="${escape(row.id)}">Edit account</button>` : '';
    const access = typeof row.suspended === 'boolean'
      ? `<button data-suspend="${escape(row.id)}">${row.suspended ? 'Restore sign-in' : 'Block sign-in'}</button>` : '';
    return `${edit}${access}<button data-mailbox="${escape(row.id)}">Mail settings</button>`;
  }
  private render() {
    const connected = this.connection?.connected && this.connection?.enabled;
    const columns = headers[this.kind];
    const visible = this.rows.filter(row => !this.query || Object.values(row).some(value => String(value ?? '').toLowerCase().includes(this.query)));
    this.root.innerHTML = `<style>${styles}</style><main><header><div><p class="eyebrow">Google Workspace</p><h1>${this.storageOpen ? 'Storage' : 'Directory'}</h1><p>${connected ? escape(this.connection?.customerDomain ?? 'Connected') : 'Users and groups for the selected organization.'}</p></div><button id="refresh" ${this.loading ? 'disabled' : ''}>Refresh</button></header>${this.error ? `<p class="error" role="alert">${escape(this.error)}</p>` : ''}${!this.connection && this.loading ? '<p role="status">Loading connection…</p>' : !connected ? `<div class="empty">${this.connection?.available === false ? 'Google Workspace is not enabled on this server.' : 'No active Google Workspace connection.'}<button id="connect">Open Connect</button></div>` : `<nav aria-label="Google directory"><button data-kind="users" aria-current="${this.kind === 'users' && !this.storageOpen}">Users</button><button data-kind="groups" aria-current="${this.kind === 'groups' && !this.storageOpen}">Groups</button><button data-kind="archived" aria-current="${this.kind === 'archived' && !this.storageOpen}">Archived users</button></nav><label class="search">Search loaded ${this.kind}<input id="search" value="${escape(this.query)}" placeholder="Name or email"></label><p class="note">${this.nextToken ? 'Showing loaded results; more pages are available.' : 'Directory results loaded.'}</p><div class="table"><table><thead><tr>${columns.map(col => `<th>${col.label}</th>`).join('')}${this.connection?.canManage && this.kind === 'users' ? '<th>Action</th>' : ''}</tr></thead><tbody>${visible.map(row => `<tr>${columns.map(col => `<td>${cell(row, col.key)}</td>`).join('')}${this.connection?.canManage && this.kind === 'users' ? `<td>${typeof row.id === 'string' && typeof row.email === 'string' && typeof row.suspended === 'boolean' && row.admin !== true && row.archived !== true ? `<button data-suspend="${escape(row.id)}">${row.suspended ? 'Restore sign-in' : 'Block sign-in'}</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>${!visible.length && !this.loading ? '<p class="empty">No results in the loaded page.</p>' : ''}${this.nextToken ? `<button id="more" ${this.loading ? 'disabled' : ''}>Load more</button>` : ''}${this.pendingAction ? `<section class="confirm"><h2>${this.pendingAction.suspended ? 'Block sign-in' : 'Restore sign-in'}</h2><p>${escape(this.pendingAction.email)}</p><p>Type the email address to confirm this account change.</p><input id="confirm-email" aria-label="Confirm user email" autocomplete="off"><div><button id="confirm-action" ${this.loading ? 'disabled' : ''}>Confirm</button><button id="cancel-action">Cancel</button></div></section>` : ''}${this.loading ? '<p role="status">Loading…</p>' : ''}`}</main>`;
    if (this.connection?.canManage && this.kind === 'users') {
      this.root.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((element, index) => {
        const actionCell = element.lastElementChild;
        if (actionCell) actionCell.innerHTML = this.userActions(visible[index]);
      });
    }
    if (this.pendingProfile) this.root.querySelector('main')?.insertAdjacentHTML('beforeend',
      `<section class="confirm"><h2>Edit account</h2><p>${escape(this.pendingProfile.email)}</p><label>First name<input id="profile-given" maxlength="100" value="${escape(this.pendingProfile.draftGivenName)}"></label><label>Last name<input id="profile-family" maxlength="100" value="${escape(this.pendingProfile.draftFamilyName)}"></label><div><button id="save-profile" ${this.loading ? 'disabled' : ''}>Save name</button><button id="cancel-profile">Cancel</button></div></section>`);
    if (this.kind === 'groups') {
      this.root.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((element, index) => {
        const row = visible[index];
        if (typeof row.id === 'string' && typeof row.email === 'string') {
          element.lastElementChild?.insertAdjacentHTML('beforeend', ` <button data-members="${escape(row.id)}">View members</button>`);
        }
      });
    }
    if (this.memberGroup && this.kind === 'groups') this.root.querySelector('main')?.insertAdjacentHTML('beforeend',
      `<section class="members"><div class="members-head"><div><h2>Direct group members</h2><p>${escape(this.memberGroup.email)}</p></div><button id="close-members">Close</button></div><p class="note">Roles are shown as Google reports them. Nested members are not included.</p><div class="table"><table><thead><tr><th>Member</th><th>Role</th><th>Type</th><th>Status</th></tr></thead><tbody>${this.memberGroup.items.map(row => `<tr><td>${cell(row, 'email')}</td><td>${cell(row, 'role')}</td><td>${cell(row, 'type')}</td><td>${cell(row, 'status')}</td></tr>`).join('')}</tbody></table></div>${!this.memberGroup.items.length && !this.loading ? '<p>No direct members in this loaded page.</p>' : ''}${this.memberGroup.nextToken ? `<button id="more-members" ${this.loading ? 'disabled' : ''}>Load more members</button>` : ''}</section>`);
    if (this.mailbox && this.kind === 'users') this.root.querySelector('main')?.insertAdjacentHTML('beforeend',
      `<section class="members"><div class="members-head"><div><h2>Gmail settings</h2><p>${escape(this.mailbox.email)}</p></div><button id="close-mailbox">Close</button></div>${this.mailbox.settings ? `<div class="table"><table><tbody><tr><th>Automatic forwarding</th><td>${this.mailbox.settings.forwardingEnabled === null ? 'Unavailable' : this.mailbox.settings.forwardingEnabled ? 'On' : 'Off'}</td></tr><tr><th>Destination</th><td>${escape(this.mailbox.settings.forwardingAddress ?? '—')}</td></tr><tr><th>Disposition</th><td>${escape(this.mailbox.settings.forwardingDisposition ?? '—')}</td></tr><tr><th>Out of office</th><td>${this.mailbox.settings.vacationEnabled === null ? 'Unavailable' : this.mailbox.settings.vacationEnabled ? 'On' : 'Off'}</td></tr><tr><th>Subject</th><td>${escape(this.mailbox.settings.vacationSubject ?? '—')}</td></tr></tbody></table></div><p class="note">Read-only settings. Message body is not shown.</p>` : '<p role="status">Loading mailbox settings…</p>'}</section>`);
    this.root.querySelector('main')?.classList.toggle('storage', this.storageOpen);
    if (connected) this.root.querySelector('nav')?.insertAdjacentHTML('beforeend', `<button id="storage-tab" aria-current="${this.storageOpen}">Storage</button>`);
    if (this.storageOpen) this.root.querySelector('main')?.insertAdjacentHTML('beforeend',
      `<section class="members"><div class="members-head"><div><h2>Daily storage usage</h2><p>Google Reports API · selected date</p></div><label>Report date<input id="storage-date" type="date" value="${escape(this.storageDate)}"></label><button id="load-storage" ${this.loading ? 'disabled' : ''}>Load</button></div><p class="note">Usage may be delayed. This report requires admin.reports.usage.readonly in the existing Google delegation grant; a connected Directory does not prove reporting access.</p>${this.storageWarning ? `<p role="status">${escape(this.storageWarning)}</p>` : ''}${this.storageLoaded ? `<p role="status">${this.storagePartial ? 'Partial or unavailable data' : this.storageNext ? 'More pages available' : 'Complete for the configured domain'} · ${escape(this.storageDate)}</p><div class="table"><table><thead><tr><th>User</th><th>Gmail</th><th>Drive</th><th>Total</th></tr></thead><tbody>${this.storageRows.map(row => `<tr><td>${escape(row.email)}</td><td>${escape(mb(row.gmailMb))}</td><td>${escape(mb(row.driveMb))}</td><td>${escape(mb(row.totalMb))}</td></tr>`).join('')}</tbody></table></div>${!this.storageRows.length ? '<p>No usage records returned. This is not zero usage.</p>' : ''}${this.storageNext ? `<button id="more-storage" ${this.loading ? 'disabled' : ''}>Load more</button>` : ''}` : '<p>Choose a date and load the report.</p>'}</section>`);
    this.root.querySelector('#refresh')?.addEventListener('click', () => { if (connected) { if (this.storageOpen) void this.loadStorage(true); else void this.loadPage(true); } else void this.loadConnection(); });
    this.root.querySelector('#connect')?.addEventListener('click', () => dispatchExtensionHostEvent(this, { version: 1, type: 'navigate', path: '/extensions/cloudcommand/connect#google' }));
    this.root.querySelector('#more')?.addEventListener('click', () => void this.loadPage(false));
    this.root.querySelectorAll<HTMLButtonElement>('[data-members]').forEach(button => button.addEventListener('click', () => {
      const row = this.rows.find(item => item.id === button.dataset.members);
      if (!row || typeof row.id !== 'string' || typeof row.email !== 'string') return;
      this.memberGroup = { id: row.id, email: row.email, items: [], nextToken: null };
      this.render(); void this.loadMembers(true);
    }));
    this.root.querySelector('#more-members')?.addEventListener('click', () => void this.loadMembers(false));
    this.root.querySelector('#close-members')?.addEventListener('click', () => { this.generation++; this.memberGroup = null; this.loading = false; this.render(); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-mailbox]').forEach(button => button.addEventListener('click', () => {
      const row = this.rows.find(item => item.id === button.dataset.mailbox);
      if (!row || typeof row.id !== 'string' || typeof row.email !== 'string') return;
      this.pendingAction = null; this.pendingProfile = null;
      this.mailbox = { userId: row.id, email: row.email, settings: null };
      this.render(); void this.loadMailbox();
    }));
    this.root.querySelector('#close-mailbox')?.addEventListener('click', () => { this.generation++; this.mailbox = null; this.loading = false; this.render(); });
    this.root.querySelector('#storage-tab')?.addEventListener('click', () => { this.generation++; this.storageOpen = true; this.loading = false; this.pendingAction = null; this.pendingProfile = null; this.mailbox = null; this.memberGroup = null; this.render(); if (!this.storageLoaded) void this.loadStorage(true); });
    this.root.querySelector('#load-storage')?.addEventListener('click', () => { const next = this.root.querySelector<HTMLInputElement>('#storage-date')?.value; if (!next) return; this.storageDate = next; this.storageRows = []; this.storageNext = null; this.storageLoaded = false; void this.loadStorage(true); });
    this.root.querySelector('#more-storage')?.addEventListener('click', () => void this.loadStorage(false));
    this.root.querySelectorAll<HTMLButtonElement>('[data-suspend]').forEach(button => button.addEventListener('click', () => {
      const row = this.rows.find(item => item.id === button.dataset.suspend);
      if (!row || typeof row.id !== 'string' || typeof row.email !== 'string' || typeof row.suspended !== 'boolean') return;
      this.pendingProfile = null;
      this.pendingAction = { userId: row.id, email: row.email, expectedSuspended: row.suspended, suspended: !row.suspended };
      this.render(); this.root.querySelector<HTMLInputElement>('#confirm-email')?.focus();
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-profile]').forEach(button => button.addEventListener('click', () => {
      const row = this.rows.find(item => item.id === button.dataset.profile);
      if (!row || typeof row.id !== 'string' || typeof row.email !== 'string'
        || typeof row.givenName !== 'string' || typeof row.familyName !== 'string') return;
      this.pendingAction = null;
      this.pendingProfile = { userId: row.id, email: row.email, expectedGivenName: row.givenName, expectedFamilyName: row.familyName,
        draftGivenName: row.givenName, draftFamilyName: row.familyName };
      this.render(); this.root.querySelector<HTMLInputElement>('#profile-given')?.focus();
    }));
    this.root.querySelector('#save-profile')?.addEventListener('click', () => void this.saveProfile());
    this.root.querySelector('#cancel-profile')?.addEventListener('click', () => { this.pendingProfile = null; this.render(); });
    this.root.querySelector('#confirm-action')?.addEventListener('click', () => void this.applySuspension());
    this.root.querySelector('#cancel-action')?.addEventListener('click', () => { this.pendingAction = null; this.render(); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach(button => button.addEventListener('click', () => {
      const kind = button.dataset.kind as Kind;
      if (kind === this.kind && !this.storageOpen) return;
      if (kind === this.kind && this.storageOpen) { this.generation++; this.storageOpen = false; this.loading = false; this.render(); return; }
      this.generation++; this.kind = kind; this.rows = []; this.nextToken = null; this.query = ''; this.pendingAction = null; this.pendingProfile = null; this.memberGroup = null; this.mailbox = null; this.loading = false;
      this.storageOpen = false;
      this.render(); void this.loadPage(true);
    }));
    this.root.querySelector<HTMLInputElement>('#search')?.addEventListener('input', event => {
      this.query = (event.target as HTMLInputElement).value.trim().toLowerCase();
      this.render(); this.root.querySelector<HTMLInputElement>('#search')?.focus();
    });
  }
}
const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}main{padding:1rem 1.25rem}header{display:flex;justify-content:space-between;align-items:start;gap:1rem;border-bottom:1px solid hsl(var(--border));padding-bottom:.8rem}h1{font-size:1.4rem;margin:.1rem 0}h2{font-size:1rem}p{margin:.25rem 0;color:hsl(var(--muted-foreground));font-size:.85rem}.eyebrow{font-size:.73rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:hsl(var(--primary))}button{font:inherit;font-size:.85rem;min-height:36px;padding:.35rem .7rem;border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);background:hsl(var(--card));color:hsl(var(--foreground));cursor:pointer}button:disabled{opacity:.5}button:focus-visible,input:focus-visible{outline:2px solid hsl(var(--ring))}nav{display:flex;gap:.5rem;margin:1rem 0}nav button[aria-current=true]{border-color:hsl(var(--primary));color:hsl(var(--primary))}.search{display:block;font-size:.82rem;color:hsl(var(--muted-foreground))}input{display:block;width:min(100%,350px);height:38px;margin-top:.35rem;border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);background:hsl(var(--background));color:hsl(var(--foreground));padding:.4rem .6rem;font:inherit}.note{margin:.75rem 0}.table{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.82rem}th,td{padding:.55rem .65rem;border-bottom:1px solid hsl(var(--border));text-align:left;white-space:nowrap}th{color:hsl(var(--muted-foreground));font-size:.72rem;text-transform:uppercase}.error{color:hsl(var(--destructive))}.empty{padding:1rem;border:1px dashed hsl(var(--border));margin-top:1rem}.empty button{display:block;margin-top:.7rem}.confirm,.members{border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);padding:1rem;margin-top:1rem}.confirm{max-width:440px}.confirm button{margin:.7rem .5rem 0 0}.members-head{display:flex;align-items:start;justify-content:space-between;gap:1rem}.storage>.search,.storage>.note,.storage>.table,.storage>#more,.storage>.empty{display:none}@media(max-width:600px){main{padding:.8rem}header{flex-wrap:wrap}}`;
if (!customElements.get('cloudcommand-google-page')) customElements.define('cloudcommand-google-page', CloudCommandGooglePage);
