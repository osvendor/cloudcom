import { createHmac, timingSafeEqual } from 'node:crypto';
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
  const cursorSignature = (secret: string, row: ThreeCxConnection, start: string, end: string, skip: number, expires: string) =>
    createHmac('sha256', secret).update(JSON.stringify([row.id, row.org_id, row.version, start, end, skip, expires])).digest('hex');
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
    if (!start || !end || !/^(0|[1-9]\d{0,5})$/.test(skipText)) return c.json({ error: 'Invalid report range', code: 'invalid_report_range' }, 400);
    const skip = Number(skipText);
    const duration = new Date(end).getTime() - new Date(start).getTime();
    if (duration <= 0 || duration > 31 * 86400000) return c.json({ error: 'Invalid report range', code: 'invalid_report_range' }, 400);
    if (skip > 100000 || skip % 100 !== 0) return c.json({ error: 'Invalid report page', code: 'invalid_report_page' }, 400);
    const credentials = deps.credentials(row);
    if (skip > 0) {
      const cursor = c.req.query('cursor') ?? '';
      const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(cursor);
      const expires = match?.[1] ?? '';
      const validTime = Number(expires) > Date.now() && Number(expires) < Date.now() + 600001;
      const expected = cursorSignature(credentials.secret, row, start, end, skip, expires);
      if (!match || !validTime || !timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(expected, 'hex')))
        return c.json({ error: 'Report page expired; search again.', code: 'invalid_report_cursor' }, 409);
    }
    const result = await deps.provider.callLog(credentials, start, end, skip);
    if (!Array.isArray(result.value) || result.value.length > 100) throw new ProviderError('invalid_provider_response');
    const items = result.value.map(projectCallLog);
    // A continuation is usable only when the provider's nextLink has the exact same
    // origin, function path and fixed query, and advances by one page. The transport
    // validates it but never follows a provider-supplied bearer-bearing URL.
    const nextSkip = items.length > 0 ? result.verifiedNextSkip : null;
    const nextExpires = String(Date.now() + 600000);
    const nextCursor = nextSkip === null ? null : `${nextExpires}.${cursorSignature(credentials.secret, row, start, end, nextSkip, nextExpires)}`;
    const more = Boolean(result['@odata.nextLink']) || result.value.length === 100;
    await deps.context.audit({ orgId: scope.organizationId, actorId: scope.actorId, actorType: 'user', action: 'cloudcommand.threecx.call_log.read', resourceType: 'integration', resourceId: row.id, result: 'success', details: { returned: items.length, truncated: more, offset: skip } });
    return c.json({ items, nextSkip, nextCursor, truncated: more, scope: 'full_pbx', start, end });
  });
}
