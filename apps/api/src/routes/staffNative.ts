import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { zValidator } from '../lib/validation';
import { db, withDbAccessContext } from '../db';
import { portalNativeTargets } from '../db/schema/portalNative';
import { authMiddleware, requireInteractiveSession, requireMfa, requirePermission, computeAccessibleOrgIds } from '../middleware/auth';
import { ipAllowlistGuard } from '../middleware/ipAllowlistGuard';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp, rateLimitIpKey } from '../services/clientIp';
import { NATIVE_CLIENT_ID } from '../services/portalNativeLogin';
import { staffNativeEnabled, issueStaffNativeLoginCode, exchangeStaffNativeLoginCode,
  authenticateStaffNativeOperator, endStaffNativeLogin } from '../services/staffNativeLogin';
import { staffNativePrincipalFromAuth, authorizeStaffNativeDevice } from '../services/staffNativeAuthority';
import { issueStaffNativeAdmission, touchStaffNativePresence, endStaffNativeAdmission, type StaffNativeOperator } from '../services/staffNativeAdmission';
import { NativeAdmissionError, nativeUuid, nativeIssueSchema, nativePresenceSchema } from '../services/portalNativeAdmissionSchemas';
import { writeAuditEventAsync } from '../services/auditEvents';
import { renameStaffNativeDevice } from '../services/staffNativeDirectory';
import { listStaffRemoteComputers } from '../services/staffRemoteDirectory';
declare module 'hono' { interface ContextVariableMap { staffNative: StaffNativeOperator } }

export const staffNativeRoutes = new Hono();
staffNativeRoutes.onError((error, c) => c.json({ error: 'Staff remote access unavailable' },
  error instanceof NativeAdmissionError ? error.status : error instanceof HTTPException && error.status === 401 ? 401 : 503));
staffNativeRoutes.use('*', bodyLimit({ maxSize: 2048 }));
staffNativeRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!staffNativeEnabled()) return c.json({ error: 'Staff remote access unavailable' }, 404);
  const redis = getRedis(); if (!redis) throw new NativeAdmissionError(503);
  const limit = await rateLimiter(redis, `staff_native_ip:${rateLimitIpKey(getTrustedClientIp(c))}`, 300, 60);
  if (!limit.allowed) { c.header('Retry-After', '60'); return c.json({ error: 'Rate limit exceeded' }, 429); }
  await next();
});
const browser = new Hono();
for (const path of ['/authorize', '/launch/*', '/browser/*']) {
  browser.use(path, authMiddleware, requireInteractiveSession(), requireMfa(), requirePermission('remote', 'access'));
}
browser.get('/browser/devices', zValidator('query', z.object({ cursor: nativeUuid.optional() }).strict()), async c => {
  return c.json(await listStaffRemoteComputers(staffNativePrincipalFromAuth(c.get('auth')), c.req.valid('query').cursor));
});
browser.post('/browser/devices/:id/name', zValidator('param', z.object({ id: nativeUuid })),
  zValidator('json', z.object({ displayName: z.string().trim().max(255).nullable() }).strict()), async c => {
    const principal = staffNativePrincipalFromAuth(c.get('auth'));
    const result = await renameStaffNativeDevice(principal, c.req.valid('param').id, c.req.valid('json').displayName || null);
    await writeAuditEventAsync(c, { orgId: result.orgId, actorType: 'user', actorId: principal.userId,
      action: 'device.update', resourceType: 'device', resourceId: result.id, result: 'success',
      details: { source: 'remote_browser', previousDisplayName: result.previousName, displayName: result.displayName } });
    return c.json({ success: true, id: result.id, displayName: result.displayName });
  });
browser.post('/authorize', zValidator('json', z.object({ clientId: z.literal(NATIVE_CLIENT_ID),
  redirectUri: z.string().max(160), codeChallenge: z.string().length(43), codeChallengeMethod: z.literal('S256'),
  state: z.string().length(43) }).strict()), async c => {
  const principal = staffNativePrincipalFromAuth(c.get('auth'));
  const limit = await rateLimiter(getRedis()!, `staff_native_login:${principal.userId}`, 10, 3600);
  if (!limit.allowed) { c.header('Retry-After', '3600'); return c.json({ error: 'Too many sign-in attempts' }, 429); }
  const result = await issueStaffNativeLoginCode(principal, c.req.valid('json'));
  await writeAuditEventAsync(c, { orgId: null, actorType: 'user', actorId: principal.userId, action: 'staff.native.authorize',
    resourceType: 'user', resourceId: principal.userId, result: 'success', details: { principalType: 'staff_native' } });
  return c.json(result);
});
browser.post('/launch/:id', zValidator('param', z.object({ id: nativeUuid })), async c => {
  // Organization-scoped technicians keep their existing provider workflow.
  if (c.get('auth').scope !== 'partner') throw new NativeAdmissionError(404);
  const [target] = await db.select({ id: portalNativeTargets.id }).from(portalNativeTargets)
    .where(and(eq(portalNativeTargets.deviceId, c.req.valid('param').id), eq(portalNativeTargets.enabled, true))).limit(1);
  if (!target) throw new NativeAdmissionError(404);
  const principal = staffNativePrincipalFromAuth(c.get('auth'));
  const { device } = await authorizeStaffNativeDevice(principal, c.req.valid('param').id);
  return c.json({ launchUrl: `cloudcom-remote://staff/connect/${device.id}` });
});
staffNativeRoutes.route('/', browser);
staffNativeRoutes.post('/exchange', zValidator('json', z.object({ code: z.string().length(43),
  codeVerifier: z.string().min(43).max(128), redirectUri: z.string().max(160), clientId: z.literal(NATIVE_CLIENT_ID) }).strict()),
  async c => c.json(await exchangeStaffNativeLoginCode(c.req.valid('json'))));

const native = new Hono();
native.use('*', async (c, next) => {
  const operator = await authenticateStaffNativeOperator(c.req.header('Authorization'));
  const { principal } = operator;
  const limit = await rateLimiter(getRedis()!, `staff_native_user:${principal.userId}`, 180, 60);
  if (!limit.allowed) { c.header('Retry-After', '60'); return c.json({ error: 'Rate limit exceeded' }, 429); }
  const { orgIds } = await computeAccessibleOrgIds('partner', principal.partnerId, null, principal.userId);
  c.set('staffNative', operator);
  return ipAllowlistGuard(c, async () => {
    await withDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds,
      currentPartnerId: principal.partnerId, accessiblePartnerIds: [principal.partnerId], userId: principal.userId }, next);
  }, { partnerId: principal.partnerId, isPlatformAdmin: false, actorId: principal.userId, actorEmail: null });
});
native.get('/devices', zValidator('query', z.object({ cursor: nativeUuid.optional() }).strict()), async c => {
  return c.json(await listStaffRemoteComputers(c.get('staffNative').principal, c.req.valid('query').cursor));
});
native.post('/devices/:id/name', zValidator('param', z.object({ id: nativeUuid })),
  zValidator('json', z.object({ displayName: z.string().trim().max(255).nullable() }).strict()), async c => {
    const id = c.req.valid('param').id;
    const result = await renameStaffNativeDevice(c.get('staffNative').principal, id, c.req.valid('json').displayName || null);
    await writeAuditEventAsync(c, { orgId: result.orgId, actorType: 'user', actorId: c.get('staffNative').principal.userId,
      action: 'device.update', resourceType: 'device', resourceId: id, result: 'success',
      details: { source: 'staff_native', previousDisplayName: result.previousName, displayName: result.displayName } });
    return c.json({ success: true, id: result.id, displayName: result.displayName });
  });
native.post('/logout', async c => { await endStaffNativeLogin(c.get('staffNative').sessionHash); return c.json({ success: true }); });
native.post('/sessions', zValidator('json', nativeIssueSchema), async c => {
  const input = c.req.valid('json');
  const result = await issueStaffNativeAdmission(c.get('staffNative'), input.deviceId, input.operatorPublicKey);
  await writeAuditEventAsync(c, { orgId: result.orgId, actorType: 'user', actorId: c.get('staffNative').principal.userId,
    action: 'staff.native.session.issued', resourceType: 'device', resourceId: input.deviceId, result: 'success',
    details: { sessionId: result.sessionId } });
  return c.json(result, 201);
});
native.post('/sessions/:id/presence', zValidator('param', z.object({ id: nativeUuid })), zValidator('json', nativePresenceSchema),
  async c => c.json(await touchStaffNativePresence(c.get('staffNative'), c.req.valid('param').id, c.req.valid('json').connectionId)));
native.post('/sessions/:id/end', zValidator('param', z.object({ id: nativeUuid })), zValidator('json', z.object({ version: z.literal(2) }).strict()),
  async c => c.json(await endStaffNativeAdmission(c.get('staffNative'), c.req.valid('param').id)));
staffNativeRoutes.route('/', native);
