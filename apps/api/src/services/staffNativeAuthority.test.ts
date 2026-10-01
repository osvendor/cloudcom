import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
const mocks = vi.hoisted(() => ({ rows: [] as unknown[][], permissions: vi.fn(), revoked: vi.fn(),
  familyRevoked: vi.fn(), passwordChanged: vi.fn(), partner: vi.fn(), tenant: vi.fn(),
  policy: vi.fn(), trust: vi.fn(), trustMode: vi.fn(), mfaPolicy: vi.fn() }));
vi.mock('../db', () => ({ runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(), db: { select: () => ({
    from: () => ({ where: () => ({ limit: async () => mocks.rows.shift() ?? [] }) }),
  }) } }));
vi.mock('./permissions', async importOriginal => ({ ...await importOriginal<typeof import('./permissions')>(),
  getUserPermissions: mocks.permissions }));
vi.mock('./tokenRevocation', () => ({ isFamilyRevoked: mocks.familyRevoked,
  isUserTokenRevoked: mocks.revoked, isTokenIssuedBeforePasswordChange: mocks.passwordChanged }));
vi.mock('./tenantStatus', () => ({ getActivePartner: mocks.partner, getActiveOrgTenant: mocks.tenant }));
vi.mock('./remoteAccessPolicy', () => ({ checkRemoteAccess: mocks.policy }));
vi.mock('./partnerTrust', () => ({ evaluateCapability: mocks.trust }));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode: mocks.trustMode }));
vi.mock('./mfaPolicy', () => ({ getEffectiveMfaPolicy: mocks.mfaPolicy }));
import { authorizeStaffNativeDevice, revalidateStaffNativePrincipal, staffNativePrincipalFromAuth } from './staffNativeAuthority';
const id = '11111111-1111-4111-8111-111111111111';
const partnerId = '22222222-2222-4222-8222-222222222222';
const orgId = '33333333-3333-4333-8333-333333333333';
const deviceId = '44444444-4444-4444-8444-444444444444';
const familyId = '55555555-5555-4555-8555-555555555555';
function auth() { return { principal: { kind: 'user_session' }, scope: 'partner', partnerId, orgId: null,
  user: { id }, token: { sub: id, scope: 'partner', partnerId, orgId: null, mfa: true,
    aep: 1, mep: 0, sid: familyId, iat: Math.floor(Date.now() / 1000) },
} as AuthContext; }
function principal() { return staffNativePrincipalFromAuth(auth()); }
const user = () => ({ id, status: 'active', authEpoch: 1, mfaEpoch: 0, passwordChangedAt: null });
const device = () => ({ id: deviceId, orgId, status: 'online', agentTokenSuspendedAt: null, quarantinedAt: null });
const perms = () => ({ scope: 'partner', partnerId, orgId: null, orgAccess: 'all',
  permissions: [{ resource: 'remote', action: 'access' }] });
beforeEach(() => {
  vi.clearAllMocks(); mocks.rows = [[user()], [device()]];
  mocks.permissions.mockResolvedValue(perms()); mocks.revoked.mockResolvedValue(false);
  mocks.familyRevoked.mockResolvedValue(false); mocks.passwordChanged.mockReturnValue(false);
  mocks.partner.mockResolvedValue({ id: partnerId }); mocks.tenant.mockResolvedValue({ partnerId });
  mocks.policy.mockResolvedValue({ allowed: true }); mocks.trust.mockResolvedValue({ allow: true });
  mocks.trustMode.mockReturnValue('enforce');
  mocks.mfaPolicy.mockResolvedValue({ required: false });
});
describe('staff native authority is separate from customer assignment authority', () => {
  it('admits a current partner staff member for an owned customer device', async () => {
    expect((await authorizeStaffNativeDevice(principal(), deviceId)).device.id).toBe(deviceId);
    expect(mocks.permissions).toHaveBeenCalledWith(id, { scope: 'partner', partnerId }, { bypassCache: true });
  });
  it.each(['client_user', 'api_key', 'oauth_grant', 'agent', 'helper', 'system', 'unknown'])('rejects %s browser handoff', kind => {
    expect(() => staffNativePrincipalFromAuth({ ...auth(), principal: { kind } } as AuthContext)).toThrow();
  });
  it.each(['organization', 'system'])('cannot promote a %s session', scope => {
    expect(() => staffNativePrincipalFromAuth({ ...auth(), scope } as AuthContext)).toThrow();
  });
  it('requires existing MFA assurance and matching token identity', () => {
    for (const change of [{ mfa: false }, { sub: orgId }, { partnerId: orgId }, { sid: undefined }, { aep: undefined }]) {
      expect(() => staffNativePrincipalFromAuth({ ...auth(), token: { ...auth().token!, ...change } })).toThrow();
    }
  });
  it('rejects a customer-shaped or expired native record', async () => {
    await expect(revalidateStaffNativePrincipal({ ...principal(), kind: 'portal' } as never)).rejects.toThrow();
    await expect(revalidateStaffNativePrincipal({ ...principal(), expiresAt: Date.now() - 1 })).rejects.toThrow();
    expect(mocks.permissions).not.toHaveBeenCalled();
  });
  it.each([{ status: 'disabled' }, { authEpoch: 2 }, { mfaEpoch: 1 }])('rejects changed live identity %j', async change => {
    mocks.rows = [[{ ...user(), ...change }]];
    await expect(revalidateStaffNativePrincipal(principal())).rejects.toThrow();
  });
  it.each(['revoked', 'familyRevoked', 'passwordChanged'] as const)('rejects %s', async key => {
    mocks[key].mockResolvedValue(true);
    if (key === 'passwordChanged') mocks[key].mockReturnValue(true);
    await expect(revalidateStaffNativePrincipal(principal())).rejects.toThrow();
  });
  it.each([null, { ...perms(), permissions: [] }, { ...perms(), orgAccess: 'none' },
    { ...perms(), scope: 'organization' }])('rejects lost membership or remote authority', async permission => {
    mocks.permissions.mockResolvedValue(permission);
    await expect(revalidateStaffNativePrincipal(principal())).rejects.toThrow();
  });
  it('does not let all-org permission cross the MSP boundary', async () => {
    mocks.tenant.mockResolvedValue({ partnerId: orgId });
    await expect(authorizeStaffNativeDevice(principal(), deviceId)).rejects.toThrow();
    expect(mocks.policy).not.toHaveBeenCalled();
  });
  it('honors selected organizations', async () => {
    mocks.permissions.mockResolvedValue({ ...perms(), orgAccess: 'selected', allowedOrgIds: [partnerId] });
    await expect(authorizeStaffNativeDevice(principal(), deviceId)).rejects.toThrow();
  });
  it('requires enrollment when the partner MFA policy changes', async () => {
    mocks.mfaPolicy.mockResolvedValue({ required: true });
    await expect(revalidateStaffNativePrincipal(principal())).rejects.toThrow();
  });
  it.each([{ status: 'offline' }, { agentTokenSuspendedAt: new Date() }, { quarantinedAt: new Date() }])('rejects unavailable device %j', async change => {
    mocks.rows = [[user()], [{ ...device(), ...change }]];
    await expect(authorizeStaffNativeDevice(principal(), deviceId)).rejects.toThrow();
  });
  it.each(['partner', 'tenant', 'policy', 'trust'] as const)('honors live %s denial', async key => {
    mocks[key].mockResolvedValue(key === 'policy' ? { allowed: false } : key === 'trust' ? { allow: false } : null);
    await expect(authorizeStaffNativeDevice(principal(), deviceId)).rejects.toThrow();
  });
});
