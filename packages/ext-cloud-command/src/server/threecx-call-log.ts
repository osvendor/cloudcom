import type { Hono } from 'hono';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';
import type { Variables, ThreeCxConnection } from './index';
import type { createProvider, Credentials } from './transport';
import { ProviderError } from './transport';

type Provider = ReturnType<typeof createProvider>;
const fields = ['CdrId', 'CallId', 'StartTime', 'SourceDn', 'SourceDisplayName', 'DestinationDn', 'DestinationDisplayName', 'Answered', 'Status', 'Direction', 'RingingDuration', 'TalkingDuration'] as const;
const time = (input: string | undefined): string | null => {
  if (!input || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(input)) return null;
  const parsed = new Date(input);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(input.slice(0, 19)) ? parsed.toISOString() : null;
};

/** The old PBX report has no verified customer/department predicate. Never read it for a department connection. */
export function projectCallLog(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProviderError('invalid_provider_response');
  const source = raw as Record<string, unknown>;
  return Object.fromEntries(fields.map(key => {
    const value = source[key];
    if (value == null) return [key, null];
    if (key === 'Answered') {
      if (typeof value !== 'boolean') throw new ProviderError('invalid_provider_response');
      return [key, value];
    }
    if (typeof value === 'string' && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value)) return [key, value];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return [key, String(value)];
    throw new ProviderError('invalid_provider_response');
  }));
}

export function mountThreeCxCallLog(app: Hono<{ Variables: Variables }>, deps: {
  connection(orgId: string): Promise<ThreeCxConnection | undefined>;
  credentials(row: ThreeCxConnection): Credentials;
  provider: Provider;
  context: ExtensionRuntimeContext;
}) {
  app.get('/threecx/call-log', async c => {
    const scope = c.get('scope');
    const row = await deps.connection(scope.organizationId);
    if (!row?.enabled) return c.json({ error: 'Not available', code: 'not_available' }, 404);
    if (row.department_id !== null) {
      await deps.context.audit({ orgId: scope.organizationId, actorId: scope.actorId, actorType: 'user', action: 'cloudcommand.threecx.call_log.read', resourceType: 'integration', resourceId: row.id, result: 'failure', details: { reason: 'report_scope_unverified' } });
      return c.json({ error: 'Call reports require verified department isolation before this connection can use them.', code: 'report_scope_unverified' }, 403);
    }
    const start = time(c.req.query('start'));
    const end = time(c.req.query('end'));
    const skipText = c.req.query('skip') ?? '0';
    if (!start || !end || !/^\d{1,6}$/.test(skipText)) return c.json({ error: 'Invalid report range', code: 'invalid_report_range' }, 400);
    const skip = Number(skipText);
    const duration = new Date(end).getTime() - new Date(start).getTime();
    if (duration <= 0 || duration > 31 * 86400000) return c.json({ error: 'Invalid report range', code: 'invalid_report_range' }, 400);
    if (skip !== 0) return c.json({ error: 'Report pagination is unavailable until PBX continuation semantics are verified.', code: 'report_pagination_unverified' }, 409);
    const result = await deps.provider.callLog(deps.credentials(row), start, end, skip);
    if (!Array.isArray(result.value) || result.value.length > 100) throw new ProviderError('invalid_provider_response');
    const items = result.value.map(projectCallLog);
    // The PBX may return an opaque server-driven nextLink. Never invent a $skip continuation,
    // follow a bearer-bearing URL, or imply this first page is the complete report.
    const more = Boolean(result['@odata.nextLink']) || result.value.length === 100;
    await deps.context.audit({ orgId: scope.organizationId, actorId: scope.actorId, actorType: 'user', action: 'cloudcommand.threecx.call_log.read', resourceType: 'integration', resourceId: row.id, result: 'success', details: { returned: items.length, truncated: more } });
    return c.json({ items, nextSkip: null, truncated: more, scope: 'full_pbx', start, end });
  });
}
