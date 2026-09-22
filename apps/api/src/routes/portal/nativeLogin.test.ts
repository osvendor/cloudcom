import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ csrf: vi.fn(), issue: vi.fn(), exchange: vi.fn(),
  limit: vi.fn(), settings: vi.fn(), redis: vi.fn(), company: vi.fn() }));
vi.mock('../../services/portalCompanyGateway', () => ({ verifyPortalCompanyGateway: mocks.company }));
vi.mock('../../db', () => ({ runOutsideDbContext: (fn: () => unknown) => fn(), db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.settings }) }) }) } }));
vi.mock('../../services/redis', () => ({ getRedis: mocks.redis }));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: mocks.limit }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEventAsync: vi.fn() }));
vi.mock('./helpers', () => ({ getClientIp: () => '127.0.0.1', validatePortalCookieCsrfRequest: mocks.csrf }));
vi.mock('../../services/portalNativeLogin', async original => ({
  ...await original<typeof import('../../services/portalNativeLogin')>(),
  issueNativeLoginCode: mocks.issue, exchangeNativeLoginCode: mocks.exchange,
}));
import { portalNativeAuthorizeRoutes, portalNativeExchangeRoutes } from './nativeLogin';

const input = { clientId: 'cloudcom-rustdesk-v1', redirectUri: 'http://127.0.0.1:49871/cloudcom/callback',
  codeChallengeMethod: 'S256', codeChallenge: Buffer.alloc(32, 4).toString('base64url'), state: Buffer.alloc(32, 5).toString('base64url') };
const prior = process.env.CLOUDCOM_NATIVE_LOGIN_ENABLED;
beforeEach(() => { vi.clearAllMocks(); process.env.CLOUDCOM_NATIVE_LOGIN_ENABLED = 'true';
  mocks.redis.mockReturnValue({}); mocks.csrf.mockReturnValue(null); mocks.limit.mockResolvedValue({ allowed: true });
  mocks.settings.mockResolvedValue([{ enabled: true }]); mocks.issue.mockResolvedValue({ redirectUri: input.redirectUri, expiresIn: 60 });
  mocks.exchange.mockResolvedValue(null); mocks.company.mockResolvedValue({ ok: true, orgId: null }); });
afterEach(() => { if (prior === undefined) delete process.env.CLOUDCOM_NATIVE_LOGIN_ENABLED; else process.env.CLOUDCOM_NATIVE_LOGIN_ENABLED = prior; });
function app(authMethod: 'cookie' | 'bearer' = 'cookie') {
  const result = new Hono();
  result.use('*', async (c, next) => { c.set('portalAuth', { user: { id: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222', email: 'synthetic@example.test', name: 'Synthetic', contactId: null,
    receiveNotifications: false, status: 'active', accessMode: 'remote_only', authEpoch: 1 },
    token: 'browser_session_1234567890', authMethod, timezone: 'UTC' }); return next(); });
  result.route('/', portalNativeAuthorizeRoutes); result.route('/', portalNativeExchangeRoutes); return result;
}
const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
describe('native sign-in HTTP boundary', () => {
  it('passes the verified company into exchange and denies missing company proof', async () => {
    const body = { clientId: input.clientId, redirectUri: input.redirectUri,
      code: Buffer.alloc(32, 9).toString('base64url'), codeVerifier: 'x'.repeat(43) };
    mocks.company.mockResolvedValue({ ok: false, status: 403 });
    expect((await app().request('/auth/native/exchange', post(body))).status).toBe(403);
    expect(mocks.exchange).not.toHaveBeenCalled();
    const orgId = '22222222-2222-4222-8222-222222222222';
    mocks.company.mockResolvedValue({ ok: true, orgId });
    await app().request('/auth/native/exchange', post(body));
    expect(mocks.exchange).toHaveBeenCalledWith(body, orgId);
  });
  it('defaults off before code issuance or consumption', async () => {
    delete process.env.CLOUDCOM_NATIVE_LOGIN_ENABLED;
    expect((await app().request('/remote/native/authorize', post(input))).status).toBe(404);
    expect((await app().request('/auth/native/exchange', post({}))).status).toBe(404);
    expect(mocks.issue).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it('requires a browser ceremony, CSRF and enabled organization settings', async () => {
    expect((await app('bearer').request('/remote/native/authorize', post(input))).status).toBe(403);
    mocks.csrf.mockReturnValue('Invalid CSRF token');
    expect((await app().request('/remote/native/authorize', post(input))).status).toBe(403);
    mocks.csrf.mockReturnValue(null); mocks.settings.mockResolvedValue([{ enabled: false }]);
    expect((await app().request('/remote/native/authorize', post(input))).status).toBe(403);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it('rejects callback substitution and caller-supplied identity before issuance', async () => {
    expect((await app().request('/remote/native/authorize', post({ ...input, redirectUri: 'https://example.test' }))).status).toBe(400);
    expect((await app().request('/remote/native/authorize', post({ ...input, orgId: 'other' }))).status).toBe(400);
    expect(mocks.issue).not.toHaveBeenCalled();
    const response = await app().request('/remote/native/authorize', post(input));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.issue.mock.calls[0]?.[0]).toMatchObject({ orgId: '22222222-2222-4222-8222-222222222222' });
  });
  it('limits issuance and fails closed when state storage is unavailable', async () => {
    mocks.limit.mockResolvedValue({ allowed: false });
    expect((await app().request('/remote/native/authorize', post(input))).status).toBe(429);
    mocks.redis.mockReturnValue(null);
    expect((await app().request('/remote/native/authorize', post(input))).status).toBe(503);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it('returns a generic no-store rejection for invalid exchanges', async () => {
    const body = { clientId: input.clientId, redirectUri: input.redirectUri,
      code: Buffer.alloc(32, 9).toString('base64url'), codeVerifier: 'x'.repeat(43) };
    const response = await app().request('/auth/native/exchange', post(body));
    expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain(body.code);
  });
});
