import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createRoutes } from './index';
import type { NativeGoogleServices } from './native-google';
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
function harness(opts: { access?: boolean; sites?: string[]; read?: boolean; write?: boolean; mfa?: boolean; auditFail?: boolean } = {}) {
  const auth = { user: { id: ORG }, scope: 'partner', partnerId: PARTNER, canAccessOrg: () => opts.access !== false };
  const authorization = { hasPermission: (_: string, action: string) => action === 'read' ? opts.read !== false : opts.write !== false, mfaSatisfied: opts.mfa !== false, allowedSiteIds: opts.sites };
  const google: NativeGoogleServices = {
    version: 1,
    connection: vi.fn(async () => ({ available: true, connected: true, enabled: true, canManage: true, customerDomain: 'example.test' })),
    directory: vi.fn(async () => ({ ok: true as const, items: [{ id: 'g1', name: 'Test User', email: 'test@example.test' }], nextPageToken: 'next' })),
    auditSuspension: vi.fn(async () => { if (opts.auditFail) throw new Error('audit unavailable'); }),
    setSuspended: vi.fn(async () => ({ ok: true as const, userId: '123456', suspended: true })),
    auditProfile: vi.fn(async () => { if (opts.auditFail) throw new Error('audit unavailable'); }),
    updateProfile: vi.fn(async () => ({ ok: true as const, userId: '123456', givenName: 'Test', familyName: 'Person' })),
  };
  const context = { db: { execute: vi.fn(async () => [{ partner_id: PARTNER }]) }, audit: vi.fn(), log: vi.fn(), secrets: {} };
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => { c.set('auth', auth); c.set('extensionAuthorization', authorization); await next(); });
  app.route('/', createRoutes(context as never, vi.fn(), undefined, undefined, google));
  return { app, google, auth, authorization, context };
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
  it('routes archived users as a separate bounded Directory read', async () => {
    const h = harness();
    expect((await h.app.request(`/google/directory/archived?orgId=${ORG}`)).status).toBe(200);
    expect(h.google.directory).toHaveBeenCalledWith(expect.any(Object), 'archived', null);
  });
  const suspension = { userId: '123456', email: 'test@example.test', expectedSuspended: false, suspended: true, confirmation: 'test@example.test' };
  const post = (app: ReturnType<typeof harness>['app'], body: unknown) => app.request(`/google/users/suspension?orgId=${ORG}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  it.each([{ write: false }, { mfa: false }, { sites: [] }, { access: false }])('denies suspension before provider access: %j', async opts => {
    const h = harness(opts);
    expect((await post(h.app, suspension)).status).toBe(403);
    expect(h.google.setSuspended).not.toHaveBeenCalled();
  });
  it('requires exact confirmation and expected state', async () => {
    const h = harness();
    expect((await post(h.app, { ...suspension, confirmation: 'wrong' })).status).toBe(400);
    expect((await post(h.app, { ...suspension, expectedSuspended: true })).status).toBe(400);
    expect((await post(h.app, { ...suspension, userId: 123456 })).status).toBe(400);
    expect(h.google.setSuspended).not.toHaveBeenCalled();
  });
  it('rejects query parameters on a Google account write', async () => {
    const h = harness();
    const response = await h.app.request(`/google/users/suspension?orgId=${ORG}&pageToken=other`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(suspension),
    });
    expect(response.status).toBe(400);
    expect(h.google.setSuspended).not.toHaveBeenCalled();
  });
  it('fails closed if the intent audit cannot be written', async () => {
    const h = harness({ auditFail: true });
    expect((await post(h.app, suspension)).status).toBe(503);
    expect(h.google.setSuspended).not.toHaveBeenCalled();
  });
  it('audits intent and outcome around one native action', async () => {
    const h = harness();
    expect((await post(h.app, suspension)).status).toBe(200);
    expect(h.google.setSuspended).toHaveBeenCalledWith({ auth: h.auth, authorization: h.authorization, orgId: ORG }, suspension);
    expect(h.google.auditSuspension).toHaveBeenCalledTimes(2);
    expect(h.google.auditSuspension).toHaveBeenNthCalledWith(1, expect.any(Object), '123456', 'intent');
    expect(h.google.auditSuspension).toHaveBeenNthCalledWith(2, expect.any(Object), '123456', 'success');
  });
  it('records an uncertain native exception as failure and asks for refresh', async () => {
    const h = harness();
    vi.mocked(h.google.setSuspended).mockRejectedValueOnce(new Error('private provider body'));
    const response = await post(h.app, suspension);
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain('private provider body');
    expect(h.google.auditSuspension).toHaveBeenLastCalledWith(expect.any(Object), '123456', 'failure');
  });
  const profile = { userId: '123456', email: 'test@example.test', expectedGivenName: 'Old', expectedFamilyName: 'Person', givenName: 'Test', familyName: 'Person' };
  const postProfile = (app: ReturnType<typeof harness>['app'], body: unknown) => app.request(`/google/users/profile?orgId=${ORG}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  it.each([{ write: false }, { mfa: false }, { sites: [] }, { access: false }])('denies profile update before native access: %j', async opts => {
    const h = harness(opts);
    expect((await postProfile(h.app, profile)).status).toBe(403);
    expect(h.google.updateProfile).not.toHaveBeenCalled();
  });
  it('rejects unchanged, invalid and caller-expanded profile requests', async () => {
    const h = harness();
    expect((await postProfile(h.app, { ...profile, givenName: 'Old' })).status).toBe(400);
    expect((await postProfile(h.app, { ...profile, familyName: '' })).status).toBe(400);
    expect((await postProfile(h.app, { ...profile, isAdmin: true })).status).toBe(400);
    expect(h.google.updateProfile).not.toHaveBeenCalled();
  });
  it('audits intent and outcome for one fixed name update', async () => {
    const h = harness();
    expect((await postProfile(h.app, profile)).status).toBe(200);
    expect(h.google.auditProfile).toHaveBeenNthCalledWith(1, expect.any(Object), '123456', 'intent');
    expect(h.google.updateProfile).toHaveBeenCalledWith(expect.any(Object), profile);
    expect(h.google.auditProfile).toHaveBeenNthCalledWith(2, expect.any(Object), '123456', 'success');
  });
});
