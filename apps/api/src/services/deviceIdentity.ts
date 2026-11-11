import { sql, type SQL } from 'drizzle-orm';
import { devices } from '../db/schema';

// last_user is the latest active session reported by the heartbeat, not a
// durable history field. An offline/stale observation must not claim presence.
export const currentDeviceUser = sql<string | null>`CASE
  WHEN ${devices.status} = 'online' AND ${devices.lastSeenAt} > now() - interval '5 minutes'
  THEN NULLIF(BTRIM(${devices.lastUser}), '') ELSE NULL END`;

// One correlated projection, not a request per device. The existing
// device_sessions(device_id, login_at/username) indexes support this history.
// Retain distinct names so client-side fleet search also finds older users.
export const previousDeviceUsers = sql<string[]>`ARRAY(
  SELECT recent.username FROM (
    SELECT DISTINCT ON (lower(entries.username)) entries.username, entries.seen_at
    FROM (
      SELECT NULLIF(BTRIM(s.username), '') AS username, s.login_at AS seen_at
      FROM device_sessions s
      WHERE s.device_id = ${devices.id} AND s.org_id = ${devices.orgId}
      UNION ALL
      SELECT NULLIF(BTRIM(${devices.lastUser}), ''), ${devices.lastSeenAt}
    ) entries
    WHERE entries.username IS NOT NULL
      AND lower(entries.username) IS DISTINCT FROM lower(${currentDeviceUser})
    ORDER BY lower(entries.username), entries.seen_at DESC NULLS LAST, entries.username
  ) recent ORDER BY recent.seen_at DESC NULLS LAST, recent.username
)`;

export function deviceIdentitySearch(query: string): SQL {
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  return sql`(${devices.hostname} ILIKE ${pattern}
    OR ${devices.displayName} ILIKE ${pattern}
    OR ${devices.lastUser} ILIKE ${pattern}
    OR EXISTS (SELECT 1 FROM device_sessions s
      WHERE s.device_id = ${devices.id} AND s.org_id = ${devices.orgId}
        AND s.username ILIKE ${pattern}))`;
}
