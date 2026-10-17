/** Operator-only, one-document import. Input stays in memory; errors never echo it. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db, closeDb, withDbAccessContext } from '../src/db';
import { encryptSecret, decryptSecret } from '../src/services/secretCrypto';
import { createAuditLog } from '../src/services/auditService';
import { sealDocument, unsealDocument } from '../../../packages/ext-credentials/src/server/documentSecrets';

const schema = z.object({
  partnerId: z.string().uuid(), organizationId: z.string().uuid(), organizationName: z.string().min(1),
  sourceOrganization: z.string().min(1).max(500), sourceId: z.string().min(1).max(500),
  name: z.string().min(1).max(500), filename: z.string().min(1).max(255).regex(/^[^\\/\u0000-\u001f\u007f]+\.xlsx$/i),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), payload: z.unknown(),
}).strict();
const crypto = {
  encryptForColumn: (table: string, column: string, value: string) => encryptSecret(value, { aad: `${table}.${column}` }) ?? '',
  decryptForColumn: (table: string, column: string, value: string) => decryptSecret(value, { aad: `${table}.${column}`, strict: true }) ?? '',
};
async function main() {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 24 * 1024 * 1024) throw new Error('Input too large'); chunks.push(Buffer.from(chunk)); }
  const input = schema.parse(JSON.parse(Buffer.from(Buffer.concat(chunks).toString('ascii').trim(), 'base64').toString('utf8')));
  const dryRun = process.argv.includes('--dry-run');
  const id = randomUUID();
  const ciphertext = sealDocument(crypto, input.organizationId, id, input.payload as Parameters<typeof sealDocument>[3]);
  const verified = unsealDocument(crypto, input.organizationId, id, ciphertext);
  const original = Buffer.from(verified.originalBase64, 'base64');
  if (createHash('sha256').update(original).digest('hex') !== input.sha256 || original.readUInt32LE(0) !== 0x04034b50) throw new Error('Document integrity failure');
  const result = await withDbAccessContext({scope:'organization',orgId:input.organizationId,accessibleOrgIds:[input.organizationId],accessiblePartnerIds:[input.partnerId]}, async () => {
    const org = await db.execute(sql`SELECT o.id FROM organizations o JOIN partners p ON p.id=o.partner_id WHERE o.id=${input.organizationId}::uuid AND o.partner_id=${input.partnerId}::uuid AND o.name=${input.organizationName} AND o.deleted_at IS NULL AND o.status='active' AND p.deleted_at IS NULL AND p.status='active'`);
    if (org.length !== 1) throw new Error('Destination mismatch');
    const found = await db.execute(sql`SELECT sha256 FROM credentials_documents WHERE org_id=${input.organizationId}::uuid AND source_organization=${input.sourceOrganization} AND source_id=${input.sourceId}`);
    if (found.length && found[0].sha256 !== input.sha256) throw new Error('Existing source changed; explicit replacement required');
    if (dryRun || found.length) return {validated:1,inserted:0,existing:found.length,dryRun};
    const audit = (phase: string) => createAuditLog({orgId:input.organizationId,actorId:id,actorType:'system',action:`credentials.documentation_import.${phase}`,resourceType:'document',resourceId:id,result:'success',initiatedBy:'manual',details:{sourceId:input.sourceId,sha256:input.sha256,sizeBytes:original.length}});
    await audit('requested');
    const saved = await db.execute(sql`INSERT INTO credentials_documents(id,org_id,name,filename,mime_type,source_organization,source_id,sha256,size_bytes,sheet_count,payload_ciphertext) VALUES (${id}::uuid,${input.organizationId}::uuid,${input.name},${input.filename},'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',${input.sourceOrganization},${input.sourceId},${input.sha256},${original.length},${verified.sheets.length},${ciphertext}) ON CONFLICT (org_id,source_organization,source_id) DO NOTHING RETURNING id`);
    if (!saved.length) {
      // A concurrent import may have won after the initial lookup. Never label
      // different bytes as successfully imported merely because the key exists.
      const concurrent = await db.execute(sql`SELECT sha256 FROM credentials_documents WHERE org_id=${input.organizationId}::uuid AND source_organization=${input.sourceOrganization} AND source_id=${input.sourceId}`);
      if (concurrent.length !== 1 || concurrent[0].sha256 !== input.sha256) throw new Error('Concurrent source conflict');
    }
    await audit('completed');
    return {validated:1,inserted:saved.length,existing:1-saved.length,dryRun};
  });
  process.stdout.write(JSON.stringify(result)+'\n');
}
main().catch(()=>{process.stderr.write('Documentation import failed; document contents are not logged.\n');process.exitCode=1;}).finally(async()=>{await closeDb();process.exit(process.exitCode ?? 0);});
