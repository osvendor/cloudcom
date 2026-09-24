import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '../../lib/validation';
import { enrollNativeTarget } from '../../services/portalNativeTarget';
import { NativeAdmissionError, nativeAdmissionEnabled, targetEnrollmentSchema, targetRotationSchema } from '../../services/portalNativeAdmissionSchemas';
export const nativeTargetEnrollmentRoutes = new Hono();
nativeTargetEnrollmentRoutes.onError((error, c) => c.json({ error: 'Native admission unavailable' }, error instanceof NativeAdmissionError ? error.status : 503));
nativeTargetEnrollmentRoutes.use('/:id/native-target/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!nativeAdmissionEnabled()) return c.json({ error: 'Native admission unavailable' }, 404);
  const agent = c.get('agent');
  if (!agent || agent.role !== 'agent' || !agent.authTokenHash || agent.tenantDraining || agent.deviceUninstallDraining
    || c.get('agentTokenRotationRequired') || c.get('agentPendingTokenPresented')) return c.json({ error: 'Forbidden' }, 403);
  try { await next(); } catch (error) {
    return c.json({ error: 'Native enrollment unavailable' }, error instanceof NativeAdmissionError ? error.status : 503);
  }
});
nativeTargetEnrollmentRoutes.use('/:id/native-target/*', bodyLimit({ maxSize: 2048 }));
nativeTargetEnrollmentRoutes.post('/:id/native-target/enroll', zValidator('json', targetEnrollmentSchema), async c =>
  c.json(await enrollNativeTarget(c.get('agent'), c.req.valid('json'))));
nativeTargetEnrollmentRoutes.post('/:id/native-target/rotate', zValidator('json', targetRotationSchema), async c =>
  c.json(await enrollNativeTarget(c.get('agent'), c.req.valid('json'), c.req.valid('json').expectedGeneration)));
