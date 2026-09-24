import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createRoutes } from './index';
import { projectMicrosoftResource, type NativeMicrosoftServices } from './native-microsoft';
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
function harness(options: { access?: boolean; read?: boolean; write?: boolean; mfa?: boolean; sites?: string[]; host?: boolean; failure?: string; partner?: string; adminFailure?: string } = {}) {
  const execute = vi.fn(async () => [{ partner_id: PARTNER }]);
  const fetch = vi.fn();
  const auth = { user: { id: ORG }, scope: 'partner', partnerId: options.partner ?? PARTNER, canAccessOrg: () => options.access !== false };
  const authorization = { hasPermission: (_resource: string, action: string) => action === 'read' ? options.read !== false : options.write !== false, mfaSatisfied: options.mfa !== false, allowedSiteIds: options.sites };
  const administration: NativeMicrosoftServices['administration'] | undefined = options.adminFailure ? {
    status: vi.fn(async () => ({ state: 'ready', canManage: true, canStart: false, capabilities: [] })),
    start: vi.fn(async () => ({})), complete: vi.fn(async () => ({})), disconnect: vi.fn(async () => ({})),
    execute: vi.fn(async () => { throw Object.assign(new Error('provider rejected'), { code: options.adminFailure }); }),
  } : undefined;
  const services: NativeMicrosoftServices = {
    version: 1,
    ...(administration ? { administration } : {}),
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
  it.each([{ write: false }, { mfa: false }, { access: false }, { sites: [] }])('denies onboarding mutations before native calls: %j', async options => {
    const h = harness(options);
    expect((await h.app.request(path('onboarding/recheck'), { method: 'POST' })).status).toBe(403);
    expect(h.services.connection).not.toHaveBeenCalled();
    expect(h.services.read).not.toHaveBeenCalled();
  });
  it('does not offer partial read consent as full administration onboarding', async () => {
    const h = harness();
    const response = await h.app.request(path('onboarding/start'), { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'onboarding_unavailable' });
    expect(h.services.read).not.toHaveBeenCalled();
  });
  it('reports missing host services honestly without CIPP calls', async () => {
    const h = harness({ host: false });
    expect(await (await h.app.request(path('connection'))).json()).toMatchObject({ available: false, connected: false, enabled: false });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it('explains a rejected user profile update without misreporting it as setup failure', async () => {
    const h = harness({ adminFailure: 'provider_rejected' });
    const response = await h.app.request(path('administration'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user.update', id: ORG, update: { displayName: 'QA User' } }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'provider_rejected',
      error: 'Microsoft rejected the profile update. Refresh the user and review the current values before trying again.',
    });
  });
  it('marks administration responses no-store because they may contain a one-time password', async () => {
    const h = harness({ adminFailure: 'provider_rejected' });
    const response = await h.app.request(path('administration'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user.create', user: { displayName: 'QA', userPrincipalName: 'qa@example.test' } }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
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
  it('projects Cloud Command directory identity and the scalar Graph license join without generic profile columns', () => {
    const result = projectMicrosoftResource('users', [{
      id: ORG, displayName: 'Ada Lovelace', userPrincipalName: 'ada@example.test', accountEnabled: false,
      userType: 'Member', licenseSummary: 'SPE_E3, POWER_BI_STANDARD', assignedLicenses: [{ skuId: 'never-expose' }],
      department: 'Engineering', jobTitle: 'Analyst', officeLocation: 'London',
    }], false);
    expect(result.columns).toEqual([
      { key: 'displayName', label: 'User' },
      { key: 'userPrincipalName', label: 'Sign-in name' },
      { key: 'userType', label: 'Type' },
      { key: 'licenseSummary', label: 'License' },
      { key: 'oneDrive', label: 'OneDrive' },
      { key: 'accountEnabled', label: 'Account state' },
    ]);
    expect(result.items[0]?.values).toEqual({
      displayName: 'Ada Lovelace', userPrincipalName: 'ada@example.test', userType: 'Member',
      licenseSummary: 'SPE_E3, POWER_BI_STANDARD', oneDrive: null, accountEnabled: false,
    });
    expect(result.columns.map(column => column.label)).not.toContain('Enabled');
    expect(JSON.stringify(result)).not.toMatch(/department|jobTitle|officeLocation|assignedLicenses|never-expose/i);
  });
});
