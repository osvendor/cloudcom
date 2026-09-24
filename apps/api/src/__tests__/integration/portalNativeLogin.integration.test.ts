import './setup';
import { Hono } from 'hono';
import { randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizations, partners, portalUsers, portalRemoteSettings, installedExtensions } from '../../db/schema';
import { authRoutes, portalAuthMiddleware } from '../../routes/portal/auth';
import { portalRemoteRoutes } from '../../routes/portal/remote';
import { portalNativeExchangeRoutes } from '../../routes/portal/nativeLogin';
import { CSRF_HEADER_NAME, PORTAL_CSRF_COOKIE_NAME } from '../../routes/portal/schemas';
import { hashPassword } from '../../services/password';
import { getRedis } from '../../services/redis';
import { issueNativeLoginCode, exchangeNativeLoginCode, NATIVE_CLIENT_ID } from '../../services/portalNativeLogin';
import { currentCompanyGatewayFingerprint } from '../../services/portalCompanyGateway';
import { getTestDb } from './setup';

// The ordinary integration suite can use memory portal state. This contract
// explicitly requires Redis: its selected CI command sets both prerequisites.
describe.runIf(!!process.env.DATABASE_URL_APP && process.env.PORTAL_STATE_BACKEND === 'redis')('native login with real Redis and portal identity', () => {
  const priorNativeFlag = process.env.CLOUDCOM_NATIVE_LOGIN_ENABLED;
  const priorRemoteFlag = process.env.CLOUDCOM_REMOTE_ACCESS_ENABLED;
  const priorCompanyGatewayFlag = process.env.CLOUDCOM_COMPANY_GATEWAY_ENABLED;
  const priorCompanyGatewayConfig = process.env.CLOUDCOM_COMPANY_GATEWAY_CONFIG;
  let priorExtension: typeof installedExtensions.$inferSelect | undefined;
  beforeAll(async () => {
    process.env.CLOUDCOM_NATIVE_LOGIN_ENABLED = 'true';
    process.env.CLOUDCOM_REMOTE_ACCESS_ENABLED = 'true';
    process.env.CLOUDCOM_COMPANY_GATEWAY_ENABLED = 'false';
    [priorExtension] = await getTestDb().select().from(installedExtensions).where(eq(installedExtensions.name, 'rustdeskaccess'));
    await getTestDb().insert(installedExtensions).values({ name: 'rustdeskaccess', enabled: true,
      lifecycleState: 'active', configuredVersion: 'test', activeVersion: 'test' })
      .onConflictDoUpdate({ target: installedExtensions.name, set: { enabled: true, lifecycleState: 'active' } });
  });
  afterAll(async () => {
    if (priorNativeFlag === undefined) delete process.env.CLOUDCOM_NATIVE_LOGIN_ENABLED;
    else process.env.CLOUDCOM_NATIVE_LOGIN_ENABLED = priorNativeFlag;
    if (priorRemoteFlag === undefined) delete process.env.CLOUDCOM_REMOTE_ACCESS_ENABLED;
    else process.env.CLOUDCOM_REMOTE_ACCESS_ENABLED = priorRemoteFlag;
    if (priorCompanyGatewayFlag === undefined) delete process.env.CLOUDCOM_COMPANY_GATEWAY_ENABLED;
    else process.env.CLOUDCOM_COMPANY_GATEWAY_ENABLED = priorCompanyGatewayFlag;
    if (priorCompanyGatewayConfig === undefined) delete process.env.CLOUDCOM_COMPANY_GATEWAY_CONFIG;
    else process.env.CLOUDCOM_COMPANY_GATEWAY_CONFIG = priorCompanyGatewayConfig;
    if (priorExtension) await getTestDb().update(installedExtensions).set(priorExtension).where(eq(installedExtensions.name, 'rustdeskaccess'));
    else await getTestDb().delete(installedExtensions).where(eq(installedExtensions.name, 'rustdeskaccess'));
  });
  it('allows one concurrent exchange, confines the token, and observes live account changes', async () => {
    const admin = getTestDb();
    const redis = getRedis();
    expect(redis).not.toBeNull();
    const [partner] = await admin.insert(partners).values({ name: 'Native login QA',
      slug: crypto.randomUUID(), type: 'msp' }).returning();
    const [org] = await admin.insert(organizations).values({ partnerId: partner!.id,
      name: 'Native customer', slug: crypto.randomUUID(), currencyCode: 'USD' }).returning();
    process.env.CLOUDCOM_COMPANY_GATEWAY_CONFIG = JSON.stringify({
      teamDomain: 'test.cloudflareaccess.com', audience: 'native-integration',
      companies: [{ subject: 'integration-company', orgId: org!.id, enabled: true }],
    });
    const password = 'Synthetic-Native-Login-Test-583!';
    const [user] = await admin.insert(portalUsers).values({ orgId: org!.id,
      email: `native-${crypto.randomUUID()}@example.test`, passwordHash: await hashPassword(password),
      status: 'active', accessMode: 'remote_only' }).returning();
    const app = new Hono();
    app.route('/api/v1/portal', authRoutes);
    app.route('/api/v1/portal', portalNativeExchangeRoutes);
    app.use('/api/v1/portal/remote/*', portalAuthMiddleware);
    app.use('/api/v1/portal/profile', portalAuthMiddleware);
    app.route('/api/v1/portal', portalRemoteRoutes);
    app.get('/api/v1/portal/profile', c => c.json({ unexpected: true }));
    const login = await app.request('/api/v1/portal/auth/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: org!.id, email: user!.email, password }) });
    expect(login.status).toBe(200);
    process.env.CLOUDCOM_COMPANY_GATEWAY_ENABLED = 'true';
    const browserCookie = login.headers.get('set-cookie')!.split(';', 1)[0]!;
    const browserToken = decodeURIComponent(browserCookie.slice(browserCookie.indexOf('=') + 1));
    const verifier = randomBytes(32).toString('base64url');
    const request = { clientId: NATIVE_CLIENT_ID, redirectUri: 'http://127.0.0.1:49987/cloudcom/callback',
      codeChallengeMethod: 'S256' as const, codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      state: randomBytes(32).toString('base64url') };
    const principal = { portalUserId: user!.id, orgId: org!.id, authEpoch: user!.authEpoch };
    await admin.insert(portalRemoteSettings).values({ orgId: org!.id, enabled: true });
    const csrf = randomBytes(32).toString('base64url');
    const browserHeaders = { Cookie: `${browserCookie}; ${PORTAL_CSRF_COOKIE_NAME}=${csrf}`,
      'Content-Type': 'application/json', [CSRF_HEADER_NAME]: csrf };
    const authorizePath = '/api/v1/portal/remote/native/authorize';
    expect((await app.request(authorizePath, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request) })).status).toBe(401);
    expect((await app.request(authorizePath, { method: 'POST', headers: { Cookie: browserCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(request) })).status).toBe(403);
    // Without a signed company assertion, the browser endpoint must fail.
    // The real-Redis exchange contract starts from an already verified company
    // context; the signed-assertion boundary has its own focused route tests.
    expect((await app.request(authorizePath, { method: 'POST', headers: browserHeaders,
      body: JSON.stringify(request) })).status).toBe(403);
    const issued = await issueNativeLoginCode(principal, browserToken, request, {
      orgId: org!.id, expiresAt: Date.now() + 6 * 3600_000,
      configFingerprint: currentCompanyGatewayFingerprint()!,
    });
    const code = new URL(issued.redirectUri).searchParams.get('code')!;
    const exchange = { code, clientId: request.clientId, redirectUri: request.redirectUri, codeVerifier: verifier };
    const results = await Promise.all(Array.from({ length: 8 }, () => app.request('/api/v1/portal/auth/native/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exchange),
    })));
    const successes = results.filter(value => value.status === 200);
    expect(successes).toHaveLength(1);
    expect(results.filter(value => value.status === 401)).toHaveLength(7);
    expect(successes[0]!.headers.get('Cache-Control')).toBe('no-store');
    const accessToken = (await successes[0]!.json()).accessToken;
    const headers = { Authorization: `Bearer ${accessToken}` };
    try {
      const ttlBefore = await redis!.pttl(`portal:session:${accessToken}`);
      const listing = await app.request('/api/v1/portal/remote/devices', { headers });
      expect(listing.status).toBe(200);
      expect(await listing.json()).toEqual({ devices: [] });
      expect(await redis!.pttl(`portal:session:${accessToken}`)).toBeLessThanOrEqual(ttlBefore);
      expect((await app.request('/api/v1/portal/profile', { headers })).status).toBe(401);
      expect((await app.request('/api/v1/portal/remote/devices', {
        headers: { Cookie: `breeze_portal_session=${accessToken}` },
      })).status).toBe(401);
      await admin.update(portalUsers).set({ accessMode: 'standard' }).where(eq(portalUsers.id, user!.id));
      expect((await app.request('/api/v1/portal/remote/devices', { headers })).status).toBe(403);
      await admin.update(portalUsers).set({ accessMode: 'remote_only', authEpoch: user!.authEpoch + 1 })
        .where(eq(portalUsers.id, user!.id));
      expect((await app.request('/api/v1/portal/remote/devices', { headers })).status).toBe(401);
      const loggedOutCode = await issueNativeLoginCode(principal, browserToken, request,
        { orgId: org!.id, expiresAt: Date.now() + 6 * 3600_000,
          configFingerprint: currentCompanyGatewayFingerprint()! });
      await redis!.del(`portal:session:${browserToken}`);
      expect(await exchangeNativeLoginCode({ ...exchange,
        code: new URL(loggedOutCode.redirectUri).searchParams.get('code')!,
      })).toBeNull();
    } finally {
      await redis!.del(`portal:session:${browserToken}`, `portal:session:${accessToken}`, `portal:user-sessions:${user!.id}`);
    }
  });
});
