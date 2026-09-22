import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createRoutes } from './index';
import { projectMicrosoftResource, type NativeMicrosoftServices } from './native-microsoft';
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
function harness(options: { access?: boolean; read?: boolean; sites?: string[]; host?: boolean; failure?: string; partner?: string } = {}) {
  const execute = vi.fn(async () => [{ partner_id: PARTNER }]);
  const fetch = vi.fn();
  const auth = { user: { id: ORG }, scope: 'partner', partnerId: options.partner ?? PARTNER, canAccessOrg: () => options.access !== false };
  const authorization = { hasPermission: (_resource: string, action: string) => action !== 'read' || options.read !== false, mfaSatisfied: true, allowedSiteIds: options.sites };
  const services: NativeMicrosoftServices = {
    version: 1,
    connection: vi.fn(async () => ({ available: true, connected: true, enabled: true, canManage: true, tenantName: 'Native tenant' })),
    read: vi.fn(async () => options.failure ? { ok: false as const, code: options.failure, message: 'Safe native failure', retryAfterSeconds: 12 } : { ok: true as const, items: [{ id: ORG, displayName: 'User', secret: 'must-not-leave' }], truncated: true }),
  };
  const context = { db: { execute }, audit: vi.fn(), log: vi.fn(), secrets: {} };
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => { c.set('auth', auth); c.set('extensionAuthorization', authorization); await next(); });
  app.route('/', createRoutes(context as never, fetch, options.host === false ? undefined : services));
  return { app, fetch, execute, services, auth, authorization };
}
const path = (suffix: string) => `/microsoft/${suffix}?orgId=${ORG}`;
describe('native Microsoft extension routes', () => {
  it('reports missing host services honestly without CIPP calls', async () => {
    const h = harness({ host: false });
    expect(await (await h.app.request(path('connection'))).json()).toMatchObject({ available: false, connected: false, enabled: false });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it('uses the authenticated host context and canonical organization', async () => {
    const h = harness();
    expect(await (await h.app.request(path('connection'))).json()).toMatchObject({ tenantName: 'Native tenant' });
    expect(h.services.connection).toHaveBeenCalledWith({ orgId: ORG, auth: h.auth, authorization: h.authorization });
    expect(h.execute).toHaveBeenCalledTimes(1); // Only active organization; no legacy mapping query.
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([{ access: false }, { read: false }, { sites: [] }, { partner: ORG }])('denies before calling native services: %j', async options => {
    const h = harness(options);
    expect([403, 404]).toContain((await h.app.request(path('resources/users'))).status);
    expect(h.services.read).not.toHaveBeenCalled();
  });
  it.each(['tenants', 'connection'])('retires CIPP binding operation %s', async suffix => {
    const h = harness();
    const res = await h.app.request(path(suffix), suffix === 'connection' ? { method: 'PUT', body: JSON.stringify({ tenantId: PARTNER }) } : undefined);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'native_connection_required' });
    expect(h.services.read).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each(['users', 'groups', 'licenses', 'sites'])('routes only the fixed native resource %s', async resource => {
    const h = harness();
    const res = await h.app.request(path(`resources/${resource}`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.complete).toBe(false);
    expect(JSON.stringify(data)).not.toContain('must-not-leave');
    expect(h.services.read).toHaveBeenCalledWith({ orgId: ORG, auth: h.auth, authorization: h.authorization }, resource);
  });
  it.each(['&tenantId=other', `&orgId=${PARTNER}`, '&url=https://example.test'])('rejects caller-selected tenant or provider query %s', async query => {
    const h = harness();
    expect((await h.app.request(path('resources/users') + query)).status).toBe(400);
    expect(h.services.read).not.toHaveBeenCalled();
  });
  it('rejects arbitrary native actions', async () => {
    const h = harness();
    expect((await h.app.request(path('resources/deleteUser'))).status).toBe(404);
    expect(h.services.read).not.toHaveBeenCalled();
  });
  it.each([['read_rate_limited', 429], ['connection_changed', 409], ['connection_not_ready', 409], ['tools_disabled', 503], ['access_denied', 403]] as const)('preserves safe native failure %s', async (failure, status) => {
    const h = harness({ failure });
    const res = await h.app.request(path('resources/users'));
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code: failure });
  });
  it('projects native fields without fabricating unsupported CIPP report columns', () => {
    const result = projectMicrosoftResource('sites', [{ id: ORG, displayName: 'Site', webUrl: 'https://example.test', storageUsedInGigabytes: 123 }], false);
    expect(result.complete).toBe(true);
    expect(result.items[0]?.values).not.toHaveProperty('storageUsedInGigabytes');
    expect(result.items[0]?.values.name).toBeNull();
  });
});
