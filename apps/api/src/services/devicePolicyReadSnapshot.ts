import { AsyncLocalStorage } from 'node:async_hooks';
import { eq, sql } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, getCurrentDbTransactionIdentity } from '../db';
import { configPolicyFeatureLinks, devices, deviceGroupMemberships, organizations } from '../db/schema';

type Executor = Pick<typeof db, 'select'>;

interface PolicyReadSnapshot {
  deviceId: string;
  transaction: object;
  context: ReturnType<typeof getCurrentDbAccessContext>;
  reads: Map<string, Promise<unknown>>;
  active: boolean;
}

const snapshotStorage = new AsyncLocalStorage<PolicyReadSnapshot>();

/**
 * Deduplicate hierarchy reads only during one read-only heartbeat policy block.
 * Each feature still resolves its own assignments, ownership and inheritance.
 * No value survives this callback or crosses a device, transaction, savepoint,
 * narrowed access context, or explicitly supplied nonambient executor.
 */
export async function withDevicePolicyReadSnapshot<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  const transaction = getCurrentDbTransactionIdentity();
  const context = getCurrentDbAccessContext();
  if (!transaction || !context) return fn();
  const snapshot: PolicyReadSnapshot = { deviceId, transaction, context, reads: new Map(), active: true };
  return snapshotStorage.run(snapshot, async () => {
    try {
      return await fn();
    } finally {
      snapshot.active = false;
      snapshot.reads.clear();
    }
  });
}

async function readOnce<T>(deviceId: string, key: string, executor: Executor, read: () => Promise<T>): Promise<T> {
  const snapshot = snapshotStorage.getStore();
  if (!snapshot?.active || snapshot.deviceId !== deviceId || executor !== db
    || snapshot.transaction !== getCurrentDbTransactionIdentity()
    || snapshot.context !== getCurrentDbAccessContext()) return read();

  const existing = snapshot.reads.get(key);
  if (existing) return existing as Promise<T>;
  const pending = Promise.resolve().then(read);
  snapshot.reads.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    // A failed read is not an authoritative missing row, nor a cached failure.
    if (snapshot.reads.get(key) === pending) snapshot.reads.delete(key);
    throw error;
  }
}

/**
 * The effective-links view only contains links from this base table (including
 * inherited parent links). Global absence therefore proves there is no match,
 * but only in this opt-in, system-scoped read snapshot. Scoped callers and
 * explicitly supplied executors keep their normal resolver/visibility path.
 */
export async function isPolicyFeatureAbsentInSnapshot(
  deviceId: string,
  featureType: 'event_log' | 'hardware_monitoring' | 'patch' | 'warranty' | 'time_sync',
  executor: Executor = db,
): Promise<boolean> {
  const snapshot = snapshotStorage.getStore();
  if (!snapshot?.active || snapshot.deviceId !== deviceId || executor !== db
    || snapshot.context?.scope !== 'system'
    || snapshot.transaction !== getCurrentDbTransactionIdentity()
    || snapshot.context !== getCurrentDbAccessContext()) return false;

  const key = 'feature-types';
  const reused = snapshot.reads.has(key);
  const featureTypes = await readOnce(deviceId, key, executor, async () => {
    const rows = await db.select({ featureType: configPolicyFeatureLinks.featureType })
      .from(configPolicyFeatureLinks).groupBy(configPolicyFeatureLinks.featureType);
    return new Set(rows.map(row => row.featureType));
  });
  if (featureTypes.has(featureType)) return false;

  // A previous resolver may have caught a SQL error, aborting the shared tx.
  // Never let cached absence turn that error into a default/off config update.
  // The first inventory query already proves liveness; every reuse must do so
  // on the SAME transaction, without catching or replacing its failure.
  if (reused) await db.execute(sql`select 1`);
  return true;
}

export async function readPolicyDevice(deviceId: string, executor: Executor = db) {
  return readOnce(deviceId, 'device', executor, async () => {
    const [device] = await executor.select({
      id: devices.id, orgId: devices.orgId, siteId: devices.siteId,
      deviceRole: devices.deviceRole, osType: devices.osType,
    }).from(devices).where(eq(devices.id, deviceId)).limit(1);
    return device;
  });
}

export async function readPolicyOrganization(deviceId: string, orgId: string, executor: Executor = db) {
  return readOnce(deviceId, `org:${orgId}`, executor, async () => {
    const [org] = await executor.select({ partnerId: organizations.partnerId, type: organizations.type })
      .from(organizations).where(eq(organizations.id, orgId)).limit(1);
    return org;
  });
}

export async function readPolicyGroups(deviceId: string, executor: Executor = db) {
  return readOnce(deviceId, 'groups', executor, async () =>
    executor.select({ groupId: deviceGroupMemberships.groupId })
      .from(deviceGroupMemberships).where(eq(deviceGroupMemberships.deviceId, deviceId)));
}
