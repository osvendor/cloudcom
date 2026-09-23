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
type UserSecurityAction = 'reset-password' | 'revoke-sessions' | 'block-sign-in' | 'restore-sign-in';
type MicrosoftRecord = Record<string, unknown>;
type MfaMethodType = 'phone' | 'microsoftAuthenticator' | 'email' | 'fido2' | 'password' | 'softwareOath' | 'temporaryAccessPass' | 'windowsHelloForBusiness' | 'platformCredential' | 'other';
type MfaMethod = { id?: string; type: MfaMethodType; detail?: string; removable: boolean };
type LicenseOption = { skuId: string; skuPartNumber: string; capabilityStatus: string; consumedUnits: number; prepaidUnits: { enabled: number } };
type HealthIssue = { id: string; title?: string | null; impactDescription?: string | null; status?: string | null; lastModifiedDateTime?: string | null };
type HealthService = { id: string; service: string; status: string; issues?: HealthIssue[] };
type HealthData = { services: HealthService[]; partial: boolean; checkedAt: string };
const healthyStatuses = new Set(['serviceOperational', 'serviceRestored', 'postIncidentReviewPublished', 'resolved', 'resolvedExternal', 'falsePositive']);
function healthTone(status: string): 'green' | 'yellow' | 'red' | 'unknown' {
  return healthyStatuses.has(status) ? 'green' : status === 'serviceInterruption' ? 'red' : !status || status === 'unknownFutureValue' ? 'unknown' : 'yellow';
}
type RemovableMfaMethod = MfaMethod & { id: string; type: 'phone' | 'microsoftAuthenticator'; removable: true };
type UserDraft = Partial<Record<(typeof USER_FIELDS)[number], string>> & { accountEnabled?: boolean };
// Cloud Command's Edit account drawer saves the account name as one field. The
// directory is an MSP operations view, not a copy of every Graph profile field.
const USER_FIELDS = ['displayName'] as const;
// Match Cloud Command's directory update flow: allow Graph's eventual reads
// to converge for up to 30 seconds before reporting an uncertain outcome.
const USER_VERIFY_READS = 15;
const USER_VERIFY_DELAY_MS = 2000;

const labels: Record<Resource, string> = {
  users: 'Users',
  groups: 'Groups',
  licenses: 'Licenses',
  sites: 'Sites',
};
// Native Graph currently supplies identity, account type, and licensing.  The
// historical Cloud Command table also reserved the remaining operations
// columns, so retain them with an explicit unavailable value instead of
// inventing Exchange, OneDrive, or exclusion data.
const USER_DIRECTORY_COLUMNS = [
  { key: 'displayName', label: 'User' },
  { key: 'userType', label: 'Type' },
  { key: 'licenseSummary', label: 'License' },
  { key: 'mailbox', label: 'Mailbox' },
  { key: 'archive', label: 'Archive' },
  { key: 'oneDrive', label: 'OneDrive' },
  { key: 'exclude', label: 'Exclude', defaultHidden: true },
] as const;

export class CloudCommandMicrosoftPage extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private contextValue: ExtensionPageContextV1 | null = null;
  private api: HostApi | null = null;
  private connection: Connection | null = null;
  private resource: Resource = 'users';
  private data: ResourceData | null = null;
  private filter = '';
  private directoryScope: 'users' | 'exclude' = 'users';
  private directoryExclusions = new Map<string, boolean>();
  private directoryExclusionsReady = false;
  private directoryExclusionError = '';
  private directoryPreferenceRequest = 0;
  private detail: ResourceRow | null = null;
  private createUserOpen = false;
  private createUserDomains: string[] | null = null;
  private createUserLicenses: LicenseOption[] | null = null;
  private createLicenseCatalogError = '';
  private createUserError = '';
  private createUserBusy = false;
  private createdUser: { id: string; userPrincipalName: string; temporaryPassword: string } | null = null;
  private createUserDraft = { name: '', local: '', domain: '', location: '', skuId: '' };
  private createLicenseOutcome = '';
  private createLicenseOutcomeError = false;
  private detailKind: DetailKind = 'read';
  private detailRecord: MicrosoftRecord | null = null;
  private detailRequest = 0;
  private userVerificationRequest = 0;
  private userSecurityRequest = 0;
  private userSecurityAction: UserSecurityAction | null = null;
  private userSecurityConfirmed = false;
  private temporaryPassword: string | null = null;
  private globalAdminStatus: boolean | null = null;
  private globalAdminDraft: boolean | null = null;
  private globalAdminLoading = false;
  private globalAdminError = '';
  private globalAdminConfirmation = '';
  private globalAdminRequest = 0;
  private mfaOpen = false;
  private mfaMethods: MfaMethod[] | null = null;
  private mfaLoading = false;
  private mfaError = '';
  private mfaRemoval: RemovableMfaMethod | null = null;
  private mfaConfirmation = '';
  private mfaRequest = 0;
  private drawerMessage = '';
  private drawerError = false;
  private membershipUserId = '';
  private membershipUsers: ResourceData | null = null;
  private membershipSearch = '';
  private membershipUsersRequest = 0;
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
  private health: HealthData | null = null;
  private healthError = '';
  private healthOpen = false;
  private healthLoading = false;
  private healthRequest = 0;

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
    this.globalAdminRequest += 1;
    this.mfaRequest += 1;
    this.temporaryPassword = null;
    this.createdUser = null;
    this.healthRequest += 1;
    this.userSecurityAction = null;
  }

  private onHashChange = (): void => {
    const next = this.resourceFromHash();
    if (next !== this.resource) {
      this.resource = next;
      if (next === 'users') this.directoryScope = 'users';
      this.data = null;
      this.detail = null;
      this.createUserOpen = false;
      this.createdUser = null; this.createUserBusy = false;
      this.detailRecord = null;
      this.detailRequest += 1;
      this.userVerificationRequest += 1;
      this.userSecurityRequest += 1;
      this.globalAdminRequest += 1;
      this.mfaRequest += 1;
      this.userSecurityAction = null; this.userSecurityConfirmed = false; this.temporaryPassword = null;
      this.busy = false;
      this.filter = '';
      this.directoryScope = 'users'; this.directoryExclusions.clear(); this.directoryExclusionsReady = false; this.directoryExclusionError = ''; this.directoryPreferenceRequest += 1;
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
    this.health = null; this.healthError = ''; this.healthOpen = false; this.healthLoading = false; this.healthRequest += 1;
    this.data = null;
    this.detail = null;
    this.createUserOpen = false;
    this.createdUser = null; this.createUserBusy = false;
    this.detailRecord = null;
    this.expandedRowId = null;
    this.visibleColumns = [];
    this.detailRequest += 1;
    this.userVerificationRequest += 1;
    this.userSecurityRequest += 1;
    this.globalAdminRequest += 1;
    this.mfaRequest += 1;
    this.userSecurityAction = null; this.userSecurityConfirmed = false; this.temporaryPassword = null;
    this.drawerMessage = '';
    this.drawerError = false;
    this.membershipUserId = '';
    this.membershipUsers = null;
    this.membershipSearch = '';
    this.membershipUsersRequest += 1;
    this.membershipAction = 'add';
    this.membershipConfirmed = false;
    this.userDraft = {};
    this.filter = '';
    this.directoryScope = 'users'; this.directoryExclusions.clear(); this.directoryExclusionsReady = false; this.directoryExclusionError = ''; this.directoryPreferenceRequest += 1;
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
  private async loadHealth(): Promise<void> {
    if (!this.canRead() || this.healthLoading) return;
    const generation = this.generation; const context = this.contextValue; const request = ++this.healthRequest;
    this.healthLoading = true; this.healthError = ''; this.render();
    try {
      const raw = await this.request<HealthData>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'service.health.get' }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.healthRequest) return;
      if (!raw || !Array.isArray(raw.services) || typeof raw.partial !== 'boolean' || !Number.isFinite(Date.parse(raw.checkedAt))
        || !raw.services.every(service => typeof service.id === 'string' && typeof service.service === 'string' && typeof service.status === 'string' && (!service.issues || Array.isArray(service.issues))))
        throw new Error('Microsoft returned an invalid service-health response.');
      this.health = raw;
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && request === this.healthRequest)
        this.healthError = error instanceof Error && error.message === 'provider_access_denied'
          ? 'The connected application needs the ServiceHealth.Read.All permission with administrator consent.'
          : error instanceof Error ? error.message : 'Service health could not be refreshed.';
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.healthRequest) { this.healthLoading = false; this.render(); }
    }
  }
  private renderHealth(): string {
    const data = this.health;
    const affected = data?.services.filter(service => healthTone(service.status) !== 'green') ?? [];
    const tone = !data || data.partial || !data.services.length || this.healthError ? 'unknown'
      : affected.some(service => healthTone(service.status) === 'red') ? 'red'
      : affected.some(service => healthTone(service.status) === 'yellow') ? 'yellow'
      : affected.length ? 'unknown' : 'green';
    const headline = tone === 'red' ? 'Service interruption reported' : tone === 'yellow' ? 'Some services have issues'
      : tone === 'green' ? 'No known service issues' : 'Status unavailable';
    const serviceRows = affected.map(service => `<details class="health-service"><summary><span class="health-dot ${healthTone(service.status)}"></span>${esc(service.service)}</summary><p class="meta">${esc(service.status)}</p>${service.issues?.length ? service.issues.map(issue => `<article class="health-issue"><strong>${esc(issue.title || 'Service advisory')}</strong><p>${esc(issue.impactDescription || 'Microsoft has not published an impact description yet.')}</p><small>${esc(issue.id)} · ${esc(issue.status || 'Microsoft update')}${issue.lastModifiedDateTime ? ` · Updated ${esc(this.formatCheckedAt(issue.lastModifiedDateTime))}` : ''}</small></article>`).join('') : '<p class="meta">Microsoft reports a service issue, but no further details were returned.</p>'}</details>`).join('');
    return `<section class="health-panel" aria-label="Microsoft service health"><div class="health-heading"><div><h2>Client service status</h2><p class="meta">Microsoft-reported status for the selected tenant</p></div><button class="secondary compact" id="health-close">Close</button></div><p class="health-headline"><span class="health-dot ${tone}"></span>${headline}</p>${this.healthError ? `<p role="alert" class="status" data-error="true">Refresh failed. ${esc(this.healthError)}${data ? ' Showing the last saved result.' : ''}</p>` : ''}${data?.partial ? '<p role="status" class="meta">Microsoft returned only part of the service list. Overall status is unknown.</p>' : ''}<p class="meta">Last checked: ${data ? esc(this.formatCheckedAt(data.checkedAt)) : 'Not available'} · ${data ? `${affected.length} affected of ${data.services.length} services` : 'No verified status yet'}</p><div class="health-actions"><button class="secondary compact" id="health-refresh" ${this.healthLoading ? 'disabled' : ''}>${this.healthLoading ? 'Refreshing…' : 'Refresh status'}</button></div>${serviceRows}${data && !affected.length && !data.partial && data.services.length ? `<p class="meta">${data.services.length} services have no known issues.</p>` : ''}</section>`;
  }
  private async loadResource(): Promise<void> {
    if (!this.canRead()) return;
    const generation = this.generation;
    const context = this.contextValue;
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
      if (resource === 'users') {
        this.directoryExclusions.clear(); this.directoryExclusionsReady = false; this.directoryExclusionError = '';
        void this.loadDirectoryExclusions(data.items, generation, context, request);
      }
      const availableColumns = resource === 'users' ? USER_DIRECTORY_COLUMNS : data.columns;
      this.visibleColumns = this.visibleColumns.filter(key => availableColumns.some(column => column.key === key));
      if (!this.visibleColumns.length) this.visibleColumns = this.defaultVisibleColumns(data);
      this.setMessage(data.items.length ? '' : `No ${labels[resource].toLowerCase()} are available for this tenant.`);
    } catch (e) {
      if (generation === this.generation && resource === this.resource && request === this.resourceRequest)
        this.setMessage(e instanceof Error ? e.message : 'Could not load Microsoft resource.', true);
    } finally {
      if (generation === this.generation && request === this.resourceRequest) this.render();
    }
  }
  private async loadDirectoryExclusions(rows: ResourceRow[], generation: number, context: ExtensionPageContextV1 | null, resourceRequest: number): Promise<void> {
    const request = ++this.directoryPreferenceRequest;
    try {
      const body = await this.request<unknown>(this.path('/directory/exclusions'));
      if (!body || typeof body !== 'object' || !Array.isArray((body as MicrosoftRecord).items) || !(body as { items: unknown[] }).items.every(item => typeof item === 'string')) throw new Error('Invalid directory exclusions response.');
      if (generation !== this.generation || context !== this.contextValue || resourceRequest !== this.resourceRequest || request !== this.directoryPreferenceRequest || this.resource !== 'users') return;
      const excluded = new Set((body as { items: string[] }).items);
      this.directoryExclusions = new Map(rows.map(row => [row.id, excluded.has(row.id)]));
      this.directoryExclusionsReady = true;
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || resourceRequest !== this.resourceRequest || request !== this.directoryPreferenceRequest || this.resource !== 'users') return;
      this.directoryExclusionsReady = false;
      this.directoryExclusionError = error instanceof Error ? error.message : 'Could not load directory exclusions.';
    }
    this.render();
  }
  private async setDirectoryExcluded(row: ResourceRow, excluded: boolean): Promise<void> {
    if (!this.connection?.canManage || this.busy || this.resource !== 'users') return;
    const generation = this.generation; const context = this.contextValue; const request = ++this.directoryPreferenceRequest;
    this.busy = true; this.drawerError = false; this.drawerMessage = excluded ? 'Excluding user from this directory…' : 'Restoring user to this directory…'; this.render();
    try {
      const body = await this.request<unknown>(this.path(`/directory/users/${encodeURIComponent(row.id)}/exclude`), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ excluded }) });
      if (generation !== this.generation || context !== this.contextValue || request !== this.directoryPreferenceRequest || this.resource !== 'users') return;
      if (!body || typeof body !== 'object' || (body as MicrosoftRecord).excluded !== excluded) throw new Error('Directory exclusion was not acknowledged.');
      this.directoryExclusions.set(row.id, excluded); this.directoryExclusionsReady = true;
      this.drawerError = false; this.drawerMessage = excluded ? 'User excluded from your directory.' : 'User restored to your directory.';
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && request === this.directoryPreferenceRequest) { this.drawerError = true; this.drawerMessage = error instanceof Error ? error.message : 'Directory exclusion outcome is uncertain.'; }
    } finally { if (generation === this.generation && context === this.contextValue && request === this.directoryPreferenceRequest) { this.busy = false; this.render(); } }
  }
  private setDirectoryScope(scope: 'users' | 'exclude'): void {
    this.directoryScope = scope;
    this.filter = '';
    this.expandedRowId = null;
    this.render();
  }
  private openDetail(row: ResourceRow, securityAction: UserSecurityAction | null = null): void {
    this.busy = false;
    this.detail = row;
    this.detailKind = this.resource === 'users' ? 'user' : this.resource === 'groups' ? 'group' : 'read';
    this.detailRecord = null;
    this.userVerificationRequest += 1;
    this.userSecurityRequest += 1;
    this.globalAdminRequest += 1;
    this.userSecurityAction = securityAction; this.userSecurityConfirmed = false; this.temporaryPassword = null;
    this.globalAdminStatus = null; this.globalAdminDraft = null; this.globalAdminLoading = this.detailKind === 'user'; this.globalAdminError = ''; this.globalAdminConfirmation = '';
    this.mfaOpen = false; this.mfaMethods = null; this.mfaLoading = false; this.mfaError = ''; this.mfaRemoval = null; this.mfaConfirmation = '';
    this.drawerMessage = '';
    this.drawerError = false;
    this.membershipUserId = '';
    this.membershipUsers = null;
    this.membershipSearch = '';
    this.membershipUsersRequest += 1;
    this.membershipAction = 'add';
    this.membershipConfirmed = false;
    this.userDraft = {};
    this.returnFocus = `row-${row.id}`;
    this.render();
    queueMicrotask(() => this.root.querySelector<HTMLButtonElement>('#detail-close')?.focus());
    if (this.detailKind !== 'read') void this.loadDetailRecord(row.id, this.detailKind);
    if (this.detailKind === 'user') void this.loadGlobalAdminStatus(row.id);
    if (this.detailKind === 'group' && this.connection?.canManage) void this.loadMembershipUsers(row.id);
  }
  private openCreateUser(): void {
    if (!this.connection?.canManage || this.resource !== 'users') return;
    this.createUserOpen = true;
    this.createUserDomains = null; this.createUserError = ''; this.createdUser = null;
    this.createUserLicenses = null; this.createLicenseCatalogError = '';
    this.createUserDraft = { name: '', local: '', domain: '', location: '', skuId: '' };
    this.createLicenseOutcome = ''; this.createLicenseOutcomeError = false;
    this.render();
    queueMicrotask(() => this.root.querySelector<HTMLButtonElement>('#create-user-close')?.focus());
    void this.loadCreateUserDomains();
    void this.loadCreateUserLicenses();
  }
  private closeCreateUser(): void {
    if (this.createUserBusy) return;
    this.createUserOpen = false;
    this.createdUser = null;
    this.render();
    queueMicrotask(() => this.root.querySelector<HTMLButtonElement>('#create-user')?.focus());
  }
  private async loadCreateUserDomains(): Promise<void> {
    const generation = this.generation, context = this.contextValue;
    try {
      const result = await this.request<{ domains: string[] }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user.domains.list' }),
      });
      if (generation !== this.generation || context !== this.contextValue || !this.createUserOpen) return;
      if (!Array.isArray(result.domains) || !result.domains.every(domain => typeof domain === 'string')) throw new Error('Invalid verified-domain response.');
      this.createUserDomains = result.domains;
      this.createUserDraft.domain = result.domains[0] ?? '';
      if (!result.domains.length) this.createUserError = 'No verified sign-in domain is available for this tenant.';
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || !this.createUserOpen) return;
      this.createUserError = error instanceof Error ? error.message : 'Could not load verified domains.';
    }
    this.render();
  }
  private async loadCreateUserLicenses(): Promise<void> {
    const generation = this.generation, context = this.contextValue;
    try {
      const result = await this.request<{ items: LicenseOption[]; partial: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'licenses.list' }),
      });
      if (generation !== this.generation || context !== this.contextValue || !this.createUserOpen) return;
      if (!Array.isArray(result.items) || result.partial || !result.items.every(item => typeof item.skuId === 'string' && typeof item.skuPartNumber === 'string'
        && typeof item.consumedUnits === 'number' && typeof item.prepaidUnits?.enabled === 'number')) throw new Error('Complete license inventory is unavailable.');
      this.createUserLicenses = result.items.filter(item => item.skuPartNumber === 'O365_BUSINESS_PREMIUM'
        && item.capabilityStatus === 'Enabled' && item.prepaidUnits.enabled > item.consumedUnits);
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || !this.createUserOpen) return;
      this.createLicenseCatalogError = error instanceof Error ? error.message : 'Could not load license inventory.';
      this.createUserLicenses = [];
    }
    this.render();
  }
  private async createUser(): Promise<void> {
    if (!this.connection?.canManage || this.createUserBusy || this.createdUser || !this.createUserDomains?.length) return;
    const name = this.root.querySelector<HTMLInputElement>('#create-user-name')?.value.trim() ?? '';
    const local = this.root.querySelector<HTMLInputElement>('#create-user-local')?.value.trim() ?? '';
    const domain = this.root.querySelector<HTMLSelectElement>('#create-user-domain')?.value ?? '';
    const location = this.root.querySelector<HTMLInputElement>('#create-user-location')?.value.trim().toUpperCase() ?? '';
    const skuId = this.root.querySelector<HTMLSelectElement>('#create-user-license')?.value ?? '';
    this.createUserDraft = { name, local, domain, location, skuId };
    if (!name || !/^[A-Za-z0-9'.!#^~_-]+$/.test(local) || !this.createUserDomains.includes(domain)) {
      this.createUserError = 'Enter a name and valid sign-in name using a verified domain.'; this.render(); return;
    }
    if ((location && !/^[A-Z]{2}$/.test(location)) || (skuId && (!location || !this.createUserLicenses?.some(item => item.skuId === skuId)))) {
      this.createUserError = 'A Business Standard license needs an available seat and a two-letter usage location.'; this.render(); return;
    }
    const generation = this.generation, context = this.contextValue;
    this.createUserBusy = true; this.createUserError = ''; this.render();
    try {
      const result = await this.request<{ accepted: boolean; id: string; userPrincipalName: string; temporaryPassword: string }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'user.create', user: { displayName: name, userPrincipalName: `${local}@${domain}`, ...(location ? { usageLocation: location } : {}) } }),
      });
      if (generation !== this.generation || context !== this.contextValue || !this.createUserOpen) return;
      if (!result.accepted || !result.id || !result.temporaryPassword) throw new Error('Creation outcome is uncertain. Refresh the directory before trying again.');
      this.createdUser = { id: result.id, userPrincipalName: result.userPrincipalName, temporaryPassword: result.temporaryPassword };
      this.render();
      if (skuId) {
        try {
          const assignment = await this.request<{ accepted: boolean; verified: boolean }>(this.path('/administration'), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'user.license.assign', id: result.id, license: { skuId } }),
          });
          if (generation !== this.generation || context !== this.contextValue || !this.createUserOpen) return;
          this.createLicenseOutcome = assignment.accepted
            ? assignment.verified ? 'Business Standard assigned and verified.' : 'Microsoft accepted the license assignment. Refresh the user to verify it appears.'
            : 'License assignment was not confirmed. Review the user before retrying.';
          this.createLicenseOutcomeError = !assignment.accepted || !assignment.verified;
        } catch (error) {
          if (generation !== this.generation || context !== this.contextValue || !this.createUserOpen) return;
          this.createLicenseOutcome = `User created; license assignment was not confirmed. ${error instanceof Error ? error.message : 'Review the user before retrying.'}`;
          this.createLicenseOutcomeError = true;
        }
      }
      void this.loadResource();
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && this.createUserOpen)
        this.createUserError = error instanceof Error ? error.message : 'Creation outcome is uncertain. Refresh before retrying.';
    } finally {
      if (generation === this.generation && context === this.contextValue) { this.createUserBusy = false; this.render(); }
    }
  }
  private openMfa(row: ResourceRow): void {
    if (!this.connection?.canManage) return;
    this.openDetail(row);
    this.mfaOpen = true; this.mfaMethods = null; this.mfaLoading = true; this.mfaError = ''; this.mfaRemoval = null; this.mfaConfirmation = '';
    this.render();
    void this.loadMfaMethods(row.id);
  }
  private closeDetail(): void {
    const id = this.returnFocus;
    this.detail = null;
    this.detailRecord = null;
    this.detailRequest += 1;
    this.userVerificationRequest += 1;
    this.userSecurityRequest += 1;
    this.globalAdminRequest += 1;
    this.userSecurityAction = null; this.userSecurityConfirmed = false; this.temporaryPassword = null;
    this.globalAdminStatus = null; this.globalAdminDraft = null; this.globalAdminLoading = false; this.globalAdminError = ''; this.globalAdminConfirmation = '';
    this.mfaOpen = false; this.mfaMethods = null; this.mfaLoading = false; this.mfaError = ''; this.mfaRemoval = null; this.mfaConfirmation = ''; this.mfaRequest += 1;
    this.busy = false;
    this.drawerMessage = '';
    this.drawerError = false;
    this.membershipUserId = '';
    this.membershipUsers = null;
    this.membershipSearch = '';
    this.membershipUsersRequest += 1;
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

  private async loadMembershipUsers(groupId: string): Promise<void> {
    const generation = this.generation;
    const context = this.contextValue;
    const request = ++this.membershipUsersRequest;
    try {
      const data = parseResourceData(await this.request<unknown>(this.path('/resources/users')));
      if (generation !== this.generation || context !== this.contextValue || request !== this.membershipUsersRequest || this.detail?.id !== groupId || this.detailKind !== 'group') return;
      this.membershipUsers = data;
      this.render();
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.membershipUsersRequest || this.detail?.id !== groupId || this.detailKind !== 'group') return;
      this.drawerError = true;
      this.drawerMessage = error instanceof Error ? error.message : 'Could not load users for the member picker.';
      this.render();
    }
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

  private async loadGlobalAdminStatus(id: string): Promise<void> {
    const generation = this.generation;
    const context = this.contextValue;
    const request = ++this.globalAdminRequest;
    try {
      const body = await this.request<unknown>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user.globalAdmin.get', id }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.globalAdminRequest || this.detail?.id !== id || this.detailKind !== 'user') return;
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as MicrosoftRecord).enabled !== 'boolean') throw new Error('Invalid Global Administrator status response.');
      this.globalAdminStatus = (body as { enabled: boolean }).enabled;
      this.globalAdminDraft = this.globalAdminStatus;
      this.globalAdminError = '';
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.globalAdminRequest || this.detail?.id !== id || this.detailKind !== 'user') return;
      this.globalAdminStatus = null;
      this.globalAdminDraft = null;
      this.globalAdminError = error instanceof Error ? error.message : 'Global Administrator status is unavailable.';
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.globalAdminRequest && this.detail?.id === id && this.detailKind === 'user') {
        this.globalAdminLoading = false;
        this.render();
      }
    }
  }

  private async saveGlobalAdmin(): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'user' || this.busy || this.globalAdminStatus === null || this.globalAdminDraft === null || this.globalAdminDraft === this.globalAdminStatus) return;
    if (this.globalAdminConfirmation !== 'GLOBAL_ADMIN') {
      this.drawerError = true; this.drawerMessage = 'Type GLOBAL_ADMIN to confirm this privileged role change.'; this.render(); return;
    }
    const id = this.detail.id; const enabled = this.globalAdminDraft; const generation = this.generation; const context = this.contextValue; const request = ++this.globalAdminRequest;
    const current = () => generation === this.generation && context === this.contextValue && request === this.globalAdminRequest && this.detail?.id === id && this.detailKind === 'user';
    this.busy = true; this.drawerError = false; this.drawerMessage = 'Saving Global Administrator role…'; this.render();
    try {
      const result = await this.request<{ accepted?: boolean }>(this.path('/administration'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user.globalAdmin.set', id, enabled, confirmation: 'GLOBAL_ADMIN' }) });
      if (!current()) return;
      if (result.accepted !== true) throw new Error('Microsoft did not accept the Global Administrator role change.');
      const readback = await this.request<unknown>(this.path('/administration'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user.globalAdmin.get', id }) });
      if (!current()) return;
      if (!readback || typeof readback !== 'object' || Array.isArray(readback) || typeof (readback as MicrosoftRecord).enabled !== 'boolean') throw new Error('Global Administrator role readback was unavailable. Review the account before retrying.');
      const confirmed = (readback as { enabled: boolean }).enabled;
      this.globalAdminStatus = confirmed; this.globalAdminDraft = confirmed;
      if (confirmed !== enabled) throw new Error('Microsoft accepted the role change, but readback did not confirm it. Review the account before retrying.');
      this.globalAdminConfirmation = '';
      this.drawerError = false; this.drawerMessage = enabled ? 'Global Administrator role enabled and verified.' : 'Global Administrator role removed and verified.';
    } catch (error) {
      if (current()) { this.drawerError = true; this.drawerMessage = error instanceof Error ? error.message : 'Global Administrator role outcome is uncertain. Review the account before retrying.'; }
    } finally { if (current()) { this.busy = false; this.render(); } }
  }

  private mfaRequestIsCurrent(id: string, generation: number, context: ExtensionPageContextV1 | null, request: number): boolean {
    return generation === this.generation && context === this.contextValue && request === this.mfaRequest && this.detail?.id === id && this.detailKind === 'user' && this.mfaOpen;
  }
  private mfaMethodLabel(method: MfaMethod): string {
    return ({ phone: 'Phone', microsoftAuthenticator: 'Microsoft Authenticator', email: 'Email', fido2: 'Security key', password: 'Password', softwareOath: 'Software OATH', temporaryAccessPass: 'Temporary Access Pass', windowsHelloForBusiness: 'Windows Hello for Business', platformCredential: 'Platform credential', other: 'Other authentication method' } as const)[method.type];
  }
  private async loadMfaMethods(id: string, request = ++this.mfaRequest): Promise<MfaMethod[] | null> {
    const generation = this.generation; const context = this.contextValue;
    try {
      const body = await this.request<unknown>(this.path('/administration'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user.mfa.methods.list', id }) });
      if (!this.mfaRequestIsCurrent(id, generation, context, request)) return null;
      const methods = parseMfaMethods(body);
      this.mfaMethods = methods; this.mfaError = '';
      return methods;
    } catch (error) {
      if (this.mfaRequestIsCurrent(id, generation, context, request)) { this.mfaMethods = null; this.mfaError = error instanceof Error ? error.message : 'MFA methods are unavailable.'; }
      return null;
    } finally {
      if (this.mfaRequestIsCurrent(id, generation, context, request)) { this.mfaLoading = false; this.render(); }
    }
  }
  private async removeMfaMethod(): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'user' || !this.mfaOpen || !this.mfaRemoval || this.busy) return;
    if (this.mfaConfirmation !== 'REMOVE_AUTH_METHOD') { this.drawerError = true; this.drawerMessage = 'Type REMOVE_AUTH_METHOD to confirm this authentication-method removal.'; this.render(); return; }
    const id = this.detail.id; const method = this.mfaRemoval; const generation = this.generation; const context = this.contextValue; const request = ++this.mfaRequest;
    const current = () => this.mfaRequestIsCurrent(id, generation, context, request);
    this.busy = true; this.drawerError = false; this.drawerMessage = 'Removing authentication method…'; this.render();
    try {
      const result = await this.request<{ accepted?: boolean }>(this.path('/administration'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user.mfa.method.remove', id, kind: method.type, methodId: method.id, confirmation: 'REMOVE_AUTH_METHOD' }) });
      if (!current()) return;
      if (result.accepted !== true) throw new Error('Microsoft did not accept the authentication-method removal.');
      this.mfaLoading = true;
      const methods = await this.loadMfaMethods(id, request);
      if (!methods || !current()) return;
      if (methods.some(item => item.id === method.id && item.type === method.type)) throw new Error('Microsoft accepted the removal, but method readback did not confirm it. Review the account before retrying.');
      this.mfaRemoval = null; this.mfaConfirmation = '';
      this.drawerError = false; this.drawerMessage = 'Authentication method removed and verified.';
    } catch (error) {
      if (current()) { this.drawerError = true; this.drawerMessage = error instanceof Error ? error.message : 'Authentication-method removal outcome is uncertain. Review the account before retrying.'; }
    } finally { if (current()) { this.busy = false; this.mfaLoading = false; this.render(); } }
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
    if (this.data) this.visibleColumns = this.defaultVisibleColumns(this.data);
    this.render();
  }
  private directoryColumns(): Array<{ key: string; label: string; defaultHidden?: boolean }> {
    return this.resource === 'users' ? [...USER_DIRECTORY_COLUMNS] : (this.data?.columns ?? []);
  }
  private defaultVisibleColumns(data: ResourceData): string[] {
    const columns = this.resource === 'users' ? USER_DIRECTORY_COLUMNS : data.columns;
    return columns.filter(column => !('defaultHidden' in column && column.defaultHidden)).map(column => column.key);
  }
  private userDirectoryValue(row: ResourceRow, key: string): string | number | boolean | null {
    if (key === 'mailbox' || key === 'archive') return 'Unavailable';
    if (key === 'oneDrive') return typeof row.values.oneDrive === 'string' && row.values.oneDrive ? row.values.oneDrive : 'Unavailable';
    // Graph's Member/Guest value is an identity classification, not the old
    // Cloud Command mailbox type. Only the exceptional Guest classification is
    // meaningful to technicians until Exchange supplies mailbox type.
    if (key === 'userType') return String(row.values.userType ?? '').toLowerCase() === 'guest' ? 'Guest' : 'Unavailable';
    if (key === 'exclude') return this.directoryExclusionsReady ? (this.directoryExclusions.get(row.id) ? 'Excluded' : 'Included') : 'Unavailable';
    return row.values[key] ?? null;
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
    return Object.entries(update).every(([field, value]) => field === 'accountEnabled'
      ? user.accountEnabled === value
      : String(user[field] ?? '') === value);
  }
  private async saveUserField(field: (typeof USER_FIELDS)[number] | 'accountEnabled'): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'user' || this.busy) return;
    const input = this.root.querySelector<HTMLInputElement>(field === 'accountEnabled' ? '#user-account-enabled' : `#user-${field}`);
    if (!input || !this.detailRecord) return;
    const value: string | boolean = field === 'accountEnabled' ? input.checked : input.value;
    const current = field === 'accountEnabled' ? this.detailRecord.accountEnabled === true : String(this.detailRecord[field] ?? '');
    // Each account property is an independent Microsoft operation, matching
    // Cloud Command's field-level save behavior.
    if (current === value) return;
    const changes: Record<string, string | boolean> = { [field]: value };
    const id = this.detail.id; const generation = this.generation; const context = this.contextValue; const verification = ++this.userVerificationRequest;
    this.busy = true; this.drawerError = false; this.drawerMessage = `Saving ${field === 'displayName' ? 'name' : field === 'accountEnabled' ? 'account access' : field}…`; this.render();
    try {
      const result = await this.request<{ accepted?: boolean }>(this.path('/administration'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user.update', id, update: changes }) });
      if (result.accepted !== true) throw new Error('Microsoft did not accept the user update.');
      if (!this.userVerificationIsCurrent(id, generation, context, verification)) return;
      for (let attempt = 0; attempt < USER_VERIFY_READS; attempt += 1) {
        const readback = await this.readUserForVerification(id, generation, context, verification);
        if (!readback || !this.userVerificationIsCurrent(id, generation, context, verification)) return;
        this.detailRecord = readback;
        if (this.userMatchesUpdate(readback, changes)) {
          this.detailRecord = readback;
          const row = this.data?.items.find(item => item.id === id);
          if (row) for (const field of [...USER_FIELDS, 'accountEnabled'] as const) {
            if (field in readback && typeof readback[field] !== 'object') row.values[field] = readback[field] as string | number | boolean | null;
          }
          delete this.userDraft[field as keyof UserDraft];
          this.drawerError = false; this.drawerMessage = `${field === 'displayName' ? 'Name' : field === 'accountEnabled' ? 'Account access' : field} saved and verified.`; return;
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
    const verification = ++this.userVerificationRequest;
    this.temporaryPassword = null; this.busy = true; this.drawerError = false;
    const stateChange = action === 'block-sign-in' || action === 'restore-sign-in';
    this.drawerMessage = action === 'reset-password' ? 'Resetting password…' : action === 'revoke-sessions' ? 'Signing out user sessions…' : action === 'block-sign-in' ? 'Blocking sign-in…' : 'Restoring sign-in…'; this.render();
    const current = () => this.isConnected && generation === this.generation && context === this.contextValue
      && request === this.userSecurityRequest && this.detail?.id === id && this.detailKind === 'user';
    try {
      const result = await this.request<{ accepted?: boolean; temporaryPassword?: string; forceChangePasswordNextSignIn?: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: action === 'reset-password' ? 'user.password.reset' : action === 'revoke-sessions' ? 'user.sessions.revoke' : 'user.update',
          id,
          ...(stateChange ? { update: { accountEnabled: action === 'restore-sign-in' } } : {}),
        }),
      });
      if (!current()) return;
      if (result.accepted !== true) throw new Error('Microsoft did not confirm the security action. Refresh before trying again.');
      if (action === 'reset-password') {
        if (typeof result.temporaryPassword !== 'string' || result.forceChangePasswordNextSignIn !== true)
          throw new Error('Microsoft accepted the reset, but the one-time password could not be safely displayed. Do not retry before checking the account.');
        this.temporaryPassword = result.temporaryPassword;
        this.drawerError = false; this.drawerMessage = 'Password reset. Share this temporary password securely; the user must change it at next sign-in.';
      } else if (stateChange) {
        const expected = action === 'restore-sign-in';
        let verified = false;
        for (let attempt = 0; attempt < USER_VERIFY_READS; attempt += 1) {
          const readback = await this.readUserForVerification(id, generation, context, verification);
          if (!readback || !current() || !this.userVerificationIsCurrent(id, generation, context, verification)) return;
          this.detailRecord = readback;
          if (readback.accountEnabled === expected) { verified = true; break; }
          if (attempt < USER_VERIFY_READS - 1) await new Promise<void>(resolve => setTimeout(resolve, USER_VERIFY_DELAY_MS));
        }
        if (!verified) throw new Error('Microsoft accepted the sign-in state change, but readback did not confirm it. Refresh before trying again.');
        const row = this.data?.items.find(item => item.id === id);
        if (row) row.values.accountEnabled = expected;
        this.drawerError = false;
        this.drawerMessage = expected ? 'Sign-in restored and verified.' : 'Sign-in blocked and verified.';
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
    const userId = this.membershipUserId;
    const action = this.root.querySelector<HTMLSelectElement>('#group-member-action')?.value ?? this.membershipAction;
    const confirmed = this.root.querySelector<HTMLInputElement>('#group-member-confirm')?.checked ?? this.membershipConfirmed;
    this.membershipUserId = userId;
    if (action === 'add' || action === 'remove') this.membershipAction = action;
    this.membershipConfirmed = confirmed;
    if (!userId || (action !== 'add' && action !== 'remove') || !confirmed) { this.drawerError = true; this.drawerMessage = 'Choose a user and confirm this membership change.'; this.render(); return; }
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
      if (this.mfaOpen) {
        const methods = this.mfaMethods?.map(method => `<li><span><strong>${this.mfaMethodLabel(method)}</strong><small>${esc(method.detail || 'No additional detail available')}</small></span>${method.removable && method.id && (method.type === 'phone' || method.type === 'microsoftAuthenticator') ? `<button class="secondary compact" data-mfa-remove="${esc(method.id)}" data-mfa-kind="${method.type}" ${this.busy ? 'disabled' : ''}>Remove</button>` : '<small>Not removable</small>'}</li>`).join('') ?? '';
        const removal = this.mfaRemoval ? `<div class="security-confirmation" role="group"><p>Remove ${esc(this.mfaRemoval.type === 'phone' ? 'phone' : 'Microsoft Authenticator')} method: ${esc(this.mfaRemoval.detail || 'No additional detail available')}.</p><label>Type REMOVE_AUTH_METHOD to confirm<input id="mfa-removal-confirmation" value="${esc(this.mfaConfirmation)}" autocomplete="off" ${this.busy ? 'disabled' : ''}></label><div class="actions"><button class="secondary" id="mfa-removal-cancel" ${this.busy ? 'disabled' : ''}>Cancel</button><button id="mfa-removal-submit" ${this.busy ? 'disabled' : ''}>Remove method</button></div></div>` : '';
        const inventory = this.mfaLoading ? '<p class="meta">Loading authentication methods…</p>' : this.mfaMethods ? methods ? `<ul class="mfa-methods">${methods}</ul>` : '<p class="meta">No supported removable phone or Authenticator methods are registered.</p>' : `<p class="meta">MFA methods unavailable${this.mfaError ? `: ${esc(this.mfaError)}` : ''}</p>`;
        content = `<div class="drawer-body"><section class="drawer-section"><h3>MFA methods</h3>${inventory}${removal}</section><section class="drawer-section"><h3>Unavailable</h3><p class="meta">Save phone, recovery email, re-registration, and per-user MFA state are unavailable until their backend operations exist.</p></section></div><footer class="drawer-footer">${feedback}</footer>`;
      } else {
      const field = (name: typeof USER_FIELDS[number], label: string) => `<div class="user-field"><label><span>${label}</span><input id="user-${name}" value="${esc(String(this.userDraft[name] ?? record[name] ?? ''))}" ${this.busy || !canManage ? 'disabled' : ''}></label>${canManage ? `<button class="secondary" type="button" data-user-save="${name}" ${this.busy || String(this.userDraft[name] ?? record[name] ?? '') === String(record[name] ?? '') ? 'disabled' : ''}>Save</button>` : ''}</div>`;
      const securityConfirmation = this.userSecurityAction ? `<div class="security-confirmation" role="group" aria-label="Confirm security action"><p>${this.userSecurityAction === 'reset-password' ? 'Microsoft will set a new temporary password and require the user to change it at next sign-in.' : this.userSecurityAction === 'revoke-sessions' ? 'Microsoft will invalidate refresh tokens and browser session cookies. Users may need to sign in again; revocation can take a few minutes.' : this.userSecurityAction === 'block-sign-in' ? 'Microsoft will block this account from signing in.' : 'Microsoft will allow this account to sign in again.'}</p><label class="check"><input id="user-security-confirm" type="checkbox" ${this.userSecurityConfirmed ? 'checked' : ''} ${this.busy ? 'disabled' : ''}> I confirm this security action</label><div class="actions"><button class="secondary" id="user-security-cancel" ${this.busy ? 'disabled' : ''}>Cancel</button><button id="user-security-submit" ${this.busy ? 'disabled' : ''}>${this.userSecurityAction === 'reset-password' ? 'Reset password' : this.userSecurityAction === 'revoke-sessions' ? 'Sign out all sessions' : this.userSecurityAction === 'block-sign-in' ? 'Block sign-in' : 'Restore sign-in'}</button></div></div>` : '';
      const passwordDisplay = this.temporaryPassword ? `<div class="one-time-secret" role="status"><strong>Temporary password</strong><code id="temporary-password">${esc(this.temporaryPassword)}</code><p>It is shown only in this drawer. Copy it now; closing the drawer clears it.</p><button class="secondary compact" id="copy-temporary-password">Copy password</button><button class="secondary compact" id="hide-temporary-password">Hide password</button></div>` : '';
      const globalAdmin = this.globalAdminLoading ? '<p class="meta" data-testid="global-admin-status">Loading Global Administrator status…</p>' : this.globalAdminStatus === null ? `<p class="meta" data-testid="global-admin-status">Global Administrator status unavailable${this.globalAdminError ? `: ${esc(this.globalAdminError)}` : ''}</p>` : canManage ? `<div class="role-field"><label class="check"><input id="global-admin-enabled" type="checkbox" ${this.globalAdminDraft ? 'checked' : ''} ${this.busy ? 'disabled' : ''}> Global Administrator</label>${this.globalAdminDraft !== this.globalAdminStatus ? `<label>Type GLOBAL_ADMIN to confirm<input id="global-admin-confirmation" value="${esc(this.globalAdminConfirmation)}" autocomplete="off" ${this.busy ? 'disabled' : ''}></label><button class="secondary compact" id="global-admin-save" ${this.busy ? 'disabled' : ''}>Save role</button>` : ''}</div>` : `<p class="meta" data-testid="global-admin-status">Global Administrator: ${this.globalAdminStatus ? 'Enabled' : 'Not assigned'}</p>`;
      content = `<div class="drawer-body"><section class="drawer-section"><h3>Account</h3><div class="field-grid">${field('displayName', 'Name')}</div><div class="role-field">${globalAdmin}</div></section>${canManage ? `<section class="drawer-section"><h3>Security</h3><div class="actions"><button class="secondary" id="user-password-reset-start" ${this.busy ? 'disabled' : ''}>Reset password</button><button class="secondary" id="user-sessions-revoke-start" ${this.busy ? 'disabled' : ''}>Sign out of all sessions</button></div>${securityConfirmation}${passwordDisplay}</section>` : ''}</div><footer class="drawer-footer">${canManage ? '' : '<p class="read-only">An organization administrator can edit this user.</p>'}${feedback}</footer>`;
      }
    } else {
      const query = this.membershipSearch.trim().toLowerCase();
      const users = this.membershipUsers?.items.filter(user => `${user.values.displayName ?? ''} ${user.values.userPrincipalName ?? user.values.mail ?? ''}`.toLowerCase().includes(query)) ?? [];
      const selected = this.membershipUsers?.items.find(user => user.id === this.membershipUserId);
      const picker = !this.membershipUsers ? '<p class="meta" data-testid="member-picker-status">Loading users for member picker…</p>' : !users.length ? '<p class="meta" data-testid="member-picker-status">No loaded users match this search.</p>' : `<div class="member-options" role="listbox" aria-label="Choose user">${users.slice(0, 20).map(user => { const name = String(user.values.displayName ?? user.id); const email = user.values.userPrincipalName ?? user.values.mail; return `<button type="button" class="member-option ${user.id === this.membershipUserId ? 'selected' : ''}" data-member-user="${esc(user.id)}" role="option" aria-selected="${user.id === this.membershipUserId}" ${this.busy ? 'disabled' : ''}><strong>${esc(name)}</strong>${email ? `<small>${esc(String(email))}</small>` : ''}</button>`; }).join('')}</div>`;
      content = `<div class="drawer-body"><p class="meta">${record.displayName ? `Group: ${esc(String(record.displayName))}` : 'Group details loaded.'}</p>${canManage ? `<section class="drawer-section"><h3>Membership</h3><label>Find user<input id="group-member-search" value="${esc(this.membershipSearch)}" placeholder="Search loaded names or emails" autocomplete="off" ${this.busy ? 'disabled' : ''}></label>${picker}${selected ? `<p class="meta">Selected: ${esc(String(selected.values.displayName ?? selected.id))}</p>` : ''}<label>Membership action<select id="group-member-action" ${this.busy ? 'disabled' : ''}><option value="add" ${this.membershipAction === 'add' ? 'selected' : ''}>Add member</option><option value="remove" ${this.membershipAction === 'remove' ? 'selected' : ''}>Remove member</option></select></label><label class="check"><input id="group-member-confirm" type="checkbox" ${this.membershipConfirmed ? 'checked' : ''} ${this.busy ? 'disabled' : ''}> I confirm this membership change</label></section>` : '<p class="read-only">An organization administrator can change group membership.</p>'}</div><footer class="drawer-footer">${canManage ? `<div class="actions"><button id="group-member-submit" ${this.busy || !this.membershipUserId ? 'disabled' : ''}>Confirm membership change</button></div>` : ''}${feedback}</footer>`;
    }
    const title = this.detailKind === 'user' ? (canManage ? 'Edit account' : 'View account') : this.detailKind === 'group' ? 'Manage members' : 'Resource details';
    return `<div class="backdrop" data-backdrop><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title"><div class="heading drawer-heading"><div><h2 id="detail-title">${title}</h2>${subtitle ? `<p class="subtle">${subtitle}</p>` : ''}</div><button class="secondary compact" id="detail-close">Close</button></div>${content}</aside></div>`;
  }

  private renderCreateUserDrawer(): string {
    const domains = this.createUserDomains;
    const done = this.createdUser;
    const licenseOptions = this.createUserLicenses?.map(item => `<option value="${esc(item.skuId)}" ${item.skuId === this.createUserDraft.skuId ? 'selected' : ''}>Business Standard · ${item.prepaidUnits.enabled - item.consumedUnits} available</option>`).join('') ?? '';
    const licenseForm = `<section class="drawer-section"><h3>Assignments</h3><label>Usage location (ISO country code)<input id="create-user-location" aria-label="Usage location" maxlength="2" autocomplete="off" value="${esc(this.createUserDraft.location)}" placeholder="US, GB, CA…" ${this.createUserBusy ? 'disabled' : ''}></label><label>License<select id="create-user-license" aria-label="License" ${this.createUserBusy || this.createUserLicenses === null ? 'disabled' : ''}><option value="">No license</option>${licenseOptions}</select></label>${this.createLicenseCatalogError ? `<p class="meta">${esc(this.createLicenseCatalogError)} You can create the user without a license.</p>` : this.createUserLicenses === null ? '<p class="meta">Loading available Business Standard seats…</p>' : !this.createUserLicenses.length ? '<p class="meta">No Business Standard seats are available.</p>' : ''}<p class="meta">MFA enrollment, aliases, and group membership remain separate actions after creation.</p></section>`;
    const licenseStatus = this.createLicenseOutcome ? `<p class="status" data-error="${this.createLicenseOutcomeError}" role="status">${esc(this.createLicenseOutcome)}</p>` : '';
    const status = this.createUserError ? `<p class="status" data-error="true" role="alert">${esc(this.createUserError)}</p>` : '';
    const content = done ? `<div class="drawer-body"><section class="drawer-section"><h3>Created account</h3><p>${esc(done.userPrincipalName)}</p><label>Temporary password<input aria-label="Temporary password" type="text" readonly value="${esc(done.temporaryPassword)}"></label><p class="meta">Copy this password now. It is shown only in this drawer; the user must change it at next sign-in. It may take a moment to appear in the directory.</p></section><section class="drawer-section"><h3>Next assignments</h3>${licenseStatus}<p class="meta">MFA enrollment, aliases, and group membership remain separate actions; they were not applied during creation.</p></section></div>` : `<div class="drawer-body"><section class="drawer-section"><h3>Account</h3><label>Name<input id="create-user-name" aria-label="Name" maxlength="256" value="${esc(this.createUserDraft.name)}" placeholder="Full name" ${this.createUserBusy ? 'disabled' : ''}></label><label>Sign-in name<div class="upn-field"><input id="create-user-local" aria-label="Sign-in name" maxlength="64" value="${esc(this.createUserDraft.local)}" placeholder="name" ${this.createUserBusy ? 'disabled' : ''}><span>@</span><select id="create-user-domain" aria-label="Domain" ${!domains?.length || this.createUserBusy ? 'disabled' : ''}>${domains?.length ? domains.map(domain => `<option value="${esc(domain)}" ${domain === this.createUserDraft.domain ? 'selected' : ''}>${esc(domain)}</option>`).join('') : '<option>Loading verified domains…</option>'}</select></div></label></section><section class="drawer-section"><h3>Sign-in</h3><p class="meta">A temporary password is generated securely when the user is created.</p><label class="check"><input type="checkbox" checked disabled> Force change password at next sign-in</label></section>${licenseForm}</div>`;
    return `<div class="backdrop" data-create-user-backdrop><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="create-user-title"><div class="heading drawer-heading"><div><h2 id="create-user-title">Add user</h2><p class="subtle">${done ? 'Account created' : 'Create a Microsoft 365 user'}</p></div><button class="secondary compact" id="create-user-close" ${this.createUserBusy ? 'disabled' : ''}>Close</button></div>${status}${content}<footer class="drawer-footer"><div class="actions">${done ? '' : `<button id="create-user-submit" ${!domains?.length || this.createUserBusy ? 'disabled' : ''}>Create user</button>`}</div></footer></aside></div>`;
  }

  private render(): void {
    const connection = this.connection;
    const canManage = connection?.canManage === true;
    const canRead = this.canRead();
    const scoped = this.data?.items.filter(row => this.resource !== 'users' || (this.directoryScope === 'exclude' ? this.directoryExclusions.get(row.id) === true : this.directoryExclusions.get(row.id) !== true)) ?? [];
    const filtered = scoped.filter(row => JSON.stringify(row.values).toLowerCase().includes(this.filter.toLowerCase()));
    const allColumns = this.directoryColumns();
    const columns = allColumns.filter((column, index) => index === 0 || this.visibleColumns.includes(column.key));
    const loadedCount = this.data ? `${this.data.items.length}${this.data.complete ? '' : ' loaded'}` : '—';
    const tenant = connection?.tenantName || 'Microsoft 365 tenant';
    const createControl = canManage && this.resource === 'users' ? '<button class="secondary compact" id="create-user">Add user</button>' : '';
    const tabs = `<button class="resource-tab" disabled title="A combined directory feed is not available">All</button><button data-resource="users" role="tab" aria-selected="${this.resource === 'users' && this.directoryScope === 'users'}" class="resource-tab" ${!canRead ? 'disabled' : ''}>Users</button><button class="resource-tab" disabled title="Shared-mailbox inventory requires an Exchange worker">Shared mailboxes</button><button data-resource="groups" role="tab" aria-selected="${this.resource === 'groups'}" class="resource-tab" ${!canRead ? 'disabled' : ''}>Groups</button><button data-directory-scope="exclude" role="tab" aria-selected="${this.resource === 'users' && this.directoryScope === 'exclude'}" class="resource-tab" ${!canRead || this.resource !== 'users' ? 'disabled' : ''}>Exclude</button>`;
    const chips = this.data ? `<div class="column-tools"><span>Columns</span>${allColumns.map((column, index) => `<button class="column-chip" data-column="${esc(column.key)}" aria-pressed="${index === 0 || this.visibleColumns.includes(column.key)}" ${index === 0 ? 'disabled' : ''}>${esc(column.label)}</button>`).join('')}<button class="secondary compact" id="reset-columns">Reset</button></div>` : '';
    const rows = filtered.map(row => {
      const expanded = this.expandedRowId === row.id;
      const cells = columns.map((column, index) => {
        const value = this.resource === 'users' ? this.userDirectoryValue(row, column.key) : row.values[column.key];
        return `<td class="${index === 0 ? 'identity' : ''}">${index === 0 ? this.rowIdentity(row, column) : typeof value === 'boolean' ? `<span class="state ${value ? 'on' : ''}">${value ? 'Enabled' : 'Disabled'}</span>` : esc(String(value ?? 'Unavailable'))}</td>`;
      }).join('');
      const action = this.resource === 'users' ? `<button class="secondary compact" data-testid="row-${esc(row.id)}" data-expand="${esc(row.id)}" aria-expanded="${expanded}">${canManage ? 'Account' : 'View account'} <span aria-hidden="true">${expanded ? '⌃' : '⌄'}</span></button>` : `<button class="secondary compact" data-testid="row-${esc(row.id)}" data-detail="${esc(row.id)}">${this.resource === 'groups' ? 'Manage members' : 'View details'}</button>`;
      const signInAction: UserSecurityAction = row.values.accountEnabled === false ? 'restore-sign-in' : 'block-sign-in';
      const excluded = this.directoryExclusions.get(row.id) === true;
      const expandedRow = this.resource === 'users' && expanded ? `<tr class="row-actions"><td colspan="${columns.length + 1}"><div class="actionline"><span>Account</span><button class="secondary compact" data-detail="${esc(row.id)}">${canManage ? 'Edit account' : 'View account'}</button><button class="secondary compact" data-directory-exclude="${esc(row.id)}" data-excluded="${!excluded}" ${!canManage ? 'disabled' : ''}>${excluded ? 'Include user' : 'Exclude user'}</button><small>Add-to-group and delete workflows are unavailable.</small></div><div class="actionline"><span>Security</span><button class="secondary compact" data-row-security="reset-password" data-row-id="${esc(row.id)}" ${!canManage ? 'disabled' : ''}>Reset password</button><button class="secondary compact" data-row-security="${signInAction}" data-row-id="${esc(row.id)}" ${!canManage ? 'disabled' : ''}>${signInAction === 'block-sign-in' ? 'Block sign-in' : 'Restore sign-in'}</button><button class="secondary compact" data-row-security="revoke-sessions" data-row-id="${esc(row.id)}" ${!canManage ? 'disabled' : ''}>Sign out of all sessions</button><button class="secondary compact" data-mfa="${esc(row.id)}" ${!canManage ? 'disabled' : ''}>MFA</button></div><div class="actionline"><span>Mailbox</span><small>Mailbox delegation, forwarding, and out-of-office require an Exchange worker.</small></div></td></tr>` : '';
      return `<tr class="${this.detail?.id === row.id || expanded ? 'selected-row' : ''}">${cells}<td class="row-control">${action}</td></tr>${expandedRow}`;
    }).join('');
    const exclusionUnavailable = this.resource === 'users' && this.directoryScope === 'exclude' && !!this.directoryExclusionError;
    const inventory = !canRead ? `<div class="empty">${connection?.connected && connection.enabled === false ? 'Enable this connection before loading inventory.' : 'Connect Microsoft 365 in Extensions > Connect before loading inventory.'}</div>` : !this.data ? `<div class="empty">${this.error ? `Could not load ${labels[this.resource].toLowerCase()}. Use Refresh to try again.` : `Loading current ${labels[this.resource].toLowerCase()}…`}</div>` : exclusionUnavailable ? `<div class="empty">Could not load directory exclusions. Refresh before reviewing excluded users.</div>` : !filtered.length ? `<div class="empty">${this.filter ? 'No rows match this search.' : `No ${labels[this.resource].toLowerCase()} are available for this tenant.`}</div>` : `<div class="table-wrap"><table><thead><tr>${columns.map(column => `<th>${esc(column.label)}</th>`).join('')}<th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    this.root.innerHTML = `<style>${styles}${createUserStyles}${healthStyles}</style><main><header><div><p class="eyebrow">Microsoft 365</p><h1>Directory</h1><p class="subtle">${esc(tenant)} · ${labels[this.resource]}: ${loadedCount}</p></div><div class="header-actions">${createControl}<button class="secondary compact" id="health-open" aria-expanded="${this.healthOpen}" ${!canRead ? 'disabled' : ''}>Service health</button><span class="badge ${canRead ? 'ok' : ''}">${connection?.available === false ? 'Unavailable' : connection?.connected ? (connection.enabled === false ? 'Disabled' : 'Connected') : 'Not configured'}</span></div></header>${this.healthOpen && canRead ? this.renderHealth() : ''}${this.message ? `<p class="status" data-testid="status" data-error="${this.error}" aria-live="polite">${esc(this.message)}</p>` : '<p class="status" data-testid="status" aria-live="polite"></p>'}<section class="directory"><div class="directory-top">${canRead ? `<label class="filter"><span class="sr-only">Search ${labels[this.resource]}</span><input id="filter" data-testid="filter" value="${esc(this.filter)}" placeholder="${this.resource === 'users' ? 'Search name or email' : `Search ${labels[this.resource].toLowerCase()}`}"></label>` : ''}<nav class="resource-nav" role="tablist" aria-label="Microsoft directory resources">${tabs}</nav><button class="secondary compact" id="refresh-resource" ${!canRead ? 'disabled' : ''}>Refresh</button></div>${canRead ? `${chips}${this.data ? `<p class="meta">${this.data.complete ? 'Complete inventory' : 'Partial inventory'} · checked ${esc(this.formatCheckedAt(this.data.checkedAt))}</p>` : ''}${inventory}` : inventory}</section>${this.detail ? this.renderDrawer(canManage) : ''}${this.createUserOpen ? this.renderCreateUserDrawer() : ''}</main>`;
    this.root.querySelector('#health-open')?.addEventListener('click', () => { this.healthOpen = !this.healthOpen; this.render(); if (this.healthOpen && !this.health) void this.loadHealth(); });
    this.root.querySelector('#health-close')?.addEventListener('click', () => { this.healthOpen = false; this.render(); });
    this.root.querySelector('#health-refresh')?.addEventListener('click', () => void this.loadHealth());
    this.root.querySelector('#refresh-resource')?.addEventListener('click', () => void this.loadResource());
    this.root.querySelector('#create-user')?.addEventListener('click', () => this.openCreateUser());
    this.root.querySelector('#create-user-close')?.addEventListener('click', () => this.closeCreateUser());
    this.root.querySelector('#create-user-submit')?.addEventListener('click', () => void this.createUser());
    for (const [id, field] of [['create-user-name', 'name'], ['create-user-local', 'local'], ['create-user-location', 'location'], ['create-user-domain', 'domain'], ['create-user-license', 'skuId']] as const) {
      this.root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.addEventListener('input', event => {
        this.createUserDraft[field] = (event.target as HTMLInputElement | HTMLSelectElement).value;
      });
    }
    this.root.querySelector('[data-create-user-backdrop]')?.addEventListener('click', event => { if (event.target === event.currentTarget) this.closeCreateUser(); });
    this.root
      .querySelectorAll<HTMLButtonElement>('[data-resource]')
      .forEach((button) =>
        button.addEventListener('click', () => {
          if (button.dataset.resource === 'users' && this.resource === 'users') this.setDirectoryScope('users');
          else this.setResource(button.dataset.resource as Resource);
        }),
      );
    this.root.querySelectorAll<HTMLButtonElement>('[data-directory-scope]').forEach(button => button.addEventListener('click', () => this.setDirectoryScope('exclude')));
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
    this.root.querySelectorAll<HTMLButtonElement>('[data-row-security]').forEach(button => button.addEventListener('click', () => {
      const row = this.data?.items.find(item => item.id === button.dataset.rowId);
      const action = button.dataset.rowSecurity;
      if (row && (action === 'reset-password' || action === 'revoke-sessions' || action === 'block-sign-in' || action === 'restore-sign-in')) this.openDetail(row, action);
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-mfa]').forEach(button => button.addEventListener('click', () => {
      const row = this.data?.items.find(item => item.id === button.dataset.mfa);
      if (row) this.openMfa(row);
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-directory-exclude]').forEach(button => button.addEventListener('click', () => {
      const row = this.data?.items.find(item => item.id === button.dataset.directoryExclude);
      if (row) void this.setDirectoryExcluded(row, button.dataset.excluded === 'true');
    }));
    this.root.querySelector('#detail-close')?.addEventListener('click', () => this.closeDetail());
    this.root.querySelectorAll<HTMLButtonElement>('[data-user-save]').forEach(button => button.addEventListener('click', () => {
      const field = button.dataset.userSave as (typeof USER_FIELDS)[number] | 'accountEnabled';
      void this.saveUserField(field);
    }));
    this.root.querySelector('#user-password-reset-start')?.addEventListener('click', () => { this.userSecurityAction = 'reset-password'; this.userSecurityConfirmed = false; this.temporaryPassword = null; this.drawerError = false; this.drawerMessage = ''; this.render(); this.root.querySelector<HTMLInputElement>('#user-security-confirm')?.focus(); });
    this.root.querySelector('#user-sessions-revoke-start')?.addEventListener('click', () => { this.userSecurityAction = 'revoke-sessions'; this.userSecurityConfirmed = false; this.temporaryPassword = null; this.drawerError = false; this.drawerMessage = ''; this.render(); this.root.querySelector<HTMLInputElement>('#user-security-confirm')?.focus(); });
    this.root.querySelector<HTMLInputElement>('#user-security-confirm')?.addEventListener('change', event => { this.userSecurityConfirmed = (event.target as HTMLInputElement).checked; });
    this.root.querySelector('#user-security-cancel')?.addEventListener('click', () => { this.userSecurityRequest += 1; this.userSecurityAction = null; this.userSecurityConfirmed = false; this.drawerError = false; this.drawerMessage = ''; this.render(); });
    this.root.querySelector('#user-security-submit')?.addEventListener('click', () => void this.performUserSecurityAction());
    this.root.querySelector<HTMLInputElement>('#global-admin-enabled')?.addEventListener('change', event => {
      this.globalAdminDraft = (event.target as HTMLInputElement).checked;
      this.globalAdminConfirmation = ''; this.drawerError = false; this.drawerMessage = ''; this.render();
    });
    this.root.querySelector<HTMLInputElement>('#global-admin-confirmation')?.addEventListener('input', event => {
      this.globalAdminConfirmation = (event.target as HTMLInputElement).value;
    });
    this.root.querySelector('#global-admin-save')?.addEventListener('click', () => void this.saveGlobalAdmin());
    this.root.querySelectorAll<HTMLButtonElement>('[data-mfa-remove]').forEach(button => button.addEventListener('click', () => {
      const method = this.mfaMethods?.find(item => item.id === button.dataset.mfaRemove && item.type === button.dataset.mfaKind);
      if (method && method.removable && method.id && (method.type === 'phone' || method.type === 'microsoftAuthenticator')) { this.mfaRemoval = method as RemovableMfaMethod; this.mfaConfirmation = ''; this.drawerError = false; this.drawerMessage = ''; this.render(); }
    }));
    this.root.querySelector<HTMLInputElement>('#mfa-removal-confirmation')?.addEventListener('input', event => { this.mfaConfirmation = (event.target as HTMLInputElement).value; });
    this.root.querySelector('#mfa-removal-cancel')?.addEventListener('click', () => { this.mfaRemoval = null; this.mfaConfirmation = ''; this.drawerError = false; this.drawerMessage = ''; this.render(); });
    this.root.querySelector('#mfa-removal-submit')?.addEventListener('click', () => void this.removeMfaMethod());
    this.root.querySelector('#hide-temporary-password')?.addEventListener('click', () => { this.temporaryPassword = null; this.render(); });
    this.root.querySelector('#copy-temporary-password')?.addEventListener('click', () => {
      if (!this.temporaryPassword) return;
      if (!navigator.clipboard?.writeText) { this.drawerError = true; this.drawerMessage = 'Clipboard access is unavailable. Select the temporary password to copy it manually.'; this.render(); return; }
      void navigator.clipboard.writeText(this.temporaryPassword).then(() => { this.drawerError = false; this.drawerMessage = 'Temporary password copied. Share it securely.'; this.render(); }).catch(() => { this.drawerError = true; this.drawerMessage = 'Clipboard access failed. Select the temporary password to copy it manually.'; this.render(); });
    });
    this.root.querySelectorAll<HTMLInputElement>('[id^="user-"]').forEach(input => input.addEventListener('input', () => {
      const field = input.id.slice('user-'.length) as typeof USER_FIELDS[number];
      if ((USER_FIELDS as readonly string[]).includes(field)) {
        this.userDraft[field] = input.value;
        const save = this.root.querySelector<HTMLButtonElement>(`[data-user-save="${field}"]`);
        if (save && this.detailRecord) save.disabled = this.busy || input.value === String(this.detailRecord[field] ?? '');
      }
    }));
    this.root.querySelector('#user-account-enabled')?.addEventListener('change', event => {
      this.userDraft.accountEnabled = (event.target as HTMLInputElement).checked;
      const save = this.root.querySelector<HTMLButtonElement>('[data-user-save="accountEnabled"]');
      if (save && this.detailRecord) save.disabled = this.busy || this.userDraft.accountEnabled === (this.detailRecord.accountEnabled === true);
    });
    this.root.querySelector<HTMLInputElement>('#group-member-search')?.addEventListener('input', event => {
      const input = event.target as HTMLInputElement;
      const start = input.selectionStart; const end = input.selectionEnd;
      this.membershipSearch = input.value;
      this.render();
      queueMicrotask(() => { const next = this.root.querySelector<HTMLInputElement>('#group-member-search'); next?.focus(); if (next && start !== null && end !== null) next.setSelectionRange(start, end); });
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-member-user]').forEach(button => button.addEventListener('click', () => {
      this.membershipUserId = button.dataset.memberUser ?? '';
      this.drawerError = false; this.drawerMessage = ''; this.render();
    }));
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
        if (this.createUserOpen) this.closeCreateUser(); else this.closeDetail();
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
function parseMfaMethods(input: unknown): MfaMethod[] {
  if (!input || typeof input !== 'object' || !Array.isArray((input as MicrosoftRecord).items)) throw new Error('Invalid MFA methods response.');
  const methods = (input as { items: unknown[] }).items;
  const types: readonly MfaMethodType[] = ['phone', 'microsoftAuthenticator', 'email', 'fido2', 'password', 'softwareOath', 'temporaryAccessPass', 'windowsHelloForBusiness', 'platformCredential', 'other'];
  if (!methods.every(item => item && typeof item === 'object' && types.includes((item as MicrosoftRecord).type as MfaMethodType)
    && typeof (item as MicrosoftRecord).removable === 'boolean'
    && ((item as MicrosoftRecord).id === undefined || typeof (item as MicrosoftRecord).id === 'string')
    && ((item as MicrosoftRecord).detail === undefined || typeof (item as MicrosoftRecord).detail === 'string'))) throw new Error('Invalid MFA methods response.');
  return methods.map(item => item as MfaMethod);
}
const createUserStyles = `.upn-field{display:flex;align-items:center;gap:.45rem;min-width:0}.upn-field input{flex:1;min-width:0}.upn-field select{min-width:0;max-width:55%}@media(max-width:600px){.upn-field{flex-wrap:wrap}.upn-field select{max-width:100%;flex:1}}`;
const healthStyles = `.header-actions{align-items:center;display:flex;flex-wrap:wrap;gap:.5rem}.health-panel{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);margin-top:1rem;padding:.85rem 1rem}.health-heading{align-items:flex-start;display:flex;gap:.75rem;justify-content:space-between}.health-headline{align-items:center;display:flex;font-weight:700;gap:.5rem;margin-top:.8rem}.health-dot{background:hsl(var(--muted-foreground));border-radius:50%;display:inline-block;flex:none;height:.7rem;width:.7rem}.health-dot.green{background:hsl(var(--success))}.health-dot.yellow{background:#d9a441}.health-dot.red{background:hsl(var(--destructive))}.health-actions{margin:.65rem 0}.health-service{border-top:1px solid hsl(var(--border));padding:.55rem 0}.health-service summary{align-items:center;cursor:pointer;display:flex;gap:.55rem;font-weight:600}.health-service .meta{margin-left:1.25rem}.health-issue{border-left:2px solid hsl(var(--border));margin:.55rem 0 .55rem 1.25rem;padding:.15rem .65rem}.health-issue p{margin:.3rem 0;overflow-wrap:anywhere}.health-issue small{color:hsl(var(--muted-foreground))}@media(max-width:600px){.health-heading{align-items:flex-start}.header-actions{justify-content:flex-start}}`;
const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}main{max-width:1200px;margin:auto;padding:1.5rem}header,.directory-top,.heading,.actions{align-items:flex-start;display:flex;gap:1rem;justify-content:space-between}h1,h2,h3,p{margin:0}h1{font-size:1.55rem}h2{font-size:1.1rem}h3{font-size:.9rem}.eyebrow{color:hsl(var(--primary));font-size:.75rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.subtle,.read-only,.meta{color:hsl(var(--muted-foreground));font-size:.875rem;margin-top:.35rem}.status{color:hsl(var(--muted-foreground));min-height:1.4rem;margin-top:.75rem}.status:empty{display:none}.status[data-error="true"],.drawer-feedback.error{color:hsl(var(--destructive))}.badge,.state{background:hsl(var(--muted));border-radius:999px;font-size:.8rem;font-weight:700;padding:.25rem .6rem}.badge.ok,.state.on{background:hsl(var(--success) / .16);color:hsl(var(--success))}.directory{border-top:1px solid hsl(var(--border));margin-top:1.25rem;padding-top:.8rem}.resource-nav{display:flex;gap:.15rem}.resource-tab{background:transparent;border-radius:0;color:hsl(var(--muted-foreground));min-height:2.45rem;padding:.45rem .8rem}.resource-tab[aria-selected="true"]{border-bottom:2px solid hsl(var(--primary));color:hsl(var(--foreground))}label{display:grid;gap:.4rem;font-size:.875rem;font-weight:600;margin-top:1rem}select,input{background:hsl(var(--background));border:1px solid hsl(var(--input));border-radius:calc(var(--radius,.5rem) - 2px);color:inherit;font:inherit;min-height:2.25rem;padding:.4rem .55rem}.filter{margin:0;flex:1;max-width:420px;min-width:180px}.directory-top{align-items:center;flex-wrap:wrap}.directory-top .resource-nav{margin-right:auto}.column-tools{align-items:center;display:flex;flex-wrap:wrap;gap:.4rem;margin-top:1rem}.column-tools>span{color:hsl(var(--muted-foreground));font-size:.8rem;font-weight:700;margin-right:.15rem}.column-chip{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground));font-size:.78rem;min-height:2rem;padding:.25rem .55rem}.column-chip[aria-pressed="false"]{background:transparent;border:1px solid hsl(var(--border));color:hsl(var(--muted-foreground))}.check{align-items:center;display:flex;gap:.5rem}.check input{min-height:auto;width:1rem}.actions{justify-content:flex-end;margin-top:1rem}button{background:hsl(var(--primary));border:0;border-radius:calc(var(--radius,.5rem) - 2px);color:hsl(var(--primary-foreground));cursor:pointer;font:inherit;font-weight:700;min-height:2.25rem;padding:.4rem .7rem}button.secondary{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground))}button.compact{font-size:.8rem;min-height:1.9rem;padding:.25rem .55rem}button:disabled{cursor:not-allowed;opacity:.6}button:focus,input:focus,select:focus{outline:2px solid hsl(var(--ring));outline-offset:2px}.table-wrap{margin-top:1rem;overflow:auto}table{border-collapse:collapse;color:hsl(var(--foreground));min-width:700px;width:100%}th,td{border-bottom:1px solid hsl(var(--border));padding:.75rem;text-align:left;vertical-align:middle}th{color:hsl(var(--muted-foreground));font-size:.75rem;text-transform:uppercase}.identity strong,.identity span{display:block}.identity span{color:hsl(var(--muted-foreground));font-size:.84rem;margin-top:.15rem}.row-control{text-align:right}.selected-row td{background:hsl(var(--accent) / .42)}.row-actions td{background:hsl(var(--accent) / .28)}.row-actions td>div{align-items:center;display:flex;gap:.7rem}.empty{border:1px dashed hsl(var(--border));border-radius:var(--radius,.5rem);color:hsl(var(--muted-foreground));margin-top:1rem;padding:1.25rem;text-align:center}.sr-only{clip:rect(0,0,0,0);height:1px;margin:-1px;overflow:hidden;position:absolute;width:1px}.backdrop{background:hsl(var(--background) / .64);display:flex;inset:0;justify-content:flex-end;position:fixed;z-index:20}.drawer{background:hsl(var(--card));box-shadow:-8px 0 24px hsl(var(--foreground) / .16);display:flex;flex-direction:column;height:100%;max-width:min(100%,40rem);width:100%}.drawer-heading{border-bottom:1px solid hsl(var(--border));flex:0 0 auto;padding:.85rem 1.1rem}.drawer-body{flex:1;min-height:0;overflow:auto;padding:.9rem 1.1rem}.drawer-section{margin-top:.9rem}.security-confirmation,.one-time-secret{background:hsl(var(--muted) / .28);border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);margin-top:1rem;padding:1rem}.security-confirmation p,.one-time-secret p{color:hsl(var(--muted-foreground));margin-bottom:.75rem}.one-time-secret code{display:block;background:hsl(var(--background));border-radius:.35rem;font-size:1rem;margin:.5rem 0;overflow-wrap:anywhere;padding:.65rem;user-select:all}.field-grid{display:grid;gap:.55rem;grid-template-columns:1fr}.user-field{align-items:end;display:grid;gap:.5rem;grid-template-columns:minmax(0,1fr) auto}.user-field label{align-items:center;display:grid;grid-template-columns:112px minmax(0,1fr);margin:0}.user-field label.check{display:flex;justify-content:flex-start}.field-grid .user-field label{margin:0}.drawer-footer{border-top:1px solid hsl(var(--border));flex:0 0 auto;padding:.7rem 1.1rem}.drawer-footer .actions{margin-top:0}.drawer-feedback{margin-top:.75rem;min-height:1.4rem}dl{margin:0}dl div{border-bottom:1px solid hsl(var(--border));padding:.75rem 0}dt{color:hsl(var(--muted-foreground));font-size:.75rem;font-weight:700}dd{margin:.25rem 0 0;overflow-wrap:anywhere}@media(max-width:600px){main{padding:1rem}.directory-top,.heading{flex-direction:column}.field-grid .user-field label{align-items:stretch;grid-template-columns:1fr}.drawer-heading{padding:1rem}.drawer-body,.drawer-footer{padding-left:1rem;padding-right:1rem}}`;
if (!customElements.get(ELEMENT)) customElements.define(ELEMENT, CloudCommandMicrosoftPage);
