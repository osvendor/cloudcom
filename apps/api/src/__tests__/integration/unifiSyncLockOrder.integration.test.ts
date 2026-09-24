/**
 * Live-Postgres regression for UniFi syncs spanning multiple organizations.
 *
 * An approved discovered asset is a partner-export material row. Its statement
 * trigger acquires an organization advisory lock. Sync mappings are not ordered
 * by organization, so writing an asset in descending UUID order used to make a
 * later mapping request a lower lock and abort the whole transaction. The
 * worker now pre-acquires the complete lock set before applySyncData starts.
 */
import { describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { discoveredAssets, unifiSyncRuns } from '../../db/schema';
import { unifiDevices, unifiIntegrations, unifiSiteMappings } from '../../db/schema/unifi';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { applySyncData, type CollectedSync } from '../../services/unifi/unifiSyncService';
import { lockUnifiSyncOrganizations } from '../../services/unifi/unifiSyncLocks';

const DEVICE = {
  mac: 'aa:bb:cc:dd:ee:ff',
  name: 'Updated by UniFi sync',
  model: 'USW-Pro-24',
  deviceType: 'usw',
  firmwareVersion: '6.6',
  firmwareUpdatable: false,
  adoptionState: 'CONNECTED',
  uptimeSeconds: 42,
};

type SyncFixtureMapping = typeof unifiSiteMappings.$inferSelect & { syncFixtureIp: string };

interface Fixture {
  partnerId: string;
  integrationId: string;
  formerOrgId: string;
  mappingsDescending: SyncFixtureMapping[];
}

/** Seed with the superuser in independent committed statements/transactions. */
async function seedFixture(): Promise<Fixture> {
  const fixtureDb = getTestDb() as any;
  const partner = await createPartner();
  const orgs = await Promise.all([
    createOrganization({ partnerId: partner.id }),
    createOrganization({ partnerId: partner.id }),
    createOrganization({ partnerId: partner.id }),
  ]);
  const sites = await Promise.all(orgs.map((org) => createSite({ orgId: org.id })));

  const [integration] = await fixtureDb
    .insert(unifiIntegrations)
    .values({ partnerId: partner.id, apiKeyEncrypted: 'test-cloud-key' })
    .returning({ id: unifiIntegrations.id });

  const mappings: SyncFixtureMapping[] = [];
  for (const [index, org] of orgs.entries()) {
    const site = sites[index]!;
    const ip = `10.77.0.${index + 10}`;
    const [mapping] = await fixtureDb
      .insert(unifiSiteMappings)
      .values({
        integrationId: integration.id,
        orgId: org.id,
        siteId: site.id,
        unifiHostId: `host-${index}`,
        unifiSiteId: `site-${index}`,
      })
      .returning();
    mappings.push({ ...mapping!, syncFixtureIp: ip });

    if (index < 2) {
      // Existing approved assets force applySyncData down the UPDATE path whose
      // real transition-table trigger obtains the export lock.
      await fixtureDb.insert(discoveredAssets).values({
        orgId: org.id,
        siteId: site.id,
        ipAddress: ip,
        macAddress: DEVICE.mac,
        hostname: 'before sync',
        assetType: 'switch',
        approvalStatus: 'approved',
        source: 'unifi',
      });
    }
  }

  const formerMapping = mappings[2]!;
  await fixtureDb.insert(unifiDevices).values({
    orgId: formerMapping.orgId,
    siteId: formerMapping.siteId,
    integrationId: integration.id,
    mappingId: formerMapping.id,
    unifiDeviceId: 'former-owner-device',
    raw: { id: 'former-owner-device' },
  });

  return {
    partnerId: partner.id,
    integrationId: integration.id,
    formerOrgId: formerMapping.orgId,
    mappingsDescending: mappings.slice(0, 2).sort((a, b) => b.orgId.localeCompare(a.orgId)),
  };
}

function collectedFor(mappings: SyncFixtureMapping[]): CollectedSync {
  return {
    hostsSeen: 1,
    byMapping: new Map(mappings.map((mapping, index) => [mapping.id, {
      mappingId: mapping.id,
      metrics: null,
      devices: [{
        ...DEVICE,
        unifiDeviceId: `device-${index}`,
        ip: mapping.syncFixtureIp,
        raw: { id: `device-${index}`, type: 'usw' },
      }],
    }])),
  };
}

async function assetsFor() {
  return (getTestDb() as any)
    .select({ orgId: discoveredAssets.orgId, hostname: discoveredAssets.hostname })
    .from(discoveredAssets)
    .where(eq(discoveredAssets.source, 'unifi'))
    .orderBy(asc(discoveredAssets.orgId));
}

describe('UniFi sync export lock ordering', () => {
  it('accepts an empty mapping set through the real UUID-array lock query', async () => {
    const fixtureDb = getTestDb() as any;
    const partner = await createPartner();
    const [integration] = await fixtureDb
      .insert(unifiIntegrations)
      .values({ partnerId: partner.id, apiKeyEncrypted: 'test-cloud-key' })
      .returning({ id: unifiIntegrations.id });

    await expect(runOutsideDbContext(() => withSystemDbAccessContext(() =>
      lockUnifiSyncOrganizations(db, integration!.id, [])
    ))).resolves.toBeUndefined();
  });

  it('pre-locks unordered mappings before writes so every approved asset update commits', async () => {
    const fixture = await seedFixture();

    const { result, heldOrgLockIds } = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await lockUnifiSyncOrganizations(db, fixture.integrationId, fixture.mappingsDescending);
      const heldRows = await db.execute(
        sql`SELECT current_setting('breeze.partner_export_org_locks', true) AS org_ids`,
      );
      const heldOrgLockIds = ((heldRows as unknown as Array<{ org_ids: string | null }>)[0]?.org_ids ?? '')
        .split(',')
        .filter(Boolean);
      const result = await applySyncData(
        db,
        { id: fixture.integrationId, partnerId: fixture.partnerId },
        'scheduled',
        fixture.mappingsDescending,
        collectedFor(fixture.mappingsDescending),
      );
      return { result, heldOrgLockIds };
    }));

    expect(result.status).toBe('success');
    expect(result.devicesCreated).toBe(2);
    // The current mapping set omits this former mapping, but stale sweeping can
    // still write its device row. The pre-lock must cover that owner too.
    expect(heldOrgLockIds).toContain(fixture.formerOrgId);
    const assets = await assetsFor();
    expect(assets).toHaveLength(2);
    expect(assets.every((asset: { hostname: string | null }) => asset.hostname === DEVICE.name)).toBe(true);
  });

  it('without the pre-lock, descending mapping writes fail and roll back the sync transaction', async () => {
    const fixture = await seedFixture();

    let thrown: unknown;
    try {
      await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        applySyncData(
          db,
          { id: fixture.integrationId, partnerId: fixture.partnerId },
          'scheduled',
          fixture.mappingsDescending,
          collectedFor(fixture.mappingsDescending),
        )
      ));
    } catch (error) {
      thrown = error;
    }
    // applySyncData catches the original P0001 site write, then its stale sweep
    // / ledger update hits PostgreSQL's already-aborted transaction. The
    // visible worker boundary is therefore 25P02, which is the production
    // signature and proves the entire transaction rolled back.
    const postgresError = (thrown as { cause?: { code?: string }; code?: string } | undefined)?.cause
      ?? (thrown as { code?: string } | undefined);
    expect(postgresError?.code).toBe('25P02');

    const assets = await assetsFor();
    expect(assets).toHaveLength(2);
    expect(assets.every((asset: { hostname: string | null }) => asset.hostname === 'before sync')).toBe(true);
    const runs = await (getTestDb() as any)
      .select({ id: unifiSyncRuns.id })
      .from(unifiSyncRuns)
      .where(eq(unifiSyncRuns.integrationId, fixture.integrationId));
    expect(runs).toHaveLength(0);
  });
});
