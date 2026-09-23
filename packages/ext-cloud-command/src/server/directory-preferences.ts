import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';
import type { Variables } from './index';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const update = z.object({ excluded: z.boolean() }).strict();
const table = 'cloudcommand_microsoft_directory_preferences';

function rows<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error('Unexpected database result');
  return value as T[];
}
function userId(c: Context<{ Variables: Variables }>) {
  const parsed = uuid.safeParse(c.req.param('userId'));
  if (!parsed.success) return null;
  return parsed.data;
}

/**
 * Per-technician directory preference. The surrounding extension route guard
 * owns authenticated org membership and write/MFA gating; this module scopes
 * every query to that host-derived actor and organization and never consumes
 * either identity from client input.
 */
export function mountDirectoryPreferenceRoutes(
  app: Hono<{ Variables: Variables }>,
  context: ExtensionRuntimeContext,
) {
  app.get('/microsoft/directory/exclusions', async c => {
    const scope = c.get('scope');
    const result = rows<{ microsoft_user_id: string }>(await context.db.execute(sql`
      SELECT microsoft_user_id FROM cloudcommand_microsoft_directory_preferences
      WHERE org_id = ${scope.organizationId}::uuid AND actor_id = ${scope.actorId}::uuid AND excluded = true
      ORDER BY microsoft_user_id LIMIT 1001
    `));
    if (result.length > 1000) return c.json({ error: 'Directory exclusion inventory exceeds the supported limit.', code: 'directory_preference_limit' }, 409);
    const items = z.array(uuid).max(1000).parse(result.map(row => row.microsoft_user_id));
    return c.json({ items });
  });
  app.get('/microsoft/directory/users/:userId/exclude', async c => {
    const microsoftUserId = userId(c);
    if (!microsoftUserId) return c.json({ error: 'Invalid Microsoft user.', code: 'invalid_microsoft_user' }, 400);
    const scope = c.get('scope');
    const row = rows<{ excluded: boolean }>(await context.db.execute(sql`
      SELECT excluded FROM cloudcommand_microsoft_directory_preferences
      WHERE org_id = ${scope.organizationId}::uuid AND actor_id = ${scope.actorId}::uuid
        AND microsoft_user_id = ${microsoftUserId}::uuid
    `))[0];
    return c.json({ excluded: row?.excluded === true });
  });

  app.put('/microsoft/directory/users/:userId/exclude', async c => {
    const microsoftUserId = userId(c);
    if (!microsoftUserId) return c.json({ error: 'Invalid Microsoft user.', code: 'invalid_microsoft_user' }, 400);
    if (!c.get('canManage')) return c.json({ error: 'Write permission and MFA are required.', code: 'configuration_access_denied' }, 403);
    const parsed = update.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid preference.', code: 'invalid_preference' }, 400);
    const scope = c.get('scope');
    const [saved] = rows<{ excluded: boolean }>(await context.db.execute(sql`
      INSERT INTO cloudcommand_microsoft_directory_preferences (org_id, actor_id, microsoft_user_id, excluded)
      VALUES (${scope.organizationId}::uuid, ${scope.actorId}::uuid, ${microsoftUserId}::uuid, ${parsed.data.excluded})
      ON CONFLICT (org_id, actor_id, microsoft_user_id) DO UPDATE
        SET excluded = EXCLUDED.excluded, updated_at = now()
      RETURNING excluded
    `));
    if (!saved) throw new Error('Preference write was not acknowledged');
    await context.audit({ orgId: scope.organizationId, actorId: scope.actorId, actorType: 'user',
      action: 'cloudcommand.microsoft.directory.exclude.set', resourceType: 'microsoft_user',
      resourceId: microsoftUserId, result: 'success', details: { excluded: saved.excluded } });
    return c.json({ excluded: saved.excluded });
  });
}
