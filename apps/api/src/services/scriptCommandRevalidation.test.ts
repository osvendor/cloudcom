import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getUserPermissions: vi.fn(),
  requester: null as { partnerId: string } | null,
}));
vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (m.requester ? [m.requester] : []) }),
      }),
    }),
  },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));
vi.mock('./permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./permissions')>();
  return { ...actual, getUserPermissions: m.getUserPermissions };
});

import { revalidateScriptCommandAuthority } from './scriptCommandRevalidation';

const deviceId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const orgId = '00000000-0000-4000-8000-000000000003';
const siteId = '00000000-0000-4000-8000-000000000004';
const partnerId = '00000000-0000-4000-8000-000000000005';
const row = { id: 'cmd-1', type: 'script', deviceId, payload: null, createdBy: userId };

function readerFor(device: { orgId: string; siteId: string } | undefined, requester: { partnerId: string } | undefined) {
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            call += 1;
            return call === 1 ? (device ? [device] : []) : (requester ? [requester] : []);
          },
        }),
      }),
    }),
  } as never;
}

describe('revalidateScriptCommandAuthority', () => {
  beforeEach(() => {
    m.requester = { partnerId };
    m.getUserPermissions.mockReset();
  });

  it('does not revalidate a row with no requester identity (system/automation-issued)', async () => {
    const reader = { select: () => { throw new Error('must not read'); } } as never;
    await expect(revalidateScriptCommandAuthority(reader, { ...row, createdBy: null })).resolves.toBeNull();
    expect(m.getUserPermissions).not.toHaveBeenCalled();
  });

  it('cancels when the requester no longer holds scripts:execute for the device org', async () => {
    m.requester = { partnerId };
    m.getUserPermissions.mockResolvedValue({
      permissions: [], partnerId, orgId, roleId: 'r', scope: 'organization',
    });
    const reader = readerFor({ orgId, siteId }, { partnerId });
    await expect(revalidateScriptCommandAuthority(reader, row)).resolves.toBe('scope_changed');
  });

  it('cancels when the requester no longer has org access', async () => {
    m.getUserPermissions.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'execute' }],
      partnerId, orgId: 'different-org', roleId: 'r', scope: 'organization',
    });
    const reader = readerFor({ orgId, siteId }, { partnerId });
    await expect(revalidateScriptCommandAuthority(reader, row)).resolves.toBe('scope_changed');
  });

  it('cancels when the device site is outside the requester\'s restricted site allowlist', async () => {
    m.getUserPermissions.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'execute' }],
      partnerId, orgId, roleId: 'r', scope: 'partner', orgAccess: 'all', allowedSiteIds: ['other-site'],
    });
    const reader = readerFor({ orgId, siteId }, { partnerId });
    await expect(revalidateScriptCommandAuthority(reader, row)).resolves.toBe('scope_changed');
  });

  it('allows delivery when the requester still holds authority for the device', async () => {
    m.getUserPermissions.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'execute' }],
      partnerId, orgId, roleId: 'r', scope: 'organization',
    });
    const reader = readerFor({ orgId, siteId }, { partnerId });
    await expect(revalidateScriptCommandAuthority(reader, row)).resolves.toBeNull();
  });

  it('fails closed when the device or requester row is gone', async () => {
    expect(await revalidateScriptCommandAuthority(readerFor(undefined, { partnerId }), row)).toBe('scope_changed');
    m.requester = null;
    expect(await revalidateScriptCommandAuthority(readerFor({ orgId, siteId }, undefined), row)).toBe('scope_changed');
  });

  it('uses a system identity read when the claim reader cannot see a partner-only requester', async () => {
    m.getUserPermissions.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'execute' }],
      partnerId, orgId: null, roleId: 'partner-admin', scope: 'partner', orgAccess: 'all',
    });
    const hiddenClaimReader = readerFor({ orgId, siteId }, undefined);
    await expect(revalidateScriptCommandAuthority(hiddenClaimReader, row)).resolves.toBeNull();
    expect(m.getUserPermissions).toHaveBeenCalledWith(userId, { orgId, partnerId });
  });
});
