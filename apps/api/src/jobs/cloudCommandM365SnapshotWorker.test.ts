import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(), publish: vi.fn(), release: vi.fn(), provision: vi.fn(),
  users: vi.fn(), groups: vi.fn(), licenses: vi.fn(), drives: vi.fn(),
  inventory: vi.fn(), statistics: vi.fn(),
}));
vi.mock('@cloudcom/ext-cloud-command', () => ({
  claimDirectorySnapshot: mocks.claim,
  publishDirectorySnapshotSource: mocks.publish,
  releaseDirectorySnapshot: mocks.release,
  createAdminGraphProvider: () => ({ listUsers: mocks.users, listGroups: mocks.groups,
    listLicenses: mocks.licenses, getKnownLicensedDriveUsage: mocks.drives }),
  createExchangeMailboxInventoryClient: () => mocks.inventory,
  createExchangeMailboxStatisticsClient: () => mocks.statistics,
  projectMicrosoftResource: (_resource: string, items: unknown[]) => ({ items }),
}));
vi.mock('../db', () => ({
  db: { execute: vi.fn() },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../extensions/cloudCommandAdminRuntime', () => ({
  cloudCommandAdminRuntime: { acquireToken: vi.fn(), configuration: vi.fn(),
    exchange: async () => ({ registry: { provision: mocks.provision }, worker: {} }) },
}));
vi.mock('../services/urlSafety', () => ({ safeFetch: vi.fn() }));

import { collectCloudCommandM365Snapshot, refreshCloudCommandM365Snapshot } from './cloudCommandM365SnapshotWorker';

const binding = { orgId: '0b430874-6159-4ddf-b4ad-36ae5f62ba14',
  tenantId: '1b430874-6159-4ddf-b4ad-36ae5f62ba14',
  clientId: '2b430874-6159-4ddf-b4ad-36ae5f62ba14', credentialVersion: 'v1', generation: 2 };
const at = '2026-09-25T12:00:00Z';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockResolvedValue('3b430874-6159-4ddf-b4ad-36ae5f62ba14');
  mocks.publish.mockResolvedValue(true);
  mocks.release.mockResolvedValue(undefined);
  mocks.users.mockResolvedValue({ partial: false, items: [{ id: 'user-a', licenseSummary: 'Business Standard', oneDrive: null }] });
  mocks.groups.mockResolvedValue({ partial: false, items: [] });
  mocks.licenses.mockResolvedValue({ partial: false, items: [] });
  mocks.inventory.mockResolvedValue({ partial: false, records: [{ id: 'mailbox-a',
    primarySmtpAddress: 'shared@example.test', recipientType: 'SharedMailbox', archiveEnabled: false,
    mailboxBytes: null, archiveBytes: null, statisticsUnavailable: true, collectedAt: at }],
    summary: { userMailboxCount: 0, sharedMailboxCount: 1, mailboxStatisticsUnavailableCount: 1,
      archiveStatisticsUnavailableCount: 0 }, collectedAt: at });
  mocks.statistics.mockResolvedValue({ id: 'mailbox-a', primarySmtpAddress: 'shared@example.test',
    recipientType: 'SharedMailbox', archiveEnabled: false, mailboxBytes: 1024,
    archiveBytes: null, statisticsUnavailable: false, collectedAt: at });
  mocks.drives.mockResolvedValue({ 'user-a': '1.0 GB' });
});

describe('Cloud Command Microsoft snapshot collection', () => {
  it('uses the bound Exchange descriptor and fills missing licensed drive usage before publishing', async () => {
    const result = await collectCloudCommandM365Snapshot(binding);
    expect(mocks.provision).toHaveBeenCalledWith({ organizationId: binding.orgId,
      tenantId: binding.tenantId, clientId: binding.clientId,
      credentialVersion: binding.credentialVersion, connectionGeneration: binding.generation });
    expect(result.directory.mailboxes).toEqual([{ id: 'mailbox-a', primarySmtpAddress: 'shared@example.test',
      recipientType: 'SharedMailbox', archiveEnabled: false }]);
    expect(result.usage?.oneDriveByUserId).toEqual({ 'user-a': '1.0 GB' });
    expect(mocks.statistics).toHaveBeenCalledWith(expect.objectContaining({ tenantId: binding.tenantId }), 'mailbox-a');
    expect((result.usage?.mailboxInventory as { records: Array<{ mailboxBytes: number }> }).records[0]?.mailboxBytes).toBe(1024);
  });

  it('keeps usage stale when a mailbox statistics read fails, despite complete identity enumeration', async () => {
    mocks.statistics.mockRejectedValue(new Error('provider unavailable'));
    const result = await collectCloudCommandM365Snapshot(binding);
    expect(result.directory.mailboxes).toHaveLength(1);
    expect(result.usage).toBeNull();
  });
  it('does not join mailbox usage to an identity that changed during collection', async () => {
    mocks.statistics.mockResolvedValue({ id: 'mailbox-a', primarySmtpAddress: 'different@example.test',
      recipientType: 'SharedMailbox', archiveEnabled: false, mailboxBytes: 1024,
      archiveBytes: null, statisticsUnavailable: false, collectedAt: at });
    const result = await collectCloudCommandM365Snapshot(binding);
    expect(result.directory.mailboxes).toHaveLength(1);
    expect(result.usage).toBeNull();
  });

  it('never publishes a partial directory as complete', async () => {
    mocks.groups.mockResolvedValue({ partial: true, items: [] });
    await refreshCloudCommandM365Snapshot(binding);
    expect(mocks.publish).toHaveBeenCalledWith(expect.anything(), binding, expect.any(String), 'directory', null);
    expect(mocks.publish).toHaveBeenCalledWith(expect.anything(), binding, expect.any(String), 'usage', null);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('publishes a complete directory while leaving usage stale if OneDrive is unavailable', async () => {
    mocks.drives.mockResolvedValue({ 'user-a': 'Unavailable' });
    await refreshCloudCommandM365Snapshot(binding);
    expect(mocks.publish).toHaveBeenCalledWith(expect.anything(), binding, expect.any(String), 'directory', expect.objectContaining({ mailboxes: expect.any(Array) }));
    expect(mocks.publish).toHaveBeenCalledWith(expect.anything(), binding, expect.any(String), 'usage', null);
  });
  it('resolves report-anonymized OneDrive rows through the bound direct-drive read', async () => {
    mocks.users.mockResolvedValue({ partial: false, items: [{ id: 'user-a',
      licenseSummary: 'Business Standard', oneDrive: 'Names concealed in Microsoft reports' }] });
    const result = await collectCloudCommandM365Snapshot(binding);
    expect(mocks.drives).toHaveBeenCalledWith(['user-a']);
    expect(result.usage?.oneDriveByUserId).toEqual({ 'user-a': '1.0 GB' });
  });
  it('collects usage for more than 999 concealed licensed users in one bounded tenant batch', async () => {
    const items = Array.from({ length: 1001 }, (_, i) => ({ id: `user-${i}`, licenseSummary: 'Business Standard', oneDrive: null }));
    mocks.users.mockResolvedValue({ partial: false, items });
    mocks.drives.mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, '1.0 GB'])));
    const result = await collectCloudCommandM365Snapshot(binding);
    expect(mocks.drives).toHaveBeenCalledOnce();
    expect((mocks.drives.mock.calls[0]![0] as string[])).toHaveLength(1001);
    expect(Object.keys(result.usage!.oneDriveByUserId as Record<string, string>)).toHaveLength(1001);
  });
});
