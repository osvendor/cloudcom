import { createHash } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { dbMock, auditMock, authSpy } = vi.hoisted(() => ({
  dbMock: { results: [] as unknown[][], execute: vi.fn() }, auditMock: vi.fn(), authSpy: vi.fn(),
}));
vi.mock('../db', () => ({ db: { execute: dbMock.execute,
  transaction: (fn: (tx: { execute: typeof dbMock.execute }) => Promise<unknown>) => fn({ execute: dbMock.execute }) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../middleware/auth', () => ({
  authMiddleware: (c: any, next: () => Promise<void>) => { authSpy(c.req.path); c.set('auth', { user: { id: '11111111-1111-4111-8111-111111111111' } }); return next(); },
  requireMfa: () => (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../services/permissions', () => ({ PERMISSIONS: { ORGS_READ: { resource: 'organizations', action: 'read' },
  ORGS_WRITE: { resource: 'organizations', action: 'write' } } }));
vi.mock('../services/siteCeilingAccess', () => ({ canMutateOrgWideGovernance: () => true }));
vi.mock('./c2c/helpers', () => ({ resolveScopedOrgId: () => '22222222-2222-4222-8222-222222222222' }));
vi.mock('../services/secretCrypto', () => ({ encryptSecret: (value: string) => `enc:v3:${value}`,
  decryptSecret: (value: string) => value.slice(7) }));
vi.mock('../services/auditEvents', () => ({ writeAuditEvent: auditMock }));
vi.mock('../config/env', () => ({ GOOGLE_WORKSPACE_ENABLED: true }));
import { cloudCommandGoogleOAuthRoutes } from './cloudCommandGoogleOAuth';
import { googleRoutes } from './google';

function app() { const app = new Hono(); app.route('/google', cloudCommandGoogleOAuthRoutes); return app; }
function mountedApp() { const app = new Hono(); app.route('/api/v1/google', googleRoutes); return app; }
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  vi.stubEnv('CLOUDCOMMAND_GOOGLE_OAUTH_CLIENT_ID', 'client');
  vi.stubEnv('CLOUDCOMMAND_GOOGLE_OAUTH_CLIENT_SECRET', 'private-client-secret');
  vi.stubEnv('CLOUDCOMMAND_GOOGLE_OAUTH_REDIRECT_URI', 'https://breeze.example/api/v1/google/oauth/callback');
  dbMock.results.length = 0;
  dbMock.execute.mockReset().mockImplementation(async () => dbMock.results.shift() ?? []);
  auditMock.mockReset();
  authSpy.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Cloud Command Google OAuth Connect', () => {
  it('mounts the public callback ahead of the legacy Google auth middleware', async () => {
    const callback = await mountedApp().request('/api/v1/google/oauth/callback?state=invalid&code=code');
    expect(callback.status).toBe(302);
    expect(authSpy).not.toHaveBeenCalled();
    const start = await mountedApp().request('/api/v1/google/oauth/start', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerDomain: 'example.test' }) });
    expect(start.status).toBe(200);
    expect(authSpy).toHaveBeenCalled();
  });
  it('starts one PKCE browser-bound flow for a named customer domain', async () => {
    const result = await app().request('/google/oauth/start', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerDomain: 'Example.Test' }) });
    expect(result.status).toBe(200);
    const url = new URL((await result.json() as { url: string }).url);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')?.length).toBeGreaterThan(30);
    expect(result.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax');
    expect(JSON.stringify(await dbMock.execute.mock.results[0])).not.toContain('private-client-secret');
  });
  it('rejects an invalid domain and never contacts Google', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const result = await app().request('/google/oauth/start', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerDomain: 'evil/path' }) });
    expect(result.status).toBe(400);
    expect(dbMock.execute).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('requires both state and the initiating browser cookie before token exchange', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const result = await app().request('/google/oauth/callback?state=missing&code=code');
    expect(result.status).toBe(302);
    expect(dbMock.execute).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects a Google customer/domain mismatch without saving a grant', async () => {
    const started = await app().request('/google/oauth/start', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerDomain: 'example.test' }) });
    const url = new URL((await started.json() as { url: string }).url);
    const browser = started.headers.get('set-cookie')!.split(';')[0].split('=')[1];
    dbMock.results.push([{ org_id: '22222222-2222-4222-8222-222222222222',
      actor_id: '11111111-1111-4111-8111-111111111111',
      browser_hash: createHash('sha256').update(browser).digest('hex'),
      verifier_ciphertext: 'enc:v3:verifier', expected_domain: 'example.test' }]);
    const fetchMock = vi.fn(async (target: string | URL) => {
      const text = String(target);
      if (text.includes('/token')) return response({ access_token: 'access', refresh_token: 'refresh',
        scope: 'openid email https://www.googleapis.com/auth/admin.directory.user.readonly https://www.googleapis.com/auth/admin.directory.group.readonly' });
      if (text.includes('/userinfo')) return response({ email_verified: true, email: 'admin@other.test', hd: 'other.test' });
      throw new Error('must not list');
    });
    vi.stubGlobal('fetch', fetchMock);
    const callback = await app().request(`/google/oauth/callback?state=${url.searchParams.get('state')}&code=code`,
      { headers: { Cookie: `__Host-cloudcom_google_oauth=${browser}` } });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain('connect-failed');
    expect(dbMock.execute).toHaveBeenCalledTimes(4); // start: 3; callback claim: 1
    expect(auditMock).not.toHaveBeenCalled();
  });
  it('saves only a verified customer grant and rejects callback replay', async () => {
    const started = await app().request('/google/oauth/start', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerDomain: 'example.test' }) });
    const url = new URL((await started.json() as { url: string }).url);
    const browser = started.headers.get('set-cookie')!.split(';')[0].split('=')[1];
    dbMock.results.push([{ org_id: '22222222-2222-4222-8222-222222222222',
      actor_id: '11111111-1111-4111-8111-111111111111',
      browser_hash: createHash('sha256').update(browser).digest('hex'),
      verifier_ciphertext: 'enc:v3:verifier', expected_domain: 'example.test' }],
      [], [], [{ id: 'connection' }], []);
    const fetchMock = vi.fn(async (target: string | URL) => {
      const text = String(target);
      if (text.includes('/token')) return response({ access_token: 'access', refresh_token: 'refresh',
        scope: 'openid email https://www.googleapis.com/auth/admin.directory.user.readonly https://www.googleapis.com/auth/admin.directory.group.readonly' });
      if (text.includes('/userinfo')) return response({ email_verified: true, email: 'admin@example.test', hd: 'example.test' });
      if (text.includes('/users')) return response({ users: [{ customerId: 'C123' }] });
      if (text.includes('/groups')) return response({ groups: [] });
      throw new Error('unexpected provider URL');
    });
    vi.stubGlobal('fetch', fetchMock);
    const path = `/google/oauth/callback?state=${url.searchParams.get('state')}&code=code`;
    const headers = { Cookie: `__Host-cloudcom_google_oauth=${browser}` };
    const first = await app().request(path, { headers });
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toContain('google=connected');
    expect(first.headers.get('location')).not.toContain('refresh');
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: '22222222-2222-4222-8222-222222222222', actorId: '11111111-1111-4111-8111-111111111111' }));
    const second = await app().request(path, { headers });
    expect(second.headers.get('location')).toContain('connect-failed');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
