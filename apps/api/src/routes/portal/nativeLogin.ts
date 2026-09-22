import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { db, runOutsideDbContext } from '../../db';
import { portalRemoteSettings } from '../../db/schema';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { rateLimitIpKey } from '../../services/clientIp';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { issueNativeLoginCode, exchangeNativeLoginCode, validateNativeLoginRequest,
  NATIVE_CLIENT_ID } from '../../services/portalNativeLogin';
import { getClientIp, validatePortalCookieCsrfRequest } from './helpers';
import { verifyPortalCompanyGateway } from '../../services/portalCompanyGateway';

export const portalNativeExchangeRoutes = new Hono();
export const portalNativeAuthorizeRoutes = new Hono();

// Kept off until the paired native build and target-side acceptance pass.
const enabled = () => process.env.CLOUDCOM_NATIVE_LOGIN_ENABLED === 'true';
for (const [routes, path] of [[portalNativeExchangeRoutes, '/auth/native/exchange'],
  [portalNativeAuthorizeRoutes, '/remote/native/authorize']] as const) {
  routes.use(path, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    if (!enabled()) return c.json({ error: 'Native sign-in is unavailable' }, 404);
    if (!getRedis()) return c.json({ error: 'Native sign-in is unavailable' }, 503);
    return next();
  });
  routes.use(path, bodyLimit({ maxSize: 2048 }));
}

const authorizeSchema = z.object({ clientId: z.literal(NATIVE_CLIENT_ID),
  redirectUri: z.string().max(160), codeChallenge: z.string().length(43),
  codeChallengeMethod: z.literal('S256'), state: z.string().length(43) }).strict();

// Mounted only under the existing portal remote middleware: live customer
// identity, organization/RLS and extension gates run before this handler.
portalNativeAuthorizeRoutes.post('/remote/native/authorize', zValidator('json', authorizeSchema), async c => {
  const auth = c.get('portalAuth');
  if (auth.authMethod !== 'cookie' || auth.user.accessMode !== 'remote_only') {
    return c.json({ error: 'Sign in using your browser to continue' }, 403);
  }
  const csrf = validatePortalCookieCsrfRequest(c);
  if (csrf) return c.json({ error: csrf }, 403);
  const request = c.req.valid('json');
  if (!validateNativeLoginRequest(request)) return c.json({ error: 'Invalid native sign-in request' }, 400);
  const [settings] = await db.select({ enabled: portalRemoteSettings.enabled }).from(portalRemoteSettings)
    .where(eq(portalRemoteSettings.orgId, auth.user.orgId)).limit(1);
  if (!settings?.enabled) return c.json({ error: 'Remote access is unavailable' }, 403);
  const limit = await runOutsideDbContext(() => rateLimiter(getRedis(), `portal_native_login:${auth.user.orgId}:${auth.user.id}`, 10, 3600));
  if (!limit.allowed) { c.header('Retry-After', '3600'); return c.json({ error: 'Too many sign-in attempts' }, 429); }
  try {
    const result = await issueNativeLoginCode({ portalUserId: auth.user.id, orgId: auth.user.orgId,
      authEpoch: auth.user.authEpoch! }, auth.token, request);
    await writeAuditEventAsync(c, { orgId: auth.user.orgId, actorType: 'user', actorId: auth.user.id,
      action: 'portal.native.authorize', resourceType: 'portal_auth', resourceId: auth.user.id,
      result: 'success', details: { principalType: 'portal_user', clientId: NATIVE_CLIENT_ID } });
    return c.json(result);
  } catch {
    return c.json({ error: 'Native sign-in is unavailable' }, 503);
  }
});

portalNativeExchangeRoutes.post('/auth/native/exchange', zValidator('json', z.object({
  code: z.string().length(43), clientId: z.literal(NATIVE_CLIENT_ID),
  redirectUri: z.string().max(160), codeVerifier: z.string().min(43).max(128),
}).strict()), async c => {
  const limit = await rateLimiter(getRedis(), `portal_native_exchange:${rateLimitIpKey(getClientIp(c))}`, 30, 60);
  if (!limit.allowed) { c.header('Retry-After', '60'); return c.json({ error: 'Too many sign-in attempts' }, 429); }
  const company = await verifyPortalCompanyGateway(c.req.header('Cf-Access-Jwt-Assertion'));
  if (!company.ok) return c.json({ error: 'Company authentication is required' }, company.status);
  const result = await exchangeNativeLoginCode(c.req.valid('json'), company.orgId ?? undefined);
  return result ? c.json(result) : c.json({ error: 'Invalid or expired sign-in code' }, 401);
});
