import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db,withDbAccessContext,withSystemDbAccessContext } from '../../db';
const pA=randomUUID(),pB=randomUUID(),oA=randomUUID(),oB=randomUUID(),iA=randomUUID(),iB=randomUUID(),site=randomUUID(),device=randomUUID();
const orgContext=(id:string)=>({scope:'organization' as const,orgId:id,accessibleOrgIds:[id],accessiblePartnerIds:[],userId:null});
const partnerContext=(id:string)=>({scope:'partner' as const,orgId:null,accessibleOrgIds:[],accessiblePartnerIds:[id],userId:null});
describe('Harmony real PostgreSQL isolation',()=>{
  beforeAll(async()=>{await withSystemDbAccessContext(async()=>{
    await db.execute(sql`INSERT INTO partners(id,name,slug) VALUES (${pA}::uuid,'Harmony QA A',${pA}),(${pB}::uuid,'Harmony QA B',${pB})`);
    await db.execute(sql`INSERT INTO organizations(id,partner_id,name,slug,currency_code) VALUES (${oA}::uuid,${pA}::uuid,'Harmony QA A',${oA},'USD'),(${oB}::uuid,${pB}::uuid,'Harmony QA B',${oB},'USD')`);
    await db.execute(sql`INSERT INTO sites(id,org_id,name) VALUES (${site}::uuid,${oB}::uuid,'QA')`);
    await db.execute(sql`INSERT INTO devices(id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version)
      VALUES (${device}::uuid,${oB}::uuid,${site}::uuid,${device},'synthetic-device','windows','test','amd64','test')`);
    await db.execute(sql`INSERT INTO harmony_integrations(id,partner_id,region,credentials_encrypted) VALUES (${iA}::uuid,${pA}::uuid,'us','test-ciphertext'),(${iB}::uuid,${pB}::uuid,'us','test-ciphertext')`);
    await db.execute(sql`INSERT INTO cloudcommand_harmony_scopes(org_id,partner_id,integration_id,kind,external_id) VALUES (${oA}::uuid,${pA}::uuid,${iA}::uuid,'endpoint','qa-a'),(${oB}::uuid,${pB}::uuid,${iB}::uuid,'endpoint','qa-b')`);
    await db.execute(sql`INSERT INTO cloudcommand_harmony_clients(org_id,partner_id,integration_id,version,checked_at) VALUES (${oA}::uuid,${pA}::uuid,${iA}::uuid,1,now()),(${oB}::uuid,${pB}::uuid,${iB}::uuid,1,now())`);
    await db.execute(sql`INSERT INTO cloudcommand_harmony_endpoints(org_id,partner_id,integration_id,external_id,evidence) VALUES (${oA}::uuid,${pA}::uuid,${iA}::uuid,'qa-a','{"name":"A"}'),(${oB}::uuid,${pB}::uuid,${iB}::uuid,'qa-b','{"name":"B"}')`);
  });});
  afterAll(async()=>{await withSystemDbAccessContext(async()=>{
    await db.execute(sql`DELETE FROM harmony_integrations WHERE id IN (${iA}::uuid,${iB}::uuid)`);
    await db.execute(sql`DELETE FROM devices WHERE id=${device}::uuid`);
    await db.execute(sql`DELETE FROM sites WHERE id=${site}::uuid`);
    await db.execute(sql`DELETE FROM organizations WHERE id IN (${oA}::uuid,${oB}::uuid)`);
    await db.execute(sql`DELETE FROM partners WHERE id IN (${pA}::uuid,${pB}::uuid)`);
  });});
  it('runs as an unprivileged app role',async()=>{const [r]=await db.execute(sql`SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`) as any;expect(r).toMatchObject({role:'breeze_app',rolsuper:false,rolbypassrls:false});});
  it.each(['cloudcommand_harmony_scopes','cloudcommand_harmony_clients','cloudcommand_harmony_endpoints'])('org A sees only its own %s rows',async table=>{
    const rows=await withDbAccessContext(orgContext(oA),()=>db.execute(sql`SELECT org_id FROM ${sql.identifier(table)}`)) as any[];
    expect(rows).toHaveLength(1);expect(rows[0].org_id).toBe(oA);
  });
  it('an org reader cannot select partner credential rows',async()=>{expect(await withDbAccessContext(orgContext(oA),()=>db.execute(sql`SELECT id FROM harmony_integrations`))).toHaveLength(0);});
  it('partner A cannot read or forge partner B credentials',async()=>{
    expect(await withDbAccessContext(partnerContext(pA),()=>db.execute(sql`SELECT id FROM harmony_integrations WHERE partner_id=${pB}::uuid`))).toHaveLength(0);
    await expect(withDbAccessContext(partnerContext(pA),()=>db.execute(sql`INSERT INTO harmony_integrations(partner_id,region,credentials_encrypted) VALUES (${pB}::uuid,'us','forged')`))).rejects.toThrow();
  });
  it('org A cross-org cache INSERT is rejected by RLS',async()=>{await expect(withDbAccessContext(orgContext(oA),()=>db.execute(sql`INSERT INTO cloudcommand_harmony_endpoints(org_id,partner_id,integration_id,external_id,evidence) VALUES (${oB}::uuid,${pB}::uuid,${iB}::uuid,'forged','{}')`))).rejects.toThrow();});
  it('org A cannot modify or delete org B cache',async()=>{
    expect(await withDbAccessContext(orgContext(oA),()=>db.execute(sql`UPDATE cloudcommand_harmony_endpoints SET evidence='{}' WHERE org_id=${oB}::uuid RETURNING external_id`))).toHaveLength(0);
    expect(await withDbAccessContext(orgContext(oA),()=>db.execute(sql`DELETE FROM cloudcommand_harmony_clients WHERE org_id=${oB}::uuid RETURNING org_id`))).toHaveLength(0);
  });
  it('partner/integration mismatch fails even for system scope',async()=>{await expect(withSystemDbAccessContext(()=>db.execute(sql`INSERT INTO cloudcommand_harmony_scopes(org_id,partner_id,integration_id,kind,external_id) VALUES (${oA}::uuid,${pA}::uuid,${iB}::uuid,'endpoint','mismatch')`))).rejects.toThrow();});
  it('cross-client device link fails even for system scope',async()=>{await expect(withSystemDbAccessContext(()=>db.execute(sql`UPDATE cloudcommand_harmony_endpoints SET device_id=${device}::uuid WHERE org_id=${oA}::uuid`))).rejects.toThrow();});
  it('configuration invalidation removes the client cache and endpoint rows together',async()=>{await withSystemDbAccessContext(async()=>{
    await db.execute(sql`DELETE FROM cloudcommand_harmony_clients WHERE integration_id=${iA}::uuid`);
    expect(await db.execute(sql`SELECT * FROM cloudcommand_harmony_endpoints WHERE integration_id=${iA}::uuid`)).toHaveLength(0);
  });});
});
