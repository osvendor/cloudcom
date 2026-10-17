/** Operator-only import. Reads a base64 JSON envelope from stdin; never logs input. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db, closeDb, withDbAccessContext } from '../src/db';
import { encryptSecret, decryptSecret } from '../src/services/secretCrypto';
import { createAuditLog } from '../src/services/auditService';
import { parseItGlueCsv } from '../../../packages/ext-credentials/src/import/itGlue';
import { seal, unseal } from '../../../packages/ext-credentials/src/server/secrets';

const batchSchema = z.object({ organizationId: z.string().uuid(), organizationName: z.string().min(1), sourceOrganization: z.string().min(1), csv: z.string().max(500_000) }).strict();
const envelopeSchema = z.object({ partnerId: z.string().uuid(), batches: z.array(batchSchema).min(1).max(100) }).strict();
const crypto = {
  encryptForColumn: (table: string, column: string, value: string) => encryptSecret(value, { aad: `${table}.${column}` }) ?? '',
  decryptForColumn: (table: string, column: string, value: string) => decryptSecret(value, { aad: `${table}.${column}`, strict: true }) ?? '',
};
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if(size > 12 * 1024 * 1024) throw new Error('Import too large'); chunks.push(Buffer.from(chunk)); }
  const input = envelopeSchema.parse(JSON.parse(Buffer.from(Buffer.concat(chunks).toString('ascii').trim(), 'base64').toString('utf8')));
  const importId = randomUUID();
  const batches = input.batches.map(batch => ({...batch, rows: parseItGlueCsv(batch.csv)}));
  for (const batch of batches) {
    if (!batch.rows.length || batch.rows.length > 1000 || batch.rows.some(row => row.sourceOrganization !== batch.sourceOrganization || row.issues.some(issue => !['missing_username','missing_password'].includes(issue)))) throw new Error('Invalid import batch');
  }
  if (new Set(batches.map(b=>b.sourceOrganization)).size !== batches.length) throw new Error('Duplicate source mapping');
  // The privileged operator supplies explicit client IDs AND names. RLS still
  // restricts this transaction to exactly those clients and one partner.
  const result = await withDbAccessContext({ scope:'organization', orgId:null, accessibleOrgIds:batches.map(b=>b.organizationId), accessiblePartnerIds:[input.partnerId] }, async () => {
    let inserted = 0, existing = 0;
    for (const batch of batches) {
      const organizations = await db.execute(sql`SELECT id FROM organizations WHERE id=${batch.organizationId}::uuid AND partner_id=${input.partnerId}::uuid AND name=${batch.organizationName} AND deleted_at IS NULL AND status='active'`);
      if (organizations.length !== 1) throw new Error('Destination mismatch');
      if (!dryRun) await createAuditLog({orgId:batch.organizationId, actorId:importId, actorType:'system', action:'credentials.operator_import.requested', resourceType:'organization', resourceId:batch.organizationId, result:'success', initiatedBy:'manual', details:{count:batch.rows.length, importId}});
      const values = batch.rows.map(row => {
        const id = randomUUID(); const value = {password:row.password,otpSecret:row.otpSecret,notes:row.notes};
        const ciphertext = seal(crypto,batch.organizationId,id,value);
        const verified = unseal(crypto,batch.organizationId,id,ciphertext);
        if (JSON.stringify(value) !== JSON.stringify(verified)) throw new Error('Encryption verification failed');
        return sql`(${id}::uuid,${batch.organizationId}::uuid,${row.name},${row.category},${row.username},${row.email},${row.url},${ciphertext},${Boolean(row.password)},${Boolean(row.otpSecret)},${row.archived},${row.sourceOrganization},${row.sourceId})`;
      });
      if (dryRun) { inserted += values.length; continue; }
      const saved = await db.execute(sql`INSERT INTO credentials_records(id,org_id,name,category,username,email,url,secret_ciphertext,has_password,has_otp,archived,source_organization,source_id) VALUES ${sql.join(values,sql`, `)} ON CONFLICT (org_id,source_organization,source_id) DO NOTHING RETURNING id`);
      inserted += saved.length; existing += batch.rows.length - saved.length;
    }
    return {inserted: dryRun ? 0 : inserted, validated: dryRun ? inserted : undefined, existing,clients:batches.length,importId,dryRun};
  });
  if (!dryRun) await createAuditLog({actorId:importId, actorType:'system', action:'credentials.operator_import.committed', resourceType:'import', resourceId:importId, result:'success', initiatedBy:'manual', details:result});
  process.stdout.write(JSON.stringify(result)+'\n');
}
main().catch(() => { process.stderr.write('Credential import failed. Input and secrets are not logged. Check counts before retrying.\n'); process.exitCode=1; }).finally(async()=>{await closeDb(); process.exit(process.exitCode ?? 0);});
