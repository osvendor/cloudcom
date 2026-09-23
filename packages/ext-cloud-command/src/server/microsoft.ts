import type { Hono } from 'hono';
import type { Variables } from './index';
import { microsoftResources, projectMicrosoftResource, type MicrosoftResource, type NativeMicrosoftServices } from './native-microsoft';
import { microsoftOnboardingStatus } from './onboarding';
import type { Context } from 'hono';

/** Native connection lifecycle remains owned by the single Extensions Connect surface. */
export function mountMicrosoftRoutes(app: Hono<{ Variables: Variables }>, services?: NativeMicrosoftServices) {
  const request = (c: Context<{ Variables: Variables }>) => ({ auth: c.get('auth'), authorization: c.get('extensionAuthorization'), orgId: c.get('scope').organizationId });
  const administration = (method: 'start' | 'complete' | 'execute' | 'disconnect') => async (c: Context<{ Variables: Variables }>) => {
    // Administration responses can contain a one-time temporary password.
    c.header('Cache-Control', 'no-store');
    if (!services?.administration) {
      const response = c.json({ error: 'Microsoft administration is unavailable.', code: 'onboarding_unavailable' }, 503);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
    try {
      const response = c.json(await services.administration[method](request(c), await c.req.json()));
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'invalid_or_failed_request';
      const allowed = new Set(['access_denied', 'invalid_operation', 'connection_not_ready', 'connection_changed', 'audit_unavailable', 'unknown_write_outcome', 'provider_failed', 'provider_rejected', 'provider_unreachable', 'worker_busy', 'exchange_unavailable', 'consent_expired_or_used', 'consent_rejected', 'tenant_verification_failed', 'administration_permissions_missing', 'provider_access_denied', 'provider_rate_limited', 'unsupported_group', 'role_assignment_state_unknown', 'last_global_administrator', 'method_not_removable']);
      const operation = method === 'execute' ? await c.req.json().catch(() => null) as { type?: unknown } | null : null;
      const optionalRole = operation?.type === 'user.password.reset' ? 'User-PasswordProfile.ReadWrite.All'
        : operation?.type === 'user.sessions.revoke' ? 'User.RevokeSessions.All'
          : operation?.type === 'user.globalAdmin.set' ? 'RoleManagement.ReadWrite.Directory'
            : operation?.type === 'user.mfa.methods.list' ? 'UserAuthenticationMethod.Read.All'
              : operation?.type === 'user.mfa.method.remove' ? 'UserAuthenticationMethod.ReadWrite.All' : null;
      const message = code === 'unknown_write_outcome'
        ? 'The change may have been applied. Refresh before attempting another change.'
        : code === 'provider_rejected' && operation?.type === 'user.update'
          ? 'Microsoft rejected the profile update. Refresh the user and review the current values before trying again.'
        : code === 'last_global_administrator'
          ? 'The last Global Administrator cannot be removed.'
        : code === 'role_assignment_state_unknown'
          ? 'Microsoft returned an incomplete Global Administrator assignment list. No change was made.'
        : code === 'method_not_removable'
          ? 'This authentication method is not available for removal. Refresh the user before trying again.'
        : code === 'provider_access_denied' && optionalRole
          ? `This action is not enabled. Grant the ${optionalRole} application permission to the connected enterprise app, then retry.`
          : 'The Microsoft request could not be completed. Check setup and try again.';
      const response = c.json({ code: allowed.has(code) ? code : 'invalid_or_failed_request', error: message }, code === 'access_denied' ? 403 : 409);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
  };
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
  app.get('/microsoft/onboarding', async c => c.json(await microsoftOnboardingStatus(services, {
    auth: c.get('auth'), authorization: c.get('extensionAuthorization'), orgId: c.get('scope').organizationId,
  })));
  app.post('/microsoft/onboarding/recheck', async c => c.json(await microsoftOnboardingStatus(services, {
    auth: c.get('auth'), authorization: c.get('extensionAuthorization'), orgId: c.get('scope').organizationId,
  }, true)));
  // Never initiate read-only consent and present it as consent for full administration.
  app.post('/microsoft/onboarding/start', administration('start'));
  app.post('/microsoft/onboarding/complete', administration('complete'));
  app.post('/microsoft/administration', administration('execute'));
  app.post('/microsoft/disconnect', administration('disconnect'));
  // Old clients must not silently create a second tenant mapping or revive CIPP.
  app.put('/microsoft/connection', c => c.json({ error: 'Manage the native Microsoft connection in Extensions > Connect.', code: 'native_connection_required' }, 409));
  app.get('/microsoft/tenants', c => c.json({ error: 'Manage the native Microsoft connection in Extensions > Connect.', code: 'native_connection_required' }, 409));
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
