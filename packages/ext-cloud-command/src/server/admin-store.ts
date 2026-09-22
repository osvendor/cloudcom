import { sql } from 'drizzle-orm';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';
import type { AdministrationConnection } from './admin-execution';

export type StoredAdministrationConnection = AdministrationConnection & { tenantName: string; verifiedAt: string | Date | null };
export type ConsentAttempt = { org_id: string; actor_id: string; tenant_id: string; client_id: string;
  credential_version: string; expected_generation: number | null; state_hash: string;
  stage: 'consent' | 'identity' | 'processing' | 'complete'; verifier_ciphertext: string; nonce: string };
function rows<T>(value: unknown): T[] { if (!Array.isArray(value)) throw new Error('Invalid database result'); return value as T[]; }
export function createAdministrationStore(context: ExtensionRuntimeContext) {
  return {
    async load(orgId: string) {
      const row = rows<Record<string, unknown>>(await context.db.execute(sql`SELECT * FROM cloudcommand_microsoft_admin_connections WHERE org_id = ${orgId}::uuid`))[0];
      if (!row) return null;
      return { id: row.id, orgId: row.org_id, tenantId: row.tenant_id, clientId: row.client_id,
        credentialVersion: row.credential_version, permissionManifestVersion: row.permission_manifest_version,
        enabled: row.enabled, generation: row.generation, tenantName: row.tenant_name, verifiedAt: row.verified_at } as StoredAdministrationConnection;
    },
    async start(attempt: ConsentAttempt) {
      await context.db.execute(sql`INSERT INTO cloudcommand_microsoft_admin_consent
        (org_id, state_hash, actor_id, tenant_id, client_id, credential_version, expected_generation, stage, verifier_ciphertext, nonce, expires_at)
        VALUES (${attempt.org_id}::uuid, ${attempt.state_hash}, ${attempt.actor_id}::uuid, ${attempt.tenant_id}::uuid,
          ${attempt.client_id}::uuid, ${attempt.credential_version}, ${attempt.expected_generation}, 'consent', ${attempt.verifier_ciphertext}, ${attempt.nonce}, now() + interval '10 minutes')
        ON CONFLICT (org_id, actor_id) DO UPDATE SET state_hash = EXCLUDED.state_hash,
          tenant_id = EXCLUDED.tenant_id, client_id = EXCLUDED.client_id, credential_version = EXCLUDED.credential_version,
          expected_generation = EXCLUDED.expected_generation, stage = 'consent', verifier_ciphertext = EXCLUDED.verifier_ciphertext,
          nonce = EXCLUDED.nonce, expires_at = EXCLUDED.expires_at, created_at = now()`);
    },
    async claim(orgId: string, actorId: string, stateHash: string, stage: 'consent' | 'identity') {
      return rows<ConsentAttempt>(await context.db.execute(sql`UPDATE cloudcommand_microsoft_admin_consent SET stage = 'processing'
        WHERE org_id = ${orgId}::uuid AND actor_id = ${actorId}::uuid AND state_hash = ${stateHash}
          AND stage = ${stage} AND expires_at > now() RETURNING *`))[0] ?? null;
    },
    async advance(orgId: string, oldHash: string, nextHash: string) {
      return rows(await context.db.execute(sql`UPDATE cloudcommand_microsoft_admin_consent SET stage = 'identity', state_hash = ${nextHash}
        WHERE org_id = ${orgId}::uuid AND state_hash = ${oldHash} AND stage = 'processing' RETURNING org_id`)).length === 1;
    },
    async finish(orgId: string, stateHash: string) {
      await context.db.execute(sql`UPDATE cloudcommand_microsoft_admin_consent SET stage = 'complete', verifier_ciphertext = '', nonce = ''
        WHERE org_id = ${orgId}::uuid AND state_hash = ${stateHash} AND stage = 'processing'`);
    },
    async save(attempt: ConsentAttempt, tenantName: string) {
      const result = attempt.expected_generation === null
        ? await context.db.execute(sql`INSERT INTO cloudcommand_microsoft_admin_connections
            (org_id, tenant_id, tenant_name, client_id, credential_version, permission_manifest_version, enabled, verified_at)
            SELECT ${attempt.org_id}::uuid, ${attempt.tenant_id}::uuid, ${tenantName}, ${attempt.client_id}::uuid,
              ${attempt.credential_version}, 'business-standard-v1', true, now()
            FROM cloudcommand_microsoft_admin_consent WHERE org_id = ${attempt.org_id}::uuid AND actor_id = ${attempt.actor_id}::uuid
              AND state_hash = ${attempt.state_hash} AND stage = 'processing' AND expires_at > now()
            ON CONFLICT (org_id) DO NOTHING RETURNING id`)
        : await context.db.execute(sql`UPDATE cloudcommand_microsoft_admin_connections SET tenant_id = ${attempt.tenant_id}::uuid,
            tenant_name = ${tenantName}, client_id = ${attempt.client_id}::uuid, credential_version = ${attempt.credential_version},
            permission_manifest_version = 'business-standard-v1', enabled = true, generation = generation + 1, verified_at = now(), updated_at = now()
            WHERE org_id = ${attempt.org_id}::uuid AND generation = ${attempt.expected_generation}
              AND EXISTS (SELECT 1 FROM cloudcommand_microsoft_admin_consent WHERE org_id = ${attempt.org_id}::uuid
                AND actor_id = ${attempt.actor_id}::uuid AND state_hash = ${attempt.state_hash} AND stage = 'processing' AND expires_at > now()) RETURNING id`);
      return rows(result).length === 1;
    },
    async disable(orgId: string, generation: number) {
      return rows(await context.db.execute(sql`UPDATE cloudcommand_microsoft_admin_connections SET enabled = false, generation = generation + 1, updated_at = now()
        WHERE org_id = ${orgId}::uuid AND generation = ${generation} RETURNING id`)).length === 1;
    },
  };
}
