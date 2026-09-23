import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminGraphProvider } from './admin-graph-provider';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER_ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP = '33333333-3333-4333-8333-333333333333';
const SKU = '55555555-5555-4555-8555-555555555555';
const ORIGIN = 'https://graph.microsoft.com/v1.0';
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function harness() {
  const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }));
  const acquireToken = vi.fn().mockResolvedValue('server-owned-token');
  return { fetch, acquireToken, provider: createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken }) };
}
const staticGroup = { id: GROUP, securityEnabled: true, mailEnabled: false, groupTypes: [], onPremisesSyncEnabled: null, isAssignableToRole: false };
afterEach(() => vi.useRealTimers());

describe('bounded Microsoft administration provider', () => {
  it('creates a Microsoft 365 group with a verified user owner and reports Microsoft-assigned mail', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['Group.ReadWrite.All', 'User.ReadWrite.All'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER }))
      .mockResolvedValueOnce(response({ id: GROUP }, 201))
      .mockResolvedValueOnce(response({ ...staticGroup, displayName: 'Ops', mail: 'ops@tenant.onmicrosoft.com', mailEnabled: true, groupTypes: ['Unified'] }))
      .mockResolvedValueOnce(response({ value: [{ id: USER }] }));
    const fence = vi.fn(async () => {});
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.createGroup({ displayName: 'Ops', mailNickname: 'ops', ownerId: USER }, fence))
      .resolves.toEqual({ accepted: true, id: GROUP, verified: true, mail: 'ops@tenant.onmicrosoft.com' });
    expect(fence).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[2]).toEqual([`${ORIGIN}/groups`, expect.objectContaining({ method: 'POST', body: JSON.stringify({
      displayName: 'Ops', mailNickname: 'ops', mailEnabled: true, securityEnabled: false, groupTypes: ['Unified'],
      'owners@odata.bind': [`${ORIGIN}/users/${USER}`],
    }) })]);
  });
  it('rejects group creation without owner permission or valid alias before writing', async () => {
    for (const [roles, alias] of [[['Group.ReadWrite.All'], 'ops'], [['Group.ReadWrite.All', 'User.ReadWrite.All'], 'ops@bad']] as const) {
      const token = `h.${Buffer.from(JSON.stringify({ roles })).toString('base64url')}.s`;
      const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }));
      const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
      await expect(provider.createGroup({ displayName: 'Ops', mailNickname: alias, ownerId: USER })).rejects.toBeTruthy();
      expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
    }
  });
  it('updates only the display name of a verified Microsoft 365 group', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['Group.ReadWrite.All'] })).toString('base64url')}.s`;
    const current = { ...staticGroup, displayName: 'Old', mailEnabled: true, groupTypes: ['Unified'] };
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response(current)).mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({ ...current, displayName: 'New' }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.updateGroup(GROUP, { displayName: 'New' })).resolves.toEqual({ accepted: true, changed: true, verified: true });
    expect(fetch.mock.calls[2]).toEqual([`${ORIGIN}/groups/${GROUP}`, expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ displayName: 'New' }) })]);
  });
  it('reads only the fixed service-health endpoint for the verified tenant and strips provider extras', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['ServiceHealth.Read.All'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ value: [{ id: 'Exchange Online', service: 'Exchange Online', status: 'serviceDegradation',
        issues: [{ id: 'EX123', title: 'Mail delay', impactDescription: 'Some mail is delayed', status: 'investigating', lastModifiedDateTime: '2026-09-22T12:00:00Z', secret: 'never-return' }], secret: 'never-return' }] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    const result = await provider.serviceHealth();
    expect(result).toMatchObject({ partial: false, services: [{ service: 'Exchange Online', status: 'serviceDegradation', issues: [{ id: 'EX123' }] }] });
    expect(JSON.stringify(result)).not.toContain('never-return');
    expect(fetch.mock.calls[1]![0]).toBe(`${ORIGIN}/admin/serviceAnnouncement/healthOverviews?$expand=issues`);
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });
  it('fails service health closed on missing permission or wrong tenant, and marks pagination incomplete', async () => {
    for (const [roles, identity, code] of [
      [[], TENANT, 'provider_access_denied'],
      [['ServiceHealth.Read.All'], USER, 'tenant_identity_mismatch'],
    ] as const) {
      const token = `h.${Buffer.from(JSON.stringify({ roles })).toString('base64url')}.s`;
      const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: identity }] }));
      const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
      await expect(provider.serviceHealth()).rejects.toMatchObject({ code });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['ServiceHealth.Read.All'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ value: [], '@odata.nextLink': 'https://attacker.example/next' }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.serviceHealth()).resolves.toMatchObject({ partial: true, services: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('creates one user only in a verified tenant domain and returns a one-time password', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['User.ReadWrite.All'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ value: [{ id: TENANT, verifiedDomains: [{ name: 'example.test', isVerified: true }, { name: 'unverified.test', isVerified: false }] }] }))
      .mockResolvedValueOnce(response({ id: USER, userPrincipalName: 'new@example.test', passwordProfile: { password: 'do-not-echo' } }, 201));
    const fence = vi.fn(async () => {});
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    const result = await provider.createUser({ displayName: 'New User', userPrincipalName: 'new@example.test', usageLocation: 'GB' }, fence);
    expect(result).toMatchObject({ accepted: true, id: USER, userPrincipalName: 'new@example.test', forceChangePasswordNextSignIn: true });
    expect(result.temporaryPassword).toHaveLength(32);
    expect(fence).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
    const body = JSON.parse(fetch.mock.calls[2]![1].body);
    expect(body).toEqual({ accountEnabled: true, displayName: 'New User', mailNickname: 'new', userPrincipalName: 'new@example.test', usageLocation: 'GB', passwordProfile: { password: result.temporaryPassword, forceChangePasswordNextSignIn: true } });
    expect(JSON.stringify(result)).not.toContain('do-not-echo');
  });

  it('rejects unverified domains, missing create permission, and arbitrary create properties without writing', async () => {
    for (const [input, roles] of [
      [{ displayName: 'New User', userPrincipalName: 'new@unverified.test' }, ['User.ReadWrite.All']],
      [{ displayName: 'New User', userPrincipalName: 'new@example.test' }, []],
      [{ displayName: 'New User', userPrincipalName: 'new@example.test', isAdmin: true }, ['User.ReadWrite.All']],
    ] as const) {
      const token = `h.${Buffer.from(JSON.stringify({ roles })).toString('base64url')}.s`;
      const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
        .mockResolvedValueOnce(response({ value: [{ id: TENANT, verifiedDomains: [{ name: 'example.test', isVerified: true }] }] }));
      const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
      await expect(provider.createUser(input as never)).rejects.toBeTruthy();
      expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
    }
  });
  it('assigns only an available subscribed SKU to a user with usage location and verifies readback', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['LicenseAssignment.ReadWrite.All'] })).toString('base64url')}.s`;
    const sku = { id: 'fixture', skuId: SKU, skuPartNumber: 'O365_BUSINESS_PREMIUM', consumedUnits: 2, capabilityStatus: 'Enabled', prepaidUnits: { enabled: 3, suspended: 0, warning: 0 } };
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, usageLocation: 'GB', assignedLicenses: [] }))
      .mockResolvedValueOnce(response({ value: [sku] }))
      .mockResolvedValueOnce(response({ id: USER }, 200))
      .mockResolvedValueOnce(response({ id: USER, assignedLicenses: [{ skuId: SKU }] }));
    const fence = vi.fn(async () => {});
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.assignUserLicense(USER, { skuId: SKU }, fence)).resolves.toEqual({ accepted: true, changed: true, verified: true });
    expect(fence).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[3]).toEqual([`${ORIGIN}/users/${USER}/assignLicense`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ addLicenses: [{ skuId: SKU }], removeLicenses: [] }) })]);
    expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
  });
  it('fails closed before assignment when usage location or seat is unavailable', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['User.ReadWrite.All'] })).toString('base64url')}.s`;
    for (const location of [null, 'GB']) {
      const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
        .mockResolvedValueOnce(response({ id: USER, usageLocation: location, assignedLicenses: [] }))
        .mockResolvedValueOnce(response({ value: [{ id: 'fixture', skuId: SKU, skuPartNumber: 'O365_BUSINESS_PREMIUM', consumedUnits: 3, capabilityStatus: 'Enabled', prepaidUnits: { enabled: 3, suspended: 0, warning: 0 } }] }));
      const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
      await expect(provider.assignUserLicense(USER, { skuId: SKU })).rejects.toMatchObject({ code: location ? 'license_not_available' : 'usage_location_required' });
      expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
    }
  });
  it('does not retry a license write when readback has not converged', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['User.ReadWrite.All'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, usageLocation: 'CA', assignedLicenses: [] }))
      .mockResolvedValueOnce(response({ value: [{ id: 'fixture', skuId: SKU, skuPartNumber: 'O365_BUSINESS_PREMIUM', consumedUnits: 0, capabilityStatus: 'Enabled', prepaidUnits: { enabled: 1, suspended: 0, warning: 0 } }] }))
      .mockResolvedValueOnce(response({ id: USER }))
      .mockResolvedValueOnce(response({ id: USER, assignedLicenses: [] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.assignUserLicense(USER, { skuId: SKU })).resolves.toEqual({ accepted: true, changed: true, verified: false });
    expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
  });
  it.each(['common', 'organizations', '../users', `${TENANT}?evil=1`])('rejects invalid tenant %s', tenantId => {
    const fetch = vi.fn();
    expect(() => createAdminGraphProvider({ tenantId, fetch, acquireToken: vi.fn() })).toThrow('invalid_input');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes uppercase tenant and resource identifiers', async () => {
    const tenant = TENANT.replace('1', 'a'), user = USER.replace('2', 'b');
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: tenant.toUpperCase() }] }))
      .mockResolvedValueOnce(response({ id: user.toUpperCase() }));
    const acquireToken = vi.fn().mockResolvedValue('token');
    const provider = createAdminGraphProvider({ tenantId: tenant.toUpperCase(), fetch, acquireToken });
    expect(await provider.getUser(user.toUpperCase())).toEqual({ id: user });
    expect(acquireToken).toHaveBeenCalledWith(tenant);
    expect(fetch.mock.calls[1][0]).toContain(`/users/${user}?`);
  });

  it('verifies the server-owned tenant before every operation and strips provider extras', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ id: USER, displayName: 'Example', passwordProfile: { password: 'secret' }, roles: ['admin'] }))
      .mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, displayName: 'Example' }));
    expect(await h.provider.getUser(USER)).toEqual({ id: USER, displayName: 'Example' });
    await h.provider.getUser(USER);
    expect(h.acquireToken.mock.calls).toEqual([[TENANT], [TENANT]]);
    expect(h.fetch.mock.calls.map(([url]) => url).filter(url => url === `${ORIGIN}/organization?$select=id`)).toHaveLength(2);
    for (const [url, init] of h.fetch.mock.calls) {
      expect(url.startsWith(`${ORIGIN}/`)).toBe(true);
      expect(init).toMatchObject({ redirect: 'error', timeoutMs: 15000, maxBytes: 1048576, headers: { Authorization: 'Bearer server-owned-token' } });
    }
  });

  it('blocks writes when organization identity is wrong', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ value: [{ id: USER }] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => 'token' });
    await expect(provider.updateUser(USER, { accountEnabled: false })).rejects.toMatchObject({ code: 'tenant_identity_mismatch' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { passwordProfile: { password: 'no' } }, { department: 'Good', arbitrary: true }, { accountEnabled: 'yes' }])('rejects arbitrary or invalid patches before network calls', async update => {
    const h = harness();
    await expect(h.provider.updateUser(USER, update as never)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(h.acquireToken).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('uses only the allowlisted update and reports acceptance', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await h.provider.updateUser(USER, { department: null, accountEnabled: false })).toEqual({ accepted: true });
    expect(h.fetch.mock.calls[1]).toEqual([`${ORIGIN}/users/${USER}`, expect.objectContaining({ method: 'PATCH', body: '{"department":null,"accountEnabled":false}' })]);
  });

  it('resets a password only with the app role, verifies the user and requires next-sign-in change', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['User-PasswordProfile.ReadWrite.All'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, displayName: 'Fixture' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    const result = await provider.resetUserPassword(USER);
    expect(result).toMatchObject({ accepted: true, forceChangePasswordNextSignIn: true });
    expect(result.temporaryPassword).toHaveLength(32);
    expect(result.temporaryPassword).toMatch(/[A-Z]/);
    expect(result.temporaryPassword).toMatch(/[a-z]/);
    expect(result.temporaryPassword).toMatch(/[0-9]/);
    expect(result.temporaryPassword).toMatch(/[!@#$%&*\\-_+]/);
    expect(fetch.mock.calls[2]).toEqual([`${ORIGIN}/users/${USER}`, expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ passwordProfile: { password: result.temporaryPassword, forceChangePasswordNextSignIn: true } }),
    })]);
  });

  it('fails closed without the reset-password app role before reading the target', async () => {
    const h = harness();
    await expect(h.provider.resetUserPassword(USER)).rejects.toMatchObject({ code: 'provider_access_denied' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('revokes sessions through the bounded Graph action with the required role', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['User.RevokeSessions.All'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, displayName: 'Fixture' }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    expect(await provider.revokeUserSessions(USER)).toEqual({ accepted: true });
    expect(fetch.mock.calls[2]).toEqual([`${ORIGIN}/users/${USER}/revokeSignInSessions`, expect.objectContaining({ method: 'POST', body: undefined })]);
  });

  it('fails closed without the session-revocation app role before reading the target', async () => {
    const h = harness();
    await expect(h.provider.revokeUserSessions(USER)).rejects.toMatchObject({ code: 'provider_access_denied' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('sets only the fixed Global Administrator role, requires its app role, and verifies the result', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['RoleManagement.ReadWrite.Directory'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, displayName: 'Fixture' }))
      .mockResolvedValueOnce(response({ value: [{ id: OTHER_ADMIN, principalId: OTHER_ADMIN, roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', directoryScopeId: '/' }] }))
      .mockResolvedValueOnce(response({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, 201))
      .mockResolvedValueOnce(response({ value: [
        { id: OTHER_ADMIN, principalId: OTHER_ADMIN, roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', directoryScopeId: '/' },
        { id: USER, principalId: USER, roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', directoryScopeId: '/' },
      ] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    expect(await provider.setGlobalAdministrator(USER, true)).toEqual({ accepted: true, changed: true, enabled: true });
    expect(fetch.mock.calls[3]).toEqual([`${ORIGIN}/roleManagement/directory/roleAssignments`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ principalId: USER, roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', directoryScopeId: '/' }),
    })]);
    expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
  });

  it('requires the role-management app permission before reading a Global Administrator target', async () => {
    const h = harness();
    await expect(h.provider.setGlobalAdministrator(USER, true)).rejects.toMatchObject({ code: 'provider_access_denied' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('reads a Global Administrator assignment without requiring the write app permission', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, displayName: 'Fixture' }))
      .mockResolvedValueOnce(response({ value: [{ id: USER, principalId: USER, roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', directoryScopeId: '/' }] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => 'read-only-token' });
    await expect(provider.getGlobalAdministrator(USER)).resolves.toEqual({ enabled: true });
    expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
  });

  it('refuses to remove the last Global Administrator without dispatching a write', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['RoleManagement.ReadWrite.Directory'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, displayName: 'Fixture' }))
      .mockResolvedValueOnce(response({ value: [{ id: USER, principalId: USER, roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', directoryScopeId: '/' }] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.setGlobalAdministrator(USER, false)).rejects.toMatchObject({ code: 'last_global_administrator' });
    expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
  });

  it('removes only the target tenant-scope assignment and verifies it is gone', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['RoleManagement.ReadWrite.Directory'] })).toString('base64url')}.s`;
    const targetAssignment = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, displayName: 'Fixture' }))
      .mockResolvedValueOnce(response({ value: [
        { id: targetAssignment, principalId: USER, roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', directoryScopeId: '/' },
        { id: OTHER_ADMIN, principalId: OTHER_ADMIN, roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', directoryScopeId: '/' },
      ] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({ value: [{ id: OTHER_ADMIN, principalId: OTHER_ADMIN, roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', directoryScopeId: '/' }] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    expect(await provider.setGlobalAdministrator(USER, false)).toEqual({ accepted: true, changed: true, enabled: false });
    expect(fetch.mock.calls[3]).toEqual([`${ORIGIN}/roleManagement/directory/roleAssignments/${targetAssignment}`, expect.objectContaining({ method: 'DELETE' })]);
    expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
  });

  it('fails closed when Global Administrator assignment inventory is partial', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['RoleManagement.ReadWrite.Directory'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, displayName: 'Fixture' }))
      .mockResolvedValueOnce(response({ value: [], '@odata.nextLink': `${ORIGIN}/roleManagement/directory/roleAssignments?$skiptoken=untrusted` }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.setGlobalAdministrator(USER, false)).rejects.toMatchObject({ code: 'role_assignment_state_unknown' });
    expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
  });

  it('does not follow hostile pagination links and explicitly marks partial collections', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ value: [{ id: USER, displayName: 'One', accessToken: 'secret' }], '@odata.nextLink': 'https://attacker.example/token' }));
    expect(await h.provider.listUsers()).toEqual({ items: [{ id: USER, displayName: 'One' }], partial: true });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects redirected reads without exposing the provider body', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ error: 'private material' }, 302));
    await expect(h.provider.listUsers()).rejects.toMatchObject({ code: 'provider_rejected', message: 'provider_rejected' });
  });

  it('classifies mutation timeouts as unknown outcomes without retrying', async () => {
    const h = harness();
    h.fetch.mockRejectedValueOnce(new Error('timeout with private bearer token'));
    await expect(h.provider.updateUser(USER, { department: 'Example' })).rejects.toMatchObject({ code: 'unknown_write_outcome', message: 'unknown_write_outcome' });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'provider_access_denied'], [429, 'provider_rate_limited'], [400, 'provider_rejected'], [503, 'unknown_write_outcome']])('classifies write response %s', async (status, code) => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ error: { message: 'private' } }, status as number));
    await expect(h.provider.updateUser(USER, { department: 'Example' })).rejects.toMatchObject({ code, message: code });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('uses $ref for member removal, never the directory object deletion endpoint', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response(staticGroup)).mockResolvedValueOnce(response({ id: USER }))
      .mockResolvedValueOnce(response({ id: USER })).mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({}, 404));
    expect(await h.provider.removeGroupMember(GROUP, USER)).toEqual({ accepted: true, changed: true, verified: true });
    expect(h.fetch.mock.calls[4]).toEqual([`${ORIGIN}/groups/${GROUP}/members/${USER}/$ref`, expect.objectContaining({ method: 'DELETE' })]);
  });

  it('adds only the validated user reference to a static group', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response(staticGroup)).mockResolvedValueOnce(response({ id: USER }))
      .mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({ id: USER }));
    expect(await h.provider.addGroupMember(GROUP, USER)).toEqual({ accepted: true, changed: true, verified: true });
    expect(h.fetch.mock.calls[4]).toEqual([`${ORIGIN}/groups/${GROUP}/members/$ref`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ '@odata.id': `${ORIGIN}/directoryObjects/${USER}` }) })]);
  });

  it.each([{ groupTypes: ['DynamicMembership'] }, { onPremisesSyncEnabled: true }, { isAssignableToRole: true }, { mailEnabled: true }, { isAssignableToRole: undefined }])('denies unsupported group mutations %j', async changed => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ ...staticGroup, ...changed }));
    await expect(h.provider.addGroupMember(GROUP, USER)).rejects.toMatchObject({ code: 'unsupported_group' });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['add', 'remove'] as const)('allows %s for an ordinary group with explicit null role assignability', async action => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ ...staticGroup, isAssignableToRole: null }))
      .mockResolvedValueOnce(response({ id: USER }))
      .mockResolvedValueOnce(action === 'add' ? response({}, 404) : response({ id: USER }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(action === 'add' ? response({ id: USER }) : response({}, 404));
    expect(await (action === 'add' ? h.provider.addGroupMember(GROUP, USER) : h.provider.removeGroupMember(GROUP, USER)))
      .toEqual({ accepted: true, changed: true, verified: true });
    expect(h.fetch).toHaveBeenCalledTimes(6);
    expect(h.fetch.mock.calls[4][1].method).toBe(action === 'add' ? 'POST' : 'DELETE');
  });

  it('rejects malformed role assignability before any membership mutation', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ ...staticGroup, isAssignableToRole: 'false' }));
    await expect(h.provider.addGroupMember(GROUP, USER)).rejects.toMatchObject({ code: 'invalid_provider_response' });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects object identity substitution', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ id: GROUP }));
    await expect(h.provider.getUser(USER)).rejects.toMatchObject({ code: 'invalid_provider_response' });
  });

  it('bounds collection size and strips license detail outside the contract', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ value: [{ id: `${TENANT}_${USER}`, skuId: USER, skuPartNumber: 'STANDARD', consumedUnits: 2, capabilityStatus: 'Enabled', prepaidUnits: { enabled: 3, suspended: 0, warning: 0, secret: 'no' }, servicePlans: ['not exposed'] }] }));
    const result = await h.provider.listLicenses();
    expect(result.partial).toBe(false);
    expect(result.items[0]).not.toHaveProperty('servicePlans');
    expect(result.items[0]?.prepaidUnits).not.toHaveProperty('secret');
    const oversized = harness();
    oversized.fetch.mockResolvedValueOnce(response({ value: Array.from({ length: 101 }, () => ({ id: USER })) }));
    await expect(oversized.provider.listUsers()).rejects.toMatchObject({ code: 'invalid_provider_response' });
  });

  it('bounds token acquisition and redacts credential failures', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: () => new Promise(() => {}) });
    const result = expect(provider.listUsers()).rejects.toMatchObject({ code: 'credential_unavailable' });
    await vi.advanceTimersByTimeAsync(15000);
    await result;
    expect(fetch).not.toHaveBeenCalled();
  });
});
