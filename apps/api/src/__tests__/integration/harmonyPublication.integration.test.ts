import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
const vendor = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../middleware/auth', async () => {
  const { withSystemDbAccessContext } = await import('../../db');
  return { withAuthDbAccessContext: (_auth: unknown, work: () => Promise<unknown>) => withSystemDbAccessContext(work) };
});
vi.mock('../../services/secretCrypto', () => ({ encryptSecret: () => 'enc:v3:qa', decryptForColumn: () => '{"clientId":"qa","accessKey":"qa"}' }));
vi.mock('../../services/auditService', () => ({ createAuditLog: vi.fn() }));
vi.mock('../../services/urlSafety', () => ({ safeFetch: vi.fn() }));
vi.mock('@cloudcom/ext-cloud-command', async original => ({ ...await original<object>(), createHarmonyProvider: () => ({ administrativeInventory: vendor.read }) }));
import { normalizeHarmonyComputer, type HarmonyRequest } from '@cloudcom/ext-cloud-command';
import { nativeHarmonyServices } from '../../extensions/cloudCommandHarmony';
import { attachHarmonySecurity } from '../../extensions/harmonySecurity';
import { db, withSystemDbAccessContext } from '../../db';

describe('Harmony real PostgreSQL publication', () => {
  const partner = randomUUID(), org = randomUUID(), connection = randomUUID(), site = randomUUID(), device = randomUUID();
  const request: HarmonyRequest = { orgId: org, auth: { scope: 'partner', partnerId: partner, partnerOrgAccess: 'all', principal: { kind: 'user_session' }, user: { id: randomUUID(), isPlatformAdmin: true }, canAccessOrg: () => true }, authorization: { hasPermission: () => true, mfaSatisfied: true } as never };
  const checkedAt = new Date().toISOString();
  const inventory = { checkedAt, groups: [], computers: [normalizeHarmonyComputer({ computerId: 'qa-endpoint', computerName: 'QA', computerGroups: [] })] };
  const readCache = () => withSystemDbAccessContext(() => db.execute(sql`SELECT external_id,device_id,evidence FROM cloudcommand_harmony_endpoints WHERE integration_id=${connection}::uuid`));
  beforeAll(async () => withSystemDbAccessContext(async () => {
    await db.execute(sql`INSERT INTO partners(id,name,slug) VALUES (${partner}::uuid,'Harmony publication QA',${partner})`);
    await db.execute(sql`INSERT INTO organizations(id,partner_id,name,slug,currency_code) VALUES (${org}::uuid,${partner}::uuid,'Harmony publication QA',${org},'USD')`);
    await db.execute(sql`INSERT INTO sites(id,org_id,name) VALUES (${site}::uuid,${org}::uuid,'QA')`);
    await db.execute(sql`INSERT INTO devices(id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version) VALUES (${device}::uuid,${org}::uuid,${site}::uuid,${device},'qa','windows','test','amd64','test')`);
    await db.execute(sql`INSERT INTO harmony_integrations(id,partner_id,region,credentials_encrypted) VALUES (${connection}::uuid,${partner}::uuid,'us','enc:v3:qa')`);
    await db.execute(sql`INSERT INTO cloudcommand_harmony_scopes(org_id,partner_id,integration_id,kind,external_id) VALUES (${org}::uuid,${partner}::uuid,${connection}::uuid,'endpoint','qa-endpoint')`);
  }));
  beforeEach(async () => {
    vendor.read.mockReset().mockResolvedValue(inventory);
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE harmony_integrations SET enabled=true,lease_id=NULL,lease_expires_at=NULL WHERE id=${connection}::uuid`));
  });
  afterAll(async () => withSystemDbAccessContext(async () => {
    await db.execute(sql`DELETE FROM harmony_integrations WHERE id=${connection}::uuid`);
    await db.execute(sql`DELETE FROM devices WHERE id=${device}::uuid`);
    await db.execute(sql`DELETE FROM sites WHERE id=${site}::uuid`);
    await db.execute(sql`DELETE FROM organizations WHERE id=${org}::uuid`);
    await db.execute(sql`DELETE FROM partners WHERE id=${partner}::uuid`);
  }));
  it('publishes the sanitized cache, links a device, and preserves that link across refresh', async () => {
    expect(await nativeHarmonyServices.sync(request)).toMatchObject({ count: 1, checkedAt });
    expect(await readCache()).toMatchObject([{ external_id: 'qa-endpoint', device_id: null, evidence: { name: 'QA' } }]);
    await nativeHarmonyServices.link(request, { externalId: 'qa-endpoint', deviceId: device, checkedAt });
    await nativeHarmonyServices.sync(request);
    expect(await readCache()).toMatchObject([{ device_id: device }]);
  });
  it('rejects a superseded lease without replacing the previous cache', async () => {
    await nativeHarmonyServices.sync(request);
    const before = await readCache();
    vendor.read.mockImplementation(async () => {
      await withSystemDbAccessContext(() => db.execute(sql`UPDATE harmony_integrations SET version=version+1,lease_id=NULL,lease_expires_at=NULL WHERE id=${connection}::uuid`));
      return { ...inventory, computers: [] };
    });
    await expect(nativeHarmonyServices.sync(request)).rejects.toThrow('harmony_configuration_changed');
    expect(await readCache()).toEqual(before);
  });
  it('attaches cloud evidence to single and multiple native device results without changing agent observations', async () => {
    await nativeHarmonyServices.sync(request);
    await nativeHarmonyServices.link(request, { externalId: 'qa-endpoint', deviceId: device, checkedAt });
    const native = { deviceId: device, provider: 'Agent observation', realTimeProtection: true };
    const unlinked = { deviceId: randomUUID(), provider: 'Other agent observation', realTimeProtection: false };
    vi.stubEnv('CLOUDCOM_THREECX_ENABLED', 'true');
    try {
      const one = await withSystemDbAccessContext(() => attachHarmonySecurity([native]));
      expect(one[0]).toMatchObject({ ...native, cloudAntivirus: { provider: 'Check Point Harmony Endpoint', realTimeProtection: null } });
      const many = await withSystemDbAccessContext(() => attachHarmonySecurity([native, unlinked]));
      expect(many[0]).toEqual(one[0]);
      expect(many[1]).toEqual(unlinked);
      expect(await withSystemDbAccessContext(() => attachHarmonySecurity([]))).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });
  it('retains the complete previous snapshot when the provider fails', async () => {
    await nativeHarmonyServices.sync(request);
    const before = await readCache();
    vendor.read.mockRejectedValue(new Error('simulated timeout'));
    await expect(nativeHarmonyServices.sync(request)).rejects.toThrow('harmony_sync_failed');
    expect(await readCache()).toEqual(before);
    const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT lease_id,last_status,error_code FROM harmony_integrations WHERE id=${connection}::uuid`));
    expect(rows).toMatchObject([{ lease_id: null, last_status: 'failed', error_code: 'harmony_sync_failed' }]);
  });
  it('disabling removes the cached snapshot in the same transaction', async () => {
    await nativeHarmonyServices.sync(request);
    const [row] = await withSystemDbAccessContext(() => db.execute(sql`SELECT version FROM harmony_integrations WHERE id=${connection}::uuid`));
    await nativeHarmonyServices.configure(request, { version: row!.version as number, enabled: false, region: 'us' });
    expect(await readCache()).toHaveLength(0);
  });
});
