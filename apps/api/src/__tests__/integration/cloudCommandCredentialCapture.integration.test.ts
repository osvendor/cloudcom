/** Real PostgreSQL proof: independent draft commit, RLS, CAS, and retry provenance.
 * Authorization decisions/crypto/audit have separate unit coverage. They are mocked
 * here; database and the canonical auth transaction wrapper are deliberately real.
 * Run only with vitest.integration.config.ts against its guarded local test DB.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../extensions/cloudCommandAdminAuthorization', () => ({ authorizeCloudCommandAdministration: async () => ({}) }));
vi.mock('../../services/permissions', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/permissions')>(),
  getUserPermissions: async (_id: string, context: {orgId: string}) => ({scope:'organization',orgId:context.orgId}),
  hasPermission: () => true,
}));
vi.mock('../../services/secretCrypto', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/secretCrypto')>(),
  encryptSecret: () => 'enc:v3:integration-fixture',
}));
vi.mock('../../services/auditService', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/auditService')>(),
  createAuditLog: async () => undefined,
}));
import { db, withDbAccessContext } from '../../db';
import { cloudCommandCredentialCapture as capture } from '../../extensions/cloudCommandCredentialCapture';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

beforeAll(async () => {
  for (const path of [
    'ext-credentials/migrations/0001_credentials.sql',
    'ext-credentials/migrations/0004_credential_drafts.sql',
    'ext-cloud-command/migrations/2026-09-22-native-admin-connections.sql',
    // The additive migration must be safe to re-run.
    'ext-credentials/migrations/0004_credential_drafts.sql',
  ]) await getTestDb().execute(sql.raw(readFileSync(new URL(`../../../../../packages/${path}`, import.meta.url), 'utf8')));
});
beforeEach(() => vi.stubEnv('CLOUDCOM_CREDENTIALS_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({partnerId:partner.id});
  const other = await createOrganization({partnerId:partner.id});
  const input = {executionId:randomUUID(),connectionId:randomUUID(),tenantId:randomUUID(),username:'person@example.test',password:'Maple!Fox27',temporaryPassword:true};
  await getTestDb().execute(sql`INSERT INTO cloudcommand_microsoft_admin_connections
    (id,org_id,tenant_id,tenant_name,client_id,credential_version,permission_manifest_version,enabled)
    VALUES (${input.connectionId}::uuid,${org.id}::uuid,${input.tenantId}::uuid,'Test',${randomUUID()}::uuid,'test','test',true)`);
  const request = {orgId:org.id,auth:{scope:'organization',orgId:org.id,accessibleOrgIds:[org.id],user:{id:randomUUID()}},authorization:{}} as any;
  const base = {executionId:input.executionId,connectionId:input.connectionId,tenantId:input.tenantId,username:input.username};
  return {org,other,input,base,request};
}
async function records(id: string) {
  return getTestDb().execute(sql`SELECT * FROM credentials_records WHERE id=${id}::uuid`);
}
describe('credential capture with real PostgreSQL', () => {
  it('commits the draft before returning even if the ambient request rolls back', async () => {
    const f = await fixture();
    await expect(withDbAccessContext({scope:'organization',orgId:f.org.id}, async () => {
      await capture.prepare(f.request,f.input);
      expect((await records(f.input.executionId))[0]).toMatchObject({creation_state:'pending',version:1,is_draft:true});
      throw Error('outer request rollback');
    })).rejects.toThrow('outer request rollback');
    expect((await records(f.input.executionId))).toHaveLength(1);
  });
  it('uses non-bypass RLS and denies cross-organization reads and writes', async () => {
    const f = await fixture(); await capture.prepare(f.request,f.input);
    await withDbAccessContext({scope:'organization',orgId:f.other.id}, async () => {
      const roles = await db.execute(sql`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
      expect(roles[0]).toMatchObject({rolsuper:false,rolbypassrls:false});
      expect(await db.execute(sql`SELECT id FROM credentials_records WHERE id=${f.input.executionId}::uuid`)).toHaveLength(0);
      expect(await db.execute(sql`UPDATE credentials_records SET name='wrong tenant' WHERE id=${f.input.executionId}::uuid RETURNING id`)).toHaveLength(0);
    });
    expect((await records(f.input.executionId))[0]?.name).toBe('Microsoft 365');
  });
  it('completes once without rewriting the secret and rejects an edited draft', async () => {
    const f = await fixture(); await capture.prepare(f.request,f.input);
    const completion = {...f.base,providerUserId:randomUUID()};
    await capture.complete(f.request,completion); await capture.complete(f.request,completion);
    expect((await records(f.input.executionId))[0]).toMatchObject({version:2,creation_state:'accepted',secret_ciphertext:'enc:v3:integration-fixture'});
    const next = {...f.input,executionId:randomUUID(),username:'next@example.test'};
    await capture.prepare(f.request,next);
    await getTestDb().execute(sql`UPDATE credentials_records SET version=version+1 WHERE id=${next.executionId}::uuid`);
    await expect(capture.complete(f.request,{...f.base,executionId:next.executionId,username:next.username,providerUserId:randomUUID()})).rejects.toThrow('requires review');
    expect((await records(next.executionId))[0]?.creation_state).toBe('pending');
  });
  it('blocks unknown outcomes but archives a definite rejection for a fresh attempt', async () => {
    const f = await fixture(); await capture.prepare(f.request,f.input);
    await capture.fail(f.request,{...f.base,state:'unknown'});
    await expect(capture.prepare(f.request,{...f.input,executionId:randomUUID()})).rejects.toThrow('already exists');
    expect((await records(f.input.executionId))[0]).toMatchObject({archived:false,creation_state:'unknown'});
    const next = {...f.input,executionId:randomUUID(),username:'rejected@example.test'};
    await capture.prepare(f.request,next);
    await capture.fail(f.request,{...f.base,executionId:next.executionId,username:next.username,state:'rejected'});
    await capture.prepare(f.request,{...next,executionId:randomUUID()});
    expect((await records(next.executionId))[0]).toMatchObject({archived:true,creation_state:'rejected',source_id:`${next.username}:rejected:${next.executionId}`});
  });
});
