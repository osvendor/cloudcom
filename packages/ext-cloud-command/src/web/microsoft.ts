import { parseExtensionPageContextV1, type ExtensionPageContextV1 } from '@breeze/extension-web-sdk';
import { microsoftSkuName } from '../microsoft-sku-names';

const ELEMENT = 'cloudcommand-microsoft-page';
const RESOURCES = ['all', 'users', 'shared-mailboxes', 'groups', 'licenses', 'sites'] as const;
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
type ResourceRow = { id: string; values: Record<string, string | number | boolean | null>; source?: 'user' | 'group' };
type ResourceData = {
  items: ResourceRow[];
  columns: Array<{ key: string; label: string }>;
  complete: boolean;
  checkedAt: string;
};
type DirectoryLayout = { columns: string[]; widths: Record<string, number>; sortKey: string | null; sortDirection: 'asc' | 'desc' };
type MailboxRecord = {
  id: string;
  primarySmtpAddress: string;
  recipientType: 'UserMailbox' | 'SharedMailbox';
  archiveEnabled: boolean;
  mailboxBytes: number | null;
  archiveBytes: number | null;
  collectedAt: string;
  statisticsUnavailable: boolean;
};
type MailboxInventory = { records: MailboxRecord[]; partial: boolean; collectedAt: string };
type DetailKind = 'read' | 'user' | 'group';
type UserSecurityAction = 'reset-password' | 'revoke-sessions' | 'block-sign-in' | 'restore-sign-in';
type MicrosoftRecord = Record<string, unknown>;
type MfaMethodType = 'phone' | 'microsoftAuthenticator' | 'email' | 'fido2' | 'password' | 'softwareOath' | 'temporaryAccessPass' | 'windowsHelloForBusiness' | 'platformCredential' | 'other';
type MfaMethod = { id?: string; type: MfaMethodType; detail?: string; removable: boolean };
type LicenseOption = { skuId: string; skuPartNumber: string; capabilityStatus: string; consumedUnits: number; prepaidUnits: { enabled: number } };
type UserLicense = { skuId: string; name: string; assignedByGroup: string | null; state: string };
type HealthIssue = { id: string; title?: string | null; impactDescription?: string | null; status?: string | null; lastModifiedDateTime?: string | null };
type HealthService = { id: string; service: string; status: string; issues?: HealthIssue[] };
type HealthData = { services: HealthService[]; partial: boolean; checkedAt: string };
type GroupPeople = { groupId: string; members: Array<{ id: string; displayName: string | null; userPrincipalName: string | null }>;
  owners: Array<{ id: string; displayName: string | null; userPrincipalName: string | null }>; complete: boolean; otherMemberCount: number };
type GroupSettings = { groupId: string; kind: 'distribution' | 'microsoft365'; displayName: string;
  primarySmtpAddress: string; requireSenderAuthenticationEnabled: boolean;
  emailAddressPolicyEnabled: boolean | null; aliases: string[] };
type ForwardingState = { mailboxId: string; smtpAddress: string | null; keepCopy: boolean; internalRecipient: string | null };
type AutoReplyState = { mailboxId: string; state: 'Disabled' | 'Enabled' | 'Scheduled'; internalMessage: string; externalMessage: string;
  externalAudience: 'None' | 'Known' | 'All'; start: string | null; end: string | null };
type AddressesState = { mailboxId: string; primarySmtpAddress: string; aliases: string[]; policyEnabled: boolean };
type DelegationState = { mailboxId: string; delegateId: string; delegateAddress: string;
  fullAccess: boolean; sendAs: boolean; sendOnBehalf: boolean };
type DelegationList = { mailboxId: string; entries: Array<Pick<DelegationState, 'delegateAddress' | 'fullAccess' | 'sendAs' | 'sendOnBehalf'>>;
  partial: boolean; checkedAt: string };
type TraceCursor = { received: string; recipient: string };
type TraceCriteria = { start: string; end: string; sender: string | null; recipient: string | null;
  status: string | null; cursor: TraceCursor | null };
type TraceRow = { messageTraceId: string; received: string; sender: string; recipient: string; subject: string; status: string };
type TracePage = { rows: TraceRow[]; next: TraceCursor | null; partial: boolean; checkedAt: string };
type TraceDetail = { messageTraceId: string; recipient: string; events: Array<{ date: string | null; event: string; detail: string }>; partial: boolean };
const healthyStatuses = new Set(['serviceOperational', 'serviceRestored', 'postIncidentReviewPublished', 'resolved', 'resolvedExternal', 'falsePositive']);
function healthTone(status: string): 'green' | 'yellow' | 'red' | 'unknown' {
  return healthyStatuses.has(status) ? 'green' : status === 'serviceInterruption' ? 'red' : !status || status === 'unknownFutureValue' ? 'unknown' : 'yellow';
}
type RemovableMfaMethod = MfaMethod & { id: string; type: Exclude<MfaMethodType, 'password' | 'other'>; removable: true };
type UserDraft = Partial<Record<(typeof USER_FIELDS)[number], string>> & { accountEnabled?: boolean };
// Cloud Command's Edit account drawer saves the account name as one field. The
// directory is an MSP operations view, not a copy of every Graph profile field.
const USER_FIELDS = ['displayName'] as const;
// Match Cloud Command's directory update flow: allow Graph's eventual reads
// to converge for up to 30 seconds before reporting an uncertain outcome.
const USER_VERIFY_READS = 15;
const USER_VERIFY_DELAY_MS = 2000;

const labels: Record<Resource, string> = {
  all: 'All',
  users: 'Users',
  'shared-mailboxes': 'Shared mailboxes',
  groups: 'Groups',
  licenses: 'Licenses',
  sites: 'Sites',
};
// Keep the original Cloud Command directory's default information hierarchy.
// Exchange and OneDrive values may arrive after the directory identity snapshot.
const USER_DIRECTORY_COLUMNS = [
  { key: 'displayName', label: 'User' },
  { key: 'userType', label: 'Type' },
  { key: 'licenseSummary', label: 'License' },
  { key: 'mailbox', label: 'Mailbox' },
  { key: 'archive', label: 'Archive' },
  { key: 'oneDrive', label: 'OneDrive' },
] as const;

export class CloudCommandMicrosoftPage extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private contextValue: ExtensionPageContextV1 | null = null;
  private api: HostApi | null = null;
  private connection: Connection | null = null;
  private resource: Resource = 'users';
  private data: ResourceData | null = null;
  private allGroups: ResourceData | null = null;
  private mailboxInventory: MailboxInventory | null = null;
  private mailboxError = '';
  private mailboxStatisticsRequest = 0;
  private mailboxStatisticsLoaded = new Set<string>();
  private mailboxStatisticsFailed = new Set<string>();
  private mailboxStatisticsTargets = new Set<string>();
  private mailboxStatisticsLoading = false;
  private driveUsageRequest = 0;
  private filter = '';
  private sortKey: string | null = null;
  private sortDirection: 'asc' | 'desc' = 'asc';
  private directoryScope: 'users' | 'unlicensed' | 'exclude' = 'users';
  private directoryExclusions = new Map<string, boolean>();
  private directoryExclusionsReady = false;
  private directoryExclusionError = '';
  private directoryPreferenceRequest = 0;
  private detail: ResourceRow | null = null;
  private createUserGroups: ResourceRow[] | null = null;
  private createUserGroupIds: string[] = [];
  private createUserGroupsError = '';
  private createUserGroupOutcomes: string[] = [];
  private createUserGroupsRequest = 0;
  private createUserOpen = false;
  private createUserSession = 0;
  private createUserPasswordMode = 'generated';
  private createUserPassword = '';
  private createUserForceChange = true;
  private createUserDomainsRequest = 0;
  private createUserLicensesRequest = 0;
  private createUserUncertain = false;
  private createUserDomains: string[] | null = null;
  private createUserLicenses: LicenseOption[] | null = null;
  private createLicenseCatalogError = '';
  private createUserError = '';
  private createUserBusy = false;
  private createdUser: { id: string; userPrincipalName: string; temporaryPassword: string } | null = null;
  private createUserDraft = { name: '', local: '', domain: '', location: '', skuId: '' };
  private createLicenseOutcome = '';
  private createLicenseOutcomeError = false;
  private licensesOpen = false;
  private userLicenses: UserLicense[] | null = null;
  private userLicenseCatalog: LicenseOption[] | null = null;
  private licenseAssignSku = '';
  private licensesLoading = false;
  private licensesError = '';
  private licenseRemovalSku = '';
  private licenseConfirmation = '';
  private licenseNeedsRefresh = false;
  private licensesRequest = 0;
  private createGroupOpen = false;
  private createGroupRequest = 0;
  private createGroupUncertain = false;
  private createGroupUsers: ResourceData | null = null;
  private createGroupDraft = { kind: 'm365', name: '', alias: '', ownerId: '', primarySmtpAddress: '' };
  private createGroupError = '';
  private createGroupBusy = false;
  private createdGroup: { kind: string; id: string | null; mail: string | null; verified: boolean } | null = null;
  private groupNameDraft = '';
  private forwardingOpen = false;
  private forwarding: ForwardingState | null = null;
  private forwardingAddress = '';
  private forwardingKeepCopy = true;
  private forwardingLoading = false;
  private forwardingError = '';
  private forwardingMessage = '';
  private forwardingNeedsRefresh = false;
  private forwardingRequest = 0;
  private autoReplyOpen = false;
  private autoReply: AutoReplyState | null = null;
  private autoReplyDraft = { state: 'Disabled' as AutoReplyState['state'], message: '', externalMessage: '', externalAudience: 'All' as AutoReplyState['externalAudience'], start: '', end: '' };
  private autoReplyLoading = false;
  private autoReplyError = '';
  private autoReplyMessage = '';
  private autoReplyNeedsRefresh = false;
  private autoReplyRequest = 0;
  private addressesOpen = false;
  private addresses: AddressesState | null = null;
  private primaryDraft = '';
  private aliasDraft = '';
  private addressesLoading = false;
  private addressesError = '';
  private addressesMessage = '';
  private addressesNeedsRefresh = false;
  private addressesRequest = 0;
  private delegationOpen = false;
  private delegationUsers: ResourceData | null = null;
  private delegationSelectedId = '';
  private delegationRemoveRight = '';
  private delegation: DelegationState | null = null;
  private delegationList: DelegationList | null = null;
  private delegationListLoading = false;
  private delegationListError = '';
  private delegationListRequest = 0;
  private delegationLoading = false;
  private delegationError = '';
  private delegationMessage = '';
  private delegationNeedsRefresh = false;
  private delegationRequest = 0;
  private detailKind: DetailKind = 'read';
  private detailIsShared = false;
  private detailRecord: MicrosoftRecord | null = null;
  private detailRequest = 0;
  private userVerificationRequest = 0;
  private userSecurityRequest = 0;
  private userSecurityAction: UserSecurityAction | null = null;
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
  private mfaRemovalNeedsRefresh = false;
  private mfaConfirmation = '';
  private recoveryEmailDraft = '';
  private recoveryEmailNeedsRefresh = false;
  private mobilePhoneDraft = '';
  private mobilePhoneNeedsRefresh = false;
  private mfaRequest = 0;
  private drawerMessage = '';
  private drawerError = false;
  private membershipUserId = '';
  private membershipUsers: ResourceData | null = null;
  private membershipSearch = '';
  private membershipUsersRequest = 0;
  private groupPeople: GroupPeople | null = null;
  private groupPeopleError = '';
  private groupPeopleRequest = 0;
  private groupSettings: GroupSettings | null = null;
  private groupSettingsError = '';
  private groupSettingsRequest = 0;
  private groupExternalDraft: boolean | null = null;
  private groupExternalNeedsRefresh = false;
  private groupAliasDraft = '';
  private groupAliasRemoval = '';
  private groupPrimaryDraft = '';
  private groupPrimaryNeedsRefresh = false;
  private driveLink: string | null = null;
  private driveLinkError = '';
  private driveLinkLoading = false;
  private driveLinkRequest = 0;
  private groupNameNeedsRefresh = false;
  private membershipAction: 'add' | 'remove' = 'add';
  private membershipRole: 'member' | 'owner' = 'member';
  private membershipNeedsRefresh = false;
  private userGroupOpen = false;
  private userGroups: ResourceData | null = null;
  private userGroupRequest = 0;
  private userGroupSelectedId = '';
  private userGroupNeedsRefresh = false;
  private userDraft: UserDraft = {};
  private visibleColumns: string[] = [];
  private columnWidths: Record<string, number> = {};
  private layoutRequest = 0;
  private layoutEditVersion = 0;
  private layoutSave: Promise<void> = Promise.resolve();
  private layoutError = '';
  private accountPanel = 'account';
  private expandedRowId: string | null = null;
  private returnFocus: string | null = null;
  private message = '';
  private error = false;
  private generation = 0;
  private busy = false;
  private resourceRequest = 0;
  private manualRefreshRequest = 0;
  private health: HealthData | null = null;
  private healthError = '';
  private healthOpen = false;
  private healthLoading = false;
  private healthRequest = 0;
  private traceOpen = false;
  private traceCriteria: TraceCriteria | null = null;
  private quarantineRow: TraceRow | null = null;
  private quarantineMatch: {identity:string;messageId:string;subject:string;sender:string;recipient:string;released:boolean} | null = null;
  private quarantineBusy = false;
  private quarantineMessage = '';
  private quarantineRequest = 0;
  private traceWidths: Record<string, number> = {};
  private traceRows: TraceRow[] = [];
  private traceNext: TraceCursor | null = null;
  private traceLoading = false;
  private traceError = '';
  private traceSelected: TraceRow | null = null;
  private traceExpanded = false;
  private traceDetail: TraceDetail | null = null;
  private traceDetailLoading = false;
  private traceRequest = 0;
  private traceDraft = { start: '', end: '', sender: '', recipient: '', status: '' };

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
    if (window.location.hash === '#unlicensed') this.directoryScope = 'unlicensed';
    window.addEventListener('hashchange', this.onHashChange);
    this.render();
    if (this.contextValue) void this.loadConnection();
  }
  disconnectedCallback(): void {
    window.removeEventListener('hashchange', this.onHashChange);
    this.generation += 1;
    this.manualRefreshRequest += 1;
    this.mailboxStatisticsRequest += 1;
    this.mailboxStatisticsLoading = false; this.mailboxStatisticsTargets.clear();
    this.driveUsageRequest += 1;
    this.userVerificationRequest += 1;
    this.userSecurityRequest += 1;
    this.globalAdminRequest += 1;
    this.mfaRequest += 1;
    this.temporaryPassword = null;
    this.createdUser = null; this.createUserPassword = ''; this.createUserPasswordMode = 'generated'; this.createUserForceChange = true;
    this.createGroupOpen = false; this.createdGroup = null;
    this.forwardingRequest += 1; this.forwardingOpen = false; this.forwarding = null;
    this.resetAutoReply(); this.resetAddresses(); this.resetDelegation();
    this.healthRequest += 1;
    this.traceRequest += 1; this.traceOpen = false; this.traceLoading = false; this.traceDetailLoading = false;
    this.userSecurityAction = null;
    this.licensesRequest += 1; this.licensesOpen = false; this.userLicenses = null;
  }

  private onHashChange = (): void => {
    const next = this.resourceFromHash();
    const nextScope = window.location.hash === '#unlicensed' ? 'unlicensed' : 'users';
    if (next !== this.resource) {
      this.manualRefreshRequest += 1;
      this.resource = next;
      this.driveUsageRequest += 1;
      this.mailboxStatisticsRequest += 1; this.mailboxStatisticsLoading = false; this.mailboxStatisticsTargets.clear();
      if (next === 'users') this.directoryScope = nextScope;
      this.data = null;
      this.allGroups = null;
      this.detail = null;
      this.createUserOpen = false;
      this.createdUser = null; this.createUserPassword = ''; this.createUserPasswordMode = 'generated'; this.createUserForceChange = true; this.createUserBusy = false;
      this.createGroupOpen = false; this.createdGroup = null;
      this.forwardingRequest += 1; this.forwardingOpen = false; this.forwarding = null;
      this.resetAutoReply(); this.resetAddresses(); this.resetDelegation();
      this.detailRecord = null;
      this.detailRequest += 1;
      this.userVerificationRequest += 1;
      this.userSecurityRequest += 1;
      this.globalAdminRequest += 1;
      this.mfaRequest += 1;
      this.userSecurityAction = null; this.temporaryPassword = null;
      this.licensesRequest += 1; this.licensesOpen = false; this.userLicenses = null;
      this.busy = false;
      this.filter = '';
      this.sortKey = null; this.sortDirection = 'asc';
      this.directoryScope = window.location.hash === '#unlicensed' ? 'unlicensed' : 'users'; this.directoryExclusions.clear(); this.directoryExclusionsReady = false; this.directoryExclusionError = ''; this.directoryPreferenceRequest += 1;
      this.userDraft = {};
      this.expandedRowId = null;
      this.visibleColumns = [];
      this.columnWidths = {}; this.layoutError = ''; this.layoutRequest += 1; this.layoutEditVersion = 0;
      this.render();
      if (this.canRead()) void this.loadResource();
    }
    if (next === 'users' && this.directoryScope !== nextScope) { this.directoryScope = nextScope; this.filter = ''; this.render(); }
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
    this.manualRefreshRequest += 1;
    this.mailboxStatisticsRequest += 1; this.mailboxStatisticsLoaded.clear(); this.mailboxStatisticsFailed.clear(); this.mailboxStatisticsTargets.clear(); this.mailboxStatisticsLoading = false;
    this.driveUsageRequest += 1;
    this.resourceRequest += 1;
    this.busy = false;
    this.connection = null;
    this.health = null; this.healthError = ''; this.healthOpen = false; this.healthLoading = false; this.healthRequest += 1;
    this.quarantineRequest++; this.quarantineRow=null; this.quarantineMatch=null; this.quarantineBusy=false;
    this.traceRequest += 1; this.traceOpen = false; this.traceSelected=null; this.traceRows = []; this.traceNext = null; this.traceCriteria = null; this.traceDetail = null;
    this.traceLoading = false; this.traceDetailLoading = false; this.traceDraft = { start: '', end: '', sender: '', recipient: '', status: '' }; this.traceError = '';
    this.data = null;
    this.allGroups = null;
    this.mailboxInventory = null; this.mailboxError = '';
    this.detail = null;
    this.createUserOpen = false;
    this.createdUser = null; this.createUserPassword = ''; this.createUserPasswordMode = 'generated'; this.createUserForceChange = true; this.createUserBusy = false;
    this.createGroupOpen = false; this.createdGroup = null; this.createGroupUsers = null; this.createGroupBusy = false;
    this.forwardingRequest += 1; this.forwardingOpen = false; this.forwarding = null;
    this.resetAutoReply(); this.resetAddresses(); this.resetDelegation();
    this.detailRecord = null;
    this.expandedRowId = null;
    this.sortKey = null; this.sortDirection = 'asc';
    this.visibleColumns = [];
    this.columnWidths = {}; this.layoutError = ''; this.layoutRequest += 1; this.layoutEditVersion = 0;
    this.detailRequest += 1;
    this.userVerificationRequest += 1;
    this.userSecurityRequest += 1;
    this.globalAdminRequest += 1;
    this.mfaRequest += 1;
    this.userSecurityAction = null; this.temporaryPassword = null;
    this.licensesRequest += 1; this.licensesOpen = false; this.userLicenses = null;
    this.drawerMessage = '';
    this.drawerError = false;
    this.membershipUserId = '';
    this.membershipUsers = null;
    this.membershipSearch = '';
    this.membershipUsersRequest += 1;
    this.groupPeople = null; this.groupPeopleError = ''; this.groupPeopleRequest += 1;
    this.groupSettings = null; this.groupSettingsError = ''; this.groupSettingsRequest += 1;
    this.groupExternalDraft = null; this.groupExternalNeedsRefresh = false;
    this.groupAliasDraft = ''; this.groupAliasRemoval = '';
    this.groupPrimaryDraft = ''; this.groupPrimaryNeedsRefresh = false;
    this.driveLink = null; this.driveLinkError = ''; this.driveLinkLoading = false; this.driveLinkRequest += 1;
    this.groupNameNeedsRefresh = false;
    this.membershipAction = 'add';
    this.membershipRole = 'member'; this.membershipNeedsRefresh = false;

    this.userGroupRequest += 1; this.userGroupOpen = false; this.userGroups = null;
    this.userGroupSelectedId = ''; this.userGroupNeedsRefresh = false;
    this.groupNameDraft = '';
    this.forwardingRequest += 1; this.forwardingError = ''; this.forwardingMessage = ''; this.forwardingNeedsRefresh = false;
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
    this.driveUsageRequest += 1;
    this.data = null;
    this.allGroups = null;
    this.detail = null;
    this.setMessage(`Loading ${labels[resource].toLowerCase()}…`);
    this.render();
    try {
      let data: ResourceData;
      let groupsData: ResourceData | null = null;
      let fromSnapshot = false;
      let snapshotStale = false;
      const snapshot = resource === 'sites' ? null : await this.loadDirectorySnapshot(resource);
      if (snapshot?.pending) {
        if (generation !== this.generation || resource !== this.resource || request !== this.resourceRequest) return;
        this.setMessage('The background directory snapshot is being prepared. This view will update automatically.');
        setTimeout(() => {
          if (generation === this.generation && resource === this.resource && request === this.resourceRequest)
            void this.loadResource();
        }, 5000);
        return;
      }
      if (snapshot) {
        ({ data, groupsData } = snapshot);
        fromSnapshot = true;
        snapshotStale = snapshot.directoryStatus === 'stale';
        this.mailboxInventory = snapshot.inventory;
        this.mailboxError = snapshot.usageStatus === 'ready' ? '' : 'Background usage is pending or stale.';
        this.mailboxStatisticsRequest += 1;
        this.mailboxStatisticsLoaded.clear(); this.mailboxStatisticsFailed.clear();
        for (const row of snapshot.inventory.records) {
          const id = row.id.toLowerCase();
          if (!snapshot.usageRecordIds.has(id)) continue;
          this.mailboxStatisticsLoaded.add(id);
          if (row.statisticsUnavailable) this.mailboxStatisticsFailed.add(id);
        }
      } else if (resource === 'shared-mailboxes') {
        const inventory = this.mailboxInventory ?? await this.fetchMailboxInventory();
        for (const row of inventory.records) if (!row.statisticsUnavailable) this.mailboxStatisticsLoaded.add(row.id.toLowerCase());
        data = {
          items: inventory.records.filter(row => row.recipientType === 'SharedMailbox').map(row => ({
            id: row.id,
            values: {
              primarySmtpAddress: row.primarySmtpAddress,
              mailbox: this.mailboxStatisticsLoaded.has(row.id.toLowerCase()) ? storageLabel(row.mailboxBytes) : 'Usage not loaded',
              archive: row.archiveEnabled ? this.mailboxStatisticsLoaded.has(row.id.toLowerCase()) ? storageLabel(row.archiveBytes) : 'Usage not loaded' : 'Off',
            },
          })),
          columns: [
            { key: 'primarySmtpAddress', label: 'Shared mailbox' },
            { key: 'mailbox', label: 'Mailbox usage' },
            { key: 'archive', label: 'Archive' },
          ],
          complete: !inventory.partial,
          checkedAt: inventory.collectedAt,
        };
        this.mailboxInventory = inventory;
        this.mailboxError = '';
        this.startMailboxStatistics();
      } else if (resource === 'all') {
        const [users, groups] = await Promise.all([
          this.request<unknown>(this.path('/resources/users')),
          this.request<unknown>(this.path('/resources/groups')),
        ]);
        data = parseResourceData(users);
        groupsData = parseResourceData(groups);
        data.complete = data.complete && groupsData.complete;
        const oldest = Math.min(Date.parse(data.checkedAt), Date.parse(groupsData.checkedAt));
        if (Number.isFinite(oldest)) data.checkedAt = new Date(oldest).toISOString();
      } else {
        const raw = await this.request<unknown>(this.path(`/resources/${resource}`));
        data = parseResourceData(raw);
      }
      if (generation !== this.generation || resource !== this.resource || request !== this.resourceRequest)
        return;
      this.data = data;
      this.allGroups = groupsData;
      if (resource === 'users' || resource === 'all') {
        this.directoryExclusions.clear(); this.directoryExclusionsReady = false; this.directoryExclusionError = '';
        void this.loadDirectoryExclusions(data.items, generation, context, request);
        if (!fromSnapshot) void this.loadDriveUsage(data.items, generation, context, request);
      }
      const availableColumns = resource === 'users' || resource === 'all' ? USER_DIRECTORY_COLUMNS : data.columns;
      this.visibleColumns = this.visibleColumns.filter(key => availableColumns.some(column => column.key === key));
      if (!this.visibleColumns.length) this.visibleColumns = this.defaultVisibleColumns(data);
      void this.loadDirectoryLayout(resource, generation, request);
      this.setMessage(data.items.length || groupsData?.items.some(row => row.values.mailEnabled === true)
        ? snapshotStale ? 'The last complete directory snapshot is stale; a background refresh is in progress.' : ''
        : `No ${labels[resource].toLowerCase()} are available for this tenant.`);
      if (!fromSnapshot && (resource === 'users' || resource === 'all')) void this.refreshMailboxInventory(generation, context, request);
    } catch (e) {
      if (generation === this.generation && resource === this.resource && request === this.resourceRequest)
        this.setMessage(e instanceof Error ? e.message : 'Could not load Microsoft resource.', true);
    } finally {
      if (generation === this.generation && request === this.resourceRequest) this.render();
    }
  }
  private fetchMailboxInventory(): Promise<MailboxInventory> {
    return this.request<unknown>(this.path('/administration'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'mailbox.inventory', pageSize: 200 }),
    }).then(parseMailboxInventory);
  }
  private async loadDriveUsage(rows: ResourceRow[], generation: number, context: ExtensionPageContextV1 | null, resourceRequest: number): Promise<void> {
    const request = this.driveUsageRequest;
    const pending = rows.filter(row => typeof row.values.licenseSummary === 'string'
      && row.values.licenseSummary !== 'Unlicensed'
      && (row.values.oneDrive === null || row.values.oneDrive === 'Names concealed in Microsoft reports'));
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const row = pending[next++]!;
        if (generation !== this.generation || context !== this.contextValue || resourceRequest !== this.resourceRequest
          || request !== this.driveUsageRequest || !['users', 'all'].includes(this.resource)) return;
        row.values.oneDrive = 'Loading usage…';
        this.render();
        let label = 'Unavailable';
        try {
          const result = await this.request<{ oneDrive?: unknown }>(this.path('/administration'), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'user.drive.usage.get', id: row.id }),
          });
          if (typeof result.oneDrive === 'string' && result.oneDrive.length <= 64) label = result.oneDrive;
        } catch { /* One account's drive must not block the directory or other accounts. */ }
        if (generation !== this.generation || context !== this.contextValue || resourceRequest !== this.resourceRequest
          || request !== this.driveUsageRequest || !['users', 'all'].includes(this.resource)) return;
        row.values.oneDrive = label;
        this.render();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()));
  }
  private async refreshMailboxInventory(generation: number, context: ExtensionPageContextV1 | null, request: number): Promise<void> {
    try {
      const inventory = await this.fetchMailboxInventory();
      if (generation !== this.generation || context !== this.contextValue || request !== this.resourceRequest || !['users', 'all'].includes(this.resource)) return;
      this.mailboxInventory = inventory;
      this.mailboxStatisticsRequest += 1; this.mailboxStatisticsLoaded.clear(); this.mailboxStatisticsFailed.clear(); this.mailboxStatisticsTargets.clear(); this.mailboxStatisticsLoading = false;
      for (const row of inventory.records) if (!row.statisticsUnavailable) this.mailboxStatisticsLoaded.add(row.id.toLowerCase());
      this.mailboxError = '';
      this.render();
      this.startMailboxStatistics();
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.resourceRequest || !['users', 'all'].includes(this.resource)) return;
      this.mailboxInventory = null;
      this.mailboxError = error instanceof Error ? error.message : 'Exchange mailbox inventory is unavailable.';
      this.render();
    }
  }
  private startMailboxStatistics(): void {
    if (this.mailboxStatisticsLoading || !this.mailboxInventory ||
      !(this.resource === 'shared-mailboxes' || this.visibleColumns.includes('mailbox') || this.visibleColumns.includes('archive'))) return;
    const search = this.filter.trim().toLowerCase();
    const names = new Map(this.data?.items.map(row => [row.id.toLowerCase(), String(row.values.displayName ?? '').toLowerCase()]) ?? []);
    const pending = this.mailboxInventory.records.filter(row =>
      !this.mailboxStatisticsLoaded.has(row.id.toLowerCase()) && !this.mailboxStatisticsFailed.has(row.id.toLowerCase())
      && (this.resource === 'shared-mailboxes' || names.has(row.id.toLowerCase()))
      && (this.resource !== 'users' || row.recipientType !== 'SharedMailbox')
      && (this.resource !== 'shared-mailboxes' || row.recipientType === 'SharedMailbox')
      && (!search || `${row.primarySmtpAddress} ${names.get(row.id.toLowerCase()) ?? ''}`.toLowerCase().includes(search)))
      .slice(0, 200);
    this.mailboxStatisticsTargets = new Set(pending.map(row => row.id.toLowerCase()));
    if (!pending.length) { this.render(); return; }
    if (this.resource === 'shared-mailboxes' && this.data) {
      for (const item of this.data.items) if (this.mailboxStatisticsTargets.has(item.id.toLowerCase())) {
        item.values.mailbox = 'Loading usage…';
        if (item.values.archive !== 'Off') item.values.archive = 'Loading usage…';
      }
    }
    const generation = this.generation;
    const context = this.contextValue;
    const request = this.mailboxStatisticsRequest;
    this.mailboxStatisticsLoading = true;
    void (async () => {
      let completed = 0;
      for (const row of pending) {
        if (generation !== this.generation || context !== this.contextValue || request !== this.mailboxStatisticsRequest) break;
        const id = row.id.toLowerCase();
        // One request at a time keeps the single persistent Exchange worker responsive.
        let loaded = false;
        try {
          const result = parseMailboxRecord(await this.request<unknown>(this.path('/administration'), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'mailbox.statistics.get', mailboxId: row.id }),
          }));
          if (result.id.toLowerCase() !== id) throw new Error('Mailbox identity changed.');
          if (generation !== this.generation || context !== this.contextValue || request !== this.mailboxStatisticsRequest) break;
          const index = this.mailboxInventory?.records.findIndex(record => record.id.toLowerCase() === id) ?? -1;
          if (index >= 0 && this.mailboxInventory) this.mailboxInventory.records[index] = result;
          loaded = true;
        } catch {
          // A failed individual size lookup must not hide the mailbox type inventory.
        }
        if (loaded) this.mailboxStatisticsLoaded.add(id);
        else this.mailboxStatisticsFailed.add(id);
        if (this.resource === 'shared-mailboxes' && this.data) {
          const item = this.data.items.find(entry => entry.id.toLowerCase() === id);
          const updated = this.mailboxInventory?.records.find(entry => entry.id.toLowerCase() === id);
          if (item && updated) { item.values.mailbox = loaded ? storageLabel(updated.mailboxBytes) : 'Usage unavailable'; item.values.archive = updated.archiveEnabled ? loaded ? storageLabel(updated.archiveBytes) : 'Usage unavailable' : 'Off'; }
        }
        completed += 1;
        if (completed % 10 === 0 || completed === pending.length) this.render();
      }
      if (generation === this.generation && context === this.contextValue && request === this.mailboxStatisticsRequest) {
        this.mailboxStatisticsLoading = false;
        this.render();
      }
    })();
  }
  private async loadDirectoryExclusions(rows: ResourceRow[], generation: number, context: ExtensionPageContextV1 | null, resourceRequest: number): Promise<void> {
    const request = ++this.directoryPreferenceRequest;
    try {
      const body = await this.request<unknown>(this.path('/directory/exclusions'));
      if (!body || typeof body !== 'object' || !Array.isArray((body as MicrosoftRecord).items) || !(body as { items: unknown[] }).items.every(item => typeof item === 'string')) throw new Error('Invalid directory exclusions response.');
      if (generation !== this.generation || context !== this.contextValue || resourceRequest !== this.resourceRequest || request !== this.directoryPreferenceRequest || !['users', 'all'].includes(this.resource)) return;
      const excluded = new Set((body as { items: string[] }).items);
      this.directoryExclusions = new Map(rows.map(row => [row.id, excluded.has(row.id)]));
      this.directoryExclusionsReady = true;
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || resourceRequest !== this.resourceRequest || request !== this.directoryPreferenceRequest || !['users', 'all'].includes(this.resource)) return;
      this.directoryExclusionsReady = false;
      this.directoryExclusionError = error instanceof Error ? error.message : 'Could not load directory exclusions.';
    }
    this.render();
  }
  private async setDirectoryExcluded(row: ResourceRow, excluded: boolean): Promise<void> {
    if (!this.connection?.canManage || this.busy || !['users', 'all'].includes(this.resource)) return;
    const generation = this.generation; const context = this.contextValue; const request = ++this.directoryPreferenceRequest;
    this.busy = true; this.drawerError = false; this.drawerMessage = excluded ? 'Excluding user from this directory…' : 'Restoring user to this directory…'; this.render();
    try {
      const body = await this.request<unknown>(this.path(`/directory/users/${encodeURIComponent(row.id)}/exclude`), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ excluded }) });
      if (generation !== this.generation || context !== this.contextValue || request !== this.directoryPreferenceRequest || !['users', 'all'].includes(this.resource)) return;
      if (!body || typeof body !== 'object' || (body as MicrosoftRecord).excluded !== excluded) throw new Error('Directory exclusion was not acknowledged.');
      this.directoryExclusions.set(row.id, excluded); this.directoryExclusionsReady = true;
      this.drawerError = false; this.drawerMessage = excluded ? 'User excluded from your directory.' : 'User restored to your directory.';
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && request === this.directoryPreferenceRequest) { this.drawerError = true; this.drawerMessage = error instanceof Error ? error.message : 'Directory exclusion outcome is uncertain.'; }
    } finally { if (generation === this.generation && context === this.contextValue && request === this.directoryPreferenceRequest) { this.busy = false; this.render(); } }
  }
  private setDirectoryScope(scope: 'users' | 'unlicensed' | 'exclude'): void {
    if (scope === 'unlicensed') { window.location.hash = 'unlicensed'; this.onHashChange(); return; }
    if (scope === 'users' && window.location.hash === '#unlicensed') window.location.hash = 'users';
    this.directoryScope = scope;
    this.filter = '';
    this.expandedRowId = null;
    this.render();
  }
  private openDetail(row: ResourceRow, securityAction: UserSecurityAction | null = null, panel = 'account'): void {
    this.accountPanel = securityAction ? 'security' : panel;
    this.busy = false;
    this.detail = row;
    this.detailKind = row.source === 'group' || this.resource === 'groups' ? 'group' : row.source === 'user' || this.resource === 'users' || this.resource === 'shared-mailboxes' ? 'user' : 'read';
    this.detailRecord = null;
    this.forwardingRequest += 1; this.forwardingOpen = false; this.forwarding = null;
    this.resetAutoReply(); this.resetAddresses(); this.resetDelegation();
    this.forwardingError = ''; this.forwardingMessage = ''; this.forwardingNeedsRefresh = false;
    this.userVerificationRequest += 1;
    this.userSecurityRequest += 1;
    this.globalAdminRequest += 1;
    this.userSecurityAction = securityAction; this.temporaryPassword = null;
    const sharedMailbox = this.resource === 'shared-mailboxes' || this.mailboxInventory?.records.some(record => record.id.toLowerCase() === row.id.toLowerCase() && record.recipientType === 'SharedMailbox') === true;
    this.detailIsShared = sharedMailbox;
    this.globalAdminStatus = null; this.globalAdminDraft = null; this.globalAdminLoading = this.detailKind === 'user' && !sharedMailbox; this.globalAdminError = ''; this.globalAdminConfirmation = '';
    this.mfaOpen = false; this.mfaMethods = null; this.mfaLoading = false; this.mfaError = ''; this.mfaRemoval = null; this.mfaConfirmation = ''; this.recoveryEmailDraft = ''; this.recoveryEmailNeedsRefresh = false; this.mobilePhoneDraft = ''; this.mobilePhoneNeedsRefresh = false;
    this.licensesRequest += 1; this.licensesOpen = false; this.userLicenses = null; this.licensesLoading = false;
    this.licensesError = ''; this.licenseRemovalSku = ''; this.licenseConfirmation = ''; this.licenseNeedsRefresh = false;
    this.drawerMessage = '';
    this.drawerError = false;
    this.membershipUserId = '';
    this.membershipUsers = null;
    this.membershipSearch = '';
    this.membershipUsersRequest += 1;
    this.groupPeople = null; this.groupPeopleError = ''; this.groupPeopleRequest += 1;
    this.groupSettings = null; this.groupSettingsError = ''; this.groupSettingsRequest += 1;
    this.groupExternalDraft = null; this.groupExternalNeedsRefresh = false;
    this.groupAliasDraft = ''; this.groupAliasRemoval = '';
    this.groupPrimaryDraft = ''; this.groupPrimaryNeedsRefresh = false;
    this.driveLink = null; this.driveLinkError = ''; this.driveLinkLoading = false; this.driveLinkRequest += 1;
    this.groupNameNeedsRefresh = false;
    this.membershipAction = 'add';
    this.membershipRole = 'member'; this.membershipNeedsRefresh = false;

    this.userGroupRequest += 1; this.userGroupOpen = false; this.userGroups = null;
    this.userGroupSelectedId = ''; this.userGroupNeedsRefresh = false;
    this.userDraft = {};
    this.returnFocus = `row-${row.id}`;
    this.render();
    queueMicrotask(() => this.root.querySelector<HTMLButtonElement>('#detail-close')?.focus());
    const distribution = this.detailKind === 'group' && row.values.groupKind === 'Distribution list';
    if (distribution) {
      this.detailRecord = { ...row.values, id: row.id };
      this.groupNameDraft = String(row.values.displayName ?? '');
      this.render();
    }
    else if (this.detailKind !== 'read') void this.loadDetailRecord(row.id, this.detailKind);
    if (this.detailKind === 'user' && !sharedMailbox && panel === 'account') void this.loadGlobalAdminStatus(row.id);
    if (this.detailKind === 'user' && panel === 'addresses' && this.mailboxInventory?.records.some(record => record.id.toLowerCase() === row.id.toLowerCase())) this.openAddresses();
    if (this.detailKind === 'group' && ['members', 'owners'].includes(panel) && this.connection?.canManage && (!row.values.groupKind || row.values.groupKind === 'Microsoft 365 group' || distribution)) void this.loadMembershipUsers(row.id);
    if (this.detailKind === 'group' && ['members', 'owners'].includes(panel) && (!row.values.groupKind || row.values.groupKind === 'Microsoft 365 group' || distribution)) void this.loadGroupPeople(row.id);
    if (this.detailKind === 'group' && panel === 'email' && (row.values.groupKind === 'Microsoft 365 group' || distribution)) void this.loadGroupSettings(row.id);
  }
  private openCreateUser(): void {
    if (!this.connection?.canManage || this.resource !== 'users') return;
    this.createUserOpen = true; this.createUserSession += 1; this.createUserUncertain = false;
    this.createUserDomains = null; this.createUserError = ''; this.createdUser = null; this.createUserPassword = ''; this.createUserPasswordMode = 'generated'; this.createUserForceChange = true;
    this.createUserLicenses = null; this.createLicenseCatalogError = '';
    this.createUserDraft = { name: '', local: '', domain: '', location: '', skuId: '' };
    this.createUserGroups = null; this.createUserGroupIds = []; this.createUserGroupsError = ''; this.createUserGroupOutcomes = [];
    this.createLicenseOutcome = ''; this.createLicenseOutcomeError = false;
    this.render();
    queueMicrotask(() => this.root.querySelector<HTMLButtonElement>('#create-user-close')?.focus());
    void this.loadCreateUserDomains();
    void this.loadCreateUserLicenses();
    void this.loadCreateUserGroups();
  }
  private openCreateGroup(): void {
    if (!this.connection?.canManage || this.resource !== 'groups') return;
    this.createGroupOpen = true; this.createGroupUsers = null; this.createGroupDraft = { kind: 'm365', name: '', alias: '', ownerId: '', primarySmtpAddress: '' };
    this.createGroupError = ''; this.createdGroup = null; this.createGroupBusy = false; this.createGroupUncertain = false; this.render();
    void this.loadCreateGroupOwners();
  }
  private async loadCreateGroupOwners(): Promise<void> {
    this.createGroupUsers = null; this.createGroupError = ''; this.render();
    const request = ++this.createGroupRequest;
    const generation = this.generation; const context = this.contextValue;
    void this.request<unknown>(this.path('/resources/users')).then(raw => {
      if (generation !== this.generation || context !== this.contextValue || !this.createGroupOpen || request !== this.createGroupRequest) return;
      const users = parseResourceData(raw);
      if (!users.complete) throw new Error('The owner list is incomplete. Refresh owners before creating a Microsoft 365 group.');
      this.createGroupUsers = users; this.render();
    }).catch(error => {
      if (generation !== this.generation || context !== this.contextValue || !this.createGroupOpen || request !== this.createGroupRequest) return;
      this.createGroupError = error instanceof Error ? error.message : 'Could not load owners.'; this.render();
    });
  }
  private async createGroup(): Promise<void> {
    if (!this.connection?.canManage || this.createGroupBusy || this.createGroupUncertain || !this.createGroupOpen || this.createdGroup) return;
    const { kind, name, alias, ownerId, primarySmtpAddress } = this.createGroupDraft;
    if (!name.trim() || (kind === 'm365' && (!/^[A-Za-z0-9'.!#^~_-]{1,64}$/.test(alias.trim()) || !this.createGroupUsers?.items.some(row => row.id === ownerId))) ||
      (kind === 'distribution' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(primarySmtpAddress.trim()))) {
      this.createGroupError = kind === 'distribution' ? 'Enter a name and full email address in a tenant accepted domain.'
        : 'Enter a group name and mail alias, then choose a loaded tenant user as owner.'; this.render(); return;
    }
    const generation = this.generation; const context = this.contextValue; const request = this.createGroupRequest;
    this.createGroupBusy = true; this.createGroupError = ''; this.render();
    try {
      const result = await this.request<{ accepted: boolean; id: string | null; verified: boolean; mail?: string | null; primarySmtpAddress?: string }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(kind === 'distribution' ? { type: 'distribution.create', name: name.trim(), primarySmtpAddress: primarySmtpAddress.trim() }
          : { type: 'group.create', group: { displayName: name.trim(), mailNickname: alias.trim(), ownerId } }),
      });
      if (generation !== this.generation || context !== this.contextValue || !(request === this.createGroupRequest) || !this.createGroupOpen) return;
      if (!result.accepted || (kind === 'm365' && !result.id) || (kind === 'distribution' && !result.verified))
        throw new Error('Group creation outcome is uncertain. Refresh before retrying.');
      this.createdGroup = { kind, id: result.id, mail: result.primarySmtpAddress ?? result.mail ?? null, verified: result.verified };
      void this.refreshDirectory();
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && request === this.createGroupRequest && this.createGroupOpen) {
        this.createGroupUncertain = true;
        this.createGroupError = `${error instanceof Error ? error.message : 'Group creation outcome is uncertain.'} Close this panel and check the directory before starting another creation.`;
      }
    } finally { if (generation === this.generation && context === this.contextValue && request === this.createGroupRequest) { this.createGroupBusy = false; this.render(); } }
  }
  private closeCreateUser(): void {
    if (this.createUserBusy) return;
    this.createUserOpen = false; this.createUserSession += 1;
    this.createdUser = null; this.createUserPassword = ''; this.createUserPasswordMode = 'generated'; this.createUserForceChange = true;
    this.render();
    queueMicrotask(() => this.root.querySelector<HTMLButtonElement>('#create-user')?.focus());
  }
  private async loadCreateUserDomains(): Promise<void> {
    const generation = this.generation, context = this.contextValue, session = this.createUserSession, request = ++this.createUserDomainsRequest;
    try {
      const result = await this.request<{ domains: string[]; defaultUsageLocation?: string | null }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user.domains.list' }),
      });
      if (generation !== this.generation || context !== this.contextValue || !this.createUserOpen || session !== this.createUserSession || request !== this.createUserDomainsRequest) return;
      if (!Array.isArray(result.domains) || !result.domains.every(domain => typeof domain === 'string')) throw new Error('Invalid verified-domain response.');
      this.createUserDomains = result.domains;
      this.createUserDraft.location = /^[A-Z]{2}$/.test(result.defaultUsageLocation ?? '') ? result.defaultUsageLocation! : '';
      if (!result.domains.includes(this.createUserDraft.domain)) this.createUserDraft.domain = result.domains[0] ?? '';
      if (!result.domains.length) this.createUserError = 'No verified sign-in domain is available for this tenant.';
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || !this.createUserOpen || session !== this.createUserSession || request !== this.createUserDomainsRequest) return;
      this.createUserDomains = [];
      this.createUserError = error instanceof Error ? error.message : 'Could not load verified domains.';
    }
    this.render();
  }
  private async loadCreateUserLicenses(): Promise<void> {
    const generation = this.generation, context = this.contextValue, session = this.createUserSession, request = ++this.createUserLicensesRequest;
    try {
      const result = await this.request<{ items: LicenseOption[]; partial: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'licenses.list' }),
      });
      if (generation !== this.generation || context !== this.contextValue || !this.createUserOpen || session !== this.createUserSession || request !== this.createUserLicensesRequest) return;
      if (!Array.isArray(result.items) || result.partial || !result.items.every(item => typeof item.skuId === 'string' && typeof item.skuPartNumber === 'string'
        && typeof item.consumedUnits === 'number' && typeof item.prepaidUnits?.enabled === 'number')) throw new Error('Complete license inventory is unavailable.');
      this.createUserLicenses = result.items.filter(item => item.capabilityStatus === 'Enabled'
        && item.prepaidUnits.enabled > item.consumedUnits);
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || !this.createUserOpen || session !== this.createUserSession || request !== this.createUserLicensesRequest) return;
      this.createLicenseCatalogError = error instanceof Error ? error.message : 'Could not load license inventory.';
      this.createUserLicenses = [];
    }
    this.render();
  }
  private async loadCreateUserGroups(): Promise<void> {
    const generation = this.generation, session = this.createUserSession, request = ++this.createUserGroupsRequest;
    this.createUserGroupsError = '';
    try {
      const groups = parseResourceData(await this.request<unknown>(this.path('/resources/groups')));
      if (generation !== this.generation || session !== this.createUserSession || request !== this.createUserGroupsRequest || !this.createUserOpen) return;
      if (!groups.complete) throw new Error('The group list is incomplete. Retry before selecting memberships.');
      this.createUserGroups = groups.items.filter(group => ['Microsoft 365 group', 'Distribution list'].includes(String(group.values.groupKind))
        && !group.values.membershipRule && group.values.onPremisesSyncEnabled !== true && group.values.isAssignableToRole !== true);
      this.createUserGroupIds = this.createUserGroupIds.filter(id => this.createUserGroups!.some(group => group.id === id));
    } catch (error) {
      if (generation !== this.generation || session !== this.createUserSession || request !== this.createUserGroupsRequest || !this.createUserOpen) return;
      this.createUserGroupsError = error instanceof Error ? error.message : 'Could not load groups.';
    }
    this.render();
  }
  private async createUser(): Promise<void> {
    if (!this.connection?.canManage || this.createUserBusy || this.createUserUncertain || this.createdUser || !this.createUserDomains?.length) return;
    const name = this.root.querySelector<HTMLInputElement>('#create-user-name')?.value.trim() ?? '';
    const local = this.root.querySelector<HTMLInputElement>('#create-user-local')?.value.trim() ?? '';
    const domain = this.root.querySelector<HTMLSelectElement>('#create-user-domain')?.value ?? '';
    const location = this.createUserDraft.location;
    const password = this.createUserPasswordMode === 'custom' ? this.createUserPassword : undefined;
    const forceChangePasswordNextSignIn = this.createUserForceChange;
    if (password !== undefined && (password.length < 8 || password.length > 256)) { this.createUserError = 'Enter a password between 8 and 256 characters. Microsoft also applies the tenant password policy.'; this.render(); return; }
    const skuId = this.root.querySelector<HTMLSelectElement>('#create-user-license')?.value ?? '';
    this.createUserDraft = { name, local, domain, location, skuId };
    if (!name || !/^[A-Za-z0-9'.!#^~_-]+$/.test(local) || !this.createUserDomains.includes(domain)) {
      this.createUserError = 'Enter a name and valid sign-in name using a verified domain.'; this.render(); return;
    }
    if ((location && !/^[A-Z]{2}$/.test(location)) || (skuId && (!location || !this.createUserLicenses?.some(item => item.skuId === skuId)))) {
      this.createUserError = 'A license needs an available seat and a default usage location configured in this Microsoft tenant.'; this.render(); return;
    }
    const generation = this.generation, context = this.contextValue, session = this.createUserSession;
    this.createUserBusy = true; this.createUserError = ''; this.render();
    try {
      const result = await this.request<{ accepted: boolean; id: string; userPrincipalName: string; temporaryPassword: string }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'user.create', user: { displayName: name, userPrincipalName: `${local}@${domain}`, ...(location ? { usageLocation: location } : {}), ...(password !== undefined ? { password } : {}), ...(!forceChangePasswordNextSignIn ? { forceChangePasswordNextSignIn: false } : {}) } }),
      });
      if (generation !== this.generation || context !== this.contextValue || !(session === this.createUserSession) || !this.createUserOpen) return;
      if (!result.accepted || !result.id || !result.temporaryPassword) throw new Error('Creation outcome is uncertain. Refresh the directory before trying again.');
      this.createUserPassword = '';
      this.createdUser = { id: result.id, userPrincipalName: result.userPrincipalName, temporaryPassword: result.temporaryPassword };
      this.render();
      if (skuId) {
        try {
          const assignment = await this.request<{ accepted: boolean; verified: boolean }>(this.path('/administration'), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'user.license.assign', id: result.id, license: { skuId } }),
          });
          if (generation !== this.generation || context !== this.contextValue || !(session === this.createUserSession) || !this.createUserOpen) return;
          this.createLicenseOutcome = assignment.accepted
            ? assignment.verified ? 'License assigned and verified.' : 'Microsoft accepted the license assignment. Refresh the user to verify it appears.'
            : 'License assignment was not confirmed. Review the user before retrying.';
          this.createLicenseOutcomeError = !assignment.accepted || !assignment.verified;
        } catch (error) {
          if (generation !== this.generation || context !== this.contextValue || !(session === this.createUserSession) || !this.createUserOpen) return;
          this.createLicenseOutcome = `User created; license assignment was not confirmed. ${error instanceof Error ? error.message : 'Review the user before retrying.'}`;
          this.createLicenseOutcomeError = true;
        }
      }
      for (const groupId of [...this.createUserGroupIds]) {
        if (generation !== this.generation || context !== this.contextValue || session !== this.createUserSession || !this.createUserOpen) return;
        const group = this.createUserGroups?.find(item => item.id === groupId);
        if (!group) continue;
        const name = String(group.values.displayName ?? groupId);
        try {
          const membership = await this.request<{accepted?: boolean; verified?: boolean}>(this.path('/administration'), {
            method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(group.values.groupKind === 'Distribution list'
              ? {type: 'distribution.member.set', groupId, memberId: result.id, enabled: true}
              : {type: 'group.member.add', groupId, userId: result.id}),
          });
          if (generation !== this.generation || context !== this.contextValue || session !== this.createUserSession || !this.createUserOpen) return;
          this.createUserGroupOutcomes.push(`${name}: ${membership.verified ? 'membership verified' : 'submitted; check membership before retrying'}.`);
        } catch {
          if (generation !== this.generation || context !== this.contextValue || session !== this.createUserSession || !this.createUserOpen) return;
          this.createUserGroupOutcomes.push(`${name}: membership not confirmed. Review this user’s groups before retrying.`);
        }
        this.render();
      }
      void this.loadResource();
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && session === this.createUserSession && this.createUserOpen) {
        this.createUserUncertain = true; this.createUserPassword = '';
        this.createUserError = `${error instanceof Error ? error.message : 'Creation outcome is uncertain.'} Close this panel and check the directory before starting another creation.`;
      }
    } finally {
      if (generation === this.generation && context === this.contextValue && session === this.createUserSession) { this.createUserBusy = false; this.render(); }
    }
  }
  private openMfa(row: ResourceRow): void {
    if (!this.connection?.canManage) return;
    this.openDetail(row, null, 'mfa');
    this.mfaOpen = true; this.mfaMethods = null; this.mfaLoading = true; this.mfaError = ''; this.mfaRemoval = null; this.mfaConfirmation = ''; this.recoveryEmailDraft = ''; this.recoveryEmailNeedsRefresh = false; this.mobilePhoneDraft = ''; this.mobilePhoneNeedsRefresh = false;
    this.render();
    void this.loadMfaMethods(row.id);
  }
  private closeDetail(): void {
    const id = this.returnFocus;
    this.detail = null;
    this.detailRecord = null;
    this.forwardingRequest += 1; this.forwardingOpen = false; this.forwarding = null;
    this.resetAutoReply(); this.resetAddresses(); this.resetDelegation();
    this.forwardingError = ''; this.forwardingMessage = ''; this.forwardingNeedsRefresh = false;
    this.detailRequest += 1;
    this.userVerificationRequest += 1;
    this.userSecurityRequest += 1;
    this.globalAdminRequest += 1;
    this.userSecurityAction = null; this.temporaryPassword = null;
    this.globalAdminStatus = null; this.globalAdminDraft = null; this.globalAdminLoading = false; this.globalAdminError = ''; this.globalAdminConfirmation = '';
    this.mfaOpen = false; this.mfaMethods = null; this.mfaLoading = false; this.mfaError = ''; this.mfaRemoval = null; this.mfaConfirmation = ''; this.recoveryEmailDraft = ''; this.recoveryEmailNeedsRefresh = false; this.mobilePhoneDraft = ''; this.mobilePhoneNeedsRefresh = false; this.mfaRequest += 1;
    this.licensesRequest += 1; this.licensesOpen = false; this.userLicenses = null; this.licensesLoading = false;
    this.licensesError = ''; this.licenseRemovalSku = ''; this.licenseConfirmation = ''; this.licenseNeedsRefresh = false;
    this.busy = false;
    this.drawerMessage = '';
    this.drawerError = false;
    this.membershipUserId = '';
    this.membershipUsers = null;
    this.membershipSearch = '';
    this.membershipUsersRequest += 1;
    this.groupPeople = null; this.groupPeopleError = ''; this.groupPeopleRequest += 1;
    this.groupSettings = null; this.groupSettingsError = ''; this.groupSettingsRequest += 1;
    this.groupExternalDraft = null; this.groupExternalNeedsRefresh = false;
    this.groupAliasDraft = ''; this.groupAliasRemoval = '';
    this.groupPrimaryDraft = ''; this.groupPrimaryNeedsRefresh = false;
    this.driveLink = null; this.driveLinkError = ''; this.driveLinkLoading = false; this.driveLinkRequest += 1;
    this.groupNameNeedsRefresh = false;
    this.membershipAction = 'add';
    this.membershipRole = 'member'; this.membershipNeedsRefresh = false;

    this.userGroupRequest += 1; this.userGroupOpen = false; this.userGroups = null;
    this.userGroupSelectedId = ''; this.userGroupNeedsRefresh = false;
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
      if (!data.complete) throw new Error('User directory is incomplete. Refresh the directory before changing group assignments.');
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
  private userMemberships: { items: Array<{id: string; displayName: string; removable: boolean; reason: string; membershipProvider?: 'graph' | 'exchange' | null}>; partial: boolean } | null = null;
  private userGroupRemoveId = '';
  private userGroupCatalogError = '';
  private userMembershipError = '';
  private async openUserGroups(): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'user' || this.busy) return;
    const userId = this.detail.id;
    const generation = this.generation, context = this.contextValue, request = ++this.userGroupRequest;
    const current = () => generation === this.generation && context === this.contextValue && request === this.userGroupRequest
      && this.detail?.id === userId && this.userGroupOpen;
    this.userGroupOpen = true; this.userGroups = null; this.userMemberships = null; this.userGroupRemoveId = ''; this.userGroupSelectedId = '';
    this.userGroupCatalogError = ''; this.userMembershipError = ''; this.drawerMessage = ''; this.drawerError = false;
    this.userGroupNeedsRefresh = false;
    this.render();
    await Promise.all([
      this.request<unknown>(this.path('/resources/groups')).then(parseResourceData).then(groups => {
        if (!current()) return;
        if (!groups.complete) throw new Error('The complete group list is unavailable. Refresh before assigning a member.');
        this.userGroups = groups;
      }).catch(error => { if (current()) this.userGroupCatalogError = error instanceof Error ? error.message : 'Could not load available groups.'; })
        .finally(() => { if (current()) this.render(); }),
      this.request<{ items: Array<{ id: string; displayName: string; removable: boolean; reason: string; membershipProvider?: 'graph' | 'exchange' | null }>; partial: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user.groups.get', id: userId }),
      }).then(memberships => {
        if (!current()) return;
        if (!memberships || !Array.isArray(memberships.items) || typeof memberships.partial !== 'boolean'
          || !memberships.items.every(group => group && typeof group.id === 'string' && typeof group.displayName === 'string'
            && typeof group.removable === 'boolean' && typeof group.reason === 'string')) throw new Error('Current group memberships could not be verified.');
        this.userMemberships = memberships;
      }).catch(error => { if (current()) this.userMembershipError = error instanceof Error ? error.message : 'Could not load current memberships.'; })
        .finally(() => { if (current()) this.render(); }),
    ]);
  }
  private async addUserToGroup(): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'user' || !this.userGroupOpen
      || this.busy || this.userGroupNeedsRefresh) return;
    const removing = !!this.userGroupRemoveId;
    const groupId = this.userGroupRemoveId || this.userGroupSelectedId;
    if (removing && (!this.userMemberships || this.userMemberships.partial || !this.userMemberships.items.some(group => group.id === groupId && group.removable))) return;
    if (!removing && (!this.userMemberships || !this.userGroups?.complete || !this.userGroups.items.some(group => group.id === groupId
      && group.values.groupKind === 'Microsoft 365 group'))) return;
    const userId = this.detail.id, generation = this.generation, context = this.contextValue;
    const request = this.userGroupRequest;
    this.busy = true; this.drawerError = false; this.drawerMessage = removing ? 'Removing group membership…' : 'Adding group member…'; this.render();
    try {
      const result = await this.request<{ accepted?: boolean; verified?: boolean; changed?: boolean }>(
        this.path('/administration'), { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(removing && this.userMemberships?.items.find(group => group.id === groupId)?.membershipProvider === 'exchange'
            ? { type: 'distribution.member.set', groupId, memberId: userId, enabled: false }
            : { type: removing ? 'group.member.remove' : 'group.member.add', groupId, userId }) });
      if (generation !== this.generation || context !== this.contextValue || request !== this.userGroupRequest
        || this.detail?.id !== userId) return;
      if (result.accepted !== true) throw new Error('Microsoft did not confirm the membership change.');
      this.userGroupNeedsRefresh = result.verified !== true;
      this.drawerError = result.verified !== true;
      this.drawerMessage = removing ? result.verified ? 'Group membership removed and verified.' : 'Removal accepted; refresh to confirm membership.' : result.changed === false ? 'This account was already a member.'
        : result.verified ? 'Group membership added and verified.'
          : 'Microsoft accepted the membership change, but readback is pending. Refresh before trying again.';
      if (result.verified && this.userMemberships) {
        if (removing) this.userMemberships.items = this.userMemberships.items.filter(group => group.id !== groupId);
        else { const group = this.userGroups?.items.find(item => item.id === groupId); if (group && !this.userMemberships.items.some(item => item.id === groupId)) this.userMemberships.items.push({ id: groupId, displayName: String(group.values.displayName ?? groupId), removable: true, reason: '' }); }
      }
      this.userGroupRemoveId = '';
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && request === this.userGroupRequest
        && this.detail?.id === userId) {
        this.userGroupNeedsRefresh = true; this.drawerError = true;
        this.drawerMessage = error instanceof Error ? error.message : 'Membership outcome is uncertain. Refresh before retrying.';
      }
    } finally {
      if (generation === this.generation && request === this.userGroupRequest) { this.busy = false; this.render(); }
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
      if (kind === 'group') this.groupNameDraft = String(this.detailRecord.displayName ?? '');
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
      this.mfaMethods = methods; this.mfaRemovalNeedsRefresh = false; this.recoveryEmailDraft = methods.find(method => method.type === 'email')?.detail ?? ''; this.mobilePhoneDraft = ''; this.mfaError = ''; this.recoveryEmailNeedsRefresh = false; this.mobilePhoneNeedsRefresh = false;
      return methods;
    } catch (error) {
      if (this.mfaRequestIsCurrent(id, generation, context, request)) { this.mfaMethods = null; this.mfaError = error instanceof Error ? error.message : 'MFA methods are unavailable.'; }
      return null;
    } finally {
      if (this.mfaRequestIsCurrent(id, generation, context, request)) { this.mfaLoading = false; this.render(); }
    }
  }
  private async removeMfaMethod(): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'user' || !this.mfaOpen || !this.mfaRemoval || this.busy || this.mfaRemovalNeedsRefresh) return;
    if (this.mfaConfirmation !== 'REMOVE_AUTH_METHOD') { this.drawerError = true; this.drawerMessage = 'Type REMOVE_AUTH_METHOD to confirm this authentication-method removal.'; this.render(); return; }
    const id = this.detail.id; const method = this.mfaRemoval; const generation = this.generation; const context = this.contextValue; const request = ++this.mfaRequest;
    const current = () => this.mfaRequestIsCurrent(id, generation, context, request);
    this.busy = true; this.mfaRemovalNeedsRefresh = true; this.drawerError = false; this.drawerMessage = 'Removing authentication method…'; this.render();
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
      if (current()) { this.mfaRemovalNeedsRefresh = true; this.drawerError = true; this.drawerMessage = error instanceof Error ? error.message : 'Authentication-method removal outcome is uncertain. Review the account before retrying.'; }
    } finally { if (current()) { this.busy = false; this.mfaLoading = false; this.render(); } }
  }

  private async saveRecoveryEmail(): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'user' || !this.mfaOpen || this.busy || this.recoveryEmailNeedsRefresh) return;
    const emailAddress = this.recoveryEmailDraft.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress) || emailAddress.length > 320) {
      this.drawerError = true; this.drawerMessage = 'Enter a valid recovery email address.'; this.render(); return;
    }
    const id = this.detail.id; const generation = this.generation; const context = this.contextValue; const request = ++this.mfaRequest;
    const current = () => this.mfaRequestIsCurrent(id, generation, context, request);
    this.busy = true; this.drawerError = false; this.drawerMessage = 'Saving recovery email…'; this.render();
    try {
      const result = await this.request<{ accepted?: boolean; verified?: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'user.mfa.recoveryEmail.set', id, emailAddress, confirmation: 'SET_RECOVERY_EMAIL' }),
      });
      if (!current()) return;
      this.recoveryEmailNeedsRefresh = true;
      if (result.accepted !== true) throw new Error('Microsoft did not accept the recovery email change. Refresh methods before retrying.');

      this.drawerError = result.verified !== true;
      this.drawerMessage = result.verified === true ? 'Recovery email saved and verified. Refresh methods to see the current address.' : 'Microsoft accepted the recovery email, but readback is pending. Refresh methods before another change.';
    } catch (error) {
      if (current()) { this.recoveryEmailNeedsRefresh = true; this.drawerError = true; this.drawerMessage = `${error instanceof Error ? error.message : 'Recovery email outcome is uncertain.'} Refresh methods before another change.`; }
    } finally { if (current()) { this.busy = false; this.render(); } }
  }
  private async loadGroupPeople(groupId: string): Promise<void> {
    const generation = this.generation, context = this.contextValue, request = ++this.groupPeopleRequest;
    const distribution = this.detail?.values.groupKind === 'Distribution list';
    this.groupPeople = null; this.groupPeopleError = ''; this.render();
    try {
      const raw = await this.request<GroupPeople | { groupId: string; members: Array<{ id: string; displayName: string; primarySmtpAddress: string }>; complete: boolean }>(this.path('/administration'), { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(distribution
          ? { type: 'distribution.members.get', groupId } : { type: 'group.people.list', id: groupId }) });
      const data: GroupPeople = distribution && 'members' in raw && !('owners' in raw)
        ? { groupId: raw.groupId, members: raw.members.map(member => ({ id: member.id, displayName: member.displayName,
          userPrincipalName: member.primarySmtpAddress })), owners: [], complete: raw.complete, otherMemberCount: 0 }
        : raw as GroupPeople;
      if (generation !== this.generation || context !== this.contextValue || request !== this.groupPeopleRequest
        || this.detail?.id !== groupId || this.detailKind !== 'group') return;
      if (data.groupId !== groupId || !Array.isArray(data.members) || !Array.isArray(data.owners)) throw new Error('Group membership response is invalid.');
      this.groupPeople = data;
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.groupPeopleRequest
        || this.detail?.id !== groupId || this.detailKind !== 'group') return;
      this.groupPeopleError = error instanceof Error ? error.message : 'Could not load current membership.';
    }
    this.render();
  }
  private async loadGroupSettings(groupId: string): Promise<void> {
    const generation = this.generation, context = this.contextValue, request = ++this.groupSettingsRequest;
    const expectedKind = this.detail?.values.groupKind === 'Distribution list' ? 'distribution' : 'microsoft365';
    this.groupSettings = null; this.groupSettingsError = ''; this.render();
    try {
      const data = await this.request<GroupSettings>(this.path('/administration'), { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'group.settings.get', groupId }) });
      if (generation !== this.generation || context !== this.contextValue || request !== this.groupSettingsRequest
        || this.detail?.id !== groupId || this.detailKind !== 'group') return;
      if (data.groupId !== groupId || data.kind !== expectedKind || typeof data.requireSenderAuthenticationEnabled !== 'boolean'
        || typeof data.primarySmtpAddress !== 'string' || !Array.isArray(data.aliases) ||
        (data.kind === 'distribution' && typeof data.emailAddressPolicyEnabled !== 'boolean')) throw new Error('Group settings response is invalid.');
      this.groupSettings = data;
      this.groupExternalDraft = !data.requireSenderAuthenticationEnabled;

      this.groupExternalNeedsRefresh = false;
      this.groupPrimaryDraft = data.primarySmtpAddress;

      this.groupPrimaryNeedsRefresh = false;
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.groupSettingsRequest
        || this.detail?.id !== groupId || this.detailKind !== 'group') return;
      this.groupSettingsError = error instanceof Error ? error.message : 'Could not load group settings.';
    }
    this.render();
  }
  private async saveGroupExternal(): Promise<void> {
    if (!this.connection?.canManage || this.detailKind !== 'group' || !this.detail || !this.groupSettings ||
      this.groupExternalDraft === null || this.busy || this.groupExternalNeedsRefresh) return;
    const allowExternalSenders = this.groupExternalDraft;
    if (allowExternalSenders === !this.groupSettings.requireSenderAuthenticationEnabled) return;
    const groupId = this.detail.id, generation = this.generation, context = this.contextValue;
    const detailRequest = this.detailRequest, settingsRequest = this.groupSettingsRequest;
    this.busy = true; this.drawerError = false; this.drawerMessage = 'Saving external-sender policy…'; this.render();
    try {
      const result = await this.request<{ groupId: string; allowExternalSenders: boolean; accepted: boolean; verified: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'group.external.set', groupId, allowExternalSenders }),
      });
      if (generation !== this.generation || context !== this.contextValue || detailRequest !== this.detailRequest ||
        settingsRequest !== this.groupSettingsRequest || this.detail?.id !== groupId) return;
      if (result.groupId !== groupId || result.allowExternalSenders !== allowExternalSenders || !result.accepted || !result.verified)
        throw new Error('Microsoft did not verify the external-sender change.');
      this.groupSettings.requireSenderAuthenticationEnabled = !allowExternalSenders;

      this.drawerMessage = 'External-sender policy saved and verified.';
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && detailRequest === this.detailRequest &&
        settingsRequest === this.groupSettingsRequest && this.detail?.id === groupId) {
        this.groupExternalNeedsRefresh = true; this.drawerError = true;
        this.drawerMessage = `${error instanceof Error ? error.message : 'External-sender outcome is uncertain.'} Refresh delivery settings before another change.`;
      }
    } finally {
      if (generation === this.generation && context === this.contextValue && detailRequest === this.detailRequest &&
        settingsRequest === this.groupSettingsRequest && this.detail?.id === groupId) { this.busy = false; this.render(); }
    }
  }
  private async writeGroupAlias(): Promise<void> {
    const groupId = this.detail?.id, settings = this.groupSettings;
    const removing = !!this.groupAliasRemoval;
    const address = (this.groupAliasRemoval || this.groupAliasDraft).trim();
    if (!groupId || this.detailKind !== 'group' || !settings || !this.connection?.canManage || this.busy || this.groupPrimaryNeedsRefresh || !address ||
      settings.kind === 'distribution' && settings.emailAddressPolicyEnabled !== false || this.detailRecord?.onPremisesSyncEnabled === true) return;
    if (removing && (!settings.aliases.some(alias => alias.toLowerCase() === address.toLowerCase()) || address.toLowerCase() === settings.primarySmtpAddress.toLowerCase() || /\.onmicrosoft\.com$/i.test(address))) return;
    const generation = this.generation, context = this.contextValue;
    this.busy = true; this.drawerMessage = ''; this.drawerError = false; this.render();
    try {
      const result = await this.request<{accepted: boolean; verified: boolean}>(this.path('/administration'), {method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({type: removing ? 'group.alias.remove' : 'group.alias.add', groupId, address})});
      if (generation !== this.generation || context !== this.contextValue || this.detail?.id !== groupId) return;
      this.groupPrimaryNeedsRefresh = true;
      if (!result.accepted || !result.verified) throw new Error('Alias outcome is pending. Refresh settings before another change.');
      this.groupAliasDraft = ''; this.groupAliasRemoval = ''; this.drawerMessage = 'Alias change saved and verified.';
      await this.loadGroupSettings(groupId);
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && this.detail?.id === groupId) { this.groupPrimaryNeedsRefresh = true; this.drawerError = true; this.drawerMessage = error instanceof Error ? error.message : 'Alias outcome is uncertain. Refresh settings before another change.'; }
    } finally { if (generation === this.generation && context === this.contextValue && this.detail?.id === groupId) { this.busy = false; this.render(); } }
  }

  private async saveGroupPrimary(): Promise<void> {
    if (!this.connection?.canManage || this.detailKind !== 'group' || !this.detail || !this.groupSettings ||
      this.busy || this.groupPrimaryNeedsRefresh) return;
    const address = this.groupPrimaryDraft.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) || address.length > 320 ||
      address.toLowerCase() === this.groupSettings.primarySmtpAddress.toLowerCase()) return;
    if (this.groupSettings.kind === 'distribution' && this.groupSettings.emailAddressPolicyEnabled !== false) {
      this.drawerError = true; this.drawerMessage = 'This list address is managed by an email-address policy. Change the policy in Exchange first.';
      this.render(); return;
    }
    const groupId = this.detail.id, generation = this.generation, context = this.contextValue;
    const detailRequest = this.detailRequest, settingsRequest = this.groupSettingsRequest;
    const previous = this.groupSettings.primarySmtpAddress;
    this.busy = true; this.drawerError = false; this.drawerMessage = 'Changing the group address…'; this.render();
    try {
      const result = await this.request<{ groupId: string; primarySmtpAddress: string; accepted: boolean; verified: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'group.primary.set', groupId, address }),
      });
      if (generation !== this.generation || context !== this.contextValue || detailRequest !== this.detailRequest ||
        settingsRequest !== this.groupSettingsRequest || this.detail?.id !== groupId) return;
      if (result.groupId.toLowerCase() !== groupId.toLowerCase() || result.primarySmtpAddress.toLowerCase() !== address.toLowerCase() ||
        result.accepted !== true || result.verified !== true) throw new Error('Microsoft did not verify the group address change.');
      this.groupSettings.primarySmtpAddress = result.primarySmtpAddress;
      this.groupSettings.aliases = [...new Set([...this.groupSettings.aliases, previous].filter(value => value.toLowerCase() !== address.toLowerCase()))];
      if (this.detailRecord) this.detailRecord.mail = result.primarySmtpAddress;
      this.detail.values.mail = result.primarySmtpAddress;
      this.groupPrimaryDraft = result.primarySmtpAddress;

      this.drawerMessage = 'Primary address saved and verified. The previous address remains an alias.';
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && detailRequest === this.detailRequest &&
        settingsRequest === this.groupSettingsRequest && this.detail?.id === groupId) {
        this.groupPrimaryNeedsRefresh = true; this.drawerError = true;
        this.drawerMessage = `${error instanceof Error ? error.message : 'Address outcome is uncertain.'} Refresh delivery settings before another change.`;
      }
    } finally {
      if (generation === this.generation && context === this.contextValue && detailRequest === this.detailRequest &&
        settingsRequest === this.groupSettingsRequest && this.detail?.id === groupId) { this.busy = false; this.render(); }
    }
  }
  private async showDriveLink(): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'user' || this.driveLinkLoading) return;
    const id = this.detail.id, generation = this.generation, context = this.contextValue;
    const ticket = ++this.driveLinkRequest;
    this.driveLinkLoading = true; this.driveLinkError = ''; this.driveLink = null; this.render();
    try {
      const result = await this.request<{ url: string }>(this.path('/administration'), { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user.drive.link.get', id }) });
      if (generation !== this.generation || context !== this.contextValue || ticket !== this.driveLinkRequest || this.detail?.id !== id) return;
      const url = new URL(result.url);
      if (url.protocol !== 'https:' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.sharepoint\.(?:com|us|cn)$/i.test(url.hostname) ||
        url.username || url.password) throw new Error('Microsoft returned an invalid OneDrive link.');
      this.driveLink = url.href;
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && ticket === this.driveLinkRequest && this.detail?.id === id)
        this.driveLinkError = error instanceof Error ? error.message : 'Could not retrieve the OneDrive link.';
    } finally {
      if (generation === this.generation && context === this.contextValue && ticket === this.driveLinkRequest && this.detail?.id === id) {
        this.driveLinkLoading = false; this.render();
      }
    }
  }
  private async loadDirectorySnapshot(resource: Resource): Promise<{
    data: ResourceData; groupsData: ResourceData | null; inventory: MailboxInventory;
    usageStatus: string; directoryStatus: string; usageRecordIds: Set<string>; pending?: false;
  } | { pending: true } | null> {
    let raw: unknown;
    if (!this.api) throw new Error('The authenticated host API is unavailable.');
    const result = await this.api.request(this.path('/directory/snapshot'));
    if (result.status === 404) return null; // Older hosts retain the prior live path.
    if (!result.ok) throw new Error('The background Microsoft directory is unavailable.');
    try { raw = await result.json(); }
    catch { throw new Error('The background Microsoft directory response is invalid.'); }
    if (!raw || typeof raw !== 'object') throw new Error('The background Microsoft directory response is invalid.');
    const response = raw as Record<string, unknown>;
    const directorySource = response.directory as Record<string, unknown> | undefined;
    const usageSource = response.usage as Record<string, unknown> | undefined;
    if (!directorySource || !usageSource) throw new Error('The background Microsoft directory response is invalid.');
    if (!directorySource.data) return { pending: true };
    if (typeof directorySource.data !== 'object') throw new Error('The background Microsoft directory response is invalid.');
    const directory = directorySource.data as Record<string, unknown>;
    const usage = usageSource.data && typeof usageSource.data === 'object'
      ? usageSource.data as Record<string, unknown> : null;
    const collectedAt = typeof directorySource.collectedAt === 'string' ? directorySource.collectedAt : new Date().toISOString();
    const sourceStatus = directorySource.status === 'ready' ? 'ready' : 'stale';
    const baseMailboxes = Array.isArray(directory.mailboxes) ? directory.mailboxes : [];
    const prior = usage?.mailboxInventory ? parseMailboxInventory(usage.mailboxInventory) : null;
    const priorById = new Map(prior?.records.map(row => [row.id.toLowerCase(), row]) ?? []);
    const inventory = parseMailboxInventory({ records: baseMailboxes.map(mailbox => {
      const current = mailbox as Record<string, unknown>;
      const previous = priorById.get(String(current.id).toLowerCase());
      return { ...current, mailboxBytes: previous?.mailboxBytes ?? null,
        archiveBytes: previous?.archiveBytes ?? null,
        statisticsUnavailable: previous?.statisticsUnavailable ?? true,
        collectedAt: previous?.collectedAt ?? collectedAt };
    }), partial: false, collectedAt: prior?.collectedAt ?? collectedAt });
    const users = parseResourceData(directory.users);
    const groups = parseResourceData(directory.groups);
    const licenses = parseResourceData(directory.licenses);
    const driveValues = usage?.oneDriveByUserId && typeof usage.oneDriveByUserId === 'object'
      ? usage.oneDriveByUserId as Record<string, unknown> : null;
    if (driveValues) for (const user of users.items) {
      const value = driveValues[user.id];
      if (typeof value === 'string' && value.length <= 64) user.values.oneDrive = value;
    }
    for (const data of [users, groups, licenses]) {
      data.checkedAt = collectedAt;
      data.complete = true; // Stale is a freshness state, not a partial page.
    }
    const shared: ResourceData = { items: inventory.records.filter(row => row.recipientType === 'SharedMailbox').map(row => ({
      id: row.id, values: { primarySmtpAddress: row.primarySmtpAddress,
        mailbox: priorById.has(row.id.toLowerCase()) ? storageLabel(row.mailboxBytes) : 'Usage not loaded',
        archive: !row.archiveEnabled ? 'Off' : priorById.has(row.id.toLowerCase())
          ? storageLabel(row.archiveBytes) : 'Usage not loaded' },
    })), columns: [{ key: 'primarySmtpAddress', label: 'Shared mailbox' },
      { key: 'mailbox', label: 'Mailbox usage' }, { key: 'archive', label: 'Archive' }],
      complete: true, checkedAt: collectedAt };
    const data = resource === 'users' || resource === 'all' ? users
      : resource === 'groups' ? groups : resource === 'licenses' ? licenses : shared;
    return { data, groupsData: resource === 'all' ? groups : null, inventory,
      usageRecordIds: new Set(priorById.keys()),
      usageStatus: typeof usageSource.status === 'string' ? usageSource.status : 'never',
      directoryStatus: sourceStatus };
  }

  private async refreshDirectory(): Promise<void> {
    if (!this.canRead() || !this.api) return;
    if (this.resource === 'sites') { this.clearLegacyUsage(); await this.loadResource(); return; }
    const generation = this.generation;
    const resource = this.resource;
    const request = ++this.manualRefreshRequest;
    const current = () => generation === this.generation && resource === this.resource
      && request === this.manualRefreshRequest && this.isConnected;
    try {
      const before = await this.api.request(this.path('/directory/snapshot'));
      if (!current()) return;
      if (before.status === 404) { this.clearLegacyUsage(); await this.loadResource(); return; }
      if (!before.ok) throw new Error('The background Microsoft directory is unavailable.');
      const baseline = await before.json() as { directory?: { collectedAt?: string | null }; lastAttemptAt?: string | null };
      const queued = await this.api.request(this.path('/directory/refresh'), { method: 'POST' });
      if (!current()) return;
      if (!queued.ok) throw new Error('Could not request a background directory refresh.');
      this.setMessage('Refresh requested. Showing the last verified snapshot while Microsoft data is collected.');
      this.render();
      for (let attempt = 0; attempt < 36 && current(); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (!current()) return;
        const response = await this.api.request(this.path('/directory/snapshot'));
        if (!response.ok) throw new Error('Could not check the background directory refresh.');
        const result = await response.json() as { directory?: { collectedAt?: string | null; status?: string }; lastAttemptAt?: string | null };
        if (result.directory?.collectedAt && result.directory.collectedAt !== baseline.directory?.collectedAt) {
          await this.loadResource(); return;
        }
        if (result.lastAttemptAt && result.lastAttemptAt !== baseline.lastAttemptAt
          && result.directory?.status === 'stale')
          throw new Error('The background refresh failed. The last verified snapshot remains available.');
      }
      if (current()) throw new Error('The refresh is still running. The last verified snapshot remains available; try Refresh later.');
    } catch (error) {
      if (current()) { this.setMessage(error instanceof Error ? error.message : 'Could not refresh the directory.', true); this.render(); }
    }
  }

  private clearLegacyUsage(): void {
    this.mailboxInventory = null;
    this.mailboxStatisticsRequest += 1;
    this.mailboxStatisticsLoading = false;
    this.mailboxStatisticsLoaded.clear();
    this.mailboxStatisticsFailed.clear();
    this.mailboxStatisticsTargets.clear();
  }

  private async saveMobilePhone(): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'user' || !this.mfaOpen || this.busy || this.mobilePhoneNeedsRefresh) return;
    const phoneNumber = this.mobilePhoneDraft.trim();
    if (!/^\+[1-9]\d{0,2} [0-9][0-9 ]{5,24}(?:x[0-9]{1,8})?$/.test(phoneNumber) || phoneNumber.length > 40) {
      this.drawerError = true; this.drawerMessage = 'Enter a mobile number with country code, such as +1 5555551234.'; this.render(); return;
    }
    const id = this.detail.id; const generation = this.generation; const context = this.contextValue; const request = ++this.mfaRequest;
    const current = () => this.mfaRequestIsCurrent(id, generation, context, request);
    this.busy = true; this.drawerError = false; this.drawerMessage = 'Saving mobile authentication phone…'; this.render();
    try {
      const result = await this.request<{ accepted?: boolean; verified?: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'user.mfa.mobilePhone.set', id, phoneNumber, confirmation: 'SET_MOBILE_PHONE' }),
      });
      if (!current()) return;
      this.mobilePhoneNeedsRefresh = true;
      if (result.accepted !== true) throw new Error('Microsoft did not accept the mobile phone change. Refresh methods before retrying.');

      this.drawerError = result.verified !== true;
      this.drawerMessage = result.verified === true ? 'Mobile phone saved and verified. Refresh methods to see its masked number.' : 'Microsoft accepted the mobile phone, but readback is pending. Refresh methods before another change.';
    } catch (error) {
      if (current()) { this.mobilePhoneNeedsRefresh = true; this.drawerError = true; this.drawerMessage = `${error instanceof Error ? error.message : 'Mobile phone outcome is uncertain.'} Refresh methods before another change.`; }
    } finally { if (current()) { this.busy = false; this.render(); } }
  }

  private updateVisibleColumns(key: string): void {
    const columns = this.data?.columns ?? [];
    const identity = columns[0]?.key;
    if (key === identity) return;
    this.visibleColumns = this.visibleColumns.includes(key)
      ? this.visibleColumns.filter(column => column !== key)
      : [...this.visibleColumns, key];
    this.layoutEditVersion += 1;
    this.saveDirectoryLayout();
    this.render();
    if (key === 'mailbox' || key === 'archive') this.startMailboxStatistics();
  }
  private resetVisibleColumns(): void {
    if (this.data) this.visibleColumns = this.defaultVisibleColumns(this.data);
    this.columnWidths = {};
    this.sortKey = null; this.sortDirection = 'asc';
    this.layoutEditVersion += 1;
    this.saveDirectoryLayout();
    this.render();
  }
  private async loadDirectoryLayout(resource: Resource, generation: number, request: number): Promise<void> {
    const ticket = ++this.layoutRequest;
    const editVersion = this.layoutEditVersion;
    try {
      const result = await this.request<{ layout?: DirectoryLayout | null }>(this.path(`/directory/layout/${resource}`));
      if (ticket !== this.layoutRequest || generation !== this.generation || request !== this.resourceRequest ||
          resource !== this.resource || editVersion !== this.layoutEditVersion || !this.data) return;
      const saved = result.layout;
      if (!saved || !Array.isArray(saved.columns) || typeof saved.widths !== 'object' || saved.widths === null) return;
      const available = this.directoryColumns().map(column => column.key);
      const selected = saved.columns.filter(key => available.includes(key));
      if (!selected.includes(available[0]!)) selected.unshift(available[0]!);
      this.visibleColumns = selected;
      this.columnWidths = Object.fromEntries(Object.entries(saved.widths).filter(([key, value]) => available.includes(key) && Number.isInteger(value) && value >= 80 && value <= 800));
      this.sortKey = saved.sortKey && available.includes(saved.sortKey) ? saved.sortKey : null;
      this.sortDirection = saved.sortDirection === 'desc' ? 'desc' : 'asc';
      this.layoutError = '';
      this.render();
      this.startMailboxStatistics();
    } catch {
      if (ticket === this.layoutRequest && generation === this.generation && resource === this.resource) {
        this.layoutError = 'Could not load saved table layout.';
        this.render();
      }
    }
  }
  private saveDirectoryLayout(): void {
    const resource = this.resource;
    const generation = this.generation;
    const first = this.directoryColumns()[0]?.key;
    if (!first || !this.contextValue) return;
    const columns = [first, ...this.visibleColumns.filter(key => key !== first)];
    const snapshot: DirectoryLayout = { columns, widths: { ...this.columnWidths }, sortKey: this.sortKey, sortDirection: this.sortDirection };
    // Serialize writes so a slower earlier save cannot overwrite the user's latest choice.
    this.layoutSave = this.layoutSave.catch(() => undefined).then(async () => {
      if (generation !== this.generation || resource !== this.resource) return;
      try {
        await this.request(this.path(`/directory/layout/${resource}`), { method: 'PUT',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot) });
        if (generation === this.generation && resource === this.resource) { this.layoutError = ''; this.render(); }
      } catch {
        if (generation === this.generation && resource === this.resource) {
          this.layoutError = 'Table layout could not be saved. Retry a layout change.';
          this.render();
        }
      }
    });
  }
  private moveColumn(key: string, direction: -1 | 1): void {
    const index = this.visibleColumns.indexOf(key);
    const next = index + direction;
    if (index <= 0 || next <= 0 || next >= this.visibleColumns.length) return;
    [this.visibleColumns[index], this.visibleColumns[next]] = [this.visibleColumns[next]!, this.visibleColumns[index]!];
    this.layoutEditVersion += 1;
    this.saveDirectoryLayout(); this.render();
  }
  private directoryColumns(): Array<{ key: string; label: string; defaultHidden?: boolean }> {
    return this.resource === 'users' || this.resource === 'all' ? [...USER_DIRECTORY_COLUMNS] : (this.data?.columns ?? []);
  }
  private defaultVisibleColumns(data: ResourceData): string[] {
    const columns = this.resource === 'users' || this.resource === 'all' ? USER_DIRECTORY_COLUMNS : data.columns;
    return columns.filter(column => !('defaultHidden' in column && column.defaultHidden)).map(column => column.key);
  }
  private userDirectoryValue(row: ResourceRow, key: string): string | number | boolean | null {
    const mailbox = this.mailboxInventory?.records.find(record => record.id.toLowerCase() === row.id.toLowerCase());
    if (key === 'mailbox') return mailbox ? this.mailboxStatisticsLoaded.has(mailbox.id.toLowerCase()) ? storageLabel(mailbox.mailboxBytes) : this.mailboxStatisticsFailed.has(mailbox.id.toLowerCase()) ? 'Usage unavailable' : this.mailboxStatisticsTargets.has(mailbox.id.toLowerCase()) ? 'Loading usage…' : 'Usage not loaded' : this.mailboxInventory?.partial ? 'Not in loaded page' : this.mailboxInventory ? 'No mailbox' : 'Not connected';
    if (key === 'archive') return mailbox ? mailbox.archiveEnabled ? this.mailboxStatisticsLoaded.has(mailbox.id.toLowerCase()) ? storageLabel(mailbox.archiveBytes) : this.mailboxStatisticsFailed.has(mailbox.id.toLowerCase()) ? 'Usage unavailable' : this.mailboxStatisticsTargets.has(mailbox.id.toLowerCase()) ? 'Loading usage…' : 'Usage not loaded' : 'Off' : this.mailboxInventory?.partial ? 'Not in loaded page' : this.mailboxInventory ? 'No mailbox' : 'Not connected';
    if (key === 'oneDrive') return row.values.licenseSummary === 'Unlicensed' ? 'Not licensed'
      : row.values.oneDrive === 'Names concealed in Microsoft reports' ? 'Checking usage…'
      : typeof row.values.oneDrive === 'string' && row.values.oneDrive ? row.values.oneDrive : 'Not reported';
    if (key === 'licenseSummary') return typeof row.values.licenseSummary === 'string' && row.values.licenseSummary ? row.values.licenseSummary : 'License data unavailable';
    // The reference directory classifies Graph identities as User unless
    // Exchange identifies the same object as a SharedMailbox.
    if (key === 'userType') return mailbox?.recipientType === 'SharedMailbox' ? 'Shared mailbox' : 'User';
    if (key === 'exclude') return this.directoryExclusionsReady ? (this.directoryExclusions.get(row.id) ? 'Excluded' : 'Included') : 'Unavailable';
    return row.values[key] ?? null;
  }
  private rowIdentity(row: ResourceRow, column: { key: string; label: string }): string {
    if (this.resource !== 'users' && this.resource !== 'all') return esc(String(row.values[column.key] ?? '—'));
    const name = row.values.displayName ?? row.values[column.key] ?? row.id;
    const email = row.source === 'group' ? row.values.mail : row.values.userPrincipalName ?? row.values.mail;
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
      this.userSecurityAction = null;
    } catch (error) {
      if (current()) { this.drawerError = true; this.drawerMessage = error instanceof Error ? error.message : 'Security action outcome is uncertain. Refresh the account before retrying.'; }
    } finally { if (current()) { this.busy = false; this.render(); } }
  }
  private async changeMembership(): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'group' || this.busy) return;
    const userId = this.membershipUserId;
    const action = this.root.querySelector<HTMLSelectElement>('#group-member-action')?.value ?? this.membershipAction;
    const role = this.root.querySelector<HTMLSelectElement>('#group-member-role')?.value ?? this.membershipRole;
    this.membershipUserId = userId;
    if (action === 'add' || action === 'remove') this.membershipAction = action;
    if (role === 'member' || role === 'owner') this.membershipRole = role;
    if (!userId || (action !== 'add' && action !== 'remove') || (role !== 'member' && role !== 'owner') || this.membershipNeedsRefresh) { this.drawerError = true; this.drawerMessage = 'Choose a user and group assignment. Reopen the group after an uncertain result.'; this.render(); return; }
    if (action === 'remove' && (!this.groupPeople?.complete || !(role === 'owner' ? this.groupPeople.owners : this.groupPeople.members).some(person => person.id === userId)
      || role === 'owner' && this.groupPeople.owners.length <= 1)) { this.drawerError = true; this.drawerMessage = 'Refresh the complete membership list before removing an assignment. The last owner cannot be removed.'; this.render(); return; }
    const id = this.detail.id; const generation = this.generation; const context = this.contextValue;
    const distribution = this.detail.values.groupKind === 'Distribution list';
    if (distribution && role !== 'member') { this.drawerError = true; this.drawerMessage = 'Distribution lists do not use Microsoft 365 group owners.'; this.render(); return; }
    this.busy = true; this.drawerError = false; this.drawerMessage = 'Submitting membership change…'; this.render();
    try {
      const body = distribution ? { type: 'distribution.member.set', groupId: id, memberId: userId, enabled: action === 'add' }
        : { type: `group.${role}.${action}`, groupId: id, userId };
      const result = await this.request<{ accepted?: boolean; verified?: boolean; changed?: boolean }>(this.path('/administration'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (result.accepted !== true) throw new Error('Microsoft did not accept the group change.');
      if (generation !== this.generation || context !== this.contextValue || this.detail?.id !== id || this.detailKind !== 'group') return;
      this.membershipNeedsRefresh = result.verified !== true;
      this.drawerError = this.membershipNeedsRefresh;
      this.drawerMessage = result.changed === false ? 'Group assignment was already in the requested state.'
        : result.verified ? 'Group assignment accepted and verified.'
        : 'Group assignment was accepted, but readback did not confirm it. Reopen the group before trying again.';
      if (result.verified) void this.loadGroupPeople(id);
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && this.detail?.id === id) { this.membershipNeedsRefresh = true; this.drawerError = true; this.drawerMessage = error instanceof Error ? error.message : 'Group change could not be completed. Its outcome is uncertain; do not retry automatically.'; }
    } finally { if (generation === this.generation) { this.busy = false; this.render(); } }
  }
  private async saveGroupName(): Promise<void> {
    if (!this.connection?.canManage || !this.detail || this.detailKind !== 'group' || !this.detailRecord || this.busy || this.groupNameNeedsRefresh) return;
    const displayName = this.groupNameDraft.trim();
    if (!displayName || displayName.length > 256) { this.drawerError = true; this.drawerMessage = 'Enter a valid group name.'; this.render(); return; }
    const id = this.detail.id; const generation = this.generation; const context = this.contextValue;
    const detailRequest = this.detailRequest;
    this.busy = true; this.drawerError = false; this.drawerMessage = 'Saving group name…'; this.render();
    try {
      if (this.detail.values.groupKind === 'Distribution list') {
        const result = await this.request<{ groupId: string; displayName: string; accepted: boolean; verified: boolean; changed: boolean }>(this.path('/administration'), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'distribution.name.set', groupId: id, displayName }),
        });
        if (generation !== this.generation || context !== this.contextValue || detailRequest !== this.detailRequest || this.detail?.id !== id) return;
        if (result.groupId.toLowerCase() !== id.toLowerCase() || result.displayName !== displayName || result.accepted !== true || result.verified !== true)
          throw new Error('Distribution-list name readback did not match.');
        this.detailRecord.displayName = displayName; this.detail.values.displayName = displayName;
        if (this.groupSettings) this.groupSettings.displayName = displayName;
        this.groupNameNeedsRefresh = false; this.drawerMessage = result.changed ? 'List name saved and verified.' : 'List name was already current.';
        return;
      }
      const result = await this.request<{ accepted: boolean; verified: boolean; changed: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'group.update', id, update: { displayName } }),
      });
      if (generation !== this.generation || context !== this.contextValue || detailRequest !== this.detailRequest || this.detail?.id !== id) return;
      if (!result.accepted) throw new Error('Microsoft did not confirm the group update.');
      this.groupNameNeedsRefresh = !result.verified;
      this.drawerError = false;
      this.drawerMessage = result.verified ? 'Group name saved and verified.' : 'Microsoft accepted the name change. Waiting for Microsoft to show the new name…';
      if (result.verified) { this.detailRecord.displayName = displayName; this.detail.values.displayName = displayName; }
      else {
        this.render();
        // Graph can return the old group name immediately after accepting the PATCH.
        // Re-read only; never repeat the write while its outcome is propagating.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await new Promise<void>(resolve => setTimeout(resolve, 5_000));
          if (generation !== this.generation || context !== this.contextValue || detailRequest !== this.detailRequest || this.detail?.id !== id || this.detailKind !== 'group') return;
          try {
            const fresh = await this.request<MicrosoftRecord>(this.path('/administration'), {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'group.get', id }),
            });
            if (generation !== this.generation || context !== this.contextValue || detailRequest !== this.detailRequest || this.detail?.id !== id || this.detailKind !== 'group') return;
            if (fresh?.id !== id) throw new Error('Group readback returned a different identity.');
            if (fresh.displayName === displayName) {
              this.detailRecord = fresh; this.detail.values.displayName = displayName;
              this.groupNameNeedsRefresh = false; this.drawerMessage = 'Group name saved and verified.';
              break;
            }
          } catch { /* A failed read must not trigger a second write. */ }
        }
        if (this.groupNameNeedsRefresh) {
          this.drawerError = true;
          this.drawerMessage = 'Microsoft accepted the name change, but the new value has not appeared yet. Close and reopen this group before another change.';
        }
      }
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && detailRequest === this.detailRequest && this.detail?.id === id) {
        this.groupNameNeedsRefresh = true; this.drawerError = true;
        this.drawerMessage = `${error instanceof Error ? error.message : 'Group update outcome is uncertain.'} Close and reopen this group before another change.`;
      }
    } finally { if (generation === this.generation && context === this.contextValue && detailRequest === this.detailRequest && this.detail?.id === id && this.detailKind === 'group') { this.busy = false; this.render(); } }
  }

  private resetDelegation(): void {
    this.delegationRequest += 1; this.delegationOpen = false; this.delegationUsers = null; this.delegationSelectedId = ''; this.delegationRemoveRight = '';
    this.delegationListRequest += 1; this.delegationList = null; this.delegationListLoading = false; this.delegationListError = '';
    this.delegation = null; this.delegationLoading = false; this.delegationError = ''; this.delegationMessage = '';
    this.delegationNeedsRefresh = false;
  }
  private openDelegation(): void {
    if (this.detailKind !== 'user' || !this.detail || !this.canRead()) return;
    this.forwardingRequest += 1; this.forwardingOpen = false; this.forwarding = null;
    this.resetAutoReply(); this.resetAddresses();
    this.delegationOpen = true; this.delegationError = ''; this.delegationMessage = '';
    this.render(); void this.loadDelegationUsers(); void this.loadDelegationList();
  }
  private async loadDelegationList(): Promise<void> {
    const mailboxId = this.detail?.id;
    if (!this.delegationOpen || !mailboxId) return;
    const generation = this.generation; const context = this.contextValue; const request = ++this.delegationListRequest;
    this.delegationListLoading = true; this.delegationListError = ''; this.render();
    try {
      const data = await this.request<DelegationList>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'mailbox.delegation.list', mailboxId }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.delegationListRequest || !this.delegationOpen || this.detail?.id !== mailboxId) return;
      if (data.mailboxId !== mailboxId || !Array.isArray(data.entries)) throw new Error('Delegation inventory did not match this mailbox.');
      this.delegationList = data;
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.delegationListRequest || !this.delegationOpen || this.detail?.id !== mailboxId) return;
      this.delegationListError = error instanceof Error ? error.message : 'Could not load current delegates.';
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.delegationListRequest && this.delegationOpen && this.detail?.id === mailboxId) {
        this.delegationListLoading = false; this.render();
      }
    }
  }
  private async loadDelegationUsers(): Promise<void> {
    const mailboxId = this.detail?.id;
    if (!this.delegationOpen || !mailboxId) return;
    const generation = this.generation; const context = this.contextValue; const request = ++this.delegationRequest;
    this.delegationLoading = true; this.delegationUsers = null; this.delegation = null; this.delegationError = ''; this.render();
    try {
      const users = parseResourceData(await this.request<unknown>(this.path('/resources/users')));
      if (generation !== this.generation || context !== this.contextValue || request !== this.delegationRequest || this.detail?.id !== mailboxId) return;
      this.delegationUsers = users;
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.delegationRequest || this.detail?.id !== mailboxId) return;
      this.delegationError = error instanceof Error ? error.message : 'Could not load tenant users.';
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.delegationRequest && this.detail?.id === mailboxId) {
        this.delegationLoading = false; this.render();
      }
    }
  }
  private async loadDelegation(): Promise<void> {
    const mailboxId = this.detail?.id; const delegateId = this.delegationSelectedId;
    if (!this.delegationOpen || !mailboxId || !delegateId || !this.delegationUsers?.items.some(row => row.id === delegateId)) return;
    const generation = this.generation; const context = this.contextValue; const request = ++this.delegationRequest;
    this.delegationLoading = true; this.delegation = null; this.delegationError = ''; this.delegationMessage = ''; this.render();
    try {
      const data = await this.request<DelegationState>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'mailbox.delegation.get', mailboxId, delegateId }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.delegationRequest || this.detail?.id !== mailboxId || this.delegationSelectedId !== delegateId) return;
      if (data.mailboxId !== mailboxId || data.delegateId !== delegateId) throw new Error('Delegation identity did not match the selected users.');
      this.delegation = data; this.delegationNeedsRefresh = false;
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.delegationRequest || this.detail?.id !== mailboxId || this.delegationSelectedId !== delegateId) return;
      this.delegationError = error instanceof Error ? error.message : 'Could not load direct mailbox rights.';
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.delegationRequest && this.detail?.id === mailboxId && this.delegationSelectedId === delegateId) {
        this.delegationLoading = false; this.render();
      }
    }
  }
  private async setDelegation(right: 'FullAccess' | 'SendAs' | 'SendOnBehalf', enabled: boolean): Promise<void> {
    const mailboxId = this.detail?.id; const delegateId = this.delegationSelectedId;
    if (this.delegationRemoveRight && (enabled || right !== this.delegationRemoveRight)) return;
    if (!this.connection?.canManage || !this.delegationOpen || !this.delegation || !mailboxId || !delegateId ||
      this.delegationLoading || this.delegationNeedsRefresh) return;
    const generation = this.generation; const context = this.contextValue; const request = ++this.delegationRequest;
    this.delegationLoading = true; this.delegationError = ''; this.delegationMessage = ''; this.render();
    try {
      const data = await this.request<DelegationState & { accepted: true; verified: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'mailbox.delegation.set', mailboxId, delegateId, right, enabled }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.delegationRequest || this.detail?.id !== mailboxId || this.delegationSelectedId !== delegateId) return;
      this.delegationNeedsRefresh = true;
      this.delegationMessage = data.verified ? 'Delegation change saved and verified. Refresh before another change.' : 'Microsoft accepted the delegation change, but readback is pending. Refresh before another change.';
      void this.loadDelegationList();
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.delegationRequest || this.detail?.id !== mailboxId || this.delegationSelectedId !== delegateId) return;
      this.delegationNeedsRefresh = true;
      this.delegationError = `${error instanceof Error ? error.message : 'Delegation outcome is uncertain.'} Refresh direct rights before trying again.`;
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.delegationRequest && this.detail?.id === mailboxId && this.delegationSelectedId === delegateId) {
        this.delegationLoading = false; this.render();
      }
    }
  }
  private renderDelegation(canManage: boolean): string {
    if (!this.delegationOpen) return '<button class="secondary compact" id="delegation-open">Delegate mailbox</button>';
    const users = this.delegationUsers?.items.filter(row => row.id !== this.detail?.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)) ?? [];
    const options = users.map(row => `<option value="${esc(row.id)}" ${row.id === this.delegationSelectedId ? 'selected' : ''}>${esc(String(row.values.displayName ?? row.id))} · ${esc(String(row.values.userPrincipalName ?? row.values.mail ?? ''))}</option>`).join('');
    const rights = this.delegation ? ([['FullAccess', 'fullAccess', 'Full Access'], ['SendAs', 'sendAs', 'Send As'], ['SendOnBehalf', 'sendOnBehalf', 'Send on Behalf']] as const)
      .filter(([right]) => !this.delegationRemoveRight || this.delegationRemoveRight === right)
      .map(([right, field, label]) => `<div class="user-field"><span>${label}: ${this.delegation![field] ? 'Granted' : 'Not granted'}</span>${canManage && (!this.delegationRemoveRight || this.delegation![field]) ? `<button class="secondary compact" data-delegation-right="${right}" data-delegation-enabled="${!this.delegation![field]}" ${this.delegationLoading || this.delegationNeedsRefresh ? 'disabled' : ''}>${this.delegation![field] ? 'Remove' : 'Grant'}</button>` : ''}</div>`).join('') : '';
    const current = this.delegationList?.entries.map(entry => {
      const matches = users.filter(user => [user.values.mail, user.values.userPrincipalName].some(value => typeof value === 'string' && value.toLowerCase() === entry.delegateAddress.toLowerCase()));
      const delegateId = matches.length === 1 ? matches[0]!.id : null;
      const badges = ([['FullAccess', 'fullAccess', 'Full Access'], ['SendAs', 'sendAs', 'Send As'], ['SendOnBehalf', 'sendOnBehalf', 'Send on Behalf']] as const)
        .filter(([, field]) => entry[field]).map(([right, , label]) => `<span class="delegate-permission">${label}${canManage && delegateId ? `<button class="secondary compact" data-delegate-remove="${esc(delegateId)}" data-remove-right="${right}" aria-label="Remove ${label} from ${esc(entry.delegateAddress)}" ${this.delegationLoading || this.delegationListLoading || this.delegationNeedsRefresh || this.delegationList?.partial ? 'disabled' : ''}>×</button>` : ''}</span>`).join('');
      return `<li><strong>${esc(entry.delegateAddress)}</strong><div class="delegate-permissions">${badges}</div>${canManage && !delegateId ? '<small>Cannot match this delegate to a unique tenant user.</small>' : ''}</li>`;
    }).join('') ?? '';
    const inventory = `<section class="drawer-section"><div class="actions"><h3>Current delegates</h3><button class="secondary compact" id="delegation-list-refresh" ${this.delegationListLoading ? 'disabled' : ''}>Refresh</button></div>${this.delegationListError ? `<p class="status" data-error="true" role="alert">${esc(this.delegationListError)}</p>` : this.delegationListLoading && !this.delegationList ? '<p class="meta">Loading current delegates…</p>' : this.delegationList ? `<ul class="delegation-current">${current || '<li>No direct delegates found.</li>'}</ul>${this.delegationList.partial ? '<p class="meta">Some permissions could not be resolved; this list may be incomplete.</p>' : ''}` : ''}</section>`;
    const feedback = this.delegationError ? `<p class="status" data-error="true" role="alert">${esc(this.delegationError)}</p>` : this.delegationMessage ? `<p class="status" role="status">${esc(this.delegationMessage)}</p>` : '';
    return `<div class="delegation-panel">${inventory}${this.delegationSelectedId ? `<div class="actions"><button class="secondary compact" id="delegation-refresh" ${this.delegationLoading ? 'disabled' : ''}>Refresh selected rights</button></div>` : ''}${this.delegationUsers ? `<label>Delegate<select id="delegation-user" ${this.delegationLoading ? 'disabled' : ''}><option value="">Choose a tenant user</option>${options}</select></label>${!this.delegationUsers.complete ? '<p class="meta">This is a partial user inventory; some delegates may not appear.</p>' : ''}` : this.delegationLoading ? '<p class="meta">Loading tenant users…</p>' : ''}${this.delegationLoading && this.delegationSelectedId ? '<p class="meta">Loading direct rights…</p>' : ''}${this.delegation ? `<p class="meta">${esc(this.delegation.delegateAddress)} · Direct mailbox permissions only</p>${rights}` : ''}${feedback}</div>`;
  }
  private resetAddresses(): void {
    this.addressesRequest += 1; this.addressesOpen = false; this.addresses = null;
    this.addressesLoading = false; this.addressesError = ''; this.addressesMessage = ''; this.addressesNeedsRefresh = false;
  }
  private openAddresses(): void {
    if (this.detailKind !== 'user' || !this.detail || !this.canRead()) return;
    this.forwardingRequest += 1; this.forwardingOpen = false; this.forwarding = null;
    this.resetAutoReply(); this.resetDelegation();
    this.addressesOpen = true; this.addresses = null; this.addressesError = ''; this.addressesMessage = ''; this.addressesNeedsRefresh = false;
    this.render(); void this.loadAddresses();
  }
  private async loadAddresses(): Promise<void> {
    const mailboxId = this.detail?.id;
    if (!this.addressesOpen || !mailboxId) return;
    const generation = this.generation; const context = this.contextValue; const request = ++this.addressesRequest;
    this.addressesLoading = true; this.addresses = null; this.addressesError = ''; this.addressesMessage = ''; this.render();
    try {
      const data = await this.request<AddressesState>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'mailbox.addresses.get', mailboxId }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.addressesRequest || this.detail?.id !== mailboxId) return;
      if (data.mailboxId !== mailboxId) throw new Error('Mailbox identity did not match the selected user.');
      this.addresses = data; this.primaryDraft = data.primarySmtpAddress; this.aliasDraft = ''; this.addressesNeedsRefresh = false;
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.addressesRequest || this.detail?.id !== mailboxId) return;
      this.addressesError = error instanceof Error ? error.message : 'Could not load mailbox addresses.';
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.addressesRequest && this.detail?.id === mailboxId) {
        this.addressesLoading = false; this.render();
      }
    }
  }
  private async writeAddress(action: 'mailbox.primary.set' | 'mailbox.alias.add' | 'mailbox.alias.remove', selected?: string): Promise<void> {
    const mailboxId = this.detail?.id; const current = this.addresses;
    if (!this.connection?.canManage || !this.addressesOpen || !current || !mailboxId || this.addressesLoading || this.addressesNeedsRefresh) return;
    const address = (selected ?? (action === 'mailbox.primary.set' ? this.primaryDraft : this.aliasDraft)).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 320) {
      this.addressesError = 'Enter a valid email address.'; this.render(); return;
    }
    if (action === 'mailbox.primary.set' && current.policyEnabled) {
      this.addressesError = 'An email address policy controls this primary address.'; this.render(); return;
    }
    if (action === 'mailbox.alias.remove' && !current.aliases.some(value => value.toLowerCase() === address.toLowerCase())) return;
    if (action === 'mailbox.alias.add' && (current.primarySmtpAddress.toLowerCase() === address.toLowerCase() || current.aliases.some(value => value.toLowerCase() === address.toLowerCase()))) {
      this.addressesError = 'This address is already assigned to the mailbox.'; this.render(); return;
    }
    const generation = this.generation; const context = this.contextValue; const request = ++this.addressesRequest;
    this.addressesLoading = true; this.addressesError = ''; this.addressesMessage = ''; this.render();
    try {
      const data = await this.request<AddressesState & { accepted: true; verified: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: action, mailboxId, address }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.addressesRequest || this.detail?.id !== mailboxId) return;
      if (data.mailboxId !== mailboxId) throw new Error('Mailbox identity did not match the selected user.');
      this.addresses = data;
      this.primaryDraft = data.primarySmtpAddress;
      if (data.verified) this.aliasDraft = '';
      this.addressesNeedsRefresh = !data.verified;
      this.addressesMessage = data.verified ? 'Address change saved and verified.' : 'Microsoft accepted the address change, but readback is pending. Refresh before another change.';
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.addressesRequest || this.detail?.id !== mailboxId) return;
      this.addressesNeedsRefresh = true;
      this.addressesError = `${error instanceof Error ? error.message : 'Address change outcome is uncertain.'} Refresh mailbox addresses before trying again.`;
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.addressesRequest && this.detail?.id === mailboxId) {
        this.addressesLoading = false; this.render();
      }
    }
  }
  private renderAddresses(canManage: boolean): string {
    if (!this.addressesOpen) return '<button class="secondary compact" id="addresses-open">Manage email addresses</button>';
    const data = this.addresses; const disabled = this.addressesLoading || this.addressesNeedsRefresh || !canManage;
    const feedback = this.addressesError ? `<p class="status" data-error="true" role="alert">${esc(this.addressesError)}</p>` : this.addressesMessage ? `<p class="status" role="status">${esc(this.addressesMessage)}</p>` : '';
    const aliases = data?.aliases.length ? `<div class="address-aliases" role="list" aria-label="Email aliases">${data.aliases.map(address => `<div class="alias-chip" role="listitem"><span>${esc(address)}</span>${canManage ? `<button class="alias-remove" type="button" data-alias-remove="${esc(address)}" aria-label="Remove alias ${esc(address)}" ${disabled ? 'disabled' : ''}>×</button>` : ''}</div>`).join('')}</div>` : '<p class="meta">No secondary SMTP aliases.</p>';
    const controls = data ? `<div class="user-field"><label><span>Primary email</span><input id="addresses-primary" type="email" maxlength="320" value="${esc(this.primaryDraft)}" ${disabled || data.policyEnabled ? 'disabled' : ''}></label>${canManage ? `<button class="secondary compact" id="addresses-primary-save" ${disabled || data.policyEnabled || this.primaryDraft.toLowerCase() === data.primarySmtpAddress.toLowerCase() ? 'disabled' : ''}>Save email</button>` : ''}</div>${data.policyEnabled ? '<p class="meta">The primary address is controlled by an email address policy.</p>' : ''}<div class="user-field"><label><span>Optional alias</span><input id="addresses-alias" type="email" maxlength="320" value="${esc(this.aliasDraft)}" placeholder="alias@example.com" ${disabled ? 'disabled' : ''}></label>${canManage ? `<button class="secondary compact" id="addresses-alias-add" ${disabled || !this.aliasDraft.trim() ? 'disabled' : ''}>Add alias</button>` : ''}</div>${aliases}` : '';
    return `<div class="addresses-panel"><div class="addresses-heading"><strong>Email addresses</strong><div class="actions"><button class="secondary compact" id="addresses-refresh" ${this.addressesLoading ? 'disabled' : ''}>Refresh</button><button class="secondary compact" id="addresses-close">Close</button></div></div>${this.addressesLoading ? '<p class="meta">Loading mailbox addresses…</p>' : controls}${feedback}</div>`;
  }
  private resetAutoReply(): void {
    this.autoReplyRequest += 1; this.autoReplyOpen = false; this.autoReply = null;
    this.autoReplyLoading = false; this.autoReplyError = ''; this.autoReplyMessage = ''; this.autoReplyNeedsRefresh = false;
  }
  private openAutoReply(): void {
    if (this.detailKind !== 'user' || !this.detail || !this.canRead()) return;
    this.forwardingRequest += 1; this.forwardingOpen = false; this.forwarding = null;
    this.resetAddresses(); this.resetDelegation();
    this.autoReplyOpen = true; this.autoReply = null; this.autoReplyError = ''; this.autoReplyMessage = ''; this.autoReplyNeedsRefresh = false;
    this.render(); void this.loadAutoReply();
  }
  private replyLocalTime(value: string | null): string {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  private async loadAutoReply(): Promise<void> {
    const mailboxId = this.detail?.id;
    if (!this.autoReplyOpen || !mailboxId) return;
    const generation = this.generation; const context = this.contextValue; const request = ++this.autoReplyRequest;
    this.autoReplyLoading = true; this.autoReply = null; this.autoReplyError = ''; this.autoReplyMessage = ''; this.render();
    try {
      const data = await this.request<AutoReplyState>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'mailbox.autoreply.get', mailboxId }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.autoReplyRequest || this.detail?.id !== mailboxId) return;
      if (data.mailboxId !== mailboxId) throw new Error('Mailbox identity did not match the selected user.');
      this.autoReply = data;
      this.autoReplyDraft = { state: data.state, message: data.internalMessage, externalMessage: data.externalMessage, externalAudience: data.externalAudience,
        start: this.replyLocalTime(data.start), end: this.replyLocalTime(data.end) };
      this.autoReplyNeedsRefresh = false;
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.autoReplyRequest || this.detail?.id !== mailboxId) return;
      this.autoReplyError = error instanceof Error ? error.message : 'Could not load automatic replies.';
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.autoReplyRequest && this.detail?.id === mailboxId) {
        this.autoReplyLoading = false; this.render();
      }
    }
  }
  private async saveAutoReply(): Promise<void> {
    const mailboxId = this.detail?.id;
    if (!this.connection?.canManage || !this.autoReplyOpen || !this.autoReply || !mailboxId || this.autoReplyLoading || this.autoReplyNeedsRefresh) return;
    const { state, message, externalMessage, externalAudience, start: localStart, end: localEnd } = this.autoReplyDraft;
    let start: string | null = null; let end: string | null = null;
    if (state === 'Scheduled') {
      if (!localStart || !localEnd || Number.isNaN(Date.parse(localStart)) || Number.isNaN(Date.parse(localEnd)) || Date.parse(localEnd) <= Date.parse(localStart)) {
        this.autoReplyError = 'Choose valid start and end times; end must be after start.'; this.render(); return;
      }
      start = new Date(localStart).toISOString(); end = new Date(localEnd).toISOString();
    }
    const generation = this.generation; const context = this.contextValue; const request = ++this.autoReplyRequest;
    this.autoReplyLoading = true; this.autoReplyError = ''; this.autoReplyMessage = ''; this.render();
    try {
      const data = await this.request<AutoReplyState & { accepted: true; verified: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'mailbox.autoreply.set', mailboxId, state, message, externalMessage, externalAudience, start, end }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.autoReplyRequest || this.detail?.id !== mailboxId) return;
      this.autoReplyNeedsRefresh = true;
      this.autoReplyMessage = data.verified ? 'Automatic reply saved and verified. Refresh to make another change.' : 'Microsoft accepted the reply, but readback did not confirm it. Refresh before another change.';
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.autoReplyRequest || this.detail?.id !== mailboxId) return;
      this.autoReplyNeedsRefresh = true;
      this.autoReplyError = `${error instanceof Error ? error.message : 'Automatic reply outcome is uncertain.'} Refresh current replies before trying again.`;
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.autoReplyRequest && this.detail?.id === mailboxId) {
        this.autoReplyLoading = false; this.render();
      }
    }
  }
  private renderAutoReply(canManage: boolean): string {
    if (!this.autoReplyOpen) return '<button class="secondary compact" id="autoreply-open">Out of office</button>';
    const state = this.autoReply; const busy = this.autoReplyLoading;
    const disabled = busy || !canManage || this.autoReplyNeedsRefresh;
    const feedback = this.autoReplyError ? `<p class="status" data-error="true" role="alert">${esc(this.autoReplyError)}</p>` : this.autoReplyMessage ? `<p class="status" role="status">${esc(this.autoReplyMessage)}</p>` : '';
    const controls = state ? `<label>Status<select id="autoreply-state" ${disabled ? 'disabled' : ''}><option value="Disabled" ${this.autoReplyDraft.state === 'Disabled' ? 'selected' : ''}>Disabled</option><option value="Enabled" ${this.autoReplyDraft.state === 'Enabled' ? 'selected' : ''}>Enabled</option><option value="Scheduled" ${this.autoReplyDraft.state === 'Scheduled' ? 'selected' : ''}>Scheduled</option></select></label>${this.autoReplyDraft.state === 'Scheduled' ? `<label>Start (your time)<input id="autoreply-start" type="datetime-local" value="${esc(this.autoReplyDraft.start)}" ${disabled ? 'disabled' : ''}></label><label>End (your time)<input id="autoreply-end" type="datetime-local" value="${esc(this.autoReplyDraft.end)}" ${disabled ? 'disabled' : ''}></label>` : ''}<label>Internal reply<textarea id="autoreply-message" maxlength="8192" ${disabled ? 'disabled' : ''}>${esc(this.autoReplyDraft.message)}</textarea></label><label>External reply<textarea id="autoreply-external-message" maxlength="8192" ${disabled ? 'disabled' : ''}>${esc(this.autoReplyDraft.externalMessage)}</textarea></label><label>External audience<select id="autoreply-audience" ${disabled ? 'disabled' : ''}>${(['None', 'Known', 'All'] as const).map(audience => `<option value="${audience}" ${this.autoReplyDraft.externalAudience === audience ? 'selected' : ''}>${({None: 'No external replies', Known: 'Known contacts only', All: 'All external senders'})[audience]}</option>`).join('')}</select></label>${canManage ? `<button class="secondary compact" id="autoreply-save" ${disabled ? 'disabled' : ''}>Save reply</button>` : ''}` : '';
    return `<div class="autoreply-panel"><div class="actions"><button class="secondary compact" id="autoreply-refresh" ${busy ? 'disabled' : ''}>Refresh</button><button class="secondary compact" id="autoreply-close">Close</button></div>${busy ? '<p class="meta">Loading automatic replies…</p>' : controls}${feedback}</div>`;
  }
  private openForwarding(): void {
    if (this.detailKind !== 'user' || !this.detail || !this.canRead()) return;
    this.resetAutoReply(); this.resetAddresses(); this.resetDelegation();
    this.forwardingOpen = true;
    this.forwarding = null;
    this.forwardingError = '';
    this.forwardingMessage = '';
    this.forwardingNeedsRefresh = false;
    this.render();
    void this.loadForwarding();
  }
  private async loadForwarding(): Promise<void> {
    const mailboxId = this.detail?.id;
    if (!this.forwardingOpen || !mailboxId) return;
    const generation = this.generation; const context = this.contextValue;
    const request = ++this.forwardingRequest;
    this.forwardingLoading = true; this.forwarding = null;
    this.forwardingError = ''; this.forwardingMessage = '';
    this.render();
    try {
      const data = await this.request<ForwardingState>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'mailbox.forwarding.get', mailboxId }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.forwardingRequest || this.detail?.id !== mailboxId) return;
      if (data.mailboxId !== mailboxId) throw new Error('Mailbox identity did not match the selected user.');
      this.forwarding = data;
      this.forwardingAddress = data.smtpAddress ?? '';
      this.forwardingKeepCopy = data.keepCopy;
      this.forwardingNeedsRefresh = false;
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.forwardingRequest || this.detail?.id !== mailboxId) return;
      this.forwardingError = error instanceof Error ? error.message : 'Could not load forwarding.';
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.forwardingRequest && this.detail?.id === mailboxId) {
        this.forwardingLoading = false; this.render();
      }
    }
  }
  private async saveForwarding(turnOff = false): Promise<void> {
    const mailboxId = this.detail?.id;
    if (!this.connection?.canManage || !this.forwardingOpen || !this.forwarding || !mailboxId ||
      this.forwardingLoading || this.forwardingNeedsRefresh || this.forwarding.internalRecipient) return;
    const smtpAddress = turnOff ? null : this.forwardingAddress.trim();
    if (smtpAddress !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(smtpAddress)) {
      this.forwardingError = 'Enter a valid forwarding email address.'; this.render(); return;
    }
    const generation = this.generation; const context = this.contextValue;
    const request = ++this.forwardingRequest;
    this.forwardingLoading = true; this.forwardingError = ''; this.forwardingMessage = '';
    this.render();
    try {
      const data = await this.request<ForwardingState & { accepted: true; verified: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'mailbox.forwarding.set', mailboxId, smtpAddress, keepCopy: this.forwardingKeepCopy }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.forwardingRequest || this.detail?.id !== mailboxId) return;
      this.forwardingNeedsRefresh = true;
      this.forwardingMessage = data.verified ? 'Forwarding saved and verified. Refresh to make another change.' : 'Microsoft accepted the change, but readback is pending. Refresh before another change.';
    } catch (error) {
      if (generation !== this.generation || context !== this.contextValue || request !== this.forwardingRequest || this.detail?.id !== mailboxId) return;
      this.forwardingNeedsRefresh = true;
      this.forwardingError = `${error instanceof Error ? error.message : 'Forwarding outcome is uncertain.'} Refresh current forwarding before trying again.`;
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.forwardingRequest && this.detail?.id === mailboxId) {
        this.forwardingLoading = false; this.render();
      }
    }
  }
  private renderForwarding(canManage: boolean): string {
    if (!this.forwardingOpen) return '<button class="secondary compact" id="forwarding-open">Manage forwarding</button>';
    const state = this.forwarding;
    const busy = this.forwardingLoading;
    const feedback = this.forwardingError ? `<p class="status" data-error="true" role="alert">${esc(this.forwardingError)}</p>` : this.forwardingMessage ? `<p class="status" role="status">${esc(this.forwardingMessage)}</p>` : '';
    const controls = state ? `<p class="meta">Current forwarding: ${state.internalRecipient ? `internal recipient ${esc(state.internalRecipient)}` : state.smtpAddress ? esc(state.smtpAddress) : 'Off'}</p>${state.internalRecipient ? '<p class="meta">An internal forwarding recipient is configured. Change it in Exchange administration before editing SMTP forwarding here.</p>' : `<label>Forward to<input id="forwarding-address" type="email" maxlength="320" value="${esc(this.forwardingAddress)}" placeholder="person@example.com" ${busy || !canManage || this.forwardingNeedsRefresh ? 'disabled' : ''}></label><label class="check"><input id="forwarding-keep-copy" type="checkbox" ${this.forwardingKeepCopy ? 'checked' : ''} ${busy || !canManage || this.forwardingNeedsRefresh ? 'disabled' : ''}> Keep a copy in this mailbox</label>${canManage ? `<div class="actions"><button class="secondary compact" id="forwarding-save" ${busy || this.forwardingNeedsRefresh ? 'disabled' : ''}>Save forwarding</button><button class="secondary compact" id="forwarding-off" ${busy || this.forwardingNeedsRefresh || !state.smtpAddress ? 'disabled' : ''}>Turn off</button></div>` : ''}`}` : '';
    return `<div class="forwarding-panel"><div class="actions"><button class="secondary compact" id="forwarding-refresh" ${busy ? 'disabled' : ''}>Refresh</button><button class="secondary compact" id="forwarding-close">Close</button></div>${busy ? '<p class="meta">Loading forwarding…</p>' : controls}${feedback}<p class="meta">External forwarding may be blocked by tenant policy.</p></div>`;
  }
  private async loadUserLicenses(): Promise<void> {
    const id = this.detail?.id;
    if (!id || this.detailKind !== 'user' || !this.licensesOpen) return;
    const generation = this.generation, context = this.contextValue, ticket = ++this.licensesRequest;
    this.licensesLoading = true; this.licensesError = ''; this.licenseRemovalSku = ''; this.licenseConfirmation = '';
    this.userLicenseCatalog = null; this.licenseAssignSku = '';
    this.render();
    try {
      const result = await this.request<{ items: UserLicense[] }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'user.licenses.get', id }),
      });
      if (generation !== this.generation || context !== this.contextValue || ticket !== this.licensesRequest || this.detail?.id !== id) return;
      if (!Array.isArray(result.items) || result.items.length > 256 || !result.items.every(item =>
        typeof item.skuId === 'string' && typeof item.name === 'string' &&
        (item.assignedByGroup === null || typeof item.assignedByGroup === 'string') && typeof item.state === 'string'))
        throw new Error('Microsoft returned an invalid license inventory.');
      this.userLicenses = result.items; this.licenseNeedsRefresh = false;
      if (this.connection?.canManage) {
        try {
          const catalog = await this.request<{ items: LicenseOption[]; partial: boolean }>(this.path('/administration'), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'licenses.list' }),
          });
          if (!Array.isArray(catalog.items) || catalog.partial || !catalog.items.every(item =>
            typeof item.skuId === 'string' && typeof item.skuPartNumber === 'string' &&
            typeof item.consumedUnits === 'number' && typeof item.prepaidUnits?.enabled === 'number'))
            throw new Error('Complete license inventory is unavailable.');
          if (generation !== this.generation || context !== this.contextValue || ticket !== this.licensesRequest || this.detail?.id !== id) return;
          this.userLicenseCatalog = catalog.items.filter(item => item.capabilityStatus === 'Enabled' &&
            item.prepaidUnits.enabled > item.consumedUnits &&
            !result.items.some(assigned => assigned.skuId.toLowerCase() === item.skuId.toLowerCase()));
        } catch {
          if (generation === this.generation && context === this.contextValue && ticket === this.licensesRequest && this.detail?.id === id)
            this.licensesError = 'Available seats could not be loaded. Existing assignments are still shown.';
        }
      }
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && ticket === this.licensesRequest && this.detail?.id === id)
        this.licensesError = error instanceof Error ? error.message : 'Could not load licenses.';
    } finally {
      if (generation === this.generation && context === this.contextValue && ticket === this.licensesRequest && this.detail?.id === id) {
        this.licensesLoading = false; this.render();
      }
    }
  }
  private async removeUserLicense(): Promise<void> {
    const id = this.detail?.id, skuId = this.licenseRemovalSku;
    if (!id || !this.connection?.canManage || !this.licensesOpen || this.licensesLoading || this.licenseNeedsRefresh ||
      this.licenseConfirmation !== 'REMOVE_LICENSE' || !this.userLicenses?.some(item => item.skuId === skuId && item.assignedByGroup === null)) return;
    const generation = this.generation, context = this.contextValue, ticket = ++this.licensesRequest;
    this.licensesLoading = true; this.licensesError = ''; this.render();
    try {
      const result = await this.request<{ accepted: boolean; verified: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'user.license.remove', id, skuId, confirmation: 'REMOVE_LICENSE' }),
      });
      if (generation !== this.generation || context !== this.contextValue || ticket !== this.licensesRequest || this.detail?.id !== id) return;
      if (!result.accepted) throw new Error('Microsoft did not confirm the license removal.');
      this.licenseNeedsRefresh = true;
      this.licensesError = result.verified ? 'License removal verified. Refresh licenses to see current assignments.'
        : 'Microsoft accepted the change, but readback is pending. Refresh before another change.';
      this.licenseRemovalSku = ''; this.licenseConfirmation = '';
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && ticket === this.licensesRequest && this.detail?.id === id) {
        this.licenseNeedsRefresh = true;
        this.licensesError = `${error instanceof Error ? error.message : 'License removal outcome is uncertain.'} Refresh before another change.`;
      }
    } finally {
      if (generation === this.generation && context === this.contextValue && ticket === this.licensesRequest && this.detail?.id === id) {
        this.licensesLoading = false; this.render();
      }
    }
  }
  private async assignUserLicense(): Promise<void> {
    const id = this.detail?.id, skuId = this.licenseAssignSku;
    if (!id || !this.connection?.canManage || !this.licensesOpen || this.licensesLoading || this.licenseNeedsRefresh ||
      !this.userLicenseCatalog?.some(item => item.skuId === skuId)) return;
    const generation = this.generation, context = this.contextValue, ticket = ++this.licensesRequest;
    this.licensesLoading = true; this.licensesError = ''; this.render();
    try {
      const result = await this.request<{ accepted: boolean; verified: boolean }>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'user.license.assign', id, license: { skuId } }),
      });
      if (generation !== this.generation || context !== this.contextValue || ticket !== this.licensesRequest || this.detail?.id !== id) return;
      if (!result.accepted) throw new Error('Microsoft did not confirm the license assignment.');
      this.licenseNeedsRefresh = true;
      this.licensesError = result.verified ? 'License assignment verified. Refresh licenses to see current assignments.'
        : 'Microsoft accepted the assignment, but readback is pending. Refresh before another change.';
      this.licenseAssignSku = '';
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && ticket === this.licensesRequest && this.detail?.id === id) {
        this.licenseNeedsRefresh = true;
        this.licensesError = `${error instanceof Error ? error.message : 'License assignment outcome is uncertain.'} Refresh before another change.`;
      }
    } finally {
      if (generation === this.generation && context === this.contextValue && ticket === this.licensesRequest && this.detail?.id === id) {
        this.licensesLoading = false; this.render();
      }
    }
  }
  private renderUserLicenses(canManage: boolean): string {
    if (!this.licensesOpen) return '<button class="secondary compact" id="licenses-open">Manage licenses</button>';
    const items = this.userLicenses?.map(item => `<li><span><strong>${esc(item.name)}</strong><small>${item.assignedByGroup ? 'Inherited from group' : 'Direct assignment'} · ${esc(item.state)}</small></span>${canManage && item.assignedByGroup === null ? `<button class="secondary compact" aria-label="Remove ${esc(item.name)} license" title="Remove license" data-license-remove="${esc(item.skuId)}" ${this.licensesLoading || this.licenseNeedsRefresh ? 'disabled' : ''}>&times;</button>` : ''}</li>`).join('') ?? '';
    const confirmation = this.licenseRemovalSku ? `<div class="security-confirmation"><p>Remove the direct license from this account. Group-inherited licenses remain.</p><label>Type REMOVE_LICENSE to confirm<input id="license-confirmation" value="${esc(this.licenseConfirmation)}" autocomplete="off"></label><div class="actions"><button class="secondary compact" id="license-cancel">Cancel</button><button id="license-submit" ${this.licensesLoading ? 'disabled' : ''}>Remove license</button></div></div>` : '';
    const available = this.userLicenseCatalog?.map(item => `<option value="${esc(item.skuId)}" ${item.skuId === this.licenseAssignSku ? 'selected' : ''}>${esc(microsoftSkuName(item.skuPartNumber))} · ${item.prepaidUnits.enabled - item.consumedUnits} available</option>`).join('') ?? '';
    const assign = canManage && this.userLicenseCatalog ? `<label>Assign license<select id="license-assign-sku" ${this.licensesLoading || this.licenseNeedsRefresh ? 'disabled' : ''}><option value="">Select an available license</option>${available}</select></label><button class="secondary compact" id="license-assign" ${!this.licenseAssignSku || this.licensesLoading || this.licenseNeedsRefresh ? 'disabled' : ''}>Assign license</button>` : '';
    return `<div class="licenses-panel"><div class="actions"><button class="secondary compact" id="licenses-refresh" ${this.licensesLoading ? 'disabled' : ''}>Refresh licenses</button><button class="secondary compact" id="licenses-close">Close</button></div>${this.licensesLoading ? '<p class="meta">Loading licenses…</p>' : this.userLicenses ? items ? `<ul class="mfa-methods">${items}</ul>` : '<p class="meta">No licenses assigned.</p>' : ''}${assign}${confirmation}${this.licensesError ? `<p class="meta" role="status">${esc(this.licensesError)}</p>` : ''}</div>`;
  }
  private renderDrawer(canManage: boolean): string {
    const detail = this.detail!;
    const record = this.detailRecord;
    const feedback = `<p class="drawer-feedback ${this.drawerError ? 'error' : ''}" data-testid="detail-mutation-feedback" role="${this.drawerError ? 'alert' : 'status'}">${esc(this.drawerMessage)}</p>`;
    const userName = String(record?.displayName ?? detail.values.displayName ?? detail.values.primarySmtpAddress ?? detail.id);
    const userEmail = record?.userPrincipalName ?? detail.values.userPrincipalName ?? detail.values.mail;
    const sharedMailbox = this.detailKind === 'user' && this.detailIsShared;
    const subtitle = this.detailKind === 'user' ? `${esc(userName)}${userEmail && String(userEmail) !== userName ? ` · ${esc(String(userEmail))}` : ''}` : '';
    let content: string;
    if (this.detailKind === 'read') {
      content = `<div class="drawer-body"><dl>${Object.entries(detail.values).map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(String(value ?? '—'))}</dd></div>`).join('')}</dl></div><footer class="drawer-footer">${feedback}</footer>`;
    } else if (!record) {
      content = `<div class="drawer-body">${this.drawerError ? `<p class="subtle">Current ${this.detailKind} details could not be loaded.</p><button class="secondary compact" id="detail-retry">Retry loading details</button>` : `<p class="subtle">Loading current ${this.detailKind} details…</p>`}</div><footer class="drawer-footer">${feedback}</footer>`;
    } else if (this.detailKind === 'user') {
      if (sharedMailbox) {
        const mailboxPanel = this.accountPanel === 'delegation' ? this.renderDelegation(canManage)
          : this.accountPanel === 'forwarding' ? this.renderForwarding(canManage)
            : this.accountPanel === 'autoreply' ? this.renderAutoReply(canManage) : this.renderAddresses(canManage);
        content = `<div class="drawer-body"><section class="drawer-section">${mailboxPanel}</section></div><footer class="drawer-footer">${feedback}</footer>`;
      } else if (this.mfaOpen) {
        const methods = this.mfaMethods?.map(method => `<li><span><strong>${this.mfaMethodLabel(method)}</strong><small>${esc(method.detail || 'No additional detail available')}</small></span>${method.removable && method.id && (method.type !== 'password' && method.type !== 'other') ? `<button class="secondary compact" data-mfa-remove="${esc(method.id)}" data-mfa-kind="${method.type}" aria-label="Remove ${esc(this.mfaMethodLabel(method))}: ${esc(method.detail || 'authentication method')}" ${this.busy || this.mfaRemovalNeedsRefresh ? 'disabled' : ''}>&times;</button>` : `<small>${method.type === 'password' ? 'Use Reset password' : 'Removal unavailable for this method'}</small>`}</li>`).join('') ?? '';
        const removal = this.mfaRemoval ? `<div class="security-confirmation" role="group">${this.mfaRemovalNeedsRefresh ? '<p role="status">Refresh methods to verify the last removal before trying another change.</p>' : ''}<p>Remove ${esc(this.mfaMethodLabel(this.mfaRemoval))} method: ${esc(this.mfaRemoval.detail || 'No additional detail available')}.</p><label>Type REMOVE_AUTH_METHOD to confirm<input id="mfa-removal-confirmation" value="${esc(this.mfaConfirmation)}" autocomplete="off" ${this.busy || this.mfaRemovalNeedsRefresh ? 'disabled' : ''}></label><div class="actions"><button class="secondary" id="mfa-removal-cancel" ${this.busy ? 'disabled' : ''}>Cancel</button><button id="mfa-removal-submit" ${this.busy || this.mfaRemovalNeedsRefresh ? 'disabled' : ''}>Remove method</button></div></div>` : '';
        const inventory = this.mfaLoading ? '<p class="meta">Loading authentication methods…</p>' : this.mfaMethods ? methods ? `<ul class="mfa-methods">${methods}</ul>` : '<p class="meta">No authentication methods are registered.</p>' : `<p class="meta">MFA methods unavailable${this.mfaError ? `: ${esc(this.mfaError)}` : ''}</p>`;
        const recoveryEmail = this.mfaMethods?.find(method => method.type === 'email')?.detail ?? '';
        const recovery = this.mfaMethods ? `<section class="drawer-section"><h3>Recovery email</h3><p class="meta">Current: ${recoveryEmail ? esc(recoveryEmail) : 'Not set'}</p><label>Email address<input id="mfa-recovery-email" type="email" autocomplete="off" maxlength="320" value="${esc(this.recoveryEmailDraft)}" ${this.busy || this.recoveryEmailNeedsRefresh ? 'disabled' : ''}></label><div class="actions"><button id="mfa-recovery-save" ${this.busy || this.recoveryEmailNeedsRefresh ? 'disabled' : ''}>Save recovery email</button></div></section>` : '';
        const mobile = this.mfaMethods ? `<section class="drawer-section"><h3>Mobile authentication phone</h3><p class="meta">Current: ${esc(this.mfaMethods.find(method => method.type === 'phone' && method.detail?.startsWith('mobile'))?.detail ?? 'Not set')}</p><p class="meta">Microsoft returns a masked number. Enter a full number only to replace it; use the remove control on the current method to remove it.</p><label>Replacement number with country code<input id="mfa-mobile-phone" type="tel" autocomplete="off" maxlength="40" placeholder="+1 5555551234" value="${esc(this.mobilePhoneDraft)}" ${this.busy || this.mobilePhoneNeedsRefresh ? 'disabled' : ''}></label><div class="actions"><button id="mfa-mobile-save" ${this.busy || this.mobilePhoneNeedsRefresh ? 'disabled' : ''}>Save mobile phone</button></div></section>` : '';
        content = `<div class="drawer-body"><button class="secondary compact" id="account-back">&larr; Account</button><section class="drawer-section"><div class="actions"><h3>MFA methods</h3><button class="secondary compact" id="mfa-methods-refresh" ${this.busy ? 'disabled' : ''}>Refresh methods</button> </div>${inventory}${removal}</section>${recovery}${mobile}<section class="drawer-section"><h3>Unavailable</h3><p class="meta">Re-registration and per-user MFA state are unavailable until their backend operations exist.</p></section></div><footer class="drawer-footer">${feedback}</footer>`;
      } else {
      const field = (name: typeof USER_FIELDS[number], label: string) => `<div class="user-field"><label><span>${label}</span><input id="user-${name}" value="${esc(String(this.userDraft[name] ?? record[name] ?? ''))}" ${this.busy || !canManage ? 'disabled' : ''}></label>${canManage ? `<button class="secondary" type="button" data-user-save="${name}" ${this.busy || String(this.userDraft[name] ?? record[name] ?? '') === String(record[name] ?? '') ? 'disabled' : ''}>Save</button>` : ''}</div>`;
      const securityConfirmation = this.userSecurityAction ? `<div class="security-confirmation" role="group" aria-label="Confirm security action"><p>${this.userSecurityAction === 'reset-password' ? 'Microsoft will set a new temporary password and require the user to change it at next sign-in.' : this.userSecurityAction === 'revoke-sessions' ? 'Microsoft will invalidate refresh tokens and browser session cookies. Users may need to sign in again; revocation can take a few minutes.' : this.userSecurityAction === 'block-sign-in' ? 'Microsoft will block this account from signing in.' : 'Microsoft will allow this account to sign in again.'}</p><div class="actions"><button class="secondary" id="user-security-cancel" ${this.busy ? 'disabled' : ''}>Cancel</button><button id="user-security-submit" ${this.busy ? 'disabled' : ''}>${this.userSecurityAction === 'reset-password' ? 'Reset password' : this.userSecurityAction === 'revoke-sessions' ? 'Sign out all sessions' : this.userSecurityAction === 'block-sign-in' ? 'Block sign-in' : 'Restore sign-in'}</button></div></div>` : '';
      const passwordDisplay = this.temporaryPassword ? `<div class="one-time-secret" role="status"><strong>Temporary password</strong><code id="temporary-password">${esc(this.temporaryPassword)}</code><p>It is shown only in this drawer. Copy it now; closing the drawer clears it.</p><button class="secondary compact" id="copy-temporary-password">Copy password</button><button class="secondary compact" id="hide-temporary-password">Hide password</button></div>` : '';
      const globalAdmin = this.globalAdminLoading ? '<p class="meta" data-testid="global-admin-status">Loading Global Administrator status…</p>' : this.globalAdminStatus === null ? `<p class="meta" data-testid="global-admin-status">Global Administrator status unavailable${this.globalAdminError ? `: ${esc(this.globalAdminError)}` : ''}</p><button class="secondary compact" id="global-admin-retry">Retry role status</button>` : canManage ? `<div class="role-field"><label class="check"><input id="global-admin-enabled" type="checkbox" ${this.globalAdminDraft ? 'checked' : ''} ${this.busy ? 'disabled' : ''}> Global Administrator</label>${this.globalAdminDraft !== this.globalAdminStatus ? `<label>Type GLOBAL_ADMIN to confirm<input id="global-admin-confirmation" value="${esc(this.globalAdminConfirmation)}" autocomplete="off" ${this.busy ? 'disabled' : ''}></label><button class="secondary compact" id="global-admin-save" ${this.busy ? 'disabled' : ''}>Save role</button>` : ''}</div>` : `<p class="meta" data-testid="global-admin-status">Global Administrator: ${this.globalAdminStatus ? 'Enabled' : 'Not assigned'}</p>`;
      const eligibleGroups = this.userGroups?.items.filter(group => group.values.groupKind === 'Microsoft 365 group'
        && !this.userMemberships?.items.some(member => member.id === group.id)) ?? [];
      const existingMemberships = `<h4>Current groups</h4>${this.userMemberships
        ? `${this.userMemberships.partial ? '<p class="meta">Membership list is incomplete. Refresh before removing a membership.</p>' : ''}${this.userMemberships.items.length
          ? `<ul class="membership-list">${this.userMemberships.items.map(group => `<li><span class="membership-name">${esc(group.displayName)}</span>${group.removable
            ? `<button class="secondary compact" data-user-group-remove="${esc(group.id)}" aria-label="Remove from ${esc(group.displayName)}" ${this.busy || this.userMemberships?.partial || this.userGroupNeedsRefresh ? 'disabled' : ''}>&times;</button>`
            : `<span class="membership-reason">${esc(group.reason)}</span>`}</li>`).join('')}</ul>`
          : '<p class="meta">No direct group memberships.</p>'}`
        : this.userMembershipError ? `<p class="status" data-error="true" role="alert">${esc(this.userMembershipError)}</p>` : '<p class="meta" role="status">Loading current memberships...</p>'}`;
      const catalog = this.userGroups ? eligibleGroups.length
        ? `<label>Add to Microsoft 365 group<select id="user-group-select" ${this.busy || this.userGroupNeedsRefresh || !this.userMemberships ? 'disabled' : ''}><option value="">Choose a group</option>${eligibleGroups.map(group => `<option value="${esc(group.id)}" ${group.id === this.userGroupSelectedId ? 'selected' : ''}>${esc(String(group.values.displayName ?? group.id))}</option>`).join('')}</select></label>`
        : '<p class="meta">No additional eligible Microsoft 365 groups are available.</p>'
        : this.userGroupCatalogError ? `<p class="status" data-error="true" role="alert">${esc(this.userGroupCatalogError)}</p>` : '<p class="meta" role="status">Loading available groups...</p>';
      const membershipConfirmation = this.userGroupRemoveId || eligibleGroups.length ? `${this.userGroupRemoveId ? `<p role="status">Remove this account from ${esc(this.userMemberships?.items.find(group => group.id === this.userGroupRemoveId)?.displayName ?? '')}?</p>` : ''}<button id="user-group-submit" ${this.busy || this.userGroupNeedsRefresh || !this.userMemberships || (!this.userGroupSelectedId && !this.userGroupRemoveId) ? 'disabled' : ''}>${this.userGroupRemoveId ? 'Remove membership' : 'Add to group'}</button>` : '';
      const userGroup = !canManage ? '' : `<section class="drawer-section section-groups"><h3>Groups</h3>${this.userGroupOpen
        ? `<div class="actions"><button class="secondary compact" id="user-group-refresh" ${this.busy ? 'disabled' : ''}>Refresh groups</button></div>${existingMemberships}${this.userGroupRemoveId ? '' : catalog}${membershipConfirmation}`
        : '<button class="secondary compact" id="user-group-open">View group memberships</button>'}</section>`;
      content = `<div class="drawer-body account-panel" data-panel="${this.accountPanel}"><section class="drawer-section section-account"><h3>Account</h3><div class="field-grid">${field('displayName', 'Name')}</div><div class="role-field">${globalAdmin}</div></section><section class="drawer-section section-addresses"><h3>Email addresses</h3>${this.renderAddresses(canManage)}</section><section class="drawer-section section-licenses"><h3>Licenses</h3>${this.renderUserLicenses(canManage)}</section>${userGroup}${canManage ? `<section class="drawer-section section-security"><h3>Security</h3><div class="actions"><button class="secondary" id="user-password-reset-start" ${this.busy ? 'disabled' : ''}>Reset password</button><button class="secondary" id="user-sessions-revoke-start" ${this.busy ? 'disabled' : ''}>Sign out of all sessions</button><button class="secondary" data-row-security="${record.accountEnabled === false ? 'restore-sign-in' : 'block-sign-in'}" data-row-id="${esc(detail.id)}" ${this.busy ? 'disabled' : ''}>${record.accountEnabled === false ? 'Restore sign-in' : 'Block sign-in'}</button><button class="secondary" data-mfa="${esc(detail.id)}" ${this.busy ? 'disabled' : ''}>MFA</button></div>${securityConfirmation}${passwordDisplay}</section>` : ''}<section class="drawer-section section-mailbox"><h3>Mailbox</h3><div class="mailbox-delegation">${this.renderDelegation(canManage)}</div><div class="mailbox-forwarding">${this.renderForwarding(canManage)}</div><div class="mailbox-autoreply">${this.renderAutoReply(canManage)}</div></section>${canManage ? `<section class="drawer-section section-drive"><h3>OneDrive</h3><p class="meta">The link opens the user's OneDrive. Your signed-in Microsoft account still needs file access.</p><button class="secondary compact" id="user-drive-link" ${this.driveLinkLoading ? 'disabled' : ''}>${this.driveLinkLoading ? 'Loading…' : 'Show OneDrive'}</button>${this.driveLinkError ? `<p class="status" data-error="true">${esc(this.driveLinkError)}</p>` : ''}${this.driveLink ? `<p><a href="${esc(this.driveLink)}" target="_blank" rel="noopener noreferrer">Open OneDrive</a></p>` : ''}</section>` : ''}</div><footer class="drawer-footer">${canManage ? '' : '<p class="read-only">An organization administrator can edit this user.</p>'}${feedback}</footer>`;
      }
    } else {
      const query = this.membershipSearch.trim().toLowerCase();
      const users = this.membershipUsers?.items.filter(user => `${user.values.displayName ?? ''} ${user.values.userPrincipalName ?? user.values.mail ?? ''}`.toLowerCase().includes(query)) ?? [];
      const selected = this.membershipUsers?.items.find(user => user.id === this.membershipUserId);
      const selectedExisting = [...(this.groupPeople?.members ?? []), ...(this.groupPeople?.owners ?? [])].find(person => person.id === this.membershipUserId);
      const picker = !this.membershipUsers ? `<p class="meta" data-testid="member-picker-status">${this.drawerError ? 'User list unavailable. Refresh the directory before changing group assignments.' : 'Loading users for member picker…'}</p>` : !users.length ? '<p class="meta" data-testid="member-picker-status">No loaded users match this search.</p>' : `<div class="member-options" role="listbox" aria-label="Choose user">${users.slice(0, 20).map(user => { const name = String(user.values.displayName ?? user.id); const email = user.values.userPrincipalName ?? user.values.mail; return `<button type="button" class="member-option ${user.id === this.membershipUserId ? 'selected' : ''}" data-member-user="${esc(user.id)}" role="option" aria-selected="${user.id === this.membershipUserId}" ${this.busy ? 'disabled' : ''}><strong>${esc(name)}</strong>${email ? `<small>${esc(String(email))}</small>` : ''}</button>`; }).join('')}</div>`;
      const editable = Array.isArray(record.groupTypes) && record.groupTypes.includes('Unified') && record.onPremisesSyncEnabled !== true && record.isAssignableToRole !== true;
      const distribution = detail.values.groupKind === 'Distribution list';
      const people = this.groupPeople;
      const personList = (items: GroupPeople['members'], role: 'member' | 'owner') => items.length
        ? `<ul class="current-members">${items.map(person => `<li><strong>${esc(person.displayName || person.userPrincipalName || person.id)}</strong>${person.userPrincipalName ? `<small>${esc(person.userPrincipalName)}</small>` : ''}${canManage && (editable || distribution) ? `<button class="secondary compact" data-group-person-remove="${esc(person.id)}" data-group-person-role="${role}" aria-label="Remove ${esc(person.displayName || person.userPrincipalName || person.id)} as ${role}" ${this.busy || this.membershipNeedsRefresh || !people?.complete || role === 'owner' && people.owners.length <= 1 ? 'disabled' : ''}>×</button>` : ''}</li>`).join('')}</ul>`
        : '<p class="meta">None</p>';
      const currentPeople = `<div class="current-people" data-testid="current-group-people"><div class="actions"><h4>${this.accountPanel === 'owners' ? 'Current owners' : 'Current members'}</h4><button class="secondary compact" id="group-people-refresh" ${this.busy ? 'disabled' : ''}>Refresh</button></div><div aria-live="polite">${this.groupPeopleError ? `<p class="status" data-error="true">${esc(this.groupPeopleError)}</p>` : people ? `${this.accountPanel !== 'owners' ? `<h5>Members (${people.members.length})</h5>${personList(people.members, 'member')}` : ''}${distribution || this.accountPanel !== 'owners' ? '' : `<h5>Owners (${people.owners.length})</h5>${personList(people.owners, 'owner')}${people.owners.length === 1 ? '<p class="meta">The last owner cannot be removed. Add another owner first.</p>' : ''}${people.otherMemberCount ? `<p class="meta">${people.otherMemberCount} other directory members are not shown.</p>` : ''}`}${!people.complete ? '<p class="status" data-error="true">The membership list is incomplete; refresh before relying on it.</p>' : ''}` : '<p class="meta">Loading current membership…</p>'}</div></div>`;
      const settings = this.groupSettings;
      const primaryEditor = canManage && settings ? (settings.kind === 'distribution' && settings.emailAddressPolicyEnabled !== false
        ? '<p class="meta">This address follows an Exchange email-address policy and cannot be changed here.</p>'
        : `<label>New primary address<input id="group-primary-address" type="email" maxlength="320" value="${esc(this.groupPrimaryDraft)}" ${this.busy || this.groupPrimaryNeedsRefresh ? 'disabled' : ''}></label>${this.groupPrimaryDraft.trim().toLowerCase() !== settings.primarySmtpAddress.toLowerCase() ? `<p class="meta">Changing the primary address affects mail routing. The old address remains an alias.</p><button class="secondary compact" id="group-primary-save" ${this.busy || this.groupPrimaryNeedsRefresh ? 'disabled' : ''}>Save primary address</button>` : ''}`) : '';
      const aliasEditable = canManage && settings && !(settings.kind === 'distribution' && settings.emailAddressPolicyEnabled !== false) && record.onPremisesSyncEnabled !== true;
      const aliasList = settings?.aliases.map(alias => `<span class="alias-chip"><span>${esc(alias)}</span>${aliasEditable && alias.toLowerCase() !== settings.primarySmtpAddress.toLowerCase() && !/\.onmicrosoft\.com$/i.test(alias) ? `<button class="alias-remove" data-group-alias-remove="${esc(alias)}" aria-label="Remove alias ${esc(alias)}" ${this.busy || this.groupPrimaryNeedsRefresh ? 'disabled' : ''}>×</button>` : '<small>Managed address</small>'}</span>`).join('') || 'None';
      const aliasEditor = aliasEditable ? `<section class="drawer-section"><h4>Aliases</h4>${this.groupAliasRemoval ? `<p>Remove alias ${esc(this.groupAliasRemoval)}?</p><button class="secondary compact" id="group-alias-cancel">Cancel removal</button>` : `<label>New alias<input id="group-alias-address" type="email" maxlength="320" value="${esc(this.groupAliasDraft)}" ${this.busy || this.groupPrimaryNeedsRefresh ? 'disabled' : ''}></label>`}<button id="group-alias-submit" ${this.busy || this.groupPrimaryNeedsRefresh || !(this.groupAliasRemoval || this.groupAliasDraft).trim() ? 'disabled' : ''}>${this.groupAliasRemoval ? 'Remove alias' : 'Add alias'}</button></section>` : '';
      const settingsPanel = `<section class="drawer-section" data-testid="group-settings"><div class="actions"><h3>Delivery settings</h3><button class="secondary compact" id="group-settings-refresh" ${this.busy ? 'disabled' : ''}>Refresh</button></div>${this.groupSettingsError ? `<p class="status" data-error="true">${esc(this.groupSettingsError)}</p>` : settings ? `<dl><div><dt>Primary address</dt><dd>${esc(settings.primarySmtpAddress)}</dd></div><div><dt>Email aliases</dt><dd>${aliasList}</dd></div>${settings.kind === 'distribution' ? `<div><dt>Address policy</dt><dd>${settings.emailAddressPolicyEnabled ? 'Managed automatically' : 'Manual'}</dd></div>` : ''}<div><dt>External senders</dt><dd>${settings.requireSenderAuthenticationEnabled ? 'Not allowed' : 'Allowed'}</dd></div></dl>${canManage ? `<label class="check"><input id="group-external-allow" type="checkbox" ${this.groupExternalDraft ? 'checked' : ''} ${this.busy || this.groupExternalNeedsRefresh ? 'disabled' : ''}> Allow external senders</label>${this.groupExternalDraft !== !settings.requireSenderAuthenticationEnabled ? `<button class="secondary compact" id="group-external-save" ${this.busy || this.groupExternalNeedsRefresh ? 'disabled' : ''}>Save sender policy</button>` : ''}${primaryEditor}${aliasEditor}` : ''}` : '<p class="meta">Loading delivery settings…</p>'}</section>`;
      content = `<div class="drawer-body"><p class="meta">${record.mail ? esc(String(record.mail)) : 'Microsoft 365 group'}</p>${this.accountPanel === 'account' && canManage && (editable || distribution) ? `<section class="drawer-section"><h3>Group</h3><div class="user-field"><label><span>Name</span><input id="group-name" maxlength="256" value="${esc(this.groupNameDraft)}" ${this.busy || this.groupNameNeedsRefresh ? 'disabled' : ''}></label><button class="secondary compact" id="group-name-save" ${this.busy || this.groupNameNeedsRefresh || this.groupNameDraft.trim() === String(record.displayName ?? '') ? 'disabled' : ''}>Save name</button></div></section>` : ''}${this.accountPanel === 'email' ? settingsPanel : ''}${['members', 'owners'].includes(this.accountPanel) ? currentPeople : ''}${['members', 'owners'].includes(this.accountPanel) && canManage && (editable || distribution) ? `<section class="drawer-section"><h3>Membership</h3><label>Find user<input id="group-member-search" value="${esc(this.membershipSearch)}" placeholder="Search loaded names or emails" autocomplete="off" ${this.busy ? 'disabled' : ''}></label>${picker}${selected || selectedExisting ? `<p class="meta">${this.membershipAction === 'remove' ? 'Remove' : 'Selected'} ${this.membershipRole}: ${esc(String(selected?.values.displayName ?? selectedExisting?.displayName ?? this.membershipUserId))}</p>` : ''}${distribution ? '' : `<label>Group assignment<select id="group-member-role" ${this.busy || this.membershipNeedsRefresh ? 'disabled' : ''}><option value="member" ${this.membershipRole === 'member' ? 'selected' : ''}>Member</option><option value="owner" ${this.membershipRole === 'owner' ? 'selected' : ''}>Owner</option></select></label>`}<label>Membership action<select id="group-member-action" ${this.busy ? 'disabled' : ''}><option value="add" ${this.membershipAction === 'add' ? 'selected' : ''}>Add member</option><option value="remove" ${this.membershipAction === 'remove' ? 'selected' : ''}>Remove member</option></select></label></section>` : ['members', 'owners'].includes(this.accountPanel) ? '<p class="read-only">Membership changes for this group type are not available here.</p>' : ''}</div><footer class="drawer-footer">${['members', 'owners'].includes(this.accountPanel) && canManage && (editable || distribution) ? `<div class="actions"><button id="group-member-submit" ${this.busy || this.membershipNeedsRefresh || !this.membershipUserId ? 'disabled' : ''}>${this.membershipAction === 'remove' ? 'Remove' : 'Add'} ${this.membershipRole}</button></div>` : ''}${feedback}</footer>`;
    }
    const title = this.mfaOpen ? 'Authentication methods' : sharedMailbox ? 'Shared mailbox' : this.detailKind === 'user' ? (canManage ? 'Edit account' : 'View account') : this.detailKind === 'group' ? record && (detail.values.groupKind === 'Distribution list' || (Array.isArray(record.groupTypes) && record.groupTypes.includes('Unified'))) ? (canManage ? 'Edit group' : 'Group details') : 'Group details' : 'Resource details';
    return `<div class="backdrop" data-backdrop><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title"><div class="heading drawer-heading"><div><h2 id="detail-title">${this.detailKind === 'group' ? esc(({account: 'Group details', email: 'Group email settings', members: 'Group members', owners: 'Group owners'} as Record<string,string>)[this.accountPanel] ?? title) : this.detailKind === 'user' && !this.mfaOpen ? esc(({account: title, addresses: 'Email addresses', licenses: 'Licenses', groups: 'Group membership', security: 'Account security', delegation: 'Mailbox delegation', forwarding: 'Mail forwarding', autoreply: 'Out of office', drive: 'OneDrive'} as Record<string, string>)[this.accountPanel] ?? title) : title}</h2>${subtitle ? `<p class="subtle">${subtitle}</p>` : ''}</div><button class="secondary compact" id="detail-close">Close</button></div>${content}</aside></div>`;
  }

  private renderCreateUserDrawer(): string {
    const domains = this.createUserDomains;
    const done = this.createdUser;
    const licenseOptions = this.createUserLicenses?.map(item => `<option value="${esc(item.skuId)}" ${item.skuId === this.createUserDraft.skuId ? 'selected' : ''}>${esc(microsoftSkuName(item.skuPartNumber))} · ${item.prepaidUnits.enabled - item.consumedUnits} available</option>`).join('') ?? '';
    const licenseForm = `<section class="drawer-section"><h3>Assignments</h3><label>Group membership<select id="create-user-group" aria-label="Group membership" ${this.createUserBusy || !this.createUserGroups ? 'disabled' : ''}><option value="">Choose a group to add</option>${(this.createUserGroups ?? []).filter(group => !this.createUserGroupIds.includes(group.id)).map(group => `<option value="${esc(group.id)}">${esc(String(group.values.displayName ?? group.id))}</option>`).join('')}</select></label><div class="address-aliases">${this.createUserGroupIds.map(id => `<div class="alias-chip"><span>${esc(String(this.createUserGroups?.find(group => group.id === id)?.values.displayName ?? id))}</span><button type="button" class="alias-remove" data-create-group-remove="${esc(id)}" aria-label="Remove selected group ${esc(String(this.createUserGroups?.find(group => group.id === id)?.values.displayName ?? id))}" ${this.createUserBusy ? 'disabled' : ''}>×</button></div>`).join('')}</div>${this.createUserGroupsError ? `<p class="meta" role="alert">${esc(this.createUserGroupsError)}</p><button id="create-user-groups-retry" class="secondary compact" type="button">Retry loading groups</button>` : this.createUserGroups === null ? '<p class="meta">Loading groups…</p>' : '<p class="meta">Selected groups are assigned after the account is created. Dynamic and synchronized groups are managed elsewhere.</p>'}<label>License<select id="create-user-license" aria-label="License" ${this.createUserBusy || this.createUserLicenses === null || !this.createUserDraft.location ? 'disabled' : ''}><option value="">No license</option>${licenseOptions}</select></label>${this.createUserDomains && !this.createUserDraft.location ? '<p class="meta">This tenant has no default usage location. Create the account without a license, or configure the tenant default before assigning a license here.</p>' : ''}${this.createLicenseCatalogError ? `<p class="meta">${esc(this.createLicenseCatalogError)} You can create the user without a license.</p><button class="secondary compact" id="create-user-licenses-retry" ${this.createUserBusy ? 'disabled' : ''}>Retry loading licenses</button>` : this.createUserLicenses === null ? '<p class="meta">Loading available license seats…</p>' : !this.createUserLicenses.length ? '<p class="meta">No license seats are available.</p>' : ''}<p class="meta">MFA enrollment and aliases can be managed after creation.</p></section>`;
    const licenseStatus = this.createLicenseOutcome ? `<p class="status" data-error="${this.createLicenseOutcomeError}" role="status">${esc(this.createLicenseOutcome)}</p>` : '';
    const status = this.createUserError ? `<div class="actions"><p class="status" data-error="true" role="alert">${esc(this.createUserError)}</p>${domains?.length ? '' : '<button class="secondary compact" id="create-user-domains-retry">Retry loading domains</button>'}</div>` : '';
    const content = done ? `<div class="drawer-body"><section class="drawer-section"><h3>Created account</h3><p>${esc(done.userPrincipalName)}</p><label>${this.createUserForceChange ? 'Temporary password' : 'Password'}<input aria-label="${this.createUserForceChange ? 'Temporary password' : 'Password'}" type="text" readonly value="${esc(done.temporaryPassword)}"></label><p class="meta">Copy this password now. It is shown only in this drawer; ${this.createUserForceChange ? 'The user must change it at next sign-in.' : 'A password change is not required at next sign-in.'} It may take a moment to appear in the directory.</p></section><section class="drawer-section"><h3>Assignment results</h3>${licenseStatus}${this.createUserGroupOutcomes.map(outcome => `<p class="meta" role="status">${esc(outcome)}</p>`).join('')}${this.createUserBusy ? '<p role="status">Applying selected assignments…</p>' : ''}<p class="meta">MFA enrollment and aliases remain separate actions. Review any unconfirmed assignments before retrying; do not create the account again.</p></section></div>` : `<div class="drawer-body"><section class="drawer-section"><h3>Account</h3><label>Name<input id="create-user-name" aria-label="Name" maxlength="256" value="${esc(this.createUserDraft.name)}" placeholder="Full name" ${this.createUserBusy ? 'disabled' : ''}></label><label>Sign-in name<div class="upn-field"><input id="create-user-local" aria-label="Sign-in name" maxlength="64" value="${esc(this.createUserDraft.local)}" placeholder="name" ${this.createUserBusy ? 'disabled' : ''}><span>@</span><select id="create-user-domain" aria-label="Domain" ${!domains?.length || this.createUserBusy ? 'disabled' : ''}>${domains?.length ? domains.map(domain => `<option value="${esc(domain)}" ${domain === this.createUserDraft.domain ? 'selected' : ''}>${esc(domain)}</option>`).join('') : domains === null ? '<option>Loading verified domains…</option>' : '<option>Domains unavailable</option>'}</select></div></label></section><section class="drawer-section"><h3>Sign-in</h3><label>Password setup<select id="create-user-password-mode" aria-label="Password setup" ${this.createUserBusy ? 'disabled' : ''}><option value="generated" ${this.createUserPasswordMode === 'generated' ? 'selected' : ''}>Generate a password automatically</option><option value="custom" ${this.createUserPasswordMode === 'custom' ? 'selected' : ''}>Set a password</option></select></label>${this.createUserPasswordMode === 'custom' ? `<label>Password<input type="password" id="create-user-password" aria-label="Password" autocomplete="new-password" minlength="8" maxlength="256" value="${esc(this.createUserPassword)}" ${this.createUserBusy ? 'disabled' : ''}></label><p class="meta">Must meet the tenant’s password policy.</p>` : '<p class="meta">A password is generated securely when the user is created.</p>'}<label class="check"><input id="create-user-force-change" type="checkbox" ${this.createUserForceChange ? 'checked' : ''} ${this.createUserBusy ? 'disabled' : ''}> Force change password at next sign-in</label></section>${licenseForm}</div>`;
    return `<div class="backdrop" data-create-user-backdrop><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="create-user-title"><div class="heading drawer-heading"><div><h2 id="create-user-title">Add user</h2><p class="subtle">${done ? 'Account created' : 'Create a Microsoft 365 user'}</p></div><button class="secondary compact" id="create-user-close" ${this.createUserBusy ? 'disabled' : ''}>Close</button></div>${status}${content}<footer class="drawer-footer"><div class="actions">${done ? '' : `<button id="create-user-submit" ${!domains?.length || this.createUserBusy || this.createUserUncertain ? 'disabled' : ''}>Create user</button>`}</div></footer></aside></div>`;
  }
  private renderCreateGroupDrawer(): string {
    const done = this.createdGroup;
    const owners = this.createGroupUsers?.items ?? [];
    const distribution = this.createGroupDraft.kind === 'distribution';
    const fields = distribution
      ? `<label>Email address<input id="create-group-address" type="email" maxlength="320" value="${esc(this.createGroupDraft.primarySmtpAddress)}" placeholder="team@example.com" ${this.createGroupBusy ? 'disabled' : ''}></label><p class="meta">The address must use a domain accepted by this tenant. Exchange verifies it before creating the list.</p>`
      : `<label>Mail alias<input id="create-group-alias" maxlength="64" value="${esc(this.createGroupDraft.alias)}" placeholder="team" ${this.createGroupBusy ? 'disabled' : ''}></label><label>Owner<select id="create-group-owner" ${!owners.length || this.createGroupBusy ? 'disabled' : ''}><option value="">Choose a tenant user</option>${owners.map(row => `<option value="${esc(row.id)}" ${row.id === this.createGroupDraft.ownerId ? 'selected' : ''}>${esc(String(row.values.displayName ?? row.id))} · ${esc(String(row.values.userPrincipalName ?? ''))}</option>`).join('')}</select></label><p class="meta">Microsoft assigns the primary address for Microsoft 365 groups.</p>${!this.createGroupUsers ? this.createGroupError ? '<button class="secondary compact" id="create-group-owners-retry">Retry loading owners</button>' : '<p class="meta" role="status">Loading tenant users…</p>' : !owners.length ? '<p class="meta">No tenant users are available to own this group.</p>' : ''}`;
    return `<div class="backdrop" data-create-group-backdrop><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="create-group-title"><div class="heading drawer-heading"><div><h2 id="create-group-title">Add group</h2><p class="subtle">${distribution ? 'Exchange distribution list' : 'Microsoft 365 group'}</p></div><button class="secondary compact" id="create-group-close" ${this.createGroupBusy ? 'disabled' : ''}>Close</button></div><div class="drawer-body">${done ? `<p role="status">Microsoft accepted group creation.${done.verified ? (done.kind === 'distribution' ? ' Microsoft verified the new group.' : ' Group details were verified.') : ' Group details are still propagating; refresh before another action.'}</p><p class="meta">${done.id ? `Group ID: ${esc(done.id)} · ` : ''}Address: ${esc(done.mail || 'Pending')}</p>` : `<section class="drawer-section"><label>Group type<select id="create-group-kind" ${this.createGroupBusy ? 'disabled' : ''}><option value="m365" ${!distribution ? 'selected' : ''}>Microsoft 365 group</option><option value="distribution" ${distribution ? 'selected' : ''}>Distribution list</option></select></label><label>Name<input id="create-group-name" maxlength="256" value="${esc(this.createGroupDraft.name)}" ${this.createGroupBusy ? 'disabled' : ''}></label>${fields}</section>`}${this.createGroupError ? `<p class="status" data-error="true" role="alert">${esc(this.createGroupError)}</p>` : ''}</div><footer class="drawer-footer">${done ? '' : `<div class="actions"><button id="create-group-submit" ${this.createGroupBusy || this.createGroupUncertain || (!distribution && !owners.length) ? 'disabled' : ''}>Create group</button></div>`}</footer></aside></div>`;
  }

  private async searchTrace(nextPage = false): Promise<void> {
    if (!this.canRead() || this.traceLoading) return;
    let criteria: TraceCriteria;
    if (nextPage) {
      if (!this.traceCriteria || !this.traceNext || this.traceRows.length >= 5000) return;
      criteria = { ...this.traceCriteria, cursor: this.traceNext };
    } else {
      const start = Date.parse(this.traceDraft.start), end = Date.parse(this.traceDraft.end), now = Date.now();
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 10 * 86400000 || start < now - 90 * 86400000 || end > now + 5 * 60000) {
        this.traceError = 'Choose up to 10 days within the last 90 days.'; this.render(); return;
      }
      const sender = this.traceDraft.sender.trim(), recipient = this.traceDraft.recipient.trim();
      if ([sender, recipient].some(value => value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
        this.traceError = 'Enter complete sender and recipient email addresses.'; this.render(); return;
      }
      criteria = { start: new Date(start).toISOString(), end: new Date(end).toISOString(),
        sender: sender || null, recipient: recipient || null, status: this.traceDraft.status || null, cursor: null };
      this.quarantineRequest++; this.quarantineRow=null; this.quarantineMatch=null; this.quarantineBusy=false;
      this.traceSelected=null; this.traceCriteria = criteria; this.traceRows = []; this.traceNext = null; this.traceDetail = null;
    }
    const generation = this.generation, context = this.contextValue, request = ++this.traceRequest;
    this.traceLoading = true; this.traceError = ''; this.render();
    try {
      const data = await this.request<TracePage>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'trace.search', ...criteria }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.traceRequest) return;
      if (!data || !Array.isArray(data.rows) || data.rows.length > 1000 || typeof data.partial !== 'boolean' ||
        !data.rows.every(row => typeof row.messageTraceId === 'string' && typeof row.received === 'string' && typeof row.recipient === 'string' && typeof row.sender === 'string' && typeof row.subject === 'string' && typeof row.status === 'string') ||
        (data.next && (!data.partial || !data.rows.some(row => row.received === data.next?.received && row.recipient.toLowerCase() === data.next?.recipient.toLowerCase()))))
        throw new Error('Microsoft returned an invalid trace page.');
      if (nextPage && data.next && data.next.received === criteria.cursor?.received && data.next.recipient.toLowerCase() === criteria.cursor.recipient.toLowerCase())
        throw new Error('Message trace did not advance. Narrow the dates or filters.');
      const seen = new Set(this.traceRows.map(row => `${row.messageTraceId}|${row.recipient.toLowerCase()}|${row.received}`));
      for (const row of data.rows) {
        const key = `${row.messageTraceId}|${row.recipient.toLowerCase()}|${row.received}`;
        if (!seen.has(key)) { this.traceRows.push(row); seen.add(key); }
      }
      this.traceNext = data.next;
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && request === this.traceRequest)
        this.traceError = error instanceof Error ? error.message : 'Message trace could not be loaded.';
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.traceRequest) { this.traceLoading = false; this.render(); }
    }
  }
  private async showTraceDetail(index: number): Promise<void> {
    const row = this.traceRows[index];
    if (!row || this.quarantineBusy) return;
    this.traceSelected = row; this.traceExpanded = false;
    this.quarantineRequest++; this.quarantineBusy=false; this.quarantineRow=null; this.quarantineMatch=null;  this.quarantineMessage='';
    const generation = this.generation, context = this.contextValue, request = ++this.traceRequest;
    this.traceDetailLoading = true; this.traceDetail = null; this.traceError = ''; this.render();
    this.root.querySelector<HTMLElement>('#trace-drawer-close')?.focus();
    if (row.status === 'Quarantined') void this.lookupQuarantine(index);
    try {
      const data = await this.request<TraceDetail>(this.path('/administration'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'trace.detail', messageTraceId: row.messageTraceId, recipient: row.recipient }),
      });
      if (generation !== this.generation || context !== this.contextValue || request !== this.traceRequest) return;
      if (!data || data.messageTraceId !== row.messageTraceId || data.recipient.toLowerCase() !== row.recipient.toLowerCase() || !Array.isArray(data.events))
        throw new Error('Microsoft returned invalid delivery events.');
      this.traceDetail = data;
    } catch (error) {
      if (generation === this.generation && context === this.contextValue && request === this.traceRequest)
        this.traceError = error instanceof Error ? error.message : 'Delivery events could not be loaded.';
    } finally {
      if (generation === this.generation && context === this.contextValue && request === this.traceRequest) { this.traceDetailLoading = false; this.render(); }
    }
  }
  private exportTrace(): void {
    if (!this.traceRows.length) return;
    const cell = (value: string) => `"${(/^[\s\u0000-\u001f]*[=+\-@]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
    const lines = [['Received', 'Sender', 'Recipient', 'Subject', 'Status', 'Message trace ID'],
      ...this.traceRows.map(row => [row.received, row.sender, row.recipient, row.subject, row.status, row.messageTraceId])];
    const url = URL.createObjectURL(new Blob([lines.map(line => line.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'message-trace-loaded-results.csv'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private async lookupQuarantine(index: number): Promise<void> {
    const row=this.traceRows[index]; if(!row || this.quarantineBusy) return;
    this.quarantineRow=row; this.quarantineMatch=null; this.quarantineMessage='';
    await this.quarantineAction(false);
  }
  private async quarantineAction(release: boolean): Promise<void> {
    const row=this.quarantineRow, match=this.quarantineMatch;
    if(!row || this.quarantineBusy || (release && (!match || match.released || !this.connection?.canManage))) return;
    const generation=this.generation, context=this.contextValue, request=++this.quarantineRequest;
    this.quarantineBusy=true; this.render();
    try {
      const result=await this.request<{match: typeof match;accepted?:boolean;verified?:boolean}>(this.path('/administration'), {
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:release?'quarantine.release.set':'quarantine.lookup',messageTraceId:row.messageTraceId,recipient:row.recipient,received:row.received,...(release?{identity:match!.identity}:{})}),
      });
      if(generation!==this.generation || context!==this.contextValue || request!==this.quarantineRequest) return;
      this.quarantineMatch=release && !result.verified ? null : result.match;
      this.quarantineMessage=release ? result.verified ? 'Release verified for this recipient.' : 'Release submitted; check quarantine status before retrying.' : result.match ? result.match.released ? 'Already released for this recipient.' : '' : 'No unique retained quarantine message matched this trace entry.';
    } catch(error) {
      if(generation!==this.generation || context!==this.contextValue || request!==this.quarantineRequest) return;
      this.quarantineMatch=null;
      this.quarantineMessage=release ? 'Release was not confirmed. Look up the current status before trying again.' : error instanceof Error ? error.message : 'Quarantine lookup failed.';
    } finally { if(generation===this.generation && context===this.contextValue && request===this.quarantineRequest) {this.quarantineBusy=false;this.render();} }
  }
  private closeTraceDrawer(): void {
    const index=this.traceRows.indexOf(this.traceSelected!);
    this.traceRequest++; this.quarantineRequest++; this.traceSelected=null; this.traceDetail=null;
    this.traceDetailLoading=false; this.quarantineBusy=false; this.quarantineRow=null; this.quarantineMatch=null;
    this.render(); this.root.querySelector<HTMLElement>(`[data-trace-detail="${index}"]`)?.focus();
  }
  private renderTraceDrawer(): string {
    const row=this.traceSelected; if(!row) return '';
    const descriptions: Record<string,string>={Delivered:'Microsoft reports that this message was delivered.',Quarantined:'Microsoft placed this message in quarantine. Review the delivery events and quarantine status before releasing it.',Failed:'Microsoft reports that delivery failed. The events below may explain why.',Pending:'Microsoft reports that delivery is pending.',FilteredAsSpam:'Microsoft identified this message as spam. Review its delivery events for the action taken.'};
    const events=this.traceDetail?.events ?? [];
    const quarantine=row.status==='Quarantined' ? `<section class="drawer-section"><h3>Quarantine</h3>${this.quarantineBusy?'<p role="status">Checking quarantine…</p>':''}${this.quarantineMessage?`<p role="status">${esc(this.quarantineMessage)}</p>`:''}${this.quarantineMatch?`<p class="meta">${this.quarantineMatch.released?'Already released':'Matched quarantined message'} for ${esc(row.recipient)}</p>`:''}${this.quarantineMatch && !this.quarantineMatch.released && this.connection?.canManage ? `<button id="quarantine-release" ${this.quarantineBusy?'disabled':''}>Release message</button>`:''}${!this.quarantineBusy?'<button class="secondary compact" id="quarantine-refresh">Refresh quarantine status</button>':''}</section>`:'';
    return `<div class="backdrop" data-trace-backdrop><aside class="drawer trace-drawer ${this.traceExpanded?'trace-expanded':''}" role="dialog" aria-modal="true" aria-labelledby="trace-message-title"><header class="drawer-heading"><div><p class="eyebrow">Message details</p><h2 id="trace-message-title">${esc(row.subject||'(No subject)')}</h2></div><div class="actions"><button class="secondary compact" id="trace-drawer-expand">${this.traceExpanded?'Collapse':'Expand'}</button><button class="secondary compact" id="trace-drawer-close">Close</button></div></header><div class="drawer-body"><dl class="trace-summary"><div><dt>Sender</dt><dd>${esc(row.sender)}</dd></div><div><dt>Recipient</dt><dd>${esc(row.recipient)}</dd></div><div><dt>Received</dt><dd>${esc(this.formatCheckedAt(row.received))}</dd></div><div><dt>Status</dt><dd><span class="badge">${esc(row.status)}</span></dd></div></dl><section class="drawer-section"><h3>Delivery status</h3><p>${esc(descriptions[row.status]||`Microsoft reports: ${row.status}.`)}</p></section>${quarantine}<section class="drawer-section"><div class="heading"><h3>Message events</h3><button class="secondary compact" id="trace-events-refresh" ${this.traceDetailLoading?'disabled':''}>Refresh events</button></div>${this.traceDetailLoading?'<p role="status">Loading delivery events…</p>':this.traceError?`<p role="alert">${esc(this.traceError)}</p>`:events.map(event=>`<details class="trace-event"><summary><span>${esc(event.date?this.formatCheckedAt(event.date):'Time unavailable')}</span><strong>${esc(event.event)}</strong></summary><p>${esc(event.detail||'No additional detail returned.')}</p></details>`).join('')||'<p class="meta">No delivery events returned.</p>'}${this.traceDetail?.partial?'<p class="meta">Only the first 1,000 events are shown.</p>':''}</section><section class="drawer-section"><h3>Message identifiers</h3><dl><div><dt>Trace ID</dt><dd>${esc(row.messageTraceId)}</dd></div>${this.quarantineMatch?`<div><dt>Internet Message-ID</dt><dd>${esc(this.quarantineMatch.messageId)}</dd></div>`:''}</dl><p class="meta">Message trace does not include the email body or attachments.</p></section></div></aside></div>`;
  }
  private renderTrace(): string {
    const traceColumns = ['Received', 'Sender', 'Recipient', 'Subject', 'Status', 'Actions'];
    const defaults = [170, 230, 230, 360, 150, 100];
    const widths = traceColumns.map((_, index) => this.traceWidths[`trace-${index}`] ?? defaults[index]);
    const rows = this.traceRows.map((row, index) => `<tr><td>${esc(this.formatCheckedAt(row.received))}</td><td>${esc(row.sender)}</td><td>${esc(row.recipient)}</td><td><button class="trace-subject" data-trace-detail="${index}">${esc(row.subject || '(No subject)')}</button></td><td>${esc(row.status)}</td><td><button class="secondary compact" data-trace-detail="${index}">Details</button></td></tr>`).join('');
    const detail = this.traceDetail;
    return `<section class="trace-panel" aria-label="Microsoft message trace"><div class="heading"><div><h2>Message trace</h2><p class="meta">Exchange transport results for this connected tenant.</p></div><button class="secondary compact" id="trace-close">Close</button></div>
      <form id="trace-form" class="trace-form"><label>From<input id="trace-start" type="datetime-local" value="${esc(this.traceDraft.start)}" required></label><label>To<input id="trace-end" type="datetime-local" value="${esc(this.traceDraft.end)}" required></label>
      <label>Sender<input id="trace-sender" type="email" value="${esc(this.traceDraft.sender)}" placeholder="Optional"></label><label>Recipient<input id="trace-recipient" type="email" value="${esc(this.traceDraft.recipient)}" placeholder="Optional"></label>
      <label>Status<select id="trace-status">${['', 'Delivered', 'Failed', 'Pending', 'Quarantined', 'FilteredAsSpam', 'Expanded', 'GettingStatus'].map(value => `<option value="${value}" ${this.traceDraft.status === value ? 'selected' : ''}>${value || 'All statuses'}</option>`).join('')}</select></label><button type="submit" ${this.traceLoading ? 'disabled' : ''}>Search</button></form>
      ${this.traceError ? `<p class="status" data-error="true" role="alert">${esc(this.traceError)}</p>` : ''}<div class="trace-toolbar"><p class="meta">${this.traceLoading ? 'Loading trace…' : `${this.traceRows.length} loaded result${this.traceRows.length === 1 ? '' : 's'}${this.traceNext ? ' · more pages available' : ''}`}</p><button class="secondary compact" id="trace-export" ${!this.traceRows.length ? 'disabled' : ''}>Export loaded CSV</button></div>
      ${this.traceRows.length ? `<div class="table-wrap"><table style="table-layout:fixed;width:${widths.reduce((sum,width)=>sum+width,0)}px"><colgroup>${widths.map(width=>`<col style="width:${width}px">`).join('')}</colgroup><thead><tr>${traceColumns.map((label,index)=>`<th>${label}<span class="column-resize" data-resize="trace-${index}" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize ${label} column" title="Drag to resize; double-click to reset"></span></th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : ''}
      ${this.traceNext ? `<div class="actions"><button class="secondary compact" id="trace-more" ${this.traceLoading || this.traceRows.length >= 5000 ? 'disabled' : ''}>Load next 1,000</button></div><p class="meta">CSV includes only loaded rows. Narrow the search after 5,000 loaded rows.</p>` : ''}

      </section>${this.renderTraceDrawer()}`;
  }

  private render(): void {
    const connection = this.connection;
    const canManage = connection?.canManage === true;
    const canRead = this.canRead();
    const sharedIds = new Set(this.mailboxInventory?.records.filter(row => row.recipientType === 'SharedMailbox').map(row => row.id.toLowerCase()) ?? []);
    const userRows = this.data?.items.filter(row => (this.resource === 'all' || this.resource === 'users')
      && (this.resource === 'all' || !sharedIds.has(row.id.toLowerCase()))
      && (this.resource === 'all' || this.directoryScope === 'exclude' || (this.directoryScope === 'unlicensed' ? row.values.licenseSummary === 'Unlicensed' : row.values.licenseSummary !== 'Unlicensed'))
      && (this.directoryScope === 'exclude' ? this.directoryExclusions.get(row.id) === true : this.directoryExclusions.get(row.id) !== true)) ?? [];
    const groupRows = this.resource === 'all' ? this.allGroups?.items.filter(row => row.values.mailEnabled === true) ?? [] : [];
    const scoped = this.resource === 'all'
      ? [...userRows.map(row => ({ ...row, source: 'user' as const })), ...groupRows.map(row => ({ ...row, source: 'group' as const }))]
        .sort((a, b) => String(a.values.displayName ?? '').localeCompare(String(b.values.displayName ?? '')))
      : this.resource === 'users' ? userRows : this.data?.items ?? [];
    const filtered = scoped.filter(row => JSON.stringify(row.values).toLowerCase().includes(this.filter.toLowerCase()));
    const allColumns = this.directoryColumns();
    const columns = allColumns.filter((column, index) => index === 0 || this.visibleColumns.includes(column.key))
      .sort((a, b) => this.visibleColumns.indexOf(a.key) - this.visibleColumns.indexOf(b.key));
    const sortKey = columns.some(column => column.key === this.sortKey) ? this.sortKey! : columns[0]?.key;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const sortValue = (row: ResourceRow): string | number => {
      if (!sortKey) return '';
      if ((this.resource === 'users' || this.resource === 'all' && row.source === 'user') && (sortKey === 'mailbox' || sortKey === 'archive')) {
        const mailbox = this.mailboxInventory?.records.find(record => record.id.toLowerCase() === row.id.toLowerCase());
        return (sortKey === 'mailbox' ? mailbox?.mailboxBytes : mailbox?.archiveBytes) ?? -1;
      }
      if (this.resource === 'all' && row.source === 'group') return String(sortKey === 'userType' ? 'Groups' : row.values[sortKey] ?? '');
      return String((this.resource === 'users' || this.resource === 'all' && row.source === 'user') ? this.userDirectoryValue(row, sortKey) ?? '' : row.values[sortKey] ?? '');
    };
    filtered.sort((a, b) => {
      const left = sortValue(a), right = sortValue(b);
      const compared = typeof left === 'number' && typeof right === 'number' ? left - right : collator.compare(String(left), String(right));
      return (this.sortDirection === 'desc' ? -compared : compared) || collator.compare(String(a.values.displayName ?? a.id), String(b.values.displayName ?? b.id));
    });
    const loadedCount = this.data ? `${this.resource === 'all' ? scoped.length : this.data.items.length}${this.data.complete ? '' : ' loaded'}` : '—';
    const tenant = connection?.tenantName || 'Microsoft 365 tenant';
    const createControl = canManage && this.resource === 'users' ? '<button class="secondary compact" id="create-user">Add user</button>' : canManage && this.resource === 'groups' ? '<button class="secondary compact" id="create-group">Add group</button>' : '';
    const tabs = `<button data-resource="all" role="tab" aria-selected="${this.resource === 'all'}" class="resource-tab" ${!canRead ? 'disabled' : ''}>All</button><button data-resource="users" role="tab" aria-selected="${this.resource === 'users' && this.directoryScope === 'users'}" class="resource-tab" ${!canRead ? 'disabled' : ''}>Users</button><button data-directory-scope="unlicensed" role="tab" aria-selected="${this.resource === 'users' && this.directoryScope === 'unlicensed'}" class="resource-tab" ${!canRead ? 'disabled' : ''}>Unlicensed</button><button data-resource="shared-mailboxes" role="tab" aria-selected="${this.resource === 'shared-mailboxes'}" class="resource-tab" ${!canRead ? 'disabled' : ''}>Shared mailboxes</button><button data-resource="groups" role="tab" aria-selected="${this.resource === 'groups'}" class="resource-tab" ${!canRead ? 'disabled' : ''}>Groups</button><button data-directory-scope="exclude" role="tab" aria-selected="${this.resource === 'users' && this.directoryScope === 'exclude'}" class="resource-tab" ${!canRead || this.resource !== 'users' ? 'disabled' : ''}>Exclude</button>`;
    const chips = this.data ? `<div class="column-tools"><span>Columns</span>${allColumns.map((column, index) => `<button class="column-chip" data-column="${esc(column.key)}" aria-pressed="${index === 0 || this.visibleColumns.includes(column.key)}" ${index === 0 ? 'disabled' : ''}>${esc(column.label)}</button>`).join('')}<button class="secondary compact" id="reset-columns">Reset</button></div>${this.layoutError ? `<p class="directory-notice" role="status">${esc(this.layoutError)}</p>` : ''}` : '';
    const rows = filtered.map(row => {
      const isUser = this.resource === 'users' || this.resource === 'all' && row.source === 'user';
      const isGroup = this.resource === 'groups' || this.resource === 'all' && row.source === 'group';
      const expanded = this.detail?.id === row.id;
      const cells = columns.map((column, index) => {
        const value = isUser ? this.userDirectoryValue(row, column.key)
          : isGroup && this.resource === 'all' ? column.key === 'userType' ? 'Groups' : '—'
          : row.values[column.key];
        return `<td class="${index === 0 ? 'identity' : ''}" ${this.columnWidths[column.key] ? `style="min-width:${this.columnWidths[column.key]}px;max-width:${this.columnWidths[column.key]}px;width:${this.columnWidths[column.key]}px"` : ''}>${index === 0 ? this.rowIdentity(row, column) : typeof value === 'boolean' ? `<span class="state ${value ? 'on' : ''}">${value ? 'Enabled' : 'Disabled'}</span>` : esc(String(value ?? 'Unavailable'))}</td>`;
      }).join('');
      const sharedMailbox = this.resource === 'shared-mailboxes' || this.mailboxInventory?.records.some(item => item.id.toLowerCase() === row.id.toLowerCase() && item.recipientType === 'SharedMailbox') === true;
      const userAction = (key: string, label: string, disabled = false) => `<button class="secondary compact" data-user-action="${key}" data-user-id="${esc(row.id)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
      const action = sharedMailbox ? `<div class="inline-user-actions" aria-label="Actions for ${esc(String(row.values.displayName ?? row.values.primarySmtpAddress ?? row.id))}">${userAction('addresses', 'Email addresses')}${userAction('delegation', 'Delegation')}${userAction('forwarding', 'Forwarding')}${userAction('autoreply', 'Out of office')}</div>` : isUser ? `<div class="inline-user-actions" aria-label="Actions for ${esc(String(row.values.displayName ?? row.id))}"><button class="secondary compact" data-testid="row-${esc(row.id)}" data-expand="${esc(row.id)}" aria-expanded="${expanded}">${canManage ? 'Account' : 'View account'}</button>${canManage ? `${userAction('addresses', 'Email addresses')}${userAction('licenses', 'Licenses')}${userAction('groups', 'Groups')}${userAction('reset-password', 'Reset password')}${userAction(row.values.accountEnabled === false ? 'restore-sign-in' : 'block-sign-in', row.values.accountEnabled === false ? 'Restore sign-in' : 'Block sign-in')}${userAction('revoke-sessions', 'Sign out sessions')}${userAction('mfa', 'MFA')}` : ''}${userAction('delegation', 'Delegation')}${userAction('forwarding', 'Forwarding')}${userAction('autoreply', 'Out of office')}${canManage ? `${userAction('drive', 'OneDrive')}<button class="secondary compact" data-directory-exclude="${esc(row.id)}" data-excluded="${this.directoryExclusions.get(row.id) !== true}" ${this.busy || !this.directoryExclusionsReady ? 'disabled' : ''}>${this.directoryExclusions.get(row.id) === true ? 'Include user' : 'Exclude user'}</button>` : ''}</div>` : isGroup ? `<div class="inline-user-actions">${[...['account'], ...((!row.values.groupKind || ['Microsoft 365 group', 'Distribution list'].includes(String(row.values.groupKind))) ? ['email', 'members', ...((!row.values.groupKind || row.values.groupKind === 'Microsoft 365 group') ? ['owners'] : [])] : [])].map(panel => `<button class="secondary compact" data-group-action="${panel}" data-group-id="${esc(row.id)}">${({account: 'Details', email: 'Email settings', members: 'Members', owners: 'Owners'} as Record<string,string>)[panel]}</button>`).join('')}</div>` : `<button class="secondary compact" data-testid="row-${esc(row.id)}" data-detail="${esc(row.id)}">View details</button>`;
      return `<tr class="${this.detail?.id === row.id ? 'selected-row' : ''}">${cells}</tr><tr class="inline-actions-row ${this.detail?.id === row.id ? 'selected-row' : ''}"><td colspan="${columns.length}">${action}</td></tr>`;
    }).join('');
    const exclusionUnavailable = this.resource === 'users' && this.directoryScope === 'exclude' && !!this.directoryExclusionError;
    const mailboxNotice = !['users', 'all'].includes(this.resource) || !canRead ? '' : this.mailboxInventory
      ? this.mailboxInventory.partial ? '<p class="directory-notice" role="status">Exchange returned a partial mailbox list. Some shared mailboxes may still appear under Users.</p>' : ''
      : this.mailboxError ? '<p class="directory-notice" role="status">Exchange mailbox data is unavailable. Shared mailboxes may still appear under Users, and mailbox usage cannot be shown. Check Microsoft 365 in Connect.</p>'
        : '<p class="meta" role="status">Checking mailbox types and usage…</p>';
    const inventoryState = !this.data ? '' : this.data.complete && (!['users', 'all', 'shared-mailboxes'].includes(this.resource) || this.mailboxInventory && !this.mailboxInventory.partial)
      ? 'Complete directory' : 'Partial directory';
    const mailboxUsageState = this.mailboxInventory && ['users', 'all', 'shared-mailboxes'].includes(this.resource)
      ? (() => {
        const visible = this.mailboxInventory.records.filter(row => this.resource === 'all'
          || row.recipientType === (this.resource === 'shared-mailboxes' ? 'SharedMailbox' : 'UserMailbox'));
        const failed = visible.filter(row => this.mailboxStatisticsFailed.has(row.id.toLowerCase())).length;
        const pending = visible.filter(row => !this.mailboxStatisticsLoaded.has(row.id.toLowerCase()) && !this.mailboxStatisticsFailed.has(row.id.toLowerCase())).length;
        return ` · Mailbox usage: ${pending ? `${pending} not loaded` : failed ? `${failed} unavailable` : 'loaded'}${pending && failed ? `, ${failed} unavailable` : ''}`;
      })() : '';
    const reportNotice = ['users', 'all', 'shared-mailboxes'].includes(this.resource) && (this.mailboxInventory?.records.length ?? 0) > 200
      ? '<p class="directory-notice" role="status">Mailbox usage is loaded for up to 200 matching accounts at a time. Search for another account to load its usage.</p>' : '';
    const inventory = !canRead ? `<div class="empty">${connection?.connected && connection.enabled === false ? 'Enable this connection before loading inventory.' : 'Connect Microsoft 365 in Extensions > Connect before loading inventory.'}</div>` : !this.data ? `<div class="empty">${this.error ? `Could not load ${labels[this.resource].toLowerCase()}. Use Refresh to try again.` : `Loading current ${labels[this.resource].toLowerCase()}…`}</div>` : exclusionUnavailable ? `<div class="empty">Could not load directory exclusions. Refresh before reviewing excluded users.</div>` : !filtered.length ? `<div class="empty">${this.filter ? 'No rows match this search.' : `No ${labels[this.resource].toLowerCase()} are available for this tenant.`}</div>` : `<div class="table-wrap"><table><thead><tr>${columns.map((column, index) => `<th data-header="${esc(column.key)}" draggable="${index > 0}" ${this.columnWidths[column.key] ? `style="min-width:${this.columnWidths[column.key]}px;max-width:${this.columnWidths[column.key]}px;width:${this.columnWidths[column.key]}px"` : ''} aria-sort="${sortKey === column.key ? this.sortDirection === 'asc' ? 'ascending' : 'descending' : 'none'}"><button class="table-sort" data-sort="${esc(column.key)}">${esc(column.label)}${sortKey === column.key ? `<span aria-hidden="true"> ${this.sortDirection === 'asc' ? '↑' : '↓'}</span>` : ''}</button><span class="column-resize" data-resize="${esc(column.key)}" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize ${esc(column.label)} column" title="Drag to resize; double-click to reset"></span></th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
    this.root.innerHTML = `<style>${styles}${membershipStyles}${createUserStyles}${healthStyles}${traceStyles}${visualStyles}${traceDrawerStyles}</style><main><header><div><p class="eyebrow">Microsoft 365</p><h1>${this.traceOpen ? 'Message trace' : this.healthOpen ? 'Service health' : 'Directory'}</h1><p class="subtle">${esc(tenant)}${!this.traceOpen && !this.healthOpen ? ` · ${labels[this.resource]}: ${loadedCount}` : ''}</p></div><div class="header-actions"><nav class="module-nav" aria-label="Microsoft 365 areas"><button class="secondary compact" id="directory-open" aria-pressed="${!this.traceOpen && !this.healthOpen}">Directory</button><button class="secondary compact" id="trace-open" aria-pressed="${this.traceOpen}" ${!canRead ? 'disabled' : ''}>Message trace</button><button class="secondary compact" id="health-open" aria-pressed="${this.healthOpen}" ${!canRead ? 'disabled' : ''}>Service health</button></nav><span class="badge ${canRead ? 'ok' : ''}">${connection?.available === false ? 'Unavailable' : connection?.connected ? (connection.enabled === false ? 'Disabled' : 'Connected') : 'Not configured'}</span></div></header>${this.traceOpen && canRead ? this.renderTrace() : ''}${this.healthOpen && canRead ? this.renderHealth() : ''}${!this.traceOpen && !this.healthOpen ? `${this.message ? `<p class="status" data-testid="status" data-error="${this.error}" aria-live="polite">${esc(this.message)}</p>` : '<p class="status" data-testid="status" aria-live="polite"></p>'}<section class="directory"><div class="directory-actions">${createControl}</div><div class="directory-top">${canRead ? `<label class="filter"><span class="sr-only">Search ${labels[this.resource]}</span><input id="filter" data-testid="filter" value="${esc(this.filter)}" placeholder="${this.resource === 'users' ? 'Search name or email' : `Search ${labels[this.resource].toLowerCase()}`}"></label>` : ''}<nav class="resource-nav" role="tablist" aria-label="Microsoft directory resources">${tabs}</nav><button class="secondary compact" id="refresh-resource" ${!canRead ? 'disabled' : ''}>Refresh</button></div>${canRead ? `${chips}${mailboxNotice}${reportNotice}${this.data ? `<p class="meta">${inventoryState}${mailboxUsageState} · checked ${esc(this.formatCheckedAt(this.data.checkedAt))}</p>` : ''}${inventory}` : inventory}</section>` : ''}${this.detail ? this.renderDrawer(canManage) : ''}${this.createUserOpen ? this.renderCreateUserDrawer() : ''}${this.createGroupOpen ? this.renderCreateGroupDrawer() : ''}</main>`;
    const activeSection = ['delegation', 'forwarding', 'autoreply'].includes(this.accountPanel) ? 'mailbox' : this.accountPanel;
    this.root.querySelectorAll<HTMLElement>('.account-panel > .drawer-section').forEach(section => {
      section.hidden = !section.classList.contains(`section-${activeSection}`);
    });
    this.root.querySelectorAll<HTMLElement>('.account-panel .section-mailbox > div').forEach(section => {
      section.hidden = !section.classList.contains(`mailbox-${this.accountPanel}`);
    });
    this.root.querySelector('#directory-open')?.addEventListener('click', () => {  this.traceOpen = false; this.healthOpen = false; this.traceRequest += 1; this.traceLoading = false; this.traceDetailLoading = false; this.render(); });
    this.root.querySelector('#trace-open')?.addEventListener('click', () => {
      if (this.traceOpen) return;
      this.traceOpen = true; this.healthOpen = false; this.traceRequest += 1;
      this.traceLoading = false; this.traceDetailLoading = false; this.traceDetail = null;
      if (this.traceOpen && !this.traceDraft.start) {
        const local = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        this.traceDraft.start = local(new Date(Date.now() - 86400000)); this.traceDraft.end = local(new Date());
      }
      this.render();
    });
    this.root.querySelector('#trace-close')?.addEventListener('click', () => {  this.traceRequest += 1; this.traceOpen = false; this.traceLoading = false; this.traceDetailLoading = false; this.traceDetail = null; this.render(); });
    for (const key of ['start', 'end', 'sender', 'recipient', 'status'] as const)
      this.root.querySelector<HTMLInputElement | HTMLSelectElement>(`#trace-${key}`)?.addEventListener('input', event => { this.traceDraft[key] = (event.target as HTMLInputElement | HTMLSelectElement).value; });
    this.root.querySelector('#trace-form')?.addEventListener('submit', event => { event.preventDefault(); void this.searchTrace(); });
    this.root.querySelector('#trace-more')?.addEventListener('click', () => void this.searchTrace(true));
    this.root.querySelector('#trace-export')?.addEventListener('click', () => this.exportTrace());
    this.root.querySelector('#trace-drawer-close')?.addEventListener('click',()=>this.closeTraceDrawer());
    this.root.querySelector('[data-trace-backdrop]')?.addEventListener('click',event=>{if(event.target===event.currentTarget)this.closeTraceDrawer();});
    this.root.querySelector('#trace-drawer-expand')?.addEventListener('click',()=>{this.traceExpanded=!this.traceExpanded;this.render();});
    this.root.querySelector('#trace-events-refresh')?.addEventListener('click',()=>void this.showTraceDetail(this.traceRows.indexOf(this.traceSelected!)));
    this.root.querySelector('#quarantine-refresh')?.addEventListener('click',()=>void this.lookupQuarantine(this.traceRows.indexOf(this.traceSelected!)));
    this.root.querySelector('#quarantine-release')?.addEventListener('click',()=>void this.quarantineAction(true));
    this.root.querySelector('#trace-detail-close')?.addEventListener('click', () => { this.traceRequest += 1; this.traceDetail = null; this.render(); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-trace-detail]').forEach(button => button.addEventListener('click', () => void this.showTraceDetail(Number(button.dataset.traceDetail))));
    this.root.querySelector('#create-user-password-mode')?.addEventListener('change', event => {
      this.createUserPasswordMode = (event.target as HTMLSelectElement).value;
      this.createUserPassword = ''; this.render();
    });
    this.root.querySelector('#create-user-password')?.addEventListener('input', event => { this.createUserPassword = (event.target as HTMLInputElement).value; });
    this.root.querySelector('#create-user-force-change')?.addEventListener('change', event => { this.createUserForceChange = (event.target as HTMLInputElement).checked; });
    this.root.querySelector('#create-user-groups-retry')?.addEventListener('click', () => void this.loadCreateUserGroups());
    this.root.querySelector<HTMLSelectElement>('#create-user-group')?.addEventListener('change', event => {
      const id = (event.target as HTMLSelectElement).value;
      if (!this.createUserBusy && this.createUserGroups?.some(group => group.id === id) && !this.createUserGroupIds.includes(id)) { this.createUserGroupIds.push(id); this.render(); }
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-create-group-remove]').forEach(button => button.addEventListener('click', () => {
      if (!this.createUserBusy) { this.createUserGroupIds = this.createUserGroupIds.filter(id => id !== button.dataset.createGroupRemove); this.render(); }
    }));
    this.root.querySelector('#create-group')?.addEventListener('click', () => this.openCreateGroup());
    this.root.querySelector('#create-group-close')?.addEventListener('click', () => { if (!this.createGroupBusy) { this.createGroupOpen = false; this.createGroupRequest += 1; this.createdGroup = null; this.render(); } });
    this.root.querySelector('#create-group-submit')?.addEventListener('click', () => void this.createGroup());
    this.root.querySelector('#create-group-owners-retry')?.addEventListener('click', () => void this.loadCreateGroupOwners());
    for (const [id, field] of [['create-group-name', 'name'], ['create-group-alias', 'alias'], ['create-group-owner', 'ownerId'], ['create-group-address', 'primarySmtpAddress']] as const)
      this.root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.addEventListener('input', event => { this.createGroupDraft[field] = (event.target as HTMLInputElement | HTMLSelectElement).value; });
    this.root.querySelector<HTMLSelectElement>('#create-group-kind')?.addEventListener('change', event => {
      this.createGroupDraft.kind = (event.target as HTMLSelectElement).value;
      this.createGroupError = '';
      this.render();
      if (this.createGroupDraft.kind === 'm365' && !this.createGroupUsers) void this.loadCreateGroupOwners();
    });
    this.root.querySelector('#group-name')?.addEventListener('input', event => {
      this.groupNameDraft = (event.target as HTMLInputElement).value;
      const save = this.root.querySelector<HTMLButtonElement>('#group-name-save');
      if (save) save.disabled = !this.groupNameDraft.trim() || this.groupNameDraft.trim() === String(this.detailRecord?.displayName ?? '');
    });
    this.root.querySelector('#group-name-save')?.addEventListener('click', () => void this.saveGroupName());
    this.root.querySelector('#health-open')?.addEventListener('click', () => { if (this.healthOpen) return;  this.healthOpen = true; this.traceOpen = false; this.traceRequest += 1; this.traceLoading = false; this.traceDetailLoading = false; this.render(); if (!this.health) void this.loadHealth(); });
    this.root.querySelector('#health-close')?.addEventListener('click', () => { this.healthOpen = false; this.render(); });
    this.root.querySelector('#health-refresh')?.addEventListener('click', () => void this.loadHealth());
    this.root.querySelector('#refresh-resource')?.addEventListener('click', () => void this.refreshDirectory());
    this.root.querySelector('#create-user')?.addEventListener('click', () => this.openCreateUser());
    this.root.querySelector('#create-user-close')?.addEventListener('click', () => this.closeCreateUser());
    this.root.querySelector('#create-user-submit')?.addEventListener('click', () => void this.createUser());
    this.root.querySelector('#create-user-licenses-retry')?.addEventListener('click', () => { this.createUserLicenses = null; this.createLicenseCatalogError = ''; this.render(); void this.loadCreateUserLicenses(); });
    this.root.querySelector('#create-user-domains-retry')?.addEventListener('click', () => { this.createUserDomains = null; this.createUserError = ''; this.render(); void this.loadCreateUserDomains(); });
    for (const [id, field] of [['create-user-name', 'name'], ['create-user-local', 'local'], ['create-user-domain', 'domain'], ['create-user-license', 'skuId']] as const) {
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
    this.root.querySelectorAll<HTMLButtonElement>('[data-directory-scope]').forEach(button => button.addEventListener('click', () => this.setDirectoryScope(button.dataset.directoryScope as 'exclude' | 'unlicensed')));
    this.root.querySelectorAll<HTMLButtonElement>('[data-column]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.column!;
      this.updateVisibleColumns(key);
      queueMicrotask(() => Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-column]')).find(next => next.dataset.column === key)?.focus());
    }));
    this.root.querySelectorAll<HTMLElement>('[data-header]').forEach(header => {
      header.addEventListener('dragstart', event => {
        if ((event.target as HTMLElement).closest('[data-resize]')) { event.preventDefault(); return; }
        event.dataTransfer?.setData('text/plain', header.dataset.header!);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      header.addEventListener('dragover', event => {
        if (header.dataset.header === this.directoryColumns()[0]?.key) return;
        event.preventDefault(); header.classList.add('column-drop');
      });
      header.addEventListener('dragleave', () => header.classList.remove('column-drop'));
      header.addEventListener('drop', event => {
        event.preventDefault(); header.classList.remove('column-drop');
        const key = event.dataTransfer?.getData('text/plain');
        const from = this.visibleColumns.indexOf(key ?? '');
        const to = this.visibleColumns.indexOf(header.dataset.header!);
        if (from <= 0 || to <= 0 || from === to) return;
        this.visibleColumns.splice(from, 1); this.visibleColumns.splice(to, 0, key!);
        this.layoutEditVersion++; this.saveDirectoryLayout(); this.render();
      });
      header.addEventListener('keydown', event => {
        if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key) || (event.target as HTMLElement).closest('[data-resize]')) return;
        event.preventDefault(); this.moveColumn(header.dataset.header!, event.key === 'ArrowLeft' ? -1 : 1);
      });
    });
    this.root.querySelectorAll<HTMLElement>('[data-resize]').forEach(handle => {
      const key = handle.dataset.resize!;
      const isTrace = key.startsWith('trace-');
      const widths = isTrace ? this.traceWidths : this.columnWidths;
      const commit = (width?: number) => {
        if (width === undefined) delete widths[key];
        else widths[key] = Math.max(80, Math.min(800, Math.round(width)));
        if (!isTrace) { this.layoutEditVersion++; this.saveDirectoryLayout(); } this.render();
      };
      handle.addEventListener('click', event => event.stopPropagation());
      handle.addEventListener('dblclick', () => commit());
      handle.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const width = widths[key] ?? handle.parentElement!.getBoundingClientRect().width;
        commit(event.key === 'Home' ? undefined : width + (event.key === 'ArrowRight' ? 10 : -10));
        this.root.querySelector<HTMLElement>(`[data-resize="${key}"]`)?.focus();
      });
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const header = handle.parentElement as HTMLTableCellElement;
        const table = header.closest('table')!;
        const start = event.clientX; const initial = header.getBoundingClientRect().width;
        let width = initial;
        handle.setPointerCapture?.(event.pointerId);
        const move = (next: PointerEvent) => {
          width = Math.max(80, Math.min(800, Math.round(initial + next.clientX - start)));
          if (isTrace) { const col = table.querySelectorAll('col')[header.cellIndex] as HTMLElement; if(col) col.style.width = `${width}px`; table.style.width = `${Array.from(table.querySelectorAll('col')).reduce((sum,col)=>sum+parseFloat((col as HTMLElement).style.width),0)}px`; }
          table.querySelectorAll('tr').forEach(row => {
            const cell = row.children[header.cellIndex] as HTMLElement | undefined;
            if (cell && !cell.hasAttribute('colspan')) { cell.style.width = `${width}px`; cell.style.minWidth = `${width}px`; cell.style.maxWidth = `${width}px`; }
          });
        };
        const finish = (next: PointerEvent) => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', cancel);
          if (handle.hasPointerCapture?.(next.pointerId)) handle.releasePointerCapture(next.pointerId);
          if (Math.abs(next.clientX - start) > 2) commit(width);
        };
        const cancel = () => {
          handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish);
          handle.removeEventListener('pointercancel', cancel); this.render();
        };
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', cancel);
      });
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-sort]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.sort!;
      if (this.sortKey === key) this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
      else { this.sortKey = key; this.sortDirection = 'asc'; }
      this.layoutEditVersion += 1;
      this.saveDirectoryLayout();
      this.render();
      this.root.querySelector<HTMLButtonElement>(`[data-sort="${key}"]`)?.focus();
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
      this.mailboxStatisticsRequest += 1;
      this.mailboxStatisticsLoading = false;
      this.mailboxStatisticsTargets.clear();
      this.render();
      this.startMailboxStatistics();
      queueMicrotask(() => {
        const next = this.root.querySelector<HTMLInputElement>('#filter');
        next?.focus();
        if (start !== null && end !== null) next?.setSelectionRange(start, end);
      });
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-user-action]').forEach(button => button.addEventListener('click', () => {
      const row = this.data?.items.find(item => item.id === button.dataset.userId);
      if (!row) return;
      const action = button.dataset.userAction!;
      if (action === 'mfa') { this.openMfa(row); return; }
      const security = ['reset-password', 'block-sign-in', 'restore-sign-in', 'revoke-sessions'].includes(action) ? action as UserSecurityAction : null;
      this.openDetail({ ...row, source: 'user' }, security, action);
      if (action === 'addresses' && !this.addressesOpen) this.openAddresses();
      if (action === 'groups') void this.openUserGroups();
      if (action === 'licenses') { this.licensesOpen = true; void this.loadUserLicenses(); }
      if (action === 'delegation') this.openDelegation();
      if (action === 'forwarding') this.openForwarding();
      if (action === 'autoreply') this.openAutoReply();
      if (action === 'drive') void this.showDriveLink();
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-expand]').forEach(button => button.addEventListener('click', () => {
      const row = this.data?.items.find(item => item.id === button.dataset.expand);
      if (row) this.openDetail({ ...row, source: 'user' });
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-group-action]').forEach(button => button.addEventListener('click', () => {
      const row = this.data?.items.find(item => item.id === button.dataset.groupId) ?? this.allGroups?.items.find(item => item.id === button.dataset.groupId);
      if (!row) return;
      this.openDetail({ ...row, source: 'group' }, null, button.dataset.groupAction!);
      this.membershipRole = button.dataset.groupAction === 'owners' ? 'owner' : 'member';
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-group-person-remove]').forEach(button => button.addEventListener('click', () => {
      const role = button.dataset.groupPersonRole === 'owner' ? 'owner' : 'member';
      const id = button.dataset.groupPersonRemove!;
      const people = this.groupPeople;
      if (!this.connection?.canManage || this.busy || this.membershipNeedsRefresh || !people?.complete ||
        !(role === 'owner' ? people.owners : people.members).some(person => person.id === id) || role === 'owner' && people.owners.length <= 1) return;
      this.membershipUserId = id; this.membershipRole = role; this.membershipAction = 'remove';
      this.render();
      this.root.querySelector<HTMLButtonElement>('#group-member-submit')?.focus();
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-detail]').forEach((button) =>
      button.addEventListener('click', () => {
        const user = this.data?.items.find(item => item.id === button.dataset.detail);
        const group = this.resource === 'all' ? this.allGroups?.items.find(item => item.id === button.dataset.detail && item.values.mailEnabled === true) : undefined;
        const row = user ? { ...user, source: 'user' as const } : group ? { ...group, source: 'group' as const } : undefined;
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
    this.root.querySelector('#account-back')?.addEventListener('click', () => { if (this.detail) this.openDetail(this.detail); });
    this.root.querySelector('#detail-close')?.addEventListener('click', () => this.closeDetail());
    this.root.querySelector('#detail-retry')?.addEventListener('click', () => { if (!this.detail || this.detailKind === 'read') return; this.drawerError = false; this.drawerMessage = ''; this.render(); void this.loadDetailRecord(this.detail.id, this.detailKind); });
    this.root.querySelector('#global-admin-retry')?.addEventListener('click', () => { if (!this.detail || this.busy) return; this.globalAdminLoading = true; this.render(); void this.loadGlobalAdminStatus(this.detail.id); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-row-add-group]').forEach(button => button.addEventListener('click', () => {
      const row = this.data?.items.find(item => item.id === button.dataset.rowAddGroup);
      if (row) { this.openDetail(row); void this.openUserGroups(); }
    }));
    this.root.querySelector('#user-group-open')?.addEventListener('click', () => void this.openUserGroups());
    this.root.querySelector('#user-group-refresh')?.addEventListener('click', () => void this.openUserGroups());
    this.root.querySelectorAll<HTMLButtonElement>('[data-user-group-remove]').forEach(button => button.addEventListener('click', () => {
      this.userGroupRemoveId = button.dataset.userGroupRemove!; this.userGroupSelectedId = ''; this.render();
    }));
    this.root.querySelector('#user-group-close')?.addEventListener('click', () => {
      this.userGroupRequest += 1; this.userGroupOpen = false; this.userGroups = null;
      this.userGroupSelectedId = ''; this.userGroupNeedsRefresh = false; this.render();
    });
    this.root.querySelector<HTMLSelectElement>('#user-group-select')?.addEventListener('change', event => {
      this.userGroupRemoveId = ''; this.userGroupSelectedId = (event.target as HTMLSelectElement).value; this.render();
    });
    this.root.querySelector('#user-group-submit')?.addEventListener('click', () => void this.addUserToGroup());
    this.root.querySelector('#licenses-open')?.addEventListener('click', () => { this.licensesOpen = true; void this.loadUserLicenses(); });
    this.root.querySelector('#licenses-close')?.addEventListener('click', () => { this.licensesRequest += 1; this.licensesOpen = false; this.licenseRemovalSku = ''; this.render(); });
    this.root.querySelector('#licenses-refresh')?.addEventListener('click', () => void this.loadUserLicenses());
    this.root.querySelectorAll<HTMLButtonElement>('[data-license-remove]').forEach(button => button.addEventListener('click', () => {
      this.licenseRemovalSku = button.dataset.licenseRemove ?? ''; this.licenseConfirmation = ''; this.render();
    }));
    this.root.querySelector<HTMLInputElement>('#license-confirmation')?.addEventListener('input', event => {
      this.licenseConfirmation = (event.target as HTMLInputElement).value;
    });
    this.root.querySelector('#license-cancel')?.addEventListener('click', () => { this.licenseRemovalSku = ''; this.licenseConfirmation = ''; this.render(); });
    this.root.querySelector('#license-submit')?.addEventListener('click', () => void this.removeUserLicense());
    this.root.querySelector<HTMLSelectElement>('#license-assign-sku')?.addEventListener('change', event => {
      this.licenseAssignSku = (event.target as HTMLSelectElement).value; this.render();
    });
    this.root.querySelector('#license-assign')?.addEventListener('click', () => void this.assignUserLicense());
    this.root.querySelectorAll<HTMLButtonElement>('[data-row-delegation]').forEach(button => button.addEventListener('click', () => {
      const row = this.data?.items.find(item => item.id === button.dataset.rowDelegation);
      if (row) { this.openDetail(row); this.openDelegation(); }
    }));
    this.root.querySelector('#delegation-open')?.addEventListener('click', () => this.openDelegation());
    this.root.querySelector('#delegation-close')?.addEventListener('click', () => { this.resetDelegation(); this.render(); });
    this.root.querySelector('#delegation-refresh')?.addEventListener('click', () => void this.loadDelegation());
    this.root.querySelector('#delegation-list-refresh')?.addEventListener('click', () => void this.loadDelegationList());
    this.root.querySelector<HTMLSelectElement>('#delegation-user')?.addEventListener('change', event => {
      this.delegationSelectedId = (event.target as HTMLSelectElement).value; this.delegationRemoveRight = '';
      this.delegation = null; this.delegationError = ''; this.delegationMessage = ''; this.delegationNeedsRefresh = false;
      this.render();
      if (this.delegationSelectedId) void this.loadDelegation();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-delegate-remove]').forEach(button => button.addEventListener('click', () => {
      if (this.delegationLoading || this.delegationNeedsRefresh || this.delegationList?.partial) return;
      this.delegationSelectedId = button.dataset.delegateRemove!;
      this.delegationRemoveRight = button.dataset.removeRight!;

      void this.loadDelegation();
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-delegation-right]').forEach(button => button.addEventListener('click', () => {
      const right = button.dataset.delegationRight;
      if (right === 'FullAccess' || right === 'SendAs' || right === 'SendOnBehalf') void this.setDelegation(right, button.dataset.delegationEnabled === 'true');
    }));
    this.root.querySelector('#addresses-open')?.addEventListener('click', () => this.openAddresses());
    this.root.querySelector('#addresses-close')?.addEventListener('click', () => { this.resetAddresses(); this.render(); });
    this.root.querySelector('#addresses-refresh')?.addEventListener('click', () => void this.loadAddresses());
    this.root.querySelector<HTMLInputElement>('#addresses-primary')?.addEventListener('input', event => {
      this.primaryDraft = (event.target as HTMLInputElement).value;
      const save = this.root.querySelector<HTMLButtonElement>('#addresses-primary-save');
      if (save && this.addresses) save.disabled = !this.primaryDraft.trim() || this.primaryDraft.toLowerCase() === this.addresses.primarySmtpAddress.toLowerCase();
    });
    this.root.querySelector<HTMLInputElement>('#addresses-alias')?.addEventListener('input', event => {
      this.aliasDraft = (event.target as HTMLInputElement).value;
      const add = this.root.querySelector<HTMLButtonElement>('#addresses-alias-add');
      if (add) add.disabled = !this.aliasDraft.trim();
    });
    this.root.querySelector('#addresses-primary-save')?.addEventListener('click', () => void this.writeAddress('mailbox.primary.set'));
    this.root.querySelector('#addresses-alias-add')?.addEventListener('click', () => void this.writeAddress('mailbox.alias.add'));
    this.root.querySelectorAll<HTMLButtonElement>('[data-alias-remove]').forEach(button => button.addEventListener('click', () => {
      if (button.dataset.aliasRemove) void this.writeAddress('mailbox.alias.remove', button.dataset.aliasRemove);
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-row-forwarding]').forEach(button => button.addEventListener('click', () => {
      const row = this.data?.items.find(item => item.id === button.dataset.rowForwarding);
      if (row) { this.openDetail(row); this.openForwarding(); }
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-row-autoreply]').forEach(button => button.addEventListener('click', () => {
      const row = this.data?.items.find(item => item.id === button.dataset.rowAutoreply);
      if (row) { this.openDetail(row); this.openAutoReply(); }
    }));
    this.root.querySelector('#autoreply-open')?.addEventListener('click', () => this.openAutoReply());
    this.root.querySelector('#autoreply-close')?.addEventListener('click', () => { this.resetAutoReply(); this.render(); });
    this.root.querySelector('#autoreply-refresh')?.addEventListener('click', () => void this.loadAutoReply());
    this.root.querySelector<HTMLSelectElement>('#autoreply-state')?.addEventListener('change', event => {
      this.autoReplyDraft.state = (event.target as HTMLSelectElement).value as AutoReplyState['state']; this.render();
    });
    this.root.querySelector<HTMLSelectElement>('#autoreply-audience')?.addEventListener('change', event => { this.autoReplyDraft.externalAudience = (event.target as HTMLSelectElement).value as AutoReplyState['externalAudience']; });
    for (const [selector, field] of [['#autoreply-start', 'start'], ['#autoreply-end', 'end'], ['#autoreply-message', 'message'], ['#autoreply-external-message', 'externalMessage']] as const) {
      this.root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.addEventListener('input', event => {
        this.autoReplyDraft[field] = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
      });
    }
    this.root.querySelector('#autoreply-save')?.addEventListener('click', () => void this.saveAutoReply());
    this.root.querySelector('#forwarding-open')?.addEventListener('click', () => this.openForwarding());
    this.root.querySelector('#forwarding-close')?.addEventListener('click', () => { this.forwardingRequest += 1; this.forwardingOpen = false; this.forwarding = null; this.render(); });
    this.root.querySelector('#forwarding-refresh')?.addEventListener('click', () => void this.loadForwarding());
    this.root.querySelector<HTMLInputElement>('#forwarding-address')?.addEventListener('input', event => { this.forwardingAddress = (event.target as HTMLInputElement).value; });
    this.root.querySelector<HTMLInputElement>('#forwarding-keep-copy')?.addEventListener('change', event => { this.forwardingKeepCopy = (event.target as HTMLInputElement).checked; });
    this.root.querySelector('#forwarding-save')?.addEventListener('click', () => void this.saveForwarding());
    this.root.querySelector('#forwarding-off')?.addEventListener('click', () => void this.saveForwarding(true));
    this.root.querySelectorAll<HTMLButtonElement>('[data-user-save]').forEach(button => button.addEventListener('click', () => {
      const field = button.dataset.userSave as (typeof USER_FIELDS)[number] | 'accountEnabled';
      void this.saveUserField(field);
    }));
    this.root.querySelector('#user-password-reset-start')?.addEventListener('click', () => { this.userSecurityAction = 'reset-password'; this.temporaryPassword = null; this.drawerError = false; this.drawerMessage = ''; this.render(); this.root.querySelector<HTMLButtonElement>('#user-security-submit')?.focus(); });
    this.root.querySelector('#user-sessions-revoke-start')?.addEventListener('click', () => { this.userSecurityAction = 'revoke-sessions'; this.temporaryPassword = null; this.drawerError = false; this.drawerMessage = ''; this.render(); this.root.querySelector<HTMLButtonElement>('#user-security-submit')?.focus(); });
    this.root.querySelector('#user-drive-link')?.addEventListener('click', () => void this.showDriveLink());
    this.root.querySelector('#user-security-cancel')?.addEventListener('click', () => { this.userSecurityRequest += 1; this.userSecurityAction = null; this.drawerError = false; this.drawerMessage = ''; this.render(); });
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
      if (method && method.removable && method.id && (method.type !== 'password' && method.type !== 'other')) { this.mfaRemoval = method as RemovableMfaMethod; this.mfaConfirmation = ''; this.drawerError = false; this.drawerMessage = ''; this.render(); }
    }));
    this.root.querySelector<HTMLInputElement>('#mfa-removal-confirmation')?.addEventListener('input', event => { this.mfaConfirmation = (event.target as HTMLInputElement).value; });
    this.root.querySelector('#mfa-removal-cancel')?.addEventListener('click', () => { this.mfaRemoval = null; this.mfaConfirmation = ''; this.drawerError = false; this.drawerMessage = ''; this.render(); });
    this.root.querySelector('#mfa-removal-submit')?.addEventListener('click', () => void this.removeMfaMethod());
    this.root.querySelector<HTMLInputElement>('#mfa-recovery-email')?.addEventListener('input', event => { this.recoveryEmailDraft = (event.target as HTMLInputElement).value; });
    this.root.querySelector('#mfa-recovery-save')?.addEventListener('click', () => void this.saveRecoveryEmail());
    this.root.querySelector<HTMLInputElement>('#mfa-mobile-phone')?.addEventListener('input', event => { this.mobilePhoneDraft = (event.target as HTMLInputElement).value; });
    this.root.querySelector('#mfa-mobile-save')?.addEventListener('click', () => void this.saveMobilePhone());
    this.root.querySelector('#mfa-methods-refresh')?.addEventListener('click', () => { if (!this.detail || this.busy) return; this.mfaLoading = true; void this.loadMfaMethods(this.detail.id); this.render(); });
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
      if (action === 'add' || action === 'remove') { this.membershipAction = action; this.render(); }
    });
    this.root.querySelector<HTMLSelectElement>('#group-member-role')?.addEventListener('change', event => {
      const role = (event.target as HTMLSelectElement).value;
      if (role === 'member' || role === 'owner') { this.membershipRole = role; this.render(); }
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-group-alias-remove]').forEach(button => button.addEventListener('click', () => { this.groupAliasRemoval = button.dataset.groupAliasRemove!; this.render(); }));
    this.root.querySelector('#group-alias-cancel')?.addEventListener('click', () => { this.groupAliasRemoval = ''; this.render(); });
    this.root.querySelector<HTMLInputElement>('#group-alias-address')?.addEventListener('input', event => {
      this.groupAliasDraft = (event.target as HTMLInputElement).value;
      const submit = this.root.querySelector<HTMLButtonElement>('#group-alias-submit');
      if (submit) submit.disabled = this.busy || this.groupPrimaryNeedsRefresh || !this.groupAliasDraft.trim();
    });
    this.root.querySelector('#group-alias-submit')?.addEventListener('click', () => void this.writeGroupAlias());
    this.root.querySelector('#group-member-submit')?.addEventListener('click', () => void this.changeMembership());
    this.root.querySelector('#group-people-refresh')?.addEventListener('click', () => { if (this.detail?.id) void this.loadGroupPeople(this.detail.id); });
    this.root.querySelector('#group-settings-refresh')?.addEventListener('click', () => { if (this.detail?.id) void this.loadGroupSettings(this.detail.id); });
    this.root.querySelector<HTMLInputElement>('#group-external-allow')?.addEventListener('change', event => {
      this.groupExternalDraft = (event.target as HTMLInputElement).checked; this.render();
    });
    this.root.querySelector('#group-external-save')?.addEventListener('click', () => void this.saveGroupExternal());
    this.root.querySelector<HTMLInputElement>('#group-primary-address')?.addEventListener('change', event => {
      this.groupPrimaryDraft = (event.target as HTMLInputElement).value; this.render();
    });
    this.root.querySelector('#group-primary-save')?.addEventListener('click', () => void this.saveGroupPrimary());
    this.root.querySelector('[data-backdrop]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) this.closeDetail();
    });
    this.root.querySelector<HTMLElement>('[role="dialog"]')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (this.traceSelected) this.closeTraceDrawer(); else if (this.createUserOpen) this.closeCreateUser(); else this.closeDetail();
      } else if (event.key === 'Tab') {
        const focusable = Array.from(this.root.querySelectorAll<HTMLElement>('[role="dialog"] button:not(:disabled),[role="dialog"] input:not(:disabled),[role="dialog"] select:not(:disabled)')).filter(element => !element.closest('[hidden]'));
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
function parseMailboxInventory(input: unknown): MailboxInventory {
  if (!input || typeof input !== 'object') throw new Error('Invalid Exchange mailbox response.');
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.records) || typeof value.partial !== 'boolean' || typeof value.collectedAt !== 'string'
    || !value.records.every(record => record && typeof record === 'object'
      && typeof record.id === 'string' && typeof record.primarySmtpAddress === 'string'
      && (record.recipientType === 'UserMailbox' || record.recipientType === 'SharedMailbox')
      && typeof record.archiveEnabled === 'boolean' && typeof record.statisticsUnavailable === 'boolean'
      && (record.mailboxBytes === null || (typeof record.mailboxBytes === 'number' && Number.isFinite(record.mailboxBytes) && record.mailboxBytes >= 0))
      && (record.archiveBytes === null || (typeof record.archiveBytes === 'number' && Number.isFinite(record.archiveBytes) && record.archiveBytes >= 0))))
    throw new Error('Invalid Exchange mailbox response.');
  return value as MailboxInventory;
}
function parseMailboxRecord(input: unknown): MailboxRecord {
  const inventory = parseMailboxInventory({ records: [input], partial: false, collectedAt: new Date().toISOString() });
  return inventory.records[0]!;
}
function storageLabel(bytes: number | null): string {
  if (bytes === null) return 'Usage unavailable';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
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
const traceStyles = `.trace-panel{border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);margin-top:1rem;padding:.8rem}.trace-form{align-items:end;display:grid;gap:.6rem;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-top:.5rem}.trace-form label{margin:0}.trace-form button{align-self:end}.trace-toolbar{align-items:center;display:flex;flex-wrap:wrap;gap:.6rem;justify-content:space-between;margin-top:.7rem}.trace-panel th{position:sticky;top:0;z-index:3;background:hsl(var(--background))}.trace-panel td:last-child button{white-space:normal;text-align:left}.quarantine-inline{display:flex;flex-direction:column;align-items:flex-start;gap:.4rem;font-size:.8rem}.quarantine-inline .check{margin:0;align-items:flex-start}.quarantine-inline [role=status]{overflow-wrap:anywhere}.trace-panel th,.trace-panel td{font-size:.82rem;padding:.45rem}.trace-panel table{min-width:760px}.trace-panel .table-wrap{max-height:360px;overflow:auto}.trace-events{background:hsl(var(--muted) / .24);border-radius:var(--radius,.5rem);margin-top:.8rem;padding:.8rem}.trace-events p{font-size:.82rem;margin-top:.55rem;overflow-wrap:anywhere}.header-actions{align-items:center;display:flex;flex-wrap:wrap;gap:.4rem}@media(max-width:600px){.trace-form{grid-template-columns:1fr 1fr}}`;
const visualStyles = `
  :host { font-size: .875rem; line-height: 1.45; }
  main { max-width: none; padding: 1.25rem 1.5rem; }
  h1 { font-size: 1.5rem; line-height: 1.2; }
  h2 { font-size: 1.2rem; line-height: 1.3; }
  h3 { font-size: .92rem; line-height: 1.35; }
  button { border-radius: 4px; font-size: .8125rem; font-weight: 500; line-height: 1.35; max-width: 100%; }
  button.compact { font-size: .8125rem; min-height: 2rem; padding: .35rem .65rem; }
  button.secondary { background: transparent; border: 1px solid hsl(var(--border)); }
  button:not(:disabled):hover { filter: brightness(1.12); }
  button.secondary:not(:disabled):hover { background: hsl(var(--accent)); }
  button:focus:not(:focus-visible) { outline: none; }
  .resource-nav { flex-wrap: wrap; row-gap: .25rem; }
  .column-tools { gap: .35rem; }
  td { overflow-wrap:anywhere; }
  th[data-header] { position:relative; padding-right:18px; }
  th[draggable="true"] .table-sort { cursor:grab; }
  th.column-drop { box-shadow:inset 3px 0 var(--primary,#5680ed); }
  .column-resize { position:absolute; top:0; right:-4px; width:9px; height:100%; cursor:col-resize; touch-action:none; z-index:2; }
  .column-resize:hover,.column-resize:focus-visible { background:var(--primary,#5680ed); opacity:.65; }
  .column-settings { display: inline-block; margin-left: .45rem; vertical-align: middle; text-transform: none; letter-spacing: normal; }
  .column-settings summary { cursor: pointer; list-style: none; padding: .1rem .45rem; border-radius: .25rem; font-size: 1rem; }
  .column-settings summary:hover, .column-settings[open] summary { background: hsl(var(--secondary)); }
  .column-settings summary:focus-visible { outline: 2px solid hsl(var(--ring)); }
  .column-settings-body { min-width: 7rem; padding-top: .4rem; }
  .column-move { display: flex; gap: .35rem; }
  .column-settings label { margin-top: .4rem; font-size: .75rem; }
  .column-settings input { width: 7rem; }
  .inline-user-actions { display: flex; flex-wrap: wrap; gap: .35rem .5rem; width: 100%; white-space: normal; }
  .inline-user-actions button.compact { background: transparent; border-color: transparent; color: hsl(var(--muted-foreground)); font-size: .75rem; min-height: 1.9rem; padding: .3rem .4rem; }
  .inline-user-actions button.compact:hover, .inline-user-actions button.compact:focus-visible { background: hsl(var(--accent)); color: hsl(var(--foreground)); }
  .directory .inline-actions-row td { padding: .35rem .75rem .65rem; border-top: 0; border-bottom: 1px solid hsl(var(--border)); }
  .directory tbody tr:not(.inline-actions-row) td { border-bottom: 0; padding-bottom: .25rem; }
  .directory th { white-space: nowrap; }
  .account-panel > .drawer-section { display: none; }
  .account-panel[data-panel="account"] > .section-account { display: block; border-top: 0; }
  .account-panel[data-panel="licenses"] > .section-licenses { display: block; border-top: 0; }
  .account-panel[data-panel="groups"] > .section-groups { display: block; border-top: 0; }
  .account-panel[data-panel="security"] > .section-security { display: block; border-top: 0; }
  .account-panel[data-panel="delegation"] > .section-mailbox { display: block; border-top: 0; }
  .account-panel[data-panel="forwarding"] > .section-mailbox { display: block; border-top: 0; }
  .account-panel[data-panel="autoreply"] > .section-mailbox { display: block; border-top: 0; }
  .account-panel[data-panel="drive"] > .section-drive { display: block; border-top: 0; }
  .account-panel .section-mailbox > div { display: none; }
  .account-panel[data-panel="delegation"] .mailbox-delegation, .account-panel[data-panel="forwarding"] .mailbox-forwarding, .account-panel[data-panel="autoreply"] .mailbox-autoreply { display: block; }
  .account-panel[data-panel="addresses"] > .section-addresses { display: block; border-top: 0; }
  [hidden] { display: none !important; }
  .account-panel button { font-size: .8125rem; min-height: 2rem; padding: .35rem .6rem; }
  .account-panel .role-field { margin-top: .5rem; }
  .account-panel .meta { font-size: .8rem; }
  .column-chip { font-size: .75rem; min-height: 1.9rem; }
  .directory .table-wrap { border: 1px solid hsl(var(--border)); border-radius: var(--radius,.5rem); }
  .directory table { min-width: 620px; font-size: .8125rem; }
  .directory th, .directory td { padding: .65rem .75rem; }
  .directory th .table-sort { background: transparent; color: inherit; font-size: inherit; font-weight: inherit; letter-spacing: inherit; min-height: 1.5rem; padding: 0; text-align: left; text-transform: inherit; }
  .directory th .table-sort:hover { color: hsl(var(--foreground)); }
  .directory th:first-child, .directory td:first-child { min-width: 16rem; }
  .directory th:nth-child(2), .directory td:nth-child(2) { min-width: 7.5rem; }
  .directory .row-control { min-width: 7.5rem; white-space: nowrap; }
  .directory .row-control button { white-space: nowrap; }
  .directory tbody tr:hover:not(.row-actions) td { background: hsl(var(--accent) / .18); }
  .directory th { position: relative; }
  .directory-notice { border: 1px solid hsl(var(--border)); border-radius: var(--radius,.5rem); color: hsl(var(--muted-foreground)); font-size: .8125rem; line-height: 1.5; margin-top: .8rem; padding: .65rem .8rem; }
  .identity span { overflow-wrap: anywhere; }
  .row-actions td { padding: .85rem 1rem; }
  .row-actions td > .actionline { align-items: center; display: flex; flex-wrap: wrap; gap: .45rem; justify-content: flex-start; }
  .actionline + .actionline { border-top: 1px solid hsl(var(--border)); margin-top: .7rem; padding-top: .7rem; }
  .actionline > span { color: hsl(var(--muted-foreground)); flex: 0 0 100%; font-size: .72rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .actionline > small { color: hsl(var(--muted-foreground)); flex: 0 0 100%; font-size: .75rem; }
  .drawer, .drawer-body, .drawer-section, .drawer label { min-width: 0; }
  .drawer-body button[id$="-close"], .drawer-body #account-back { display: none; }
  .drawer-body .actions { flex-wrap: wrap; }
  .drawer-body .mfa-methods { list-style: none; margin: .5rem 0; padding: 0; }
  .drawer-body .mfa-methods li { display: flex; align-items: center; justify-content: space-between; min-width: 0; gap: .65rem; padding: .6rem 0; border-bottom: 1px solid hsl(var(--border)); }
  .drawer-body .mfa-methods strong, .drawer-body .mfa-methods small { display: block; }
  .drawer-body .mfa-methods small { color: hsl(var(--muted-foreground)); margin-top: .15rem; }
  .drawer-body .mfa-methods button { flex: 0 0 auto; }
  .drawer-body ul.address-aliases { list-style: none; margin: .5rem 0; padding: 0; }
  .drawer-body ul.address-aliases li { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .35rem 0; }

  .drawer-body .mfa-methods li > span { min-width: 0; overflow-wrap: anywhere; }
  .drawer select, .drawer input:not([type="checkbox"]), .drawer textarea { min-width: 0; width: 100%; max-width: 100%; box-sizing: border-box; }
  .drawer label { grid-template-columns: minmax(0, 1fr); }
  .drawer-heading > div { min-width: 0; overflow-wrap: anywhere; }
  .delegation-current { list-style: none; padding: 0; }
  .delegation-current li { display: flex; flex-direction: column; gap: .5rem; padding: .65rem 0; overflow-wrap: anywhere; }
  .delegate-permissions { display: flex; flex-wrap: wrap; gap: .5rem; }
  .delegate-permission { display: inline-flex; align-items: center; gap: .35rem; font-size: .85rem; }
  .drawer { max-width: min(100%, 38rem); }
  .drawer-heading { align-items: flex-start; flex-direction: row; padding: 1rem 1.25rem; }
  .drawer-heading > div { min-width: 0; }
  .drawer-heading .subtle { font-size: .8125rem; overflow-wrap: anywhere; }
  .drawer-body { padding: 0 1.25rem 1.5rem; }
  .drawer-section { border-top: 1px solid hsl(var(--border)); margin-top: .75rem; padding-top: .75rem; }
  .drawer-section:first-child { border-top: 0; }
  .drawer-section h3 { margin-bottom: .45rem; }
  .drawer-section > .actions { flex-wrap: wrap; gap: .5rem; justify-content: flex-start; margin-top: .5rem; }
  .drawer-section > button { margin: .15rem .45rem .25rem 0; }
  .drawer-section label { margin-top: .75rem; }
  .drawer-section .meta { line-height: 1.5; margin-top: .65rem; }
  .current-people { border-top: 1px solid hsl(var(--border)); margin-top: .75rem; padding-top: .75rem; }
  .current-people > .actions { align-items: center; justify-content: space-between; margin: 0 0 .55rem; }
  .current-people h4 { font-size: .9rem; margin: 0; }
  .current-people h5 { color: hsl(var(--muted-foreground)); font-size: .75rem; margin: .75rem 0 .35rem; text-transform: uppercase; }
  .current-members { border: 1px solid hsl(var(--border)); border-radius: var(--radius,.5rem); list-style: none; margin: 0; max-height: 12rem; overflow: auto; padding: 0; }
  .current-members li { border-bottom: 1px solid hsl(var(--border)); min-width: 0; overflow-wrap: anywhere; padding: .5rem .65rem; }
  .current-members li:has(button) { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: .15rem .6rem; align-items: center; }
  .current-members li > button { grid-column: 2; grid-row: 1 / span 2; }
  .drawer, .drawer * { scrollbar-width: thin; scrollbar-color: hsl(var(--muted-foreground) / .4) transparent; }
  .current-members li:last-child { border-bottom: 0; }
  .current-members strong, .current-members small { display: block; }
  .current-members small { color: hsl(var(--muted-foreground)); }
  .member-options { border: 1px solid hsl(var(--border)); border-radius: var(--radius,.5rem); margin-top: .4rem; max-height: 11rem; overflow: auto; }
  .member-option { background: transparent; border-bottom: 1px solid hsl(var(--border)); border-radius: 0; color: hsl(var(--foreground)); display: block; min-height: 2.75rem; overflow-wrap: anywhere; padding: .45rem .65rem; text-align: left; width: 100%; }
  .member-option:last-child { border-bottom: 0; }
  .member-option:hover, .member-option.selected { background: hsl(var(--accent)); }
  .member-option strong, .member-option small { display: block; }
  .member-option small { color: hsl(var(--muted-foreground)); font-size: .75rem; font-weight: 400; }
  .role-field { margin-top: .8rem; }
  .role-field .role-field { margin-top: 0; }
  .addresses-panel { border: 1px solid hsl(var(--border)); border-radius: var(--radius,.5rem); padding: .75rem; }
  .addresses-heading { align-items: center; display: flex; gap: .5rem; justify-content: space-between; }
  .addresses-heading strong { font-size: .8125rem; }
  .addresses-heading .actions { gap: .4rem; margin: 0; }
  .address-aliases { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .75rem; }
  .alias-chip { align-items: center; background: hsl(var(--secondary)); border: 1px solid hsl(var(--border)); border-radius: 4px; display: inline-flex; font-size: .75rem; gap: .3rem; max-width: 100%; min-height: 1.9rem; padding: .2rem .3rem .2rem .65rem; }
  .alias-chip span { min-width: 0; overflow-wrap: anywhere; }
  .alias-remove { align-items: center; background: transparent; border-radius: 3px; color: hsl(var(--muted-foreground)); display: inline-flex; flex: 0 0 1.35rem; font-size: 1rem; justify-content: center; min-height: 1.35rem; padding: 0; width: 1.35rem; }
  .alias-remove:hover { background: hsl(var(--accent)); color: hsl(var(--foreground)); }
  .user-field label { grid-template-columns: 5rem minmax(0,1fr); }
  .user-field > button { align-self: stretch; }
  .drawer-footer { padding: .8rem 1.25rem; }
  .drawer-feedback:empty { display: none; }
  .module-nav { display: flex; flex-wrap: wrap; gap: .4rem; }
  .module-nav button[aria-pressed="true"] { border-color: hsl(var(--primary)); color: hsl(var(--foreground)); background: hsl(var(--accent)); }
  .directory-actions { display: flex; justify-content: flex-end; margin-bottom: .75rem; }
  .directory-actions:empty { display: none; }
  /* One restrained control hierarchy across every focused Microsoft panel. */
  .drawer .upn-field { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1.2fr); align-items: center; gap: .5rem; }
  .drawer .upn-field input, .drawer .upn-field select { width: 100%; max-width: 100%; min-width: 0; }
  @media (max-width: 420px) { .drawer .upn-field { grid-template-columns: minmax(0, 1fr) auto; } .drawer .upn-field select { grid-column: 1 / -1; } }
  .badge, .state { border-radius: 4px; font-weight: 500; }
  .column-chip { background: transparent; border: 1px solid hsl(var(--border)); border-radius: 4px; font-weight: 500; }
  .column-chip[aria-pressed="true"] { background: hsl(var(--accent) / .5); border-color: hsl(var(--muted-foreground) / .4); }
  .drawer input, .drawer select, .drawer textarea { border-radius: 4px; font-weight: 400; }
  .drawer textarea { background: hsl(var(--background)); color: inherit; border: 1px solid hsl(var(--input)); font: inherit; padding: .55rem; resize: vertical; }
  .drawer label + button, .drawer select + button, .drawer input + button { margin-top: .65rem; }
  .drawer .actions { align-items: center; gap: .65rem; }
  .drawer .actions h3 { margin: 0; margin-right: auto; }
  .drawer .check { grid-template-columns: none; flex-wrap: nowrap; align-items: flex-start; font-weight: 400; line-height: 1.5; }
  .drawer .check input { flex: 0 0 1rem; height: 1rem; margin: .15rem 0 0; padding: 0; }
  .drawer-heading > button { flex: 0 0 auto; }
  .drawer-body { overscroll-behavior: contain; }
  .addresses-panel { border-radius: 4px; }
  .addresses-heading { flex-wrap: wrap; row-gap: .65rem; }
  .alias-chip { background: transparent; gap: .5rem; }
  .alias-remove { min-width: 1.75rem; min-height: 1.75rem; }
  .drawer .alias-remove { padding: .15rem; }
  .resource-tab { border-radius: 0; }

  @media (max-width: 700px) {
    main { padding: 1rem; }
    header, .directory-top { align-items: stretch; flex-direction: column; }
    .resource-nav { max-width: 100%; overflow-x: auto; width: 100%; }
    .filter { max-width: none; }
    .drawer-body { padding-left: 1rem; padding-right: 1rem; }
    .drawer-heading, .drawer-footer { padding-left: 1rem; padding-right: 1rem; }
    .user-field { grid-template-columns: minmax(0, 1fr); }
    .user-field label { align-items: stretch; grid-template-columns: 1fr; }
    .user-field > button { align-self: auto; justify-self: start; }
  }
`;

if (!customElements.get(ELEMENT)) customElements.define(ELEMENT, CloudCommandMicrosoftPage);

const traceDrawerStyles = `.trace-drawer{width:min(740px,100vw)!important;max-width:100vw!important}.trace-drawer.trace-expanded{width:min(1100px,100vw)!important}.trace-drawer .drawer-heading{align-items:flex-start}.trace-drawer h2{overflow-wrap:anywhere;font-size:1.15rem}.trace-summary{display:grid;grid-template-columns:1fr 1fr;gap:0 1.25rem}.trace-event{border-bottom:1px solid hsl(var(--border));padding:.65rem 0}.trace-event summary{display:flex;gap:1rem;cursor:pointer;align-items:baseline;font-size:.82rem}.trace-event summary:before{content:'›'}.trace-event[open] summary:before{content:'⌄'}.trace-event p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem;margin:.65rem 0}.trace-subject{background:none;color:inherit;border:0;padding:0;text-align:left;font-weight:500}.trace-subject:hover{text-decoration:underline}.trace-drawer .drawer-section>button{margin:.6rem .5rem 0 0}@media(max-width:500px){.trace-summary{grid-template-columns:1fr}.trace-event summary{flex-wrap:wrap;gap:.4rem}}`;

const membershipStyles = `
  .membership-list { list-style: none; margin: .65rem 0; padding: 0; display: grid; gap: .4rem; }
  .membership-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: .75rem; row-gap: .2rem; padding: .55rem .65rem; border: 1px solid hsl(var(--border)); border-radius: 4px; }
  .membership-name { font-size: .875rem; font-weight: 500; overflow-wrap: anywhere; }
  .membership-reason { grid-column: 1; font-size: .8rem; font-weight: 400; color: hsl(var(--muted-foreground)); overflow-wrap: anywhere; }
  .membership-list button { grid-column: 2; grid-row: 1 / span 2; margin: 0; }
`;
