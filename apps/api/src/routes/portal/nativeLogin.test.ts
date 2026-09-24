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
const priorCompany = process.env.CLOUDCOM_COMPANY_GATEWAY_ENABLED;
beforeEach(() => { vi.clearAllMocks(); process.env.CLOUDCOM_NATIVE_LOGIN_ENABLED = 'true';
  mocks.redis.mockReturnValue({}); mocks.csrf.mockReturnValue(null); mocks.limit.mockResolvedValue({ allowed: true });
  mocks.settings.mockResolvedValue([{ enabled: true }]); mocks.issue.mockResolvedValue({ redirectUri: input.redirectUri, expiresIn: 60 });
  mocks.exchange.mockResolvedValue(null); mocks.company.mockResolvedValue({ ok: true,
    orgId: '22222222-2222-4222-8222-222222222222', expiresAt: Date.now() + 3600_000,
    configFingerprint: 'a'.repeat(64) }); });
afterEach(() => {
  if (prior === undefined) delete process.env.CLOUDCOM_NATIVE_LOGIN_ENABLED; else process.env.CLOUDCOM_NATIVE_LOGIN_ENABLED = prior;
  if (priorCompany === undefined) delete process.env.CLOUDCOM_COMPANY_GATEWAY_ENABLED;
  else process.env.CLOUDCOM_COMPANY_GATEWAY_ENABLED = priorCompany;
});
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
  it('binds the browser-verified company to code issuance and exchanges it without another Cloudflare token', async () => {
    vi.stubEnv('CLOUDCOM_COMPANY_GATEWAY_ENABLED', 'true');
    const orgId = '22222222-2222-4222-8222-222222222222';
    const headers = { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': 'verified-company-token' };
    const authorized = await app().request('/remote/native/authorize', { ...post(input), headers });
    expect(authorized.status).toBe(200);
    expect(mocks.company).toHaveBeenCalledWith('verified-company-token', true);
    expect(mocks.issue).toHaveBeenCalledWith(expect.objectContaining({ orgId }),
      'browser_session_1234567890', input, { orgId, expiresAt: expect.any(Number),
        configFingerprint: 'a'.repeat(64) });

    const body = { clientId: input.clientId, redirectUri: input.redirectUri,
      code: Buffer.alloc(32, 9).toString('base64url'), codeVerifier: 'x'.repeat(43) };
    const before = mocks.company.mock.calls.length;
    await app().request('/auth/native/exchange', post(body));
    expect(mocks.exchange).toHaveBeenCalledWith(body);
    expect(mocks.company).toHaveBeenCalledTimes(before);
  });
  it.each([
    { ok: false, status: 403 },
    { ok: true, orgId: null, expiresAt: undefined },
    { ok: true, orgId: '33333333-3333-4333-8333-333333333333', expiresAt: Date.now() + 3600_000 },
    { ok: true, orgId: '22222222-2222-4222-8222-222222222222', expiresAt: Date.now() - 1 },
  ])('does not issue a code without a live, matching company identity', async company => {
    vi.stubEnv('CLOUDCOM_COMPANY_GATEWAY_ENABLED', 'true');
    mocks.company.mockResolvedValue(company);
    const response = await app().request('/remote/native/authorize', {
      ...post(input), headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': 'assertion' },
    });
    expect(response.status).toBe(403);
    expect(mocks.issue).not.toHaveBeenCalled();
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
