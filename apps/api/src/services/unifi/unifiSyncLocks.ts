import { sql, type SQL } from 'drizzle-orm';

/** Take the complete export lock set before any sync writes, in the same transaction. */
export async function lockUnifiSyncOrganizations(
  db: { execute: (query: SQL) => PromiseLike<unknown> },
  integrationId: string,
  mappings: Array<{ orgId: string }>,
): Promise<void> {
  const mappedOrgIds = [...new Set(mappings.map(mapping => mapping.orgId))];
  // Include old device owners: remapping and stale sweeping can write rows
  // outside the current mapping set. The database helper orders both partner
  // and organization locks and validates organization visibility under RLS.
  await db.execute(sql`
    SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY(
      SELECT org_id FROM (
        SELECT unnest(ARRAY[${sql.join(mappedOrgIds.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[]) AS org_id
        UNION
        SELECT org_id FROM unifi_devices WHERE integration_id = ${integrationId}::uuid
      ) AS sync_orgs ORDER BY org_id
    ))
  `);
}
