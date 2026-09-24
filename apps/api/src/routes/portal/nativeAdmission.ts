import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { authenticateNativeOperator } from '../../services/portalNativeOperator';
import { issueNativeAdmission, touchNativePresence, endNativeAdmission } from '../../services/portalNativeAdmission';
import { NativeAdmissionError, nativeAdmissionEnabled, nativeUuid, nativeIssueSchema, nativePresenceSchema } from '../../services/portalNativeAdmissionSchemas';
import { portalRemoteStartRateLimit } from './remoteRateLimit';
export const portalNativeAdmissionRoutes = new Hono();
portalNativeAdmissionRoutes.onError((error, c) => c.json({ error: 'Native admission unavailable' }, error instanceof NativeAdmissionError ? error.status : 503));
portalNativeAdmissionRoutes.use('/remote/native/sessions*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!nativeAdmissionEnabled()) return c.json({ error: 'Native admission unavailable' }, 404);
  try { await next(); } catch (error) {
    return c.json({ error: 'Native admission unavailable' }, error instanceof NativeAdmissionError ? error.status : 503);
  }
});
portalNativeAdmissionRoutes.use('/remote/native/sessions*', bodyLimit({ maxSize: 2048 }));
portalNativeAdmissionRoutes.post('/remote/native/sessions', portalRemoteStartRateLimit, zValidator('json', nativeIssueSchema), async c => {
  const operator = await authenticateNativeOperator(c.get('portalAuth'));
  const input = c.req.valid('json');
  return c.json(await issueNativeAdmission(operator, input.deviceId, input.operatorPublicKey), 201);
});
portalNativeAdmissionRoutes.post('/remote/native/sessions/:id/presence', zValidator('param', z.object({ id: nativeUuid })),
  zValidator('json', nativePresenceSchema), async c => {
    const operator = await authenticateNativeOperator(c.get('portalAuth'));
    return c.json(await touchNativePresence(operator, c.req.valid('param').id, c.req.valid('json').connectionId));
  });
portalNativeAdmissionRoutes.post('/remote/native/sessions/:id/end', zValidator('param', z.object({ id: nativeUuid })),
  zValidator('json', z.object({ version: z.literal(2) }).strict()), async c => {
    const operator = await authenticateNativeOperator(c.get('portalAuth'));
    return c.json(await endNativeAdmission(operator, c.req.valid('param').id));
  });
