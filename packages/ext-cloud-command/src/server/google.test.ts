import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createRoutes } from './index';
import type { NativeGoogleServices } from './native-google';
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
function harness(opts: { access?: boolean; sites?: string[]; read?: boolean } = {}) {
  const auth = { user: { id: ORG }, scope: 'partner', partnerId: PARTNER, canAccessOrg: () => opts.access !== false };
  const authorization = { hasPermission: (_: string, action: string) => action === 'read' ? opts.read !== false : true, mfaSatisfied: true, allowedSiteIds: opts.sites };
  const google: NativeGoogleServices = {
    version: 1,
    connection: vi.fn(async () => ({ available: true, connected: true, enabled: true, canManage: true, customerDomain: 'example.test' })),
    directory: vi.fn(async () => ({ ok: true as const, items: [{ id: 'g1', name: 'Test User', email: 'test@example.test' }], nextPageToken: 'next' })),
  };
  const context = { db: { execute: vi.fn(async () => [{ partner_id: PARTNER }]) }, audit: vi.fn(), log: vi.fn(), secrets: {} };
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => { c.set('auth', auth); c.set('extensionAuthorization', authorization); await next(); });
  app.route('/', createRoutes(context as never, vi.fn(), undefined, undefined, google));
  return { app, google, auth, authorization };
}
describe('Google native extension bridge', () => {
  it('passes only the authenticated org and bounded resource', async () => {
    const h = harness();
    const response = await h.app.request(`/google/directory/users?orgId=${ORG}&pageToken=next`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ complete: false, nextPageToken: 'next' });
    expect(h.google.directory).toHaveBeenCalledWith({ auth: h.auth, authorization: h.authorization, orgId: ORG }, 'users', 'next');
  });
  it.each([{ access: false }, { read: false }, { sites: [] }])('denies unauthorized directory reads: %j', async opts => {
    const h = harness(opts);
    expect((await h.app.request(`/google/directory/users?orgId=${ORG}`)).status).toBe(403);
    expect(h.google.directory).not.toHaveBeenCalled();
  });
  it.each(['&orgId=' + PARTNER, '&tenant=other', '&pageToken=a&pageToken=b'])('rejects caller-selected scope or duplicate page token %s', async query => {
    const h = harness();
    expect((await h.app.request(`/google/directory/groups?orgId=${ORG}${query}`)).status).toBe(400);
    expect(h.google.directory).not.toHaveBeenCalled();
  });
  it('rejects arbitrary directory resources', async () => {
    const h = harness();
    expect((await h.app.request(`/google/directory/secrets?orgId=${ORG}`)).status).toBe(404);
    expect(h.google.directory).not.toHaveBeenCalled();
  });
});
