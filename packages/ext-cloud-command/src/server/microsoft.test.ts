import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createRoutes } from './index';
import type { CippDeployment } from './cipp-config';
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const deployment: CippDeployment = { origin: 'https://cipp.example.test', partnerId: PARTNER, authTenantId: PARTNER, clientId: TENANT, secret: 'fixture-secret', scope: `api://${TENANT}/.default`, identity: 'pinned-backend' };
const row = (over = {}) => ({ id: ORG, org_id: ORG, tenant_id: TENANT, tenant_domain: 'tenant.example.test', tenant_name: 'Test tenant', backend_identity: deployment.identity, version: 1, enabled: true, ...over });
function harness(options: { scope?: string; write?: boolean; mfa?: boolean; platform?: boolean; access?: boolean; partner?: string; db?: unknown[]; config?: CippDeployment | null; responses?: unknown[] } = {}) {
  const queue = [...(options.db ?? [[{ partner_id: PARTNER }]])];
  const execute = vi.fn(async () => queue.shift() ?? []);
  const responses = [...(options.responses ?? [])];
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(responses.shift() ?? {}));
  const audit = vi.fn();
  const context = { db: { execute }, audit, log: vi.fn(), secrets: {} };
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => {
    c.set('auth', { user: { id: ORG, isPlatformAdmin: options.platform }, scope: options.scope ?? 'partner', partnerId: options.partner ?? PARTNER, canAccessOrg: () => options.access !== false });
    c.set('extensionAuthorization', { hasPermission: (_r: string, action: string) => action === 'read' || options.write !== false, mfaSatisfied: options.mfa !== false });
    await next();
  });
  app.route('/', createRoutes(context as never, fetch, options.config === undefined ? deployment : options.config));
  return { app, fetch, execute, audit };
}
const path = (suffix: string) => `/microsoft/${suffix}?orgId=${ORG}`;
const put = (values = {}) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: TENANT, enabled: true, version: 1, ...values }) });
const token = { access_token: 'synthetic-token' };
const tenants = [{ customerId: TENANT, defaultDomainName: 'tenant.example.test', displayName: 'Test tenant' }];
describe('CIPP organization adapter', () => {
  it('shows an honest unavailable state without accessing credentials or mappings', async () => {
    const h = harness({ config: null });
    const response = await h.app.request(path('connection'));
    expect(await response.json()).toMatchObject({ available: false, connected: false, canManage: false });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('does not share the deployment CIPP identity with another Breeze partner', async () => {
    const h = harness({ config: { ...deployment, partnerId: TENANT } });
    expect((await h.app.request(path('resources/users'))).status).toBe(503);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([{ scope: 'organization' }, { write: false }, { mfa: false }, { scope: 'system', platform: false }])('restricts binding and discovery to authorized partner managers: %j', async options => {
    const h = harness(options);
    expect((await h.app.request(path('tenants'))).status).toBe(403);
    const second = harness(options);
    expect((await second.app.request(path('connection'), put())).status).toBe(403);
    expect(second.fetch).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('denies cross-organization requests before database and provider work', async () => {
    const h = harness({ access: false });
    expect((await h.app.request(path('resources/users'))).status).toBe(403);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('rejects stale save and unknown body fields before remote calls', async () => {
    const h = harness({ db: [[{ partner_id: PARTNER }], [row()]] });
    expect((await h.app.request(path('connection'), put({ version: 2 }))).status).toBe(409);
    expect(h.fetch).not.toHaveBeenCalled();
    const invalid = harness();
    expect((await invalid.app.request(path('connection'), put({ backendUrl: 'https://other.example.test' }))).status).toBe(400);
  });
  it('binds only a tenant returned by the configured CIPP service and audits the save', async () => {
    const h = harness({ db: [[{ partner_id: PARTNER }], [], [row()]], responses: [token, tenants] });
    const response = await h.app.request(path('connection'), put({ version: null }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connected: true, tenantId: TENANT });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, action: 'cloudcommand.microsoft.bind' }));
    const denied = harness({ db: [[{ partner_id: PARTNER }], []], responses: [token, []] });
    expect((await denied.app.request(path('connection'), put({ version: null }))).status).toBe(400);
    expect(denied.execute).toHaveBeenCalledTimes(2);
  });
  it('disables an existing connection without contacting an unavailable provider', async () => {
    const h = harness({ db: [[{ partner_id: PARTNER }], [row()], [row({ enabled: false, version: 2 })]] });
    expect((await h.app.request(path('connection'), put({ enabled: false }))).status).toBe(200);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([{ enabled: false }, { backend_identity: 'replacement' }])('rejects disabled or stale backend bindings before network: %j', async over => {
    const h = harness({ db: [[{ partner_id: PARTNER }], [row(over)]] });
    expect((await h.app.request(path('resources/users'))).status).toBe(409);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('revalidates tenant identity and domain before sending a scoped resource request', async () => {
    const h = harness({ db: [[{ partner_id: PARTNER }], [row()]], responses: [token, tenants, token, [{ id: ORG, displayName: 'Example', password: 'never-forward' }]] });
    const response = await h.app.request(path('resources/users') + '&tenantFilter=AllTenants');
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain('never-forward');
    expect(h.fetch.mock.calls[3]![0]).toContain('tenantFilter=tenant.example.test');
    expect(h.fetch.mock.calls[3]![0]).not.toContain('AllTenants');
    const stale = harness({ db: [[{ partner_id: PARTNER }], [row()]], responses: [token, [{ ...tenants[0], defaultDomainName: 'changed.example.test' }]] });
    expect((await stale.app.request(path('resources/users'))).status).toBe(409);
    expect(stale.fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects unsupported operations and redacts upstream failure bodies', async () => {
    const h = harness();
    expect((await h.app.request(path('resources/GraphRequest'))).status).toBe(404);
    const failing = harness({ db: [[{ partner_id: PARTNER }], [row()]], responses: [token, [{ Results: 'secret debug text', customerId: '' }]] });
    const response = await failing.app.request(path('resources/users'));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret debug');
  });
});
