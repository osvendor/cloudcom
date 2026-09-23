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
    members: vi.fn(async () => ({ ok: true as const, items: [{ id: 'm1', email: 'member@example.test', role: 'OWNER' }], nextPageToken: 'next' })),
    mailboxSettings: vi.fn(async () => ({ ok: true as const, email: 'test@example.test', forwardingEnabled: false, forwardingAddress: null,
      forwardingDisposition: null, vacationEnabled: false, vacationSubject: null, vacationStartMs: null, vacationEndMs: null })),
    storage: vi.fn(async (_request, date: string) => ({ ok: true as const, date, items: [{ email: 'test@example.test', gmailMb: 10, driveMb: null, totalMb: 20 }],
      nextPageToken: null, partial: true, warning: 'Some usage data is unavailable.' })),
    activity: vi.fn(async (_request, source, days) => ({ ok: true as const, source, days, asOf: new Date().toISOString(), items: [], nextPageToken: 'next', partial: false, warning: null })),
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
  it('routes direct group members with the authenticated org and bounded page', async () => {
    const h = harness();
    const response = await h.app.request(`/google/groups/g1/members?orgId=${ORG}&pageToken=next`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ complete: false, items: [{ role: 'OWNER' }] });
    expect(h.google.members).toHaveBeenCalledWith({ auth: h.auth, authorization: h.authorization, orgId: ORG }, 'g1', 'next');
  });
  it('rejects unauthorized and caller-expanded group member reads', async () => {
    const h = harness({ read: false });
    expect((await h.app.request(`/google/groups/g1/members?orgId=${ORG}`)).status).toBe(403);
    expect(h.google.members).not.toHaveBeenCalled();
    const allowed = harness();
    expect((await allowed.app.request(`/google/groups/g1/members?orgId=${ORG}&orgId=${PARTNER}`)).status).toBe(400);
    expect((await allowed.app.request(`/google/groups/g1/members?orgId=${ORG}&pageToken=a&pageToken=b`)).status).toBe(400);
    expect((await allowed.app.request(`/google/groups/%2F/members?orgId=${ORG}`)).status).toBe(400);
    expect(allowed.google.members).not.toHaveBeenCalled();
  });
  it('reads fixed Gmail settings only for managers with MFA', async () => {
    const h = harness();
    const response = await h.app.request(`/google/users/u1/mailbox-settings?orgId=${ORG}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(h.google.mailboxSettings).toHaveBeenCalledWith({ auth: h.auth, authorization: h.authorization, orgId: ORG }, 'u1');
    for (const opts of [{ write: false }, { mfa: false }, { sites: [] }, { access: false }]) {
      const denied = harness(opts);
      expect((await denied.app.request(`/google/users/u1/mailbox-settings?orgId=${ORG}`)).status).toBe(403);
      expect(denied.google.mailboxSettings).not.toHaveBeenCalled();
    }
  });
  it('rejects invalid user IDs and extra Gmail query controls', async () => {
    const h = harness();
    expect((await h.app.request(`/google/users/%2F/mailbox-settings?orgId=${ORG}`)).status).toBe(400);
    expect((await h.app.request(`/google/users/u1/mailbox-settings?orgId=${ORG}&email=other@example.test`)).status).toBe(400);
    expect(h.google.mailboxSettings).not.toHaveBeenCalled();
  });
  it('reads one fixed storage report date through the authenticated org', async () => {
    const h = harness();
    const date = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const response = await h.app.request(`/google/reports/storage?orgId=${ORG}&date=${date}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ partial: true, complete: false });
    expect(h.google.storage).toHaveBeenCalledWith({ auth: h.auth, authorization: h.authorization, orgId: ORG }, date, null);
  });
  it('rejects invalid report dates and duplicate or arbitrary scope parameters', async () => {
    const h = harness();
    const date = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    for (const suffix of ['&date=2026-02-30', `&date=${date}&date=${date}`, '&date=1900-01-01', `&date=${date}&pageToken=a&pageToken=b`, `&date=${date}&customerId=other`]) {
      const query = suffix;
      expect((await h.app.request(`/google/reports/storage?orgId=${ORG}${query}`)).status).toBe(400);
    }
    expect(h.google.storage).not.toHaveBeenCalled();
  });
  it('denies cross-scope storage reports before native provider access', async () => {
    const date = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    for (const opts of [{ access: false }, { read: false }, { sites: [] }]) {
      const h = harness(opts);
      expect((await h.app.request(`/google/reports/storage?orgId=${ORG}&date=${date}`)).status).toBe(403);
      expect(h.google.storage).not.toHaveBeenCalled();
    }
  });
  const suspension = { userId: '123456', email: 'test@example.test', expectedSuspended: false, suspended: true, confirmation: 'test@example.test' };
  it('routes a bounded security activity read only for managers with MFA', async () => {
    const h = harness();
    const response = await h.app.request(`/google/reports/activity?orgId=${ORG}&source=login&days=7`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(h.google.activity).toHaveBeenCalledWith({ auth: h.auth, authorization: h.authorization, orgId: ORG }, 'login', 7, null, null);
    const asOf = new Date().toISOString();
    const next = await h.app.request(`/google/reports/activity?orgId=${ORG}&source=login&days=7&pageToken=next&asOf=${encodeURIComponent(asOf)}`);
    expect(next.status).toBe(200);
    expect(h.google.activity).toHaveBeenLastCalledWith(expect.any(Object), 'login', 7, 'next', asOf);
    for (const opts of [{ write: false }, { mfa: false }, { access: false }, { sites: [] }]) {
      const denied = harness(opts);
      expect((await denied.app.request(`/google/reports/activity?orgId=${ORG}&source=login&days=7`)).status).toBe(403);
      expect(denied.google.activity).not.toHaveBeenCalled();
    }
  });
  it('rejects expanded activity queries and duplicate scope', async () => {
    const h = harness();
    for (const extra of ['&source=login', '&days=90', '&customerId=other', '&orgId=' + PARTNER, '&pageToken=a&pageToken=b', '&pageToken=a'])
      expect((await h.app.request(`/google/reports/activity?orgId=${ORG}&source=login&days=7${extra}`)).status).toBe(400);
    expect(h.google.activity).not.toHaveBeenCalled();
  });
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
