import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { currentDeviceUser, previousDeviceUsers, deviceIdentitySearch } from './deviceIdentity';
import { deviceDirectoryQuery } from '../../../../packages/ext-credentials/src/server/deviceDirectory';

const url=process.env.DEVICE_IDENTITY_TEST_URL;
const ORG='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const ID='33333333-3333-4333-8333-333333333333',STALE='44444444-4444-4444-8444-444444444444';
describe.skipIf(!url)('device identity SQL against PostgreSQL',()=>{
 const client=postgres(url||'postgres://unused',{max:1});const dialect=new PgDialect();
 const run=async(fragment:Parameters<PgDialect['sqlToQuery']>[0])=>{const q=dialect.sqlToQuery(fragment);return client.unsafe(q.sql,q.params as never[])};
 beforeAll(async()=>{
  await client.unsafe(`CREATE TEMP TABLE devices(id uuid,org_id uuid,hostname text,display_name text,status text,last_seen_at timestamptz,last_user text,is_ephemeral boolean,os_type text);
   CREATE TEMP TABLE organizations(id uuid,partner_id uuid,name text,status text,type text,deleted_at timestamptz);
   CREATE TEMP TABLE device_sessions(id uuid DEFAULT gen_random_uuid(),device_id uuid,org_id uuid,username text,login_at timestamptz);`);
  await client`INSERT INTO organizations VALUES (${ORG},${ORG},'Client One','active','customer',NULL),(${OTHER},${OTHER},'Other','active','customer',NULL)`;
  await client`INSERT INTO devices VALUES (${ID},${ORG},'HOST-01','Front desk','online',now(),'Alice',false,'windows'),(${STALE},${ORG},'HOST-02',NULL,'offline',now()-interval '1 day','Carol',false,'windows')`;
  await client`INSERT INTO device_sessions(device_id,org_id,username,login_at) VALUES (${ID},${ORG},'Alice',now()),(${ID},${ORG},' bob ',now()-interval '1 hour'),(${ID},${ORG},'BOB',now()-interval '2 hours'),(${ID},${ORG},'Old_User%',now()-interval '30 days'),(${ID},${OTHER},'ForeignUser',now()),(${STALE},${ORG},'Carol',now()-interval '2 days')`;
 });
 afterAll(async()=>{await client.end()});
 it('deduplicates recent users, preserves older searchable names, excludes current and foreign history',async()=>{
  const rows=await run(sql`SELECT ${currentDeviceUser} current,${previousDeviceUsers} previous FROM devices WHERE id=${ID}::uuid`);
  expect(rows[0]?.current).toBe('Alice');expect(rows[0]?.previous).toEqual(['bob','Old_User%']);
  expect((await run(sql`SELECT id FROM devices WHERE ${deviceIdentitySearch('old_user%')}`))).toHaveLength(1);
  expect((await run(sql`SELECT id FROM devices WHERE ${deviceIdentitySearch('ForeignUser')}`))).toHaveLength(0);
  for(const query of ['HOST-01','front DESK','Alice','bob'])expect((await run(sql`SELECT id FROM devices WHERE ${deviceIdentitySearch(query)}`))).toHaveLength(1);
 });
 it('does not claim a stale user is logged in and retains their last observation',async()=>{
  const rows=await run(sql`SELECT ${currentDeviceUser} current,${previousDeviceUsers} previous FROM devices WHERE id=${STALE}::uuid`);
  expect(rows[0]?.current).toBeNull();expect(rows[0]?.previous).toEqual(['Carol']);
 });
 it('companion and core identity projections agree and directory remains org scoped',async()=>{
  const rows=await run(deviceDirectoryQuery(sql`d.org_id=${ORG}::uuid`,'HOST-01',0));
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({hostname:'HOST-01',displayName:'Front desk',currentUser:'Alice',previousUsers:['bob','Old_User%'],orgId:ORG});
  expect(await run(deviceDirectoryQuery(sql`d.org_id=${OTHER}::uuid`,'',0))).toHaveLength(0);
  expect(await run(deviceDirectoryQuery(sql`d.org_id=${ORG}::uuid`,'Old_User%',0))).toHaveLength(1);
 });
});

