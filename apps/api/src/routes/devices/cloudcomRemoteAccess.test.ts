import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const state = vi.hoisted(() => ({
  device: null as Record<string, unknown> | null,
  settings: undefined as any,
  readSettings: vi.fn(), audit: vi.fn(),
}));
vi.mock('../../db', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => state.device ? [state.device] : [] }) }) }),
} }));
// Use the REAL org/site helper against a simulated database. Guard middleware
// is replaced with controllable gates; upstream auth internals have their own tests.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (c.req.header('x-test-deny') === 'auth') return c.json({ error: 'unauthorized' }, 401);
    c.set('auth', { scope: 'organization', orgId: 'org-a', canAccessOrg: (id: string) => id === 'org-a' });
    return next();
  },
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes('organization') || c.req.header('x-test-deny') === 'scope') return c.json({}, 403);
    return next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    expect(`${resource}:${action}`).toBe('remote:access');
    if (c.req.header('x-test-deny') === 'permission') return c.json({}, 403);
    c.set('permissions', { allowedSiteIds: ['site-a'] });
    return next();
  },
  requireMfa: () => async (c: any, next: any) => c.req.header('x-test-deny') === 'mfa' ? c.json({}, 403) : next(),
}));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { REMOTE_ACCESS: { resource: 'remote', action: 'access' } },
  canAccessSite: (permissions: any, id: string) => permissions.allowedSiteIds.includes(id),
}));
vi.mock('../../services/partnerTrust', () => ({ requireCapability: (capability: string) => async (c: any, next: any) => {
  expect(capability).toBe('remote_control');
  return c.req.header('x-test-deny') === 'trust' ? c.json({}, 403) : next();
} }));
vi.mock('../../services/remoteAccessProviders', () => ({ readPartnerRemoteAccessSettings: state.readSettings }));
vi.mock('../../services/secretCrypto', () => ({ decryptForColumn: (_t: string, _c: string, value: string) => value }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: state.audit }));
import { cloudcomRemoteAccessRoutes } from './cloudcomRemoteAccess';

const id = '11111111-1111-4111-8111-111111111111';
const path = `/devices/${id}/remote-access-options`;
const app = new Hono().route('/devices', cloudcomRemoteAccessRoutes);
const provider = { id: 'rustdesk', name: 'RustDesk', enabled: true, customFieldKey: 'rustdesk_id', urlTemplate: 'rustdesk://{id}', password: 'secret-not-in-response' };
beforeEach(() => {
  vi.clearAllMocks();
  state.device = { id, orgId: 'org-a', siteId: 'site-a', hostname: 'device', customFields: { rustdesk_id: '123456' } };
  state.settings = { providers: [provider], defaultProviderId: null };
  state.readSettings.mockImplementation(async () => state.settings);
});

describe('CloudCom explicit remote tool routes', () => {
  it('lists only safe summaries with no-store and no launch audit', async () => {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ providers: [{ id: 'rustdesk', name: 'RustDesk', available: true, skipReason: null }] });
    expect(state.readSettings).toHaveBeenCalledWith('org-a');
    expect(state.audit).not.toHaveBeenCalled();
  });
  it('issues an explicit choice without changing the default and audits no credentials', async () => {
    const res = await app.request(`${path}/rustdesk/launch`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ launchUrl: 'rustdesk://123456', providerId: 'rustdesk', scheme: 'rustdesk' });
    expect(state.settings.defaultProviderId).toBeNull();
    const audit = state.audit.mock.calls[0][1];
    expect(audit.details).toEqual({ deviceId: id, providerId: 'rustdesk', scheme: 'rustdesk', selection: 'explicit' });
    expect(JSON.stringify(audit)).not.toMatch(/123456|secret-not-in-response|rustdesk:\/\//);
  });
  for (const method of ['GET', 'POST']) {
    const endpoint = method === 'GET' ? path : `${path}/rustdesk/launch`;
    it.each(['auth', 'scope', 'permission', 'mfa', 'trust'])(`${method} enforces %s before reading providers`, async gate => {
      const res = await app.request(endpoint, { method, headers: { 'x-test-deny': gate } });
      expect(res.status).toBe(gate === 'auth' ? 401 : 403);
      expect(state.readSettings).not.toHaveBeenCalled();
    });
    it(`${method} rejects another organization even if the DB returns its device`, async () => {
      state.device!.orgId = 'org-b';
      expect((await app.request(endpoint, { method })).status).toBe(404);
      expect(state.readSettings).not.toHaveBeenCalled();
    });
    it(`${method} rejects an excluded site`, async () => {
      state.device!.siteId = 'site-b';
      expect((await app.request(endpoint, { method })).status).toBe(403);
      expect(state.readSettings).not.toHaveBeenCalled();
    });
    it(`${method} rejects a missing device`, async () => {
      state.device = null;
      expect((await app.request(endpoint, { method })).status).toBe(404);
    });
  }
  it('rejects malformed UUID before provider lookup', async () => {
    expect((await app.request('/devices/invalid/remote-access-options')).status).toBe(400);
    expect(state.readSettings).not.toHaveBeenCalled();
  });
  it('does not fall back for unknown or newly disabled providers', async () => {
    state.settings.defaultProviderId = 'rustdesk';
    expect((await app.request(`${path}/foreign-provider/launch`, { method: 'POST' })).status).toBe(404);
    state.settings.providers = [{ ...provider, enabled: false }];
    expect((await app.request(`${path}/rustdesk/launch`, { method: 'POST' })).status).toBe(404);
    expect(state.audit).not.toHaveBeenCalled();
  });
  it('returns configuration failures instead of falling back and leaks no error details', async () => {
    state.readSettings.mockRejectedValue(new Error('secret-not-in-response'));
    const res = await app.request(`${path}/rustdesk/launch`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret-not-in-response');
  });
  it('rejects malicious launch schemes and records a denial', async () => {
    state.settings.providers = [{ ...provider, urlTemplate: 'javascript:alert(1)' }];
    expect((await app.request(`${path}/rustdesk/launch`, { method: 'POST' })).status).toBe(422);
    expect(state.audit.mock.calls[0][1].result).toBe('denied');
  });
  it('does not attach authorization to unrelated sibling routes', async () => {
    const sibling = new Hono().route('/devices', cloudcomRemoteAccessRoutes).get('/devices/unrelated', c => c.text('ok'));
    expect((await sibling.request('/devices/unrelated', { headers: { 'x-test-deny': 'auth' } })).status).toBe(200);
  });
});
