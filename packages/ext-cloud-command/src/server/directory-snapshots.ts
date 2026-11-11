import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';
import type { Variables } from './index';
import type { NativeMicrosoftServices } from './native-microsoft';

const sourceStatus = z.enum(['never', 'ready', 'stale']);
const snapshot = z.object({
  tenant_id: z.string().uuid(), connection_generation: z.number().int().positive(),
  directory_data: z.unknown().nullable(), directory_collected_at: z.coerce.date().nullable(),
  usage_data: z.unknown().nullable(), usage_collected_at: z.coerce.date().nullable(),
  directory_status: sourceStatus, usage_status: sourceStatus,
  last_attempt_at: z.coerce.date().nullable(),
});

function rows<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error('Unexpected database result');
  return value as T[];
}

/** The host authorization and org scope run before this route. A connection change
 * makes old-generation snapshots unreadable even if the old row is retained. */
export function mountDirectorySnapshotRoutes(
  app: Hono<{ Variables: Variables }>, context: ExtensionRuntimeContext,
  services?: NativeMicrosoftServices,
) {
  app.get('/microsoft/directory/snapshot', async c => {
    c.header('Cache-Control', 'no-store');
    if (!services) return c.json({ code: 'native_service_unavailable' }, 503);
    const orgId = c.get('scope').organizationId;
    const connection = await services.connection({ auth: c.get('auth'),
      authorization: c.get('extensionAuthorization'), orgId });
    if (!connection.enabled || !connection.tenantId) return c.json({ code: 'connection_not_ready' }, 409);
    const current = rows<unknown>(await context.db.execute(sql`
      SELECT s.tenant_id, s.connection_generation, s.directory_data, s.directory_collected_at,
        s.usage_data, s.usage_collected_at, s.directory_status, s.usage_status, s.last_attempt_at
      FROM cloudcommand_microsoft_directory_snapshots s
      JOIN cloudcommand_microsoft_admin_connections c ON c.org_id = s.org_id
      WHERE s.org_id = ${orgId}::uuid AND c.enabled = true
        AND c.tenant_id = s.tenant_id AND c.generation = s.connection_generation
        AND c.tenant_id = ${connection.tenantId}::uuid
      LIMIT 1
    `))[0];
    const parsed = current === undefined ? null : snapshot.safeParse(current);
    if (parsed && !parsed.success) return c.json({ code: 'snapshot_invalid' }, 503);
    const data = parsed?.data;
    return c.json({
      tenantId: connection.tenantId,
      directory: data ? { status: data.directory_status, collectedAt: data.directory_collected_at?.toISOString() ?? null,
        data: data.directory_data } : { status: 'never', collectedAt: null, data: null },
      usage: data ? { status: data.usage_status, collectedAt: data.usage_collected_at?.toISOString() ?? null,
        data: data.usage_data } : { status: 'never', collectedAt: null, data: null },
      lastAttemptAt: data?.last_attempt_at?.toISOString() ?? null,
    });
  });
  app.post('/microsoft/directory/refresh', async c => {
    c.header('Cache-Control', 'no-store');
    if (!services) return c.json({ code: 'native_service_unavailable' }, 503);
    const scope = c.get('scope');
    const connection = await services.connection({ auth: c.get('auth'),
      authorization: c.get('extensionAuthorization'), orgId: scope.organizationId });
    if (!connection.enabled || !connection.tenantId) return c.json({ code: 'connection_not_ready' }, 409);
    // This durable request is visible to the API-role sweep, even if the
    // request-serving process exits before the next tick. It does no Graph or
    // Exchange work inside the browser request transaction.
    const queued = rows<unknown>(await context.db.execute(sql`
      INSERT INTO cloudcommand_microsoft_directory_snapshots
        (org_id, tenant_id, connection_generation, refresh_requested_at)
      SELECT c.org_id, c.tenant_id, c.generation, now()
      FROM cloudcommand_microsoft_admin_connections c
      WHERE c.org_id = ${scope.organizationId}::uuid AND c.enabled = true
        AND c.tenant_id = ${connection.tenantId}::uuid
      ON CONFLICT (org_id) DO UPDATE SET refresh_requested_at = CASE
        WHEN cloudcommand_microsoft_directory_snapshots.refresh_requested_at >= now() - interval '1 minute'
          THEN cloudcommand_microsoft_directory_snapshots.refresh_requested_at
        ELSE now() END
      RETURNING org_id
    `));
    if (queued.length !== 1) return c.json({ code: 'connection_changed' }, 409);
    await context.audit({ orgId: scope.organizationId, actorId: scope.actorId,
      actorType: 'user', action: 'cloudcommand.microsoft.directory.refresh.request',
      resourceType: 'integration', resourceId: scope.organizationId, result: 'success' });
    return c.json({ queued: true }, 202);
  });
}
