import type { Context, Hono } from 'hono';
import type { Variables } from './index';
import type { NativeGoogleServices, GoogleDirectoryKind } from './native-google';

export function mountGoogleRoutes(app: Hono<{ Variables: Variables }>, services?: NativeGoogleServices) {
  const request = (c: Context<{ Variables: Variables }>) => ({
    auth: c.get('auth'), authorization: c.get('extensionAuthorization'), orgId: c.get('scope').organizationId,
  });
  app.use('/google/*', async (c, next) => {
    const keys = [...new URL(c.req.url).searchParams.keys()];
    const pagedDirectory = c.req.method === 'GET' && c.req.path.startsWith('/google/directory/');
    if (keys.filter(key => key === 'orgId').length !== 1 || keys.some(key => key !== 'orgId' && !(pagedDirectory && key === 'pageToken')))
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
    if (kind !== 'users' && kind !== 'groups' && kind !== 'archived') return c.json({ code: 'unsupported_resource', error: 'Unsupported directory resource.' }, 404);
    const tokens = new URL(c.req.url).searchParams.getAll('pageToken');
    if (tokens.length > 1 || (tokens[0] && (tokens[0].length > 2048 || !/^[A-Za-z0-9_\-./+=]+$/.test(tokens[0]))))
      return c.json({ code: 'invalid_page', error: 'Invalid page.' }, 400);
    const result = await services.directory(request(c), kind as GoogleDirectoryKind, tokens[0] ?? null);
    if (!result.ok) return c.json({ code: result.code, error: result.message }, result.code === 'access_denied' ? 403 : result.code === 'connection_not_ready' ? 409 : 502);
    return c.json({ items: result.items, nextPageToken: result.nextPageToken, complete: !result.nextPageToken });
  });
  app.post('/google/users/suspension', async c => {
    if (!services || services.version !== 1) return c.json({ code: 'native_service_unavailable', error: 'Google Workspace is unavailable.' }, 503);
    if (!c.get('canManage')) return c.json({ code: 'access_denied', error: 'Organization manager access and MFA are required.' }, 403);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ code: 'invalid_operation', error: 'Invalid account request.' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ code: 'invalid_operation', error: 'Invalid account request.' }, 400);
    const data = body as Record<string, unknown>;
    if (Object.keys(data).length !== 5 || typeof data.userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.userId)
      || typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || data.email.length > 320
      || typeof data.expectedSuspended !== 'boolean' || typeof data.suspended !== 'boolean'
      || data.suspended === data.expectedSuspended || data.confirmation !== data.email) return c.json({ code: 'invalid_operation', error: 'Invalid account request.' }, 400);
    try { await services.auditSuspension(request(c), data.userId, 'intent'); }
    catch { return c.json({ code: 'audit_unavailable', error: 'The action could not be audited. No change was sent.' }, 503); }
    let result: Awaited<ReturnType<NativeGoogleServices['setSuspended']>>;
    try { result = await services.setSuspended(request(c), data as import('./native-google').GoogleSuspendInput); }
    catch { result = { ok: false, code: 'unknown_write_outcome', message: 'The change may have been applied. Refresh before retrying.' }; }
    try { await services.auditSuspension(request(c), data.userId, result.ok ? 'success' : 'failure'); }
    catch { return c.json({ code: 'unknown_write_outcome', error: 'The action may have been applied. Refresh before retrying.' }, 409); }
    if (!result.ok) return c.json({ code: result.code, error: result.message }, result.code === 'access_denied' ? 403 : 409);
    return c.json(result);
  });
  app.post('/google/users/profile', async c => {
    if (!services || services.version !== 1) return c.json({ code: 'native_service_unavailable', error: 'Google Workspace is unavailable.' }, 503);
    if (!c.get('canManage')) return c.json({ code: 'access_denied', error: 'Organization manager access and MFA are required.' }, 403);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ code: 'invalid_operation', error: 'Invalid account request.' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ code: 'invalid_operation', error: 'Invalid account request.' }, 400);
    const data = body as Record<string, unknown>;
    const name = (value: unknown) => typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
    if (Object.keys(data).length !== 6 || typeof data.userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.userId)
      || typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || data.email.length > 320
      || !name(data.givenName) || !name(data.familyName) || !name(data.expectedGivenName) || !name(data.expectedFamilyName)
      || (data.givenName === data.expectedGivenName && data.familyName === data.expectedFamilyName))
      return c.json({ code: 'invalid_operation', error: 'Invalid account request.' }, 400);
    try { await services.auditProfile(request(c), data.userId, 'intent'); }
    catch { return c.json({ code: 'audit_unavailable', error: 'The action could not be audited. No change was sent.' }, 503); }
    let result: Awaited<ReturnType<NativeGoogleServices['updateProfile']>>;
    try { result = await services.updateProfile(request(c), data as import('./native-google').GoogleProfileInput); }
    catch { result = { ok: false, code: 'unknown_write_outcome', message: 'The change may have been applied. Refresh before retrying.' }; }
    try { await services.auditProfile(request(c), data.userId, result.ok ? 'success' : 'failure'); }
    catch { return c.json({ code: 'unknown_write_outcome', error: 'The action may have been applied. Refresh before retrying.' }, 409); }
    if (!result.ok) return c.json({ code: result.code, error: result.message }, result.code === 'access_denied' ? 403 : 409);
    return c.json(result);
  });
}
