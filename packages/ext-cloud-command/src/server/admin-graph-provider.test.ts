import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminGraphProvider } from './admin-graph-provider';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';
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
    h.fetch.mockResolvedValueOnce(response(staticGroup)).mockResolvedValueOnce(response({ id: USER })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await h.provider.removeGroupMember(GROUP, USER)).toEqual({ accepted: true });
    expect(h.fetch.mock.calls[3]).toEqual([`${ORIGIN}/groups/${GROUP}/members/${USER}/$ref`, expect.objectContaining({ method: 'DELETE' })]);
  });

  it('adds only the validated user reference to a static group', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response(staticGroup)).mockResolvedValueOnce(response({ id: USER })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await h.provider.addGroupMember(GROUP, USER);
    expect(h.fetch.mock.calls[3]).toEqual([`${ORIGIN}/groups/${GROUP}/members/$ref`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ '@odata.id': `${ORIGIN}/directoryObjects/${USER}` }) })]);
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
      .mockResolvedValueOnce(response({ id: USER })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await (action === 'add' ? h.provider.addGroupMember(GROUP, USER) : h.provider.removeGroupMember(GROUP, USER)))
      .toEqual({ accepted: true });
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(h.fetch.mock.calls[3][1].method).toBe(action === 'add' ? 'POST' : 'DELETE');
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
