import { sql } from 'drizzle-orm';
import {
  claimDirectorySnapshot, createAdminGraphProvider, createExchangeMailboxInventoryClient, createExchangeMailboxStatisticsClient,
  projectMicrosoftResource, publishDirectorySnapshotSource, releaseDirectorySnapshot, type SnapshotBinding,
} from '@cloudcom/ext-cloud-command';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { cloudCommandAdminRuntime } from '../extensions/cloudCommandAdminRuntime';
import { safeFetch } from '../services/urlSafety';

type BoundRow = SnapshotBinding & { id: string };
const SWEEP_MS = 60_000;
let timer: ReturnType<typeof setInterval> | undefined;
let sweeping = false;

function rows<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error('Unexpected database result');
  return value as T[];
}
async function system<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return withSystemDbAccessContext(fn, `cloudCommandM365Snapshot.${label}`);
}

/** Enumeration, claim and publish each hold separate short database contexts.
 * Graph and Exchange calls never pin a pooled PostgreSQL transaction. */
async function candidates(): Promise<BoundRow[]> {
  return system('candidates', async () => rows<BoundRow>(await db.execute(sql`
    SELECT c.id, c.org_id AS "orgId", c.tenant_id AS "tenantId", c.client_id AS "clientId",
      c.credential_version AS "credentialVersion", c.generation
    FROM cloudcommand_microsoft_admin_connections c
    LEFT JOIN cloudcommand_microsoft_directory_snapshots s ON s.org_id = c.org_id
    WHERE c.enabled = true AND (s.last_attempt_at IS NULL
      OR s.last_attempt_at < now() - interval '5 minutes'
      OR s.refresh_requested_at > s.last_attempt_at)
    ORDER BY s.last_attempt_at NULLS FIRST, c.org_id
    LIMIT 10
  `)));
}

/** Reads only the configured Cloud Command enterprise app and a tenant-bound
 * Exchange descriptor. A partial Graph or mailbox page never becomes ready. */
export async function collectCloudCommandM365Snapshot(binding: SnapshotBinding): Promise<{
  directory: Record<string, unknown>;
  usage: Record<string, unknown> | null;
}> {
  const graph = createAdminGraphProvider({
    tenantId: binding.tenantId,
    fetch: (url, init) => runOutsideDbContext(() => safeFetch(url, {
      ...init, signal: init.signal ?? undefined, allowPrivateNetwork: false, allowCarrierNat: false,
    })),
    acquireToken: () => cloudCommandAdminRuntime.acquireToken(binding),
  });
  const [users, groups, licenses] = await Promise.all([graph.listUsers(), graph.listGroups(), graph.listLicenses()]);
  if (users.partial || groups.partial || licenses.partial) throw new Error('m365_directory_partial');
  const exchange = await cloudCommandAdminRuntime.exchange();
  if (!exchange) throw new Error('m365_exchange_unavailable');
  const descriptor = { organizationId: binding.orgId, tenantId: binding.tenantId,
    clientId: binding.clientId, credentialVersion: binding.credentialVersion,
    connectionGeneration: binding.generation };
  await exchange.registry.provision(descriptor);
  const mailboxes = await createExchangeMailboxInventoryClient(exchange.worker)(descriptor);
  if (mailboxes.partial) throw new Error('m365_mailbox_inventory_partial');

  const directory = {
    users: projectMicrosoftResource('users', users.items, false),
    groups: projectMicrosoftResource('groups', groups.items, false),
    licenses: projectMicrosoftResource('licenses', licenses.items, false),
    mailboxes: mailboxes.records.map(({ id, primarySmtpAddress, recipientType, archiveEnabled }) =>
      ({ id, primarySmtpAddress, recipientType, archiveEnabled })),
  };
  // Enumeration deliberately omits statistics so it can return within the
  // worker's per-command timeout. Fetch every size through the bound mailbox
  // ID before declaring the usage source ready; a deadline leaves old usage
  // stale rather than publishing identity-only rows as complete usage.
  const usageRecords: typeof mailboxes.records = [];
  const statistics = createExchangeMailboxStatisticsClient(exchange.worker);
  const statisticsDeadline = Date.now() + 8 * 60 * 1000;
  try {
    for (const row of mailboxes.records) {
      if (Date.now() >= statisticsDeadline) return { directory, usage: null };
      const actual = await statistics(descriptor, row.id);
      if (actual.recipientType !== row.recipientType
        || actual.primarySmtpAddress.toLowerCase() !== row.primarySmtpAddress.toLowerCase())
        return { directory, usage: null };
      usageRecords.push({ ...actual, statistics: {
        mailbox: actual.mailboxBytes === null ? 'unavailable' : 'available',
        archive: !actual.archiveEnabled ? 'not_enabled' : actual.archiveBytes === null ? 'unavailable' : 'available',
      } });
    }
  } catch { return { directory, usage: null }; }
  const usageInventory = { ...mailboxes, records: usageRecords, collectedAt: new Date().toISOString(),
    summary: { userMailboxCount: usageRecords.filter(row => row.recipientType === 'UserMailbox').length,
      sharedMailboxCount: usageRecords.filter(row => row.recipientType === 'SharedMailbox').length,
      mailboxStatisticsUnavailableCount: usageRecords.filter(row => row.mailboxBytes === null).length,
      archiveStatisticsUnavailableCount: usageRecords.filter(row => row.archiveEnabled && row.archiveBytes === null).length } };
  // The report may omit licensed users when identities are concealed. Fill those
  // gaps through bounded direct-drive reads; never mislabel an unknown as zero.
  const drives: Record<string, string> = {};
  const missing = users.items.filter(user => user.licenseSummary !== 'Unlicensed'
    && (user.oneDrive === null || user.oneDrive === 'Names concealed in Microsoft reports'));
  for (const user of users.items)
    if (user.oneDrive !== null && user.oneDrive !== 'Names concealed in Microsoft reports')
      drives[user.id] = user.oneDrive;
  try { Object.assign(drives, await graph.getKnownLicensedDriveUsage(missing.map(user => user.id))); }
  catch { return { directory, usage: null }; }
  if (Object.values(drives).includes('Unavailable')) return { directory, usage: null };
  return { directory, usage: { mailboxInventory: usageInventory,
    oneDriveByUserId: drives, exchangeCollectedAt: usageInventory.collectedAt } };
}

export async function refreshCloudCommandM365Snapshot(binding: SnapshotBinding): Promise<void> {
  const token = await system('claim', () => claimDirectorySnapshot(db, binding));
  if (!token) return;
  try {
    let directory: Record<string, unknown> | null = null;
    let usage: Record<string, unknown> | null = null;
    try {
      ({ directory, usage } = await runOutsideDbContext(() => collectCloudCommandM365Snapshot(binding)));
    } catch (error) {
      console.warn('[CloudCommandM365Snapshot] collection failed', {
        orgId: binding.orgId, reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    await system('publishDirectory', () => publishDirectorySnapshotSource(db, binding, token, 'directory', directory));
    await system('publishUsage', () => publishDirectorySnapshotSource(db, binding, token, 'usage', usage));
  } finally {
    await runOutsideDbContext(() => system('release', () => releaseDirectorySnapshot(db, binding, token)));
  }
}

async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const configuration = await cloudCommandAdminRuntime.configuration();
    if (!configuration) return;
    for (const row of await candidates()) {
      if (row.clientId !== configuration.clientId || row.credentialVersion !== configuration.credentialVersion) continue;
      try { await refreshCloudCommandM365Snapshot(row); }
      catch (error) { console.warn('[CloudCommandM365Snapshot] refresh failed', row.orgId, error); }
    }
  } finally { sweeping = false; }
}

export function initializeCloudCommandM365SnapshotWorker(): void {
  if (timer) return;
  timer = setInterval(() => { void sweep().catch(error => console.error('[CloudCommandM365Snapshot] sweep failed', error)); }, SWEEP_MS);
  timer.unref();
  void sweep().catch(error => console.error('[CloudCommandM365Snapshot] initial sweep failed', error));
}

export function shutdownCloudCommandM365SnapshotWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
