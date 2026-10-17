import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({
  transaction: {} as object | undefined, context: {} as any, select: vi.fn(), execute: vi.fn(),
  featureTypes: [] as string[], inventoryError: null as Error | null,
}));
vi.mock('../db', () => ({
  db: { select: state.select, execute: state.execute },
  getCurrentDbTransactionIdentity: () => state.transaction,
  getCurrentDbAccessContext: () => state.context,
}));
vi.mock('./redis', () => ({ getRedis: () => null }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
// Keep unrelated agent ingest/dispatch modules out of this resolver-only test.
vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('./commandQueue', () => ({ queueCommandForExecution: vi.fn() }));
vi.mock('./cisHardening', () => ({ parseCisCollectorOutput: vi.fn() }));
vi.mock('./cloudflareMtls', () => ({ CloudflareMtlsService: vi.fn() }));
vi.mock('./softwarePolicyService', () => ({ recordSoftwarePolicyAudit: vi.fn() }));
vi.mock('./filesystemAnalysis', () => ({}));
vi.mock('../routes/metrics', () => ({}));
vi.mock('../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn() }));
vi.mock('../routes/agents/policyProbeSafety', () => ({ isAllowedPolicyConfigProbe: vi.fn(() => true) }));

import { db } from '../db';
import { configPolicyAssignments, configPolicyEffectiveFeatureLinks, configPolicyFeatureLinks, devices, organizations, deviceGroupMemberships, sites } from '../db/schema';
import { isPolicyFeatureAbsentInSnapshot, readPolicyDevice, readPolicyOrganization, readPolicyGroups, withDevicePolicyReadSnapshot } from './devicePolicyReadSnapshot';
import { resolvePatchConfigPolicyForDevice } from './featureConfigResolver';
import { resolveEffectiveWarrantyInlineSettings } from './warrantyPolicyResolution';
import { resolveMonitorsForDevice } from './monitors/monitorResolver';
import { getDeviceTimeSyncSettings } from './timeSync/settings';
import {
  buildEventLogConfigUpdate, buildHardwareMonitoringConfigUpdate, buildPatchSourceConfigUpdate,
  buildWarrantyConfigUpdate, buildTimeSyncConfigUpdate, buildMonitoringConfigUpdate,
} from '../routes/agents/helpers';

const DEVICE = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-000000000002';
const tables: unknown[] = [];
const joined: unknown[] = [];
const dialect = new PgDialect();

function query() {
  let table: unknown;
  let predicate: any;
  let siteLookup = false;
  const chain: any = {
    from(t: unknown) { table = t; tables.push(t); return chain; },
    where(p: unknown) { predicate = p; return chain; },
    innerJoin(t: unknown) { joined.push(t); siteLookup ||= t === sites; return chain; },
    then(resolve: any, reject: any) {
      let rows: unknown[] = [];
      if (table === devices && !siteLookup) rows = [{
        id: dialect.sqlToQuery(predicate).params[0], orgId: state.context?.orgId ?? ORG,
        siteId: 'site-1', deviceRole: 'workstation', osType: 'windows',
      }];
      if (table === organizations) rows = [{ partnerId: 'partner-1', type: 'customer' }];
      if (table === configPolicyFeatureLinks) {
        if (state.inventoryError) return Promise.reject(state.inventoryError).then(resolve, reject);
        rows = state.featureTypes.map(featureType => ({ featureType }));
      }
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
  for (const name of ['limit', 'orderBy', 'groupBy']) chain[name] = () => chain;
  return chain;
}

beforeEach(() => {
  state.transaction = {};
  state.context = { scope: 'system' };
  state.select.mockReset().mockImplementation(query);
  state.execute.mockReset().mockResolvedValue([]);
  state.featureTypes = [];
  state.inventoryError = null;
  tables.length = 0;
  joined.length = 0;
});

describe('heartbeat-local policy hierarchy snapshot', () => {
  it('reduces four actual resolver passes from 17 selects to 7 with identical results', async () => {
    // The hierarchy optimization also applies to scoped callers; absence does not.
    state.context = { scope: 'organization', accessiblePartnerIds: ['partner-1'] };
    const resolveAll = async () => [
      await resolvePatchConfigPolicyForDevice(DEVICE),
      await resolveEffectiveWarrantyInlineSettings(DEVICE),
      await resolveMonitorsForDevice(DEVICE),
      await getDeviceTimeSyncSettings(DEVICE),
    ];
    const uncached = await resolveAll();
    expect(state.select).toHaveBeenCalledTimes(17);
    state.select.mockClear();
    tables.length = 0;
    expect(await withDevicePolicyReadSnapshot(DEVICE, resolveAll)).toEqual(uncached);
    expect(state.select).toHaveBeenCalledTimes(7);
    for (const table of [devices, organizations, deviceGroupMemberships]) {
      expect(tables.filter(t => t === table)).toHaveLength(1);
    }
  });

  it('does not reuse a device snapshot for another device or after the callback', async () => {
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      expect((await readPolicyDevice(DEVICE))?.id).toBe(DEVICE);
      expect((await readPolicyDevice('other-device'))?.id).toBe('other-device');
      expect((await readPolicyDevice('other-device'))?.id).toBe('other-device');
      await readPolicyDevice(DEVICE);
    });
    expect(state.select).toHaveBeenCalledTimes(3);
    await readPolicyDevice(DEVICE);
    await withDevicePolicyReadSnapshot(DEVICE, () => readPolicyDevice(DEVICE));
    expect(state.select).toHaveBeenCalledTimes(5);
  });

  it('does not reuse data across a narrowed context, transaction, or savepoint', async () => {
    const originalTransaction = state.transaction;
    const originalContext = state.context;
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      expect((await readPolicyDevice(DEVICE))?.orgId).toBe(ORG);
      state.context = { scope: 'organization', orgId: 'other-org' };
      expect((await readPolicyDevice(DEVICE))?.orgId).toBe('other-org');
      state.context = originalContext;
      state.transaction = {}; // A new transaction can reuse the system context singleton.
      await readPolicyDevice(DEVICE);
      state.transaction = {}; // Savepoints route through another executor too.
      await readPolicyDevice(DEVICE);
      state.transaction = originalTransaction;
      await readPolicyDevice(DEVICE);
    });
    expect(state.select).toHaveBeenCalledTimes(4);
  });

  it('bypasses an explicitly supplied executor and scopes org reads by org id', async () => {
    const other = { select: vi.fn(query) } as unknown as Pick<typeof db, 'select'>;
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      await readPolicyDevice(DEVICE);
      await readPolicyDevice(DEVICE, other);
      await readPolicyDevice(DEVICE, other);
      await readPolicyOrganization(DEVICE, ORG);
      await readPolicyOrganization(DEVICE, 'other-org');
      await readPolicyOrganization(DEVICE, ORG);
    });
    expect(state.select).toHaveBeenCalledTimes(3);
    expect(other.select).toHaveBeenCalledTimes(2);
  });

  it('retries a failed load and shares concurrent successful reads', async () => {
    state.select.mockImplementationOnce(() => { throw new Error('read failed'); });
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      await expect(readPolicyDevice(DEVICE)).rejects.toThrow('read failed');
      const [first, second] = await Promise.all([readPolicyDevice(DEVICE), readPolicyDevice(DEVICE)]);
      expect(first).toEqual(second);
      await readPolicyDevice(DEVICE);
      await Promise.all([readPolicyGroups(DEVICE), readPolicyGroups(DEVICE)]);
    });
    expect(state.select).toHaveBeenCalledTimes(3);
  });

  it('does not cache when no database transaction is active', async () => {
    state.transaction = undefined;
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      await readPolicyDevice(DEVICE);
      await readPolicyDevice(DEVICE);
    });
    expect(state.select).toHaveBeenCalledTimes(2);
  });

  it('deactivates snapshots inherited by work deferred beyond the callback', async () => {
    let deferred!: () => Promise<void>;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let pending!: Promise<void>;
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      await readPolicyDevice(DEVICE);
      deferred = async () => { await gate; await readPolicyDevice(DEVICE); };
      pending = deferred();
    });
    release();
    await pending;
    expect(state.select).toHaveBeenCalledTimes(2);
  });
});

describe('heartbeat-local policy feature absence', () => {
  it('replaces five heavyweight joins with one inventory and four live-transaction probes, preserving wire defaults', async () => {
    const resolveAll = async () => [
      await buildEventLogConfigUpdate(DEVICE),
      await buildHardwareMonitoringConfigUpdate(DEVICE),
      await buildPatchSourceConfigUpdate(DEVICE),
      await buildWarrantyConfigUpdate(DEVICE),
      await buildTimeSyncConfigUpdate(DEVICE),
    ];
    const uncached = await resolveAll();
    expect(joined.filter(t => t === configPolicyEffectiveFeatureLinks)).toHaveLength(4);
    expect(tables.filter(t => t === configPolicyEffectiveFeatureLinks)).toHaveLength(1);
    expect(state.select).toHaveBeenCalledTimes(22);
    state.select.mockClear();
    tables.length = joined.length = 0;
    expect(await withDevicePolicyReadSnapshot(DEVICE, resolveAll)).toEqual(uncached);
    expect(joined).not.toContain(configPolicyEffectiveFeatureLinks);
    expect(tables).not.toContain(configPolicyEffectiveFeatureLinks);
    expect(tables.filter(t => t === configPolicyFeatureLinks)).toHaveLength(1);
    // Device/org/groups, feature inventory, and the existing time-sync site read.
    expect(state.select).toHaveBeenCalledTimes(5);
    expect(state.execute).toHaveBeenCalledTimes(4);
    for (const [probe] of state.execute.mock.calls) {
      expect(dialect.sqlToQuery(probe)).toMatchObject({ sql: 'select 1', params: [] });
    }
  });

  it('keeps monitoring resolution independent of absent legacy monitoring links', async () => {
    state.featureTypes = ['monitors'];
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      await isPolicyFeatureAbsentInSnapshot(DEVICE, 'event_log');
      await buildMonitoringConfigUpdate(DEVICE);
    });
    // Both the interval and monitor attachment resolvers still read assignments.
    expect(tables.filter(t => t === configPolicyAssignments)).toHaveLength(2);
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('does not reuse absence outside its device, system scope, executor, transaction, or callback', async () => {
    expect(await isPolicyFeatureAbsentInSnapshot(DEVICE, 'patch')).toBe(false);
    const transaction = state.transaction;
    const context = state.context;
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      expect(await isPolicyFeatureAbsentInSnapshot(DEVICE, 'patch')).toBe(true);
      expect(await isPolicyFeatureAbsentInSnapshot('other-device', 'patch')).toBe(false);
      expect(await isPolicyFeatureAbsentInSnapshot(DEVICE, 'patch', { select: state.select } as any)).toBe(false);
      state.transaction = {};
      expect(await isPolicyFeatureAbsentInSnapshot(DEVICE, 'patch')).toBe(false);
      state.transaction = transaction;
      state.context = { scope: 'organization' };
      expect(await isPolicyFeatureAbsentInSnapshot(DEVICE, 'patch')).toBe(false);
      state.context = context;
    });
    expect(await isPolicyFeatureAbsentInSnapshot(DEVICE, 'patch')).toBe(false);
    state.context = { scope: 'organization' };
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      expect(await isPolicyFeatureAbsentInSnapshot(DEVICE, 'patch')).toBe(false);
    });
    state.context = context;
    state.transaction = undefined;
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      expect(await isPolicyFeatureAbsentInSnapshot(DEVICE, 'patch')).toBe(false);
    });
    expect(state.select).toHaveBeenCalledTimes(1);
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('reloads feature inventory in the next snapshot and uses the full resolver for a present feature', async () => {
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      expect(await resolvePatchConfigPolicyForDevice(DEVICE)).toBeNull();
    });
    expect(joined).not.toContain(configPolicyEffectiveFeatureLinks);
    state.featureTypes = ['patch'];
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      expect(await isPolicyFeatureAbsentInSnapshot(DEVICE, 'patch')).toBe(false);
      await resolvePatchConfigPolicyForDevice(DEVICE);
    });
    expect(tables.filter(t => t === configPolicyFeatureLinks)).toHaveLength(2);
    expect(joined).toContain(configPolicyEffectiveFeatureLinks);
  });

  it('throws on an inventory failure and retries it without caching a false absence', async () => {
    state.inventoryError = new Error('inventory read failed');
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      await expect(isPolicyFeatureAbsentInSnapshot(DEVICE, 'patch')).rejects.toThrow('inventory read failed');
      state.inventoryError = null;
      state.featureTypes = ['patch'];
      expect(await isPolicyFeatureAbsentInSnapshot(DEVICE, 'patch')).toBe(false);
    });
    expect(state.select).toHaveBeenCalledTimes(2);
  });

  it('rejects cached absence after an earlier SQL failure instead of sending off/default settings', async () => {
    await withDevicePolicyReadSnapshot(DEVICE, async () => {
      await buildEventLogConfigUpdate(DEVICE); // Primes hierarchy and absent features.
      state.execute.mockRejectedValue(new Error('current transaction is aborted'));
      for (const resolve of [buildHardwareMonitoringConfigUpdate, buildPatchSourceConfigUpdate, buildWarrantyConfigUpdate, buildTimeSyncConfigUpdate]) {
        await expect(resolve(DEVICE)).rejects.toThrow('current transaction is aborted');
      }
    });
    expect(state.execute).toHaveBeenCalledTimes(4);
    expect(tables.filter(t => t === configPolicyFeatureLinks)).toHaveLength(1);
  });
});
