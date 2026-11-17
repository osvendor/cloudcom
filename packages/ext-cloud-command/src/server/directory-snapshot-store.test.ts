import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { claimDirectorySnapshot, invalidateDirectorySnapshot, publishDirectorySnapshotSource } from './directory-snapshot-store';
const binding={orgId:'11111111-1111-4111-8111-111111111111',tenantId:'22222222-2222-4222-8222-222222222222',clientId:'33333333-3333-4333-8333-333333333333',credentialVersion:'v1',generation:1};
const query=(value:unknown)=>new PgDialect().sqlToQuery(value as never);
describe('directory snapshot concurrency and scheduling',()=>{
  it('rechecks due and cooldown when claiming, not just in candidate enumeration',async()=>{
    const db={execute:vi.fn(async(_query:unknown)=>[])};
    expect(await claimDirectorySnapshot(db,binding)).toBeNull();
    const {sql,params}=query(db.execute.mock.calls[0]![0]);
    expect(sql).toContain("interval '5 minutes'");expect(sql).toContain("interval '1 minute'");
    expect(sql).toContain("interval '15 minutes'");expect(sql).toContain("interval '6 hours'");
    expect(sql).toContain('lease_expires_at < now()');expect(params).toContain(binding.orgId);
    expect(params).toContain(binding.tenantId);
  });
  it('revokes only the matching enabled organization generation without clearing cached data or cadence timestamps',async()=>{
    const db={execute:vi.fn(async(_query:unknown)=>[])};await invalidateDirectorySnapshot(db,binding.orgId);
    const {sql,params}=query(db.execute.mock.calls[0]![0]);
    expect(sql).toContain("directory_status='stale', lease_token=NULL, lease_expires_at=NULL");
    expect(sql).toContain('c.tenant_id=s.tenant_id AND c.generation=s.connection_generation');
    expect(params).toEqual([binding.orgId]);
    expect(sql).not.toMatch(/usage_|last_attempt_at|refresh_requested_at|directory_data/);
  });
  it('fails the old collector publication after lease revocation',async()=>{
    const db={execute:vi.fn(async(_query:unknown)=>[])};
    expect(await publishDirectorySnapshotSource(db,binding,'44444444-4444-4444-8444-444444444444','directory',{users:[]})).toBe(false);
    expect(query(db.execute.mock.calls[0]![0]).sql).toContain('s.lease_token =');
  });
});
