import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

export type SnapshotSource = 'directory' | 'usage';
export type SnapshotBinding = {
  orgId: string; tenantId: string; clientId: string;
  credentialVersion: string; generation: number;
};
type Executor = { execute(query: unknown): Promise<unknown> };
function rows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) throw new Error('Invalid database result');
  return result as T[];
}

/** Only a currently enabled, exact-generation connection can obtain a lease.
 * The caller supplies a short system or org database context; Microsoft IO must
 * happen after that context closes. A crashed run is reclaimable after 30 min. */
export async function claimDirectorySnapshot(db: Executor, binding: SnapshotBinding): Promise<string | null> {
  const token = randomUUID();
  const result = await db.execute(sql`
    INSERT INTO cloudcommand_microsoft_directory_snapshots
      (org_id, tenant_id, connection_generation, lease_token, lease_expires_at, last_attempt_at)
    SELECT c.org_id, c.tenant_id, c.generation, ${token}::uuid, now() + interval '30 minutes', now()
    FROM cloudcommand_microsoft_admin_connections c
    WHERE c.org_id = ${binding.orgId}::uuid AND c.enabled = true
      AND c.tenant_id = ${binding.tenantId}::uuid AND c.client_id = ${binding.clientId}::uuid
      AND c.credential_version = ${binding.credentialVersion} AND c.generation = ${binding.generation}
    ON CONFLICT (org_id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id, connection_generation = EXCLUDED.connection_generation,
      lease_token = EXCLUDED.lease_token, lease_expires_at = EXCLUDED.lease_expires_at,
      last_attempt_at = now(),
      directory_data = CASE WHEN cloudcommand_microsoft_directory_snapshots.connection_generation = EXCLUDED.connection_generation
        AND cloudcommand_microsoft_directory_snapshots.tenant_id = EXCLUDED.tenant_id
        THEN cloudcommand_microsoft_directory_snapshots.directory_data ELSE NULL END,
      directory_collected_at = CASE WHEN cloudcommand_microsoft_directory_snapshots.connection_generation = EXCLUDED.connection_generation
        AND cloudcommand_microsoft_directory_snapshots.tenant_id = EXCLUDED.tenant_id
        THEN cloudcommand_microsoft_directory_snapshots.directory_collected_at ELSE NULL END,
      usage_data = CASE WHEN cloudcommand_microsoft_directory_snapshots.connection_generation = EXCLUDED.connection_generation
        AND cloudcommand_microsoft_directory_snapshots.tenant_id = EXCLUDED.tenant_id
        THEN cloudcommand_microsoft_directory_snapshots.usage_data ELSE NULL END,
      usage_collected_at = CASE WHEN cloudcommand_microsoft_directory_snapshots.connection_generation = EXCLUDED.connection_generation
        AND cloudcommand_microsoft_directory_snapshots.tenant_id = EXCLUDED.tenant_id
        THEN cloudcommand_microsoft_directory_snapshots.usage_collected_at ELSE NULL END,
      directory_status = CASE WHEN cloudcommand_microsoft_directory_snapshots.connection_generation = EXCLUDED.connection_generation
        AND cloudcommand_microsoft_directory_snapshots.tenant_id = EXCLUDED.tenant_id
        THEN cloudcommand_microsoft_directory_snapshots.directory_status ELSE 'never' END,
      usage_status = CASE WHEN cloudcommand_microsoft_directory_snapshots.connection_generation = EXCLUDED.connection_generation
        AND cloudcommand_microsoft_directory_snapshots.tenant_id = EXCLUDED.tenant_id
        THEN cloudcommand_microsoft_directory_snapshots.usage_status ELSE 'never' END
    WHERE cloudcommand_microsoft_directory_snapshots.lease_expires_at IS NULL
      OR cloudcommand_microsoft_directory_snapshots.lease_expires_at < now()
      OR cloudcommand_microsoft_directory_snapshots.connection_generation <> EXCLUDED.connection_generation
      OR cloudcommand_microsoft_directory_snapshots.tenant_id <> EXCLUDED.tenant_id
    RETURNING org_id
  `);
  return rows(result).length === 1 ? token : null;
}

/** One source publishes independently. A failed/partial read keeps the last
 * complete value, marking it stale; the other source may still advance. */
export async function publishDirectorySnapshotSource(
  db: Executor, binding: SnapshotBinding, token: string, source: SnapshotSource,
  data: Record<string, unknown> | null,
): Promise<boolean> {
  const payload = data === null ? null : JSON.stringify(data);
  if (payload !== null && (Array.isArray(data) || Buffer.byteLength(payload) > 16 * 1024 * 1024))
    throw new Error('Snapshot source exceeds its bounded object contract');
  const result = source === 'directory'
    ? await db.execute(sql`
      UPDATE cloudcommand_microsoft_directory_snapshots s SET
        directory_data = CASE WHEN ${payload}::jsonb IS NULL THEN s.directory_data ELSE ${payload}::jsonb END,
        directory_collected_at = CASE WHEN ${payload}::jsonb IS NULL THEN s.directory_collected_at ELSE now() END,
        directory_status = CASE WHEN ${payload}::jsonb IS NOT NULL THEN 'ready'
          WHEN s.directory_data IS NULL THEN 'never' ELSE 'stale' END
      FROM cloudcommand_microsoft_admin_connections c
      WHERE s.org_id = ${binding.orgId}::uuid AND s.lease_token = ${token}::uuid
        AND s.lease_expires_at > now() AND c.org_id = s.org_id AND c.enabled = true
        AND c.tenant_id = s.tenant_id AND c.generation = s.connection_generation
        AND c.tenant_id = ${binding.tenantId}::uuid AND c.client_id = ${binding.clientId}::uuid
        AND c.credential_version = ${binding.credentialVersion} AND c.generation = ${binding.generation}
      RETURNING s.org_id
    `)
    : await db.execute(sql`
      UPDATE cloudcommand_microsoft_directory_snapshots s SET
        usage_data = CASE WHEN ${payload}::jsonb IS NULL THEN s.usage_data ELSE ${payload}::jsonb END,
        usage_collected_at = CASE WHEN ${payload}::jsonb IS NULL THEN s.usage_collected_at ELSE now() END,
        usage_status = CASE WHEN ${payload}::jsonb IS NOT NULL THEN 'ready'
          WHEN s.usage_data IS NULL THEN 'never' ELSE 'stale' END
      FROM cloudcommand_microsoft_admin_connections c
      WHERE s.org_id = ${binding.orgId}::uuid AND s.lease_token = ${token}::uuid
        AND s.lease_expires_at > now() AND c.org_id = s.org_id AND c.enabled = true
        AND c.tenant_id = s.tenant_id AND c.generation = s.connection_generation
        AND c.tenant_id = ${binding.tenantId}::uuid AND c.client_id = ${binding.clientId}::uuid
        AND c.credential_version = ${binding.credentialVersion} AND c.generation = ${binding.generation}
      RETURNING s.org_id
    `);
  return rows(result).length === 1;
}

export async function releaseDirectorySnapshot(db: Executor, binding: SnapshotBinding, token: string): Promise<void> {
  await db.execute(sql`UPDATE cloudcommand_microsoft_directory_snapshots
    SET lease_token = NULL, lease_expires_at = NULL
    WHERE org_id = ${binding.orgId}::uuid AND lease_token = ${token}::uuid`);
}
