import { beforeEach, describe, expect, it, vi } from 'vitest';
const { dbMocks, googleMocks } = vi.hoisted(() => ({
  dbMocks: { results: [] as unknown[][], select: vi.fn() },
  googleMocks: { users: vi.fn(), userGet: vi.fn(), userUpdate: vi.fn(), groups: vi.fn(), groupGet: vi.fn(), members: vi.fn(),
    forwardGet: vi.fn(), vacationGet: vi.fn(), gmailSubject: vi.fn(), usageGet: vi.fn(), activityList: vi.fn(), decrypt: vi.fn(), audit: vi.fn() },
}));
vi.mock('../db', () => ({
  db: { select: () => { dbMocks.select(); return { from: () => ({ where: () => ({ limit: async () => dbMocks.results.shift() ?? [] }) }) }; } },
  withDbAccessContext: async (_: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../db/schema/google', () => ({ googleWorkspaceConnections: { orgId: 'org_id' } }));
vi.mock('../middleware/auth', () => ({ dbAccessContextFromAuth: () => ({}) }));
vi.mock('../config/env', () => ({ GOOGLE_WORKSPACE_ENABLED: true }));
vi.mock('../services/googleHelpers', () => ({ decryptConnectionKey: googleMocks.decrypt }));
vi.mock('../services/auditService', () => ({ createAuditLog: googleMocks.audit }));
vi.mock('../services/googleClient', () => ({
  getDirectoryClient: () => ({ users: { list: googleMocks.users, get: googleMocks.userGet, update: googleMocks.userUpdate },
    groups: { list: googleMocks.groups, get: googleMocks.groupGet }, members: { list: googleMocks.members } }),
  getGmailClient: (_key: string, subject: string) => { googleMocks.gmailSubject(subject); return { users: { settings: {
    getAutoForwarding: googleMocks.forwardGet, getVacation: googleMocks.vacationGet } } }; },
  getUsageReportsClient: () => ({ userUsageReport: { get: googleMocks.usageGet } }),
  getAuditReportsClient: () => ({ activities: { list: googleMocks.activityList } }),
}));
import { nativeGoogleServices } from './cloudCommandGoogle';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const row = { orgId: ORG, status: 'active', customerDomain: 'example.test', adminEmail: 'admin@example.test', serviceAccountKey: 'encrypted', lastVerifiedAt: new Date('2026-09-22') };
const auth = { user: { id: 'actor' }, scope: 'organization', orgId: ORG, canAccessOrg: (id: string) => id === ORG, allowedSiteIds: undefined };
const request = (orgId = ORG) => ({ auth, orgId, authorization: { allowedSiteIds: undefined, hasPermission: () => true, mfaSatisfied: true } }) as never;
beforeEach(() => { vi.clearAllMocks(); dbMocks.results.length = 0; googleMocks.decrypt.mockReturnValue('secret'); });
describe('native Google Workspace bridge', () => {
  it('reads only the current organization connection and returns no credential in status', async () => {
    dbMocks.results.push([row]);
    const result = await nativeGoogleServices.connection(request());
    expect(result).toMatchObject({ available: true, connected: true, enabled: true, customerDomain: 'example.test' });
    expect(JSON.stringify(result)).not.toContain('encrypted');
  });
  it('denies a different organization before credential access', async () => {
    expect(await nativeGoogleServices.directory(request(OTHER), 'users', null)).toMatchObject({ ok: false, code: 'access_denied' });
    expect(dbMocks.select).not.toHaveBeenCalled();
    expect(googleMocks.decrypt).not.toHaveBeenCalled();
  });
  it('rejects a row that does not match the requested organization', async () => {
    dbMocks.results.push([{ ...row, orgId: OTHER }]);
    expect(await nativeGoogleServices.directory(request(), 'users', null)).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(googleMocks.decrypt).not.toHaveBeenCalled();
  });
  it('uses the configured domain, bounded page and fixed user projection', async () => {
    dbMocks.results.push([row]);
    googleMocks.users.mockResolvedValue({ data: { users: [{ id: 'u1', primaryEmail: 'one@example.test', name: { fullName: 'One Person', givenName: 'One', familyName: 'Person' }, suspended: false, isAdmin: false, secret: 'provider-secret' }], nextPageToken: 'next' } });
    const result = await nativeGoogleServices.directory(request(), 'users', 'token');
    expect(googleMocks.users).toHaveBeenCalledWith(expect.objectContaining({ domain: 'example.test', maxResults: 100, pageToken: 'token' }));
    expect(result).toMatchObject({ ok: true, nextPageToken: 'next' });
    expect(result).toMatchObject({ items: [{ givenName: 'One', familyName: 'Person' }] });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
  });
  it('keeps provider error bodies out of browser errors', async () => {
    dbMocks.results.push([row]);
    googleMocks.groups.mockRejectedValue(new Error('private provider body'));
    const result = await nativeGoogleServices.directory(request(), 'groups', null);
    expect(result).toMatchObject({ ok: false, code: 'provider_failed' });
    expect(JSON.stringify(result)).not.toContain('private provider body');
  });
  it('reads bounded direct members only after confirming group ownership', async () => {
    dbMocks.results.push([row]);
    googleMocks.groupGet.mockResolvedValue({ data: { id: 'g1', email: 'team@example.test' } });
    googleMocks.members.mockResolvedValue({ data: { members: [{ id: 'm1', email: 'one@example.test', role: 'OWNER', type: 'USER', status: 'ACTIVE', secret: 'hidden' }], nextPageToken: 'next' } });
    const result = await nativeGoogleServices.members(request(), 'g1', 'token');
    expect(googleMocks.groupGet).toHaveBeenCalledWith({ groupKey: 'g1', fields: 'id,email' });
    expect(googleMocks.members).toHaveBeenCalledWith(expect.objectContaining({ groupKey: 'g1', maxResults: 100, pageToken: 'token', includeDerivedMembership: false }));
    expect(result).toMatchObject({ ok: true, nextPageToken: 'next', items: [{ email: 'one@example.test', role: 'OWNER' }] });
    expect(JSON.stringify(result)).not.toContain('hidden');
  });
  it('refuses cross-domain group details before listing members', async () => {
    dbMocks.results.push([row]);
    googleMocks.groupGet.mockResolvedValue({ data: { id: 'g1', email: 'other@elsewhere.test' } });
    expect(await nativeGoogleServices.members(request(), 'g1', null)).toMatchObject({ code: 'access_denied' });
    expect(googleMocks.members).not.toHaveBeenCalled();
  });
  it('denies cross-org member reads before loading a credential', async () => {
    expect(await nativeGoogleServices.members(request(OTHER), 'g1', null)).toMatchObject({ code: 'access_denied' });
    expect(dbMocks.select).not.toHaveBeenCalled();
    expect(googleMocks.decrypt).not.toHaveBeenCalled();
  });
  it('reads only bounded Gmail forwarding and vacation settings for an owned mailbox', async () => {
    dbMocks.results.push([row], [row]);
    googleMocks.userGet.mockResolvedValue({ data: { id: 'u1', primaryEmail: 'one@example.test', archived: false } });
    googleMocks.forwardGet.mockResolvedValue({ data: { enabled: true, emailAddress: 'target@example.test', disposition: 'leaveInInbox', secret: 'hidden' } });
    googleMocks.vacationGet.mockResolvedValue({ data: { enableAutoReply: true, responseSubject: 'Away', responseBodyHtml: '<b>private</b>', startTime: '1000' } });
    const result = await nativeGoogleServices.mailboxSettings(request(), 'u1');
    expect(result).toMatchObject({ ok: true, email: 'one@example.test', forwardingEnabled: true, vacationEnabled: true });
    expect(googleMocks.gmailSubject).toHaveBeenCalledWith('one@example.test');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('hidden');
  });
  it('denies cross-org, cross-domain and stale-connection Gmail reads before impersonation', async () => {
    expect(await nativeGoogleServices.mailboxSettings(request(OTHER), 'u1')).toMatchObject({ code: 'access_denied' });
    dbMocks.results.push([row]);
    googleMocks.userGet.mockResolvedValue({ data: { id: 'u1', primaryEmail: 'one@other.test', archived: false } });
    expect(await nativeGoogleServices.mailboxSettings(request(), 'u1')).toMatchObject({ code: 'state_changed' });
    dbMocks.results.push([row], [{ ...row, serviceAccountKey: 'rotated' }]);
    googleMocks.userGet.mockResolvedValue({ data: { id: 'u1', primaryEmail: 'one@example.test', archived: false } });
    expect(await nativeGoogleServices.mailboxSettings(request(), 'u1')).toMatchObject({ code: 'state_changed' });
    expect(googleMocks.gmailSubject).not.toHaveBeenCalled();
  });
  const reportDate = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  it('projects only safe storage metrics and marks absent values unavailable', async () => {
    dbMocks.results.push([row], [row]);
    googleMocks.userGet.mockResolvedValue({ data: { primaryEmail: 'admin@example.test', customerId: 'C123' } });
    googleMocks.usageGet.mockResolvedValue({ data: { usageReports: [{ entity: { customerId: 'C123', userEmail: 'one@example.test' }, parameters: [
      { name: 'accounts:gmail_used_quota_in_mb', intValue: '0' }, { name: 'accounts:used_quota_in_mb', intValue: '125' },
      { name: 'accounts:drive_used_quota_in_mb', intValue: 'private-invalid' }, { name: 'other', intValue: '999' },
    ], private: 'secret' }], nextPageToken: 'next' } });
    const result = await nativeGoogleServices.storage(request(), reportDate, null);
    expect(googleMocks.usageGet).toHaveBeenCalledWith(expect.objectContaining({ userKey: 'all', customerId: 'C123', maxResults: 100 }));
    expect(result).toMatchObject({ ok: true, partial: true, nextPageToken: 'next', items: [{ email: 'one@example.test', gmailMb: 0, driveMb: null, totalMb: 125 }] });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private-invalid');
  });
  it('fences report customer and connection before usage access', async () => {
    expect(await nativeGoogleServices.storage(request(OTHER), reportDate, null)).toMatchObject({ code: 'access_denied' });
    dbMocks.results.push([row]);
    googleMocks.userGet.mockResolvedValue({ data: { primaryEmail: 'other@example.test', customerId: 'C123' } });
    expect(await nativeGoogleServices.storage(request(), reportDate, null)).toMatchObject({ code: 'provider_failed' });
    dbMocks.results.push([row], [{ ...row, serviceAccountKey: 'rotated' }]);
    googleMocks.userGet.mockResolvedValue({ data: { primaryEmail: 'admin@example.test', customerId: 'C123' } });
    expect(await nativeGoogleServices.storage(request(), reportDate, null)).toMatchObject({ code: 'connection_not_ready' });
    expect(googleMocks.usageGet).not.toHaveBeenCalled();
  });
  it('labels missing Reports grant without disclosing provider errors', async () => {
    dbMocks.results.push([row], [row]);
    googleMocks.userGet.mockResolvedValue({ data: { primaryEmail: 'admin@example.test', customerId: 'C123' } });
    googleMocks.usageGet.mockRejectedValue({ response: { status: 403, data: { secret: 'private provider body' } } });
    const result = await nativeGoogleServices.storage(request(), reportDate, null);
    expect(result).toMatchObject({ code: 'scope_required' });
    expect(JSON.stringify(result)).not.toContain('private provider body');
  });
  const action = { userId: '123456', email: 'user@example.test', expectedSuspended: false, suspended: true, confirmation: 'user@example.test' };
  it('returns a bounded activity projection and omits a different Google customer', async () => {
    dbMocks.results.push([row], [row]);
    googleMocks.userGet.mockResolvedValue({ data: { primaryEmail: 'admin@example.test', customerId: 'C123' } });
    const at = new Date(Date.now() - 3600000).toISOString();
    googleMocks.activityList.mockResolvedValue({ data: { items: [
      { id: { customerId: 'C123', applicationName: 'login', time: at, uniqueQualifier: 'abc' }, actor: { email: 'one@example.test' }, events: [{ name: 'login_success', parameters: [{ name: 'secret', value: 'private' }] }] },
      { id: { customerId: 'OTHER', applicationName: 'login', time: at, uniqueQualifier: 'other' }, events: [{ name: 'login_failure' }] },
    ], nextPageToken: 'next' } });
    const result = await nativeGoogleServices.activity(request(), 'login', 7, null, null);
    expect(googleMocks.activityList).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'C123', applicationName: 'login', maxResults: 100 }));
    expect(result).toMatchObject({ asOf: expect.any(String) });
    expect(result).toMatchObject({ ok: true, partial: true, nextPageToken: 'next', items: [{ id: 'abc', events: ['login_success'] }] });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('OTHER');
  });
  it('fences activity before provider access and labels missing audit scope', async () => {
    expect(await nativeGoogleServices.activity(request(OTHER), 'login', 7, null, null)).toMatchObject({ code: 'access_denied' });
    expect(googleMocks.activityList).not.toHaveBeenCalled();
    dbMocks.results.push([row], [row]);
    googleMocks.userGet.mockResolvedValue({ data: { primaryEmail: 'admin@example.test', customerId: 'C123' } });
    googleMocks.activityList.mockRejectedValue({ response: { status: 403, data: { secret: 'private' } } });
    const result = await nativeGoogleServices.activity(request(), 'login', 7, null, null);
    expect(result).toMatchObject({ code: 'scope_required' });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  const current = { id: '123456', primaryEmail: 'user@example.test', suspended: false, archived: false, isAdmin: false };
  it('rechecks account and credential state before a bounded suspension, then verifies the result', async () => {
    dbMocks.results.push([row], [row]);
    googleMocks.userGet.mockResolvedValueOnce({ data: current }).mockResolvedValueOnce({ data: { ...current, suspended: true } });
    googleMocks.userUpdate.mockResolvedValue({ data: {} });
    expect(await nativeGoogleServices.setSuspended(request(), action)).toMatchObject({ ok: true, userId: '123456', suspended: true });
    expect(dbMocks.select).toHaveBeenCalledTimes(2);
    expect(googleMocks.userUpdate).toHaveBeenCalledWith({ userKey: '123456', requestBody: { suspended: true } });
  });
  it('denies suspension without host write permission or MFA before loading a credential', async () => {
    const deniedWrite = { ...request(), authorization: { allowedSiteIds: undefined, hasPermission: (_resource: string, action: string) => action === 'read', mfaSatisfied: true } } as never;
    expect(await nativeGoogleServices.setSuspended(deniedWrite, action)).toMatchObject({ code: 'access_denied' });
    const deniedMfa = { ...request(), authorization: { allowedSiteIds: undefined, hasPermission: () => true, mfaSatisfied: false } } as never;
    expect(await nativeGoogleServices.setSuspended(deniedMfa, action)).toMatchObject({ code: 'access_denied' });
    expect(dbMocks.select).not.toHaveBeenCalled();
  });
  it('uses a synchronous audit write with valid results before and after a mutation', async () => {
    await nativeGoogleServices.auditSuspension(request(), '123456', 'intent');
    await nativeGoogleServices.auditSuspension(request(), '123456', 'failure');
    expect(googleMocks.audit).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: 'cloudcommand.google.user.suspension.intent', result: 'success' }));
    expect(googleMocks.audit).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: 'cloudcommand.google.user.suspension', result: 'failure' }));
  });
  it('protects connected administrator and other admin users', async () => {
    dbMocks.results.push([row]);
    expect(await nativeGoogleServices.setSuspended(request(), { ...action, email: 'admin@example.test', confirmation: 'admin@example.test' })).toMatchObject({ code: 'protected_account' });
    expect(googleMocks.decrypt).not.toHaveBeenCalled();
    dbMocks.results.push([row]);
    googleMocks.userGet.mockResolvedValue({ data: { ...current, isAdmin: true } });
    expect(await nativeGoogleServices.setSuspended(request(), action)).toMatchObject({ code: 'protected_account' });
    expect(googleMocks.userUpdate).not.toHaveBeenCalled();
  });
  it('rejects changed account or credential state before writing', async () => {
    dbMocks.results.push([row]);
    googleMocks.userGet.mockResolvedValue({ data: { ...current, suspended: true } });
    expect(await nativeGoogleServices.setSuspended(request(), action)).toMatchObject({ code: 'state_changed' });
    expect(googleMocks.userUpdate).not.toHaveBeenCalled();
    dbMocks.results.push([row], [{ ...row, serviceAccountKey: 'rotated' }]);
    googleMocks.userGet.mockResolvedValue({ data: current });
    expect(await nativeGoogleServices.setSuspended(request(), action)).toMatchObject({ code: 'state_changed' });
    expect(googleMocks.userUpdate).not.toHaveBeenCalled();
  });
  it('labels an uncertain provider update outcome without retrying', async () => {
    dbMocks.results.push([row], [row]);
    googleMocks.userGet.mockResolvedValue({ data: current });
    googleMocks.userUpdate.mockRejectedValue(new Error('private provider body'));
    const result = await nativeGoogleServices.setSuspended(request(), action);
    expect(result).toMatchObject({ code: 'unknown_write_outcome' });
    expect(JSON.stringify(result)).not.toContain('private provider body');
    expect(googleMocks.userUpdate).toHaveBeenCalledTimes(1);
  });
  const profile = { userId: '123456', email: 'user@example.test', expectedGivenName: 'Old', expectedFamilyName: 'Person', givenName: 'New', familyName: 'Person' };
  it('updates only the two name fields after fresh account/credential checks and readback', async () => {
    dbMocks.results.push([row], [row]);
    googleMocks.userGet.mockResolvedValueOnce({ data: { ...current, name: { givenName: 'Old', familyName: 'Person' } } })
      .mockResolvedValueOnce({ data: { ...current, name: { givenName: 'New', familyName: 'Person' } } });
    googleMocks.userUpdate.mockResolvedValue({ data: {} });
    expect(await nativeGoogleServices.updateProfile(request(), profile)).toMatchObject({ ok: true, givenName: 'New' });
    expect(googleMocks.userUpdate).toHaveBeenCalledWith({ userKey: '123456', requestBody: { name: { givenName: 'New', familyName: 'Person' } } });
  });
  it('rejects stale profile and rotated credential before provider mutation', async () => {
    dbMocks.results.push([row]);
    googleMocks.userGet.mockResolvedValue({ data: { ...current, name: { givenName: 'Changed', familyName: 'Person' } } });
    expect(await nativeGoogleServices.updateProfile(request(), profile)).toMatchObject({ code: 'state_changed' });
    expect(googleMocks.userUpdate).not.toHaveBeenCalled();
    dbMocks.results.push([row], [{ ...row, serviceAccountKey: 'rotated' }]);
    googleMocks.userGet.mockResolvedValue({ data: { ...current, name: { givenName: 'Old', familyName: 'Person' } } });
    expect(await nativeGoogleServices.updateProfile(request(), profile)).toMatchObject({ code: 'state_changed' });
    expect(googleMocks.userUpdate).not.toHaveBeenCalled();
  });
  it('writes a synchronous profile audit with valid result values', async () => {
    await nativeGoogleServices.auditProfile(request(), '123456', 'intent');
    await nativeGoogleServices.auditProfile(request(), '123456', 'success');
    expect(googleMocks.audit).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: 'cloudcommand.google.user.profile.intent', result: 'success' }));
    expect(googleMocks.audit).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: 'cloudcommand.google.user.profile', result: 'success' }));
  });
});
