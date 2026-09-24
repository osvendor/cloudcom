import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { withDbAccessContext } from '../db';
import { authenticateNativeTarget } from '../services/portalNativeTarget';
import { consumeNativeAdmission, renewNativeAdmission, closeNativeAdmission } from '../services/portalNativeAdmission';
import { NativeAdmissionError, nativeAdmissionEnabled, nativeUuid, nativeConsumeSchema, nativeRenewSchema,
  nativePresenceSchema, type NativeTarget } from '../services/portalNativeAdmissionSchemas';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp, rateLimitIpKey } from '../services/clientIp';
declare module 'hono' { interface ContextVariableMap { nativeTarget: NativeTarget } }
export const nativeTargetRoutes = new Hono();
nativeTargetRoutes.onError((error, c) => c.json({ error: 'Native admission unavailable' }, error instanceof NativeAdmissionError ? error.status : 503));
nativeTargetRoutes.use('*', bodyLimit({ maxSize: 2048 }));
nativeTargetRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!nativeAdmissionEnabled()) return c.json({ error: 'Native admission unavailable' }, 404);
  try {
    const redis = getRedis(); if (!redis) throw new NativeAdmissionError(503);
    const limit = await rateLimiter(redis, `native_target:${rateLimitIpKey(getTrustedClientIp(c))}`, 6000, 60);
    if (!limit.allowed) { c.header('Retry-After', '60'); return c.json({ error: 'Rate limit exceeded' }, 429); }
    const target = await authenticateNativeTarget(c.req.header('Authorization'));
    if (!target) throw new NativeAdmissionError(401);
    const deviceLimit = await rateLimiter(redis, `native_target_device:${target.id}`, 240, 60);
    if (!deviceLimit.allowed) { c.header('Retry-After', '60'); return c.json({ error: 'Rate limit exceeded' }, 429); }
    c.set('nativeTarget', target);
    await withDbAccessContext({ scope: 'organization', orgId: target.orgId, accessibleOrgIds: [target.orgId], userId: null }, next);
  } catch (error) {
    return c.json({ error: 'Native admission unavailable' }, error instanceof NativeAdmissionError ? error.status : 503);
  }
});
nativeTargetRoutes.post('/admissions', zValidator('json', nativeConsumeSchema), async c =>
  c.json(await consumeNativeAdmission(c.get('nativeTarget'), c.req.valid('json'))));
nativeTargetRoutes.post('/sessions/:id/renew', zValidator('param', z.object({ id: nativeUuid })), zValidator('json', nativeRenewSchema), async c => {
  const input = c.req.valid('json');
  return c.json(await renewNativeAdmission(c.get('nativeTarget'), c.req.valid('param').id, input.connectionId, input.leaseToken));
});
nativeTargetRoutes.post('/sessions/:id/closed', zValidator('param', z.object({ id: nativeUuid })), zValidator('json', nativePresenceSchema), async c =>
  c.json(await closeNativeAdmission(c.get('nativeTarget'), c.req.valid('param').id, c.req.valid('json').connectionId)));
