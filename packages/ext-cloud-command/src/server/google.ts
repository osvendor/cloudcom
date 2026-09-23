import type { Context, Hono } from 'hono';
import type { Variables } from './index';
import type { NativeGoogleServices, GoogleDirectoryKind } from './native-google';

export function mountGoogleRoutes(app: Hono<{ Variables: Variables }>, services?: NativeGoogleServices) {
  const request = (c: Context<{ Variables: Variables }>) => ({
    auth: c.get('auth'), authorization: c.get('extensionAuthorization'), orgId: c.get('scope').organizationId,
  });
  app.use('/google/*', async (c, next) => {
    const keys = [...new URL(c.req.url).searchParams.keys()];
    if (keys.filter(key => key === 'orgId').length !== 1 || keys.some(key => key !== 'orgId' && key !== 'pageToken'))
      return c.json({ code: 'invalid_request', error: 'Invalid organization request.' }, 400);
    await next();
  });
  app.get('/google/connection', async c => {
    if (!services || services.version !== 1) return c.json({ available: false, connected: false, enabled: false, canManage: false });
    return c.json(await services.connection(request(c)));
  });
  app.get('/google/directory/:kind', async c => {
    if (!services || services.version !== 1) return c.json({ code: 'native_service_unavailable', error: 'Google Workspace is unavailable.' }, 503);
    const kind = c.req.param('kind');
    if (kind !== 'users' && kind !== 'groups') return c.json({ code: 'unsupported_resource', error: 'Unsupported directory resource.' }, 404);
    const tokens = new URL(c.req.url).searchParams.getAll('pageToken');
    if (tokens.length > 1 || (tokens[0] && (tokens[0].length > 2048 || !/^[A-Za-z0-9_\-./+=]+$/.test(tokens[0]))))
      return c.json({ code: 'invalid_page', error: 'Invalid page.' }, 400);
    const result = await services.directory(request(c), kind as GoogleDirectoryKind, tokens[0] ?? null);
    if (!result.ok) return c.json({ code: result.code, error: result.message }, result.code === 'access_denied' ? 403 : result.code === 'connection_not_ready' ? 409 : 502);
    return c.json({ items: result.items, nextPageToken: result.nextPageToken, complete: !result.nextPageToken });
  });
}
