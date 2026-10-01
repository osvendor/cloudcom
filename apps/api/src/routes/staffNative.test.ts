import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ enabled: true, browser: vi.fn(), authenticate: vi.fn(), exchange: vi.fn(),
  issue: vi.fn(), principal: vi.fn(), admission: vi.fn(), context: vi.fn(async (_: unknown, f: () => unknown) => f()),
  ips: vi.fn(async (_: unknown, f: () => unknown) => f()), orgs: vi.fn(), rows: [] as unknown[] }));
vi.mock('../db', () => ({ withDbAccessContext: m.context, db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => m.rows }) }) }) } }));
vi.mock('../middleware/auth', () => ({ authMiddleware: async (c: any, next: any) => { m.browser(); c.set('auth', { scope: 'partner' }); await next(); },
  requireInteractiveSession: () => async (_: any, next: any) => next(), requireMfa: () => async (_: any, next: any) => next(),
  requirePermission: () => async (_: any, next: any) => next(), computeAccessibleOrgIds: m.orgs }));
vi.mock('../middleware/ipAllowlistGuard', () => ({ ipAllowlistGuard: m.ips }));
vi.mock('../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: async () => ({ allowed: true }) }));
vi.mock('../services/clientIp', () => ({ getTrustedClientIp: () => 'test', rateLimitIpKey: () => 'test' }));
vi.mock('../services/portalNativeLogin', () => ({ NATIVE_CLIENT_ID: 'cloudcom-native-v1' }));
vi.mock('../services/staffNativeLogin', () => ({ staffNativeEnabled: () => m.enabled, issueStaffNativeLoginCode: m.issue,
  exchangeStaffNativeLoginCode: m.exchange, authenticateStaffNativeOperator: m.authenticate, endStaffNativeLogin: vi.fn() }));
vi.mock('../services/staffNativeAuthority', () => ({ staffNativePrincipalFromAuth: m.principal, authorizeStaffNativeDevice: vi.fn() }));
vi.mock('../services/staffNativeAdmission', () => ({ issueStaffNativeAdmission: m.admission, touchStaffNativePresence: vi.fn(), endStaffNativeAdmission: vi.fn() }));
vi.mock('../services/auditEvents', () => ({ writeAuditEventAsync: vi.fn() }));
import { staffNativeRoutes } from './staffNative';
import { NativeAdmissionError } from '../services/portalNativeAdmissionSchemas';
const id = '11111111-1111-4111-8111-111111111111';
const operator = { principal: { userId: id, partnerId: id }, sessionHash: 'hash' };
function post(path: string, body: unknown = {}) { const app = new Hono(); app.route('/', staffNativeRoutes); return app.request(path,
  { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ccs1.test' }, body: JSON.stringify(body) }); }
beforeEach(() => { vi.clearAllMocks(); m.enabled = true; m.authenticate.mockResolvedValue(operator); m.orgs.mockResolvedValue({ orgIds: [id] });
  m.exchange.mockResolvedValue({ tokenType: 'Bearer' }); m.principal.mockReturnValue(operator.principal); m.issue.mockResolvedValue({ redirectUri: 'callback' }); });
describe('staff native route boundaries', () => {
  it('defaults off before authenticating or exchanging', async () => { m.enabled = false; expect((await post('/exchange')).status).toBe(404); expect(m.exchange).not.toHaveBeenCalled(); });
  it('keeps the PKCE exchange reachable without browser or native authentication', async () => {
    expect((await post('/exchange', { code: 'a'.repeat(43), codeVerifier: 'b'.repeat(43), redirectUri: 'http://127.0.0.1:4000/callback', clientId: 'cloudcom-native-v1' })).status).toBe(200);
    expect(m.browser).not.toHaveBeenCalled(); expect(m.authenticate).not.toHaveBeenCalled(); expect(m.exchange).toHaveBeenCalledOnce();
  });
  it('rejects caller-added principal fields at exchange', async () => {
    expect((await post('/exchange', { code: 'a'.repeat(43), codeVerifier: 'b'.repeat(43), redirectUri: 'x', clientId: 'cloudcom-native-v1', partnerId: id })).status).toBe(400);
    expect(m.exchange).not.toHaveBeenCalled();
  });
  it('uses browser authentication only for browser authorization', async () => {
    expect((await post('/authorize', { clientId: 'cloudcom-native-v1', redirectUri: 'http://127.0.0.1:4000/callback', codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S256', state: 'b'.repeat(43) })).status).toBe(200);
    expect(m.browser).toHaveBeenCalledOnce(); expect(m.authenticate).not.toHaveBeenCalled();
  });
  it('applies live allowlists and database scope to native sessions', async () => {
    m.admission.mockResolvedValue({ sessionId: id, orgId: id });
    expect((await post('/sessions', { version: 2, deviceId: id, operatorPublicKey: Buffer.alloc(32, 1).toString('base64url') })).status).toBe(201);
    expect(m.browser).not.toHaveBeenCalled(); expect(m.ips).toHaveBeenCalledOnce();
    expect(m.context).toHaveBeenCalledWith(expect.objectContaining({ scope: 'partner', accessibleOrgIds: [id], currentPartnerId: id }), expect.any(Function));
  });
  it('rejects invalid native authentication before database access', async () => {
    m.authenticate.mockRejectedValue(new NativeAdmissionError(401)); expect((await post('/sessions')).status).toBe(401); expect(m.context).not.toHaveBeenCalled();
  });
  it('never accepts caller-selected organization at issue', async () => {
    expect((await post('/sessions', { version: 2, deviceId: id, operatorPublicKey: Buffer.alloc(32, 1).toString('base64url'), orgId: id })).status).toBe(400);
    expect(m.admission).not.toHaveBeenCalled();
  });
});
