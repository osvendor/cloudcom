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
  it('lists current group members and owners with bounded same-group pages and no writes', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['Group.Read.All'] })).toString('base64url')}.s`;
    const memberPath = `/groups/${GROUP}/members`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ ...staticGroup, groupTypes: ['Unified'] }))
      .mockResolvedValueOnce(response({ value: [
        { id: USER, '@odata.type': '#microsoft.graph.user', displayName: 'QA Owner', userPrincipalName: 'qa@example.test', secret: 'omit' },
        { id: OTHER_ADMIN, '@odata.type': '#microsoft.graph.device' },
      ], '@odata.nextLink': `${ORIGIN}${memberPath}?$skiptoken=next` }))
      .mockResolvedValueOnce(response({ value: [{ id: USER, '@odata.type': '#microsoft.graph.user', displayName: 'QA Owner' }] }))
      .mockResolvedValueOnce(response({ value: [] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    const result = await provider.listGroupPeople(GROUP);
    expect(result).toMatchObject({ complete: true, otherMemberCount: 1,
      members: [{ id: USER, displayName: 'QA Owner', userPrincipalName: 'qa@example.test' }],
      owners: [{ id: USER, displayName: 'QA Owner' }] });
    expect(JSON.stringify(result)).not.toContain('omit');
    expect(fetch.mock.calls.map(([url]) => url)).toContain(`${ORIGIN}${memberPath}?$skiptoken=next`);
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });
  it('marks group membership incomplete when Graph sends a foreign cursor', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['Group.Read.All'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ ...staticGroup, groupTypes: ['Unified'] }))
      .mockResolvedValueOnce(response({ value: [{ id: USER, '@odata.type': '#microsoft.graph.user' }],
        '@odata.nextLink': 'https://attacker.example/next?$skiptoken=x' }))
      .mockResolvedValueOnce(response({ value: [] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.listGroupPeople(GROUP)).resolves.toMatchObject({ complete: false, members: [{ id: USER }] });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
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
    expect(fetch.mock.calls[1]![0]).toBe(`${ORIGIN}/admin/serviceAnnouncement/healthOverviews?$expand=issues($select=id,title,impactDescription,status,lastModifiedDateTime)`);
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
      .mockResolvedValueOnce(response({ value: [{ id: TENANT, verifiedDomains: [{ name: 'example.test' }] }] }))
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

  it('loads sign-in domains from the verifiedDomains shape returned by Graph', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ value: [{ id: TENANT, verifiedDomains: [{ name: 'Example.Test', isDefault: true, type: 'Managed' }] }] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => 'token' });
    await expect(provider.listVerifiedUserDomains()).resolves.toEqual({ domains: ['example.test'] });
  });

  it('rejects unverified domains, missing create permission, and arbitrary create properties without writing', async () => {
    for (const [input, roles] of [
      [{ displayName: 'New User', userPrincipalName: 'new@unverified.test' }, ['User.ReadWrite.All']],
      [{ displayName: 'New User', userPrincipalName: 'new@example.test' }, []],
      [{ displayName: 'New User', userPrincipalName: 'new@example.test', isAdmin: true }, ['User.ReadWrite.All']],
    ] as const) {
      const token = `h.${Buffer.from(JSON.stringify({ roles })).toString('base64url')}.s`;
      const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
        .mockResolvedValueOnce(response({ value: [{ id: TENANT, verifiedDomains: [{ name: 'example.test' }] }] }));
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
  it('checks later subscribed-license pages before assigning an available seat', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['LicenseAssignment.ReadWrite.All'] })).toString('base64url')}.s`;
    const firstSku = { id: 'fixture', skuId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', skuPartNumber: 'OTHER',
      consumedUnits: 0, capabilityStatus: 'Enabled', prepaidUnits: { enabled: 1, suspended: 0, warning: 0 } };
    const selected = { ...firstSku, skuId: SKU, skuPartNumber: 'O365_BUSINESS_PREMIUM' };
    const firstPath = '/subscribedSkus?$select=id,skuId,skuPartNumber,consumedUnits,capabilityStatus,prepaidUnits';
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, usageLocation: 'GB', assignedLicenses: [] }))
      .mockResolvedValueOnce(response({ value: Array(100).fill(firstSku),
        '@odata.nextLink': `${ORIGIN}${firstPath}&$skiptoken=page2` }))
      .mockResolvedValueOnce(response({ value: [selected] }))
      .mockResolvedValueOnce(response({ id: USER }, 200))
      .mockResolvedValueOnce(response({ id: USER, assignedLicenses: [{ skuId: SKU }] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.assignUserLicense(USER, { skuId: SKU })).resolves.toMatchObject({ accepted: true, verified: true });
    expect(fetch.mock.calls[3]![0]).toContain('$skiptoken=page2');
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
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
  it('lists direct and inherited licenses and removes only a confirmed direct assignment', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['LicenseAssignment.ReadWrite.All'] })).toString('base64url')}.s`;
    const sku = { id: 'fixture', skuId: SKU, skuPartNumber: 'O365_BUSINESS_PREMIUM', consumedUnits: 1, capabilityStatus: 'Enabled', prepaidUnits: { enabled: 2, suspended: 0, warning: 0 } };
    const group = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const states = [{ skuId: SKU, assignedByGroup: null, state: 'Active' }, { skuId: SKU, assignedByGroup: group, state: 'Active' }];
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, licenseAssignmentStates: states }))
      .mockResolvedValueOnce(response({ value: [sku] }))
      .mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, licenseAssignmentStates: states }))
      .mockResolvedValueOnce(response({ id: USER }))
      .mockResolvedValueOnce(response({ id: USER, licenseAssignmentStates: [states[1]] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    expect(await provider.getUserLicenses(USER)).toEqual({ items: [
      { skuId: SKU, name: 'Business Standard', assignedByGroup: null, state: 'Active' },
      { skuId: SKU, name: 'Business Standard', assignedByGroup: group, state: 'Active' },
    ] });
    await expect(provider.removeUserLicense(USER, SKU)).resolves.toEqual({ accepted: true, changed: true, verified: true });
    expect(fetch.mock.calls[5]).toEqual([`${ORIGIN}/users/${USER}/assignLicense`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ addLicenses: [], removeLicenses: [SKU] }),
    })]);
    expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
  });
  it('refuses group-only license removal and unknown assignment state before any write', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['LicenseAssignment.ReadWrite.All'] })).toString('base64url')}.s`;
    const group = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    for (const states of [[{ skuId: SKU, assignedByGroup: group }], undefined]) {
      const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
        .mockResolvedValueOnce(response({ id: USER, ...(states ? { licenseAssignmentStates: states } : {}) }));
      const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
      await expect(provider.removeUserLicense(USER, SKU)).rejects.toMatchObject({ code: states ? 'license_inherited' : 'license_assignment_state_unknown' });
      expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
    }
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

  it('uses the Graph role filter and accepts opaque assignment IDs while ignoring scoped roles', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER }))
      .mockResolvedValueOnce(response({ value: [
        { id: 'assignment_opaque-1', principalId: USER, roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', directoryScopeId: '/administrativeUnits/33333333-3333-4333-8333-333333333333' },
      ] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => 'read-only-token' });
    await expect(provider.getGlobalAdministrator(USER)).resolves.toEqual({ enabled: false });
    expect(fetch.mock.calls[2]![0]).toContain("$filter=roleDefinitionId%20eq%20'62e90394-69f5-4237-9190-012177145e10'");
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
    expect(await h.provider.listUsers()).toEqual({ items: [{ id: USER, displayName: 'One', licenseSummary: null, oneDrive: null }], partial: true });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('follows only a bounded cursor for the same Graph directory query', async () => {
    const h = harness();
    // The provider's fixed select list is read from its first request so this
    // fixture remains tied to the real allowlisted projection.
    h.fetch.mockImplementationOnce(async (url: string) => {
      const query = new URL(url);
      expect(query.pathname).toBe('/v1.0/users');
      expect(query.searchParams.get('$top')).toBe('100');
      const next = new URL(url);
      next.searchParams.set('$skiptoken', 'page-2');
      return response({ value: [{ id: USER, displayName: 'First' }], '@odata.nextLink': next.href });
    }).mockResolvedValueOnce(response({ value: [{ id: OTHER_ADMIN, displayName: 'Second' }] }));
    const result = await h.provider.listUsers();
    expect(result).toMatchObject({ partial: false, items: [{ id: USER }, { id: OTHER_ADMIN }] });
    expect(new URL(h.fetch.mock.calls[2]![0]).searchParams.get('$skiptoken')).toBe('page-2');
  });

  it('classifies mail-enabled groups for the combined directory', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ value: [
      { ...staticGroup, mailEnabled: true, securityEnabled: false, groupTypes: ['Unified'], displayName: 'Team' },
      { ...staticGroup, id: OTHER_ADMIN, mailEnabled: true, securityEnabled: false, displayName: 'List' },
      { ...staticGroup, id: USER, displayName: 'Security' },
      { ...staticGroup, id: '33333333-3333-4333-8333-333333333333', mailEnabled: true, securityEnabled: true, displayName: 'Secure mail' },
    ] }));
    const result = await h.provider.listGroups();
    expect(result.items.map(item => item.groupKind)).toEqual(['Microsoft 365 group', 'Distribution list', 'Security group', 'Mail-enabled security group']);
  });

  it('returns account type and resolved licenses without exposing assigned-license objects', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ value: [
      { id: USER, displayName: 'Licensed', userType: 'Member', assignedLicenses: [{ skuId: SKU, disabledPlans: ['private'] }] },
      { id: OTHER_ADMIN, displayName: 'Shared identity', userType: 'Member', assignedLicenses: [] },
    ] }))
      .mockResolvedValueOnce(response({ value: [{ id: 'catalog', skuId: SKU.toUpperCase(), skuPartNumber: 'BUSINESS', consumedUnits: 1,
        capabilityStatus: 'Enabled', prepaidUnits: { enabled: 2, suspended: 0, warning: 0 } }] }));
    const result = await h.provider.listUsers();
    expect(result).toEqual({ partial: false, items: [
      { id: USER, displayName: 'Licensed', userType: 'Member', licenseSummary: 'BUSINESS · 1/2 assigned', oneDrive: null },
      { id: OTHER_ADMIN, displayName: 'Shared identity', userType: 'Member', licenseSummary: 'Unlicensed', oneDrive: null },
    ] });
    expect(JSON.stringify(result)).not.toContain('disabledPlans');
    expect(JSON.stringify(result)).not.toContain('assignedLicenses');
    expect(h.fetch.mock.calls[1]![0]).toContain('userType,assignedLicenses');
  });

  it('uses original Cloud Command license names and hides free or unbounded products', async () => {
    const h = harness();
    const standard = { id: 'standard', skuId: SKU, skuPartNumber: 'O365_BUSINESS_PREMIUM', consumedUnits: 2,
      capabilityStatus: 'Enabled', prepaidUnits: { enabled: 3, suspended: 0, warning: 0 } };
    const free = { ...standard, id: 'free', skuId: GROUP, skuPartNumber: 'FLOW_FREE', prepaidUnits: { ...standard.prepaidUnits, enabled: 10000 } };
    h.fetch.mockResolvedValueOnce(response({ value: [{ id: USER, assignedLicenses: [{ skuId: SKU }, { skuId: GROUP }] }] }))
      .mockResolvedValueOnce(response({ value: [standard, free] }));
    const result = await h.provider.listUsers();
    expect(result.items[0]).toMatchObject({ licenseSummary: 'Business Standard · 2/3 assigned' });
  });

  it('keeps the user inventory readable when the SKU catalog cannot be read', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ value: [{ id: USER, assignedLicenses: [{ skuId: SKU }] }] }))
      .mockResolvedValueOnce(response({ error: 'not allowed' }, 403));
    await expect(h.provider.listUsers()).resolves.toEqual({ partial: false, items: [{ id: USER, licenseSummary: null, oneDrive: null }] });
  });

  it('joins a bounded OneDrive report only with the existing enterprise-app report role', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['Reports.Read.All'] })).toString('base64url')}.s`;
    const csv = ['Report Refresh Date,Site URL,Owner Display Name,Is Deleted,Last Activity Date,File Count,Active File Count,Storage Used (Byte),Storage Allocated (Byte),Owner Principal Name,Report Period',
      '2026-09-24,,,,2026-09-23,1,1,1073741824,2147483648,ada@example.test,7'].join('\n');
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ value: [{ id: USER, userPrincipalName: 'Ada@Example.Test', assignedLicenses: [] }] }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://reports.office.com/data/download/report-id' } }))
      .mockResolvedValueOnce(new Response(csv));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.listUsers()).resolves.toEqual({ partial: false, items: [
      { id: USER, userPrincipalName: 'Ada@Example.Test', licenseSummary: 'Unlicensed', oneDrive: '1.0 GB' },
    ] });
    expect(fetch.mock.calls[3]![0]).toBe('https://reports.office.com/data/download/report-id');
    expect(fetch.mock.calls[3]![1].headers).toBeUndefined();
  });

  it('accepts the current Microsoft report host and Site Id column without forwarding the bearer token', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['Reports.Read.All'] })).toString('base64url')}.s`;
    const csv = ['Report Refresh Date,Site Id,Site URL,Owner Display Name,Is Deleted,Last Activity Date,File Count,Active File Count,Storage Used (Byte),Storage Allocated (Byte),Owner Principal Name,Report Period',
      '2026-09-25,site-id,,,False,2026-09-24,1,1,2048,4096,ada@example.test,7'].join('\n');
    const location = 'https://reportsncu.office.com/data/v1.0/download?opaque=report-id';
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ value: [{ id: USER, userPrincipalName: 'Ada@Example.Test', assignedLicenses: [] }] }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }))
      .mockResolvedValueOnce(new Response(csv));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.listUsers()).resolves.toEqual({ partial: false, items: [
      { id: USER, userPrincipalName: 'Ada@Example.Test', licenseSummary: 'Unlicensed', oneDrive: '2.0 KB' },
    ] });
    expect(fetch.mock.calls[3]![0]).toBe(location);
    expect(fetch.mock.calls[3]![1].headers).toBeUndefined();
  });

  it('identifies an anonymized Microsoft report rather than inventing a user size', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['Reports.Read.All'] })).toString('base64url')}.s`;
    const csv = ['Report Refresh Date,Site Id,Site URL,Owner Display Name,Is Deleted,Last Activity Date,File Count,Active File Count,Storage Used (Byte),Storage Allocated (Byte),Owner Principal Name,Report Period',
      '2026-09-25,site-id,,,False,2026-09-24,1,1,2048,4096,anonymous-owner,7'].join('\n');
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ value: [{ id: USER, userPrincipalName: 'ada@example.test', assignedLicenses: [] }] }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://reportsncu.office.com/data/v1.0/download?opaque=report-id' } }))
      .mockResolvedValueOnce(new Response(csv));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.listUsers()).resolves.toMatchObject({ items: [
      { id: USER, oneDrive: 'Names concealed in Microsoft reports' },
    ] });
  });

  it('reads a licensed account drive quota directly without changing report privacy', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, assignedLicenses: [{ skuId: SKU }] }))
      .mockResolvedValueOnce(response({ id: 'drive', quota: { used: 1073741824 } }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => 'token' });
    await expect(provider.getUserDriveUsage(USER)).resolves.toEqual({ oneDrive: '1.0 GB' });
    expect(fetch.mock.calls[2]![0]).toBe(`${ORIGIN}/users/${USER}/drive`);
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });

  it('returns only a tenant user OneDrive link from a trusted SharePoint host', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, assignedLicenses: [] }))
      .mockResolvedValueOnce(response({ webUrl: 'https://tenant-my.sharepoint.com/personal/qa' }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => 'token' });
    await expect(provider.getUserDriveLink(USER)).resolves.toEqual({ url: 'https://tenant-my.sharepoint.com/personal/qa' });
    expect(fetch.mock.calls.map(([url]) => url)).toContain(`${ORIGIN}/users/${USER}/drive`);
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    const rejectedFetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ id: USER, assignedLicenses: [] }))
      .mockResolvedValueOnce(response({ webUrl: 'https://evil.example/steal' }));
    await expect(createAdminGraphProvider({ tenantId: TENANT, fetch: rejectedFetch, acquireToken: async () => 'token' })
      .getUserDriveLink(USER)).rejects.toMatchObject({ code: 'invalid_provider_response' });
  });

  it('reads a bounded batch of known tenant users with one identity check', async () => {
    const fetch = vi.fn(async (url: string) => url.includes('/organization?')
      ? response({ value: [{ id: TENANT }] })
      : url.endsWith(`/users/${USER}/drive`) ? response({ quota: { used: 1073741824 } })
      : new Response(null, { status: 404 }));
    const acquireToken = vi.fn(async () => 'token');
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken });
    await expect(provider.getKnownLicensedDriveUsage([USER, OTHER_ADMIN, USER])).resolves.toEqual({
      [USER]: '1.0 GB', [OTHER_ADMIN]: 'Not provisioned',
    });
    expect(acquireToken).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.filter(([url]) => url.includes('/organization?'))).toHaveLength(1);
    expect(fetch.mock.calls).toHaveLength(3);
  });

  it('distinguishes unlicensed, unprovisioned, and unavailable OneDrive accounts', async () => {
    const cases = [
      { licenses: [], drive: undefined, expected: 'Not licensed', calls: 2 },
      { licenses: [{ skuId: SKU }], drive: new Response(null, { status: 404 }), expected: 'Not provisioned', calls: 3 },
      { licenses: [{ skuId: SKU }], drive: response({ error: 'denied' }, 403), expected: 'Unavailable', calls: 3 },
    ];
    for (const item of cases) {
      const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
        .mockResolvedValueOnce(response({ id: USER, assignedLicenses: item.licenses }));
      if (item.drive) fetch.mockResolvedValueOnce(item.drive);
      const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => 'token' });
      await expect(provider.getUserDriveUsage(USER)).resolves.toEqual({ oneDrive: item.expected });
      expect(fetch).toHaveBeenCalledTimes(item.calls);
    }
  });

  it('does not follow an untrusted OneDrive report redirect or block the directory', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['Reports.Read.All'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ value: [{ id: USER, userPrincipalName: 'ada@example.test', assignedLicenses: [] }] }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://attacker.example/data/download/report-id' } }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.listUsers()).resolves.toMatchObject({ items: [{ id: USER, oneDrive: null }] });
    expect(fetch).toHaveBeenCalledTimes(3);
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

  it('adds an owner only to a Microsoft 365 group with the app role and verifies the owner reference', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['Group.ReadWrite.All', 'User.Read.All'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ ...staticGroup, mailEnabled: true, securityEnabled: false, groupTypes: ['Unified'] }))
      .mockResolvedValueOnce(response({ id: USER }))
      .mockResolvedValueOnce(response({ value: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({ value: [{ id: USER }] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.addGroupOwner(GROUP, USER)).resolves.toEqual({ accepted: true, changed: true, verified: true });
    expect(fetch.mock.calls[4]).toEqual([`${ORIGIN}/groups/${GROUP}/owners/$ref`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ '@odata.id': `${ORIGIN}/users/${USER}` }) })]);
  });

  it('refuses to remove the last owner or rely on an incomplete owners list', async () => {
    for (const incomplete of [false, true]) {
      const token = `h.${Buffer.from(JSON.stringify({ roles: ['Group.ReadWrite.All', 'User.Read.All'] })).toString('base64url')}.s`;
      const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
        .mockResolvedValueOnce(response({ ...staticGroup, mailEnabled: true, securityEnabled: false, groupTypes: ['Unified'] }))
        .mockResolvedValueOnce(response({ id: USER }))
        .mockResolvedValueOnce(response({ value: [{ id: USER }], ...(incomplete ? { '@odata.nextLink': 'opaque' } : {}) }));
      const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
      await expect(provider.removeGroupOwner(GROUP, USER)).rejects.toMatchObject({ code: incomplete ? 'invalid_provider_response' : 'last_group_owner' });
      expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
    }
  });
  it('removes an owner by reference only when another owner remains', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ roles: ['Group.ReadWrite.All', 'User.Read.All'] })).toString('base64url')}.s`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }))
      .mockResolvedValueOnce(response({ ...staticGroup, mailEnabled: true, securityEnabled: false, groupTypes: ['Unified'] }))
      .mockResolvedValueOnce(response({ id: USER }))
      .mockResolvedValueOnce(response({ value: [{ id: USER }, { id: OTHER_ADMIN }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({ value: [{ id: OTHER_ADMIN }] }));
    const provider = createAdminGraphProvider({ tenantId: TENANT, fetch, acquireToken: async () => token });
    await expect(provider.removeGroupOwner(GROUP, USER)).resolves.toEqual({ accepted: true, changed: true, verified: true });
    expect(fetch.mock.calls[4]).toEqual([`${ORIGIN}/groups/${GROUP}/owners/${USER}/$ref`, expect.objectContaining({ method: 'DELETE' })]);
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
