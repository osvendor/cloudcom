import type { Hono } from 'hono';
import type { Variables } from './index';
import { microsoftResources, projectMicrosoftResource, type MicrosoftResource, type NativeMicrosoftServices } from './native-microsoft';

/** Native connection lifecycle remains owned by Breeze's Integrations surface. */
export function mountMicrosoftRoutes(app: Hono<{ Variables: Variables }>, services?: NativeMicrosoftServices) {
  app.use('/microsoft/*', async (c, next) => {
    const queries = new URL(c.req.url).searchParams;
    if (queries.getAll('orgId').length !== 1 || [...queries.keys()].some(key => key !== 'orgId'))
      return c.json({ error: 'Invalid organization request.', code: 'invalid_request' }, 400);
    await next();
  });
  app.get('/microsoft/connection', async c => {
    if (!services || services.version !== 1) return c.json({
      available: false, connected: false, enabled: false, canManage: false,
      reason: 'Native Microsoft services are unavailable in this host.',
    });
    return c.json(await services.connection({ auth: c.get('auth'), authorization: c.get('extensionAuthorization'), orgId: c.get('scope').organizationId }));
  });
  // Old clients must not silently create a second tenant mapping or revive CIPP.
  app.put('/microsoft/connection', c => c.json({ error: 'Manage the native Microsoft connection in Integrations.', code: 'native_connection_required' }, 409));
  app.get('/microsoft/tenants', c => c.json({ error: 'Manage the native Microsoft connection in Integrations.', code: 'native_connection_required' }, 409));
  app.get('/microsoft/resources/:resource', async c => {
    const resource = c.req.param('resource');
    if (!Object.hasOwn(microsoftResources, resource)) return c.json({ error: 'Unsupported resource.', code: 'unsupported_resource' }, 404);
    if (!services || services.version !== 1) return c.json({ error: 'Native Microsoft services are unavailable.', code: 'native_service_unavailable' }, 503);
    const result = await services.read({ auth: c.get('auth'), authorization: c.get('extensionAuthorization'), orgId: c.get('scope').organizationId }, resource as MicrosoftResource);
    if (!result.ok) {
      if (result.retryAfterSeconds) c.header('Retry-After', String(result.retryAfterSeconds));
      return c.json({ error: result.message, code: result.code }, result.code === 'access_denied' ? 403 : result.code === 'read_rate_limited' ? 429 : result.code === 'connection_not_ready' || result.code === 'connection_changed' ? 409 : 503);
    }
    return c.json(projectMicrosoftResource(resource as MicrosoftResource, result.items, result.truncated));
  });
}
