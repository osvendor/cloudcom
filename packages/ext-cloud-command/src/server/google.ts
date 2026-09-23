import type { Context, Hono } from 'hono';
import type { Variables } from './index';
import type { NativeGoogleServices, GoogleDirectoryKind } from './native-google';

export function mountGoogleRoutes(app: Hono<{ Variables: Variables }>, services?: NativeGoogleServices) {
  const request = (c: Context<{ Variables: Variables }>) => ({
    auth: c.get('auth'), authorization: c.get('extensionAuthorization'), orgId: c.get('scope').organizationId,
  });
  app.use('/google/*', async (c, next) => {
    const keys = [...new URL(c.req.url).searchParams.keys()];
    const pagedDirectory = c.req.method === 'GET' && (c.req.path.startsWith('/google/directory/') || /^\/google\/groups\/[^/]+\/members$/.test(c.req.path));
    const storageReport = c.req.method === 'GET' && c.req.path === '/google/reports/storage';
    const activityReport = c.req.method === 'GET' && c.req.path === '/google/reports/activity';
    if (keys.filter(key => key === 'orgId').length !== 1 || keys.some(key => key !== 'orgId' && !(pagedDirectory && key === 'pageToken') && !(storageReport && (key === 'date' || key === 'pageToken')) && !(activityReport && (key === 'source' || key === 'days' || key === 'pageToken' || key === 'asOf'))))
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
  app.get('/google/groups/:groupId/members', async c => {
    if (!services || services.version !== 1) return c.json({ code: 'native_service_unavailable', error: 'Google Workspace is unavailable.' }, 503);
    const groupId = c.req.param('groupId');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(groupId)) return c.json({ code: 'invalid_group', error: 'Invalid group.' }, 400);
    const tokens = new URL(c.req.url).searchParams.getAll('pageToken');
    if (tokens.length > 1 || (tokens[0] && (tokens[0].length > 2048 || !/^[A-Za-z0-9_\-./+=]+$/.test(tokens[0]))))
      return c.json({ code: 'invalid_page', error: 'Invalid page.' }, 400);
    const result = await services.members(request(c), groupId, tokens[0] ?? null);
    if (!result.ok) return c.json({ code: result.code, error: result.message }, result.code === 'access_denied' ? 403 : result.code === 'connection_not_ready' ? 409 : 502);
    return c.json({ items: result.items, nextPageToken: result.nextPageToken, complete: !result.nextPageToken });
  });
  app.get('/google/users/:userId/mailbox-settings', async c => {
    if (!services || services.version !== 1) return c.json({ code: 'native_service_unavailable', error: 'Google Workspace is unavailable.' }, 503);
    if (!c.get('canManage')) return c.json({ code: 'access_denied', error: 'Organization manager access and MFA are required.' }, 403);
    const userId = c.req.param('userId');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return c.json({ code: 'invalid_user', error: 'Invalid user.' }, 400);
    const result = await services.mailboxSettings(request(c), userId);
    if (!result.ok) return c.json({ code: result.code, error: result.message }, result.code === 'access_denied' ? 403 : result.code === 'connection_not_ready' || result.code === 'state_changed' ? 409 : 502);
    c.header('Cache-Control', 'no-store');
    return c.json(result);
  });
  app.get('/google/reports/storage', async c => {
    if (!services || services.version !== 1) return c.json({ code: 'native_service_unavailable', error: 'Google Workspace is unavailable.' }, 503);
    const params = new URL(c.req.url).searchParams;
    const dates = params.getAll('date');
    const tokens = params.getAll('pageToken');
    const date = dates[0];
    const time = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
    if (dates.length !== 1 || !date || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date
      || time > Date.now() || Date.now() - time > 180 * 86400000
      || tokens.length > 1 || (tokens[0] && (tokens[0].length > 2048 || !/^[A-Za-z0-9_\-./+=]+$/.test(tokens[0]))))
      return c.json({ code: 'invalid_report', error: 'Choose a valid report date within 180 days.' }, 400);
    const result = await services.storage(request(c), date, tokens[0] ?? null);
    if (!result.ok) return c.json({ code: result.code, error: result.message }, result.code === 'access_denied' ? 403 : result.code === 'connection_not_ready' || result.code === 'scope_required' ? 409 : 502);
    c.header('Cache-Control', 'no-store');
    return c.json({ ...result, complete: !result.nextPageToken && !result.partial });
  });
  app.get('/google/reports/activity', async c => {
    if (!services || services.version !== 1) return c.json({ code: 'native_service_unavailable', error: 'Google Workspace is unavailable.' }, 503);
    if (!c.get('canManage')) return c.json({ code: 'access_denied', error: 'Organization manager access and MFA are required.' }, 403);
    const params = new URL(c.req.url).searchParams;
    const sources = params.getAll('source');
    const daysValues = params.getAll('days');
    const tokens = params.getAll('pageToken');
    const anchors = params.getAll('asOf');
    const source = sources[0];
    const days = Number(daysValues[0]);
    if (sources.length !== 1 || !['login', 'admin', 'drive', 'token'].includes(source)
      || daysValues.length !== 1 || !['1', '7', '30'].includes(daysValues[0])
      || tokens.length > 1 || (tokens.length === 1 && (!tokens[0] || tokens[0].length > 2048 || !/^[A-Za-z0-9_\-./+=]+$/.test(tokens[0])))
      || anchors.length > 1 || (anchors.length === 1 && !anchors[0]) || !!tokens[0] !== !!anchors[0]
      || (anchors[0] && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(anchors[0])
        || !Number.isFinite(Date.parse(anchors[0])) || Date.parse(anchors[0]) > Date.now()
        || Date.now() - Date.parse(anchors[0]) > 3600000)))
      return c.json({ code: 'invalid_report', error: 'Choose a supported activity source and window.' }, 400);
    const result = await services.activity(request(c), source as import('./native-google').GoogleActivitySource, days as 1 | 7 | 30, tokens[0] ?? null, anchors[0] ?? null);
    if (!result.ok) return c.json({ code: result.code, error: result.message }, result.code === 'access_denied' ? 403 : result.code === 'connection_not_ready' || result.code === 'scope_required' ? 409 : 502);
    c.header('Cache-Control', 'no-store');
    return c.json({ ...result, complete: !result.nextPageToken && !result.partial });
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
