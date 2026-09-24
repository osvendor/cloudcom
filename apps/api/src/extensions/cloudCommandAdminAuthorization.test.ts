import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    rows: [] as unknown[][],
    withAuthDbAccessContext: vi.fn(async (_auth: unknown, work: () => Promise<unknown>) => work()),
    getUserPermissions: vi.fn(),
    hasPermission: vi.fn((permissions: { allowed?: boolean }) => permissions.allowed === true),
    hasSatisfiedMfa: vi.fn((auth: { mfaSatisfied?: boolean }) => auth.mfaSatisfied === true),
  },
}));

vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => state.rows.shift() ?? [] }) }) }) },
}));
vi.mock('../db/schema', () => ({ users: { id: 'user-id', status: 'user-status', isPlatformAdmin: 'platform-admin' }, organizations: { id: 'org-id', partnerId: 'partner-id', deletedAt: 'deleted-at', status: 'org-status' } }));
vi.mock('../middleware/auth', () => ({ hasSatisfiedMfa: state.hasSatisfiedMfa, withAuthDbAccessContext: state.withAuthDbAccessContext }));
vi.mock('../services/permissions', () => ({ getUserPermissions: state.getUserPermissions, hasPermission: state.hasPermission }));

import { authorizeCloudCommandAdministration } from './cloudCommandAdminAuthorization';

const orgId = '11111111-1111-4111-8111-111111111111';
const otherOrgId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
function request(overrides: Record<string, unknown> = {}) {
  return {
    orgId,
    auth: { user: { id: actorId }, principal: { kind: 'user_session' }, partnerId: null, orgId, scope: 'organization', mfaSatisfied: true, allowedSiteIds: undefined, canAccessOrg: (id: string) => id === orgId },
    authorization: { allowedSiteIds: undefined },
    ...overrides,
  } as any;
}
function permit(overrides: Record<string, unknown> = {}) {
  return { allowed: true, allowedSiteIds: undefined, scope: 'organization', orgId, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows.length = 0;
  state.getUserPermissions.mockResolvedValue(permit());
});

describe('Cloud Command administration host authorization', () => {
  it('allows a live direct user session manager under the authenticated DB context', async () => {
    state.rows.push([{ status: 'active', isPlatformAdmin: false }], [{ partnerId: 'partner-a' }]);
    await expect(authorizeCloudCommandAdministration(request(), orgId, true)).resolves.toEqual({ actorId });
    expect(state.withAuthDbAccessContext).toHaveBeenCalledWith(expect.objectContaining({ user: { id: actorId } }), expect.any(Function));
    expect(state.getUserPermissions).toHaveBeenCalledWith(actorId, { scope: 'organization', partnerId: undefined, orgId }, { bypassCache: true });
  });

  it('rejects a non-session principal before database permission evaluation', async () => {
    const input = request({ auth: { ...request().auth, principal: { kind: 'api_key' } } });
    await expect(authorizeCloudCommandAdministration(input, orgId, true)).resolves.toBeNull();
    expect(state.withAuthDbAccessContext).not.toHaveBeenCalled();
    expect(state.getUserPermissions).not.toHaveBeenCalled();
  });

  it('rejects a disabled user even when their session and permission snapshot otherwise look valid', async () => {
    state.rows.push([{ status: 'disabled', isPlatformAdmin: false }], [{ partnerId: 'partner-a' }]);
    await expect(authorizeCloudCommandAdministration(request(), orgId, false)).resolves.toBeNull();
    expect(state.getUserPermissions).not.toHaveBeenCalled();
  });

  it('rejects missing organization permission', async () => {
    state.rows.push([{ status: 'active', isPlatformAdmin: false }], [{ partnerId: 'partner-a' }]);
    state.getUserPermissions.mockResolvedValue(permit({ allowed: false }));
    await expect(authorizeCloudCommandAdministration(request(), orgId, false)).resolves.toBeNull();
  });

  it.each([
    ['request organization mismatch', request({ orgId: otherOrgId })],
    ['organization-scoped session mismatch', request({ auth: { ...request().auth, orgId: otherOrgId } })],
    ['site-restricted session', request({ auth: { ...request().auth, allowedSiteIds: ['site-1'] } })],
    ['site-restricted extension authorization', request({ authorization: { allowedSiteIds: ['site-1'] } })],
  ])('rejects %s before granting administration access', async (_label, input) => {
    await expect(authorizeCloudCommandAdministration(input, orgId, true)).resolves.toBeNull();
  });

  it('rejects a site-ceiling permission snapshot and a selected-org scope excluding this organization', async () => {
    state.rows.push([{ status: 'active', isPlatformAdmin: false }], [{ partnerId: 'partner-a' }]);
    state.getUserPermissions.mockResolvedValue(permit({ allowedSiteIds: ['site-1'] }));
    await expect(authorizeCloudCommandAdministration(request(), orgId, false)).resolves.toBeNull();
    state.rows.push([{ status: 'active', isPlatformAdmin: false }], [{ partnerId: 'partner-a' }]);
    state.getUserPermissions.mockResolvedValue(permit({ scope: 'partner', orgAccess: 'selected', allowedOrgIds: [otherOrgId] }));
    await expect(authorizeCloudCommandAdministration(request({ auth: { ...request().auth, scope: 'partner', orgId: undefined, partnerId: 'partner-a' } }), orgId, false)).resolves.toBeNull();
  });
});
