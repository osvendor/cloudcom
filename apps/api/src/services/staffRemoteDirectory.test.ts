import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ authority: vi.fn(), where: vi.fn(), select: vi.fn(), rows: [] as any[] }));
vi.mock('../db', () => ({ db: { select: m.select } }));
vi.mock('./staffNativeAuthority', () => ({ revalidateStaffNativePrincipal: m.authority }));
vi.mock('./staffNativeAvailability', () => ({ staffNativeAvailability: () => async () => ({ available: false }) }));
vi.mock('./remoteAccessPolicy', () => ({ checkRemoteAccess: async () => ({ allowed: true }) }));
import { currentDeviceUser, previousDeviceUsers } from './deviceIdentity';
import { listStaffRemoteComputers } from './staffRemoteDirectory';
import type { StaffNativePrincipal } from './staffNativeAuthority';
const id = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const site = '33333333-3333-4333-8333-333333333333';
const principal = { userId: id, partnerId: id } as StaffNativePrincipal;
const where = () => new PgDialect().sqlToQuery(m.where.mock.calls[0]![0]);
beforeEach(() => {
  vi.resetAllMocks(); m.rows = [];
  const query: any = { from: () => query, innerJoin: () => query, where: m.where, orderBy: () => query, limit: async () => m.rows };
  m.select.mockReturnValue(query); m.where.mockReturnValue(query);
  m.authority.mockResolvedValue({ permissions: { scope: 'partner', orgAccess: 'all', permissions: [] } });
});
describe('shared staff remote directory authority', () => {
  it('uses the shared identity projections and preserves alias, hostname and user history', async () => {
    m.rows = [{ device: { id, orgId: org, hostname: 'HOST-01', displayName: 'Front desk', status: 'online' },
      peerId: '123', organizationName: 'Client', currentUser: 'Alice', previousUsers: ['bob', 'Old_User%'] }];
    const result = await listStaffRemoteComputers(principal);
    expect(m.select.mock.calls[0]![0].currentUser).toBe(currentDeviceUser);
    expect(m.select.mock.calls[0]![0].previousUsers).toBe(previousDeviceUsers);
    expect(result.devices[0]).toMatchObject({ hostname: 'HOST-01', displayName: 'Front desk',
      organizationId: org, currentUser: 'Alice', previousUsers: ['bob', 'Old_User%'] });
  });
  it('binds partner ownership and cursor before pagination', async () => {
    await listStaffRemoteComputers(principal, org);
    expect(where().params).toEqual([id, org]);
  });
  it('applies fresh selected organizations and sites in SQL, before pagination', async () => {
    m.authority.mockResolvedValue({ permissions: { scope: 'partner', orgAccess: 'selected', allowedOrgIds: [org], allowedSiteIds: [site], permissions: [] } });
    await listStaffRemoteComputers(principal);
    expect(where().params).toEqual([id, org, site]);
    expect(where().sql).toContain('"devices"."org_id" in');
    expect(where().sql).toContain('"devices"."site_id" in');
  });
  it.each([{ orgAccess: 'selected', allowedOrgIds: [] }, { orgAccess: 'all', allowedSiteIds: [] },
    { orgAccess: 'all', allowedSiteIds: 'malformed' }])('fails closed for an empty/malformed scope %j', async scope => {
    m.authority.mockResolvedValue({ permissions: { ...scope, permissions: [] } });
    await listStaffRemoteComputers(principal);
    expect(where().sql).toContain('false');
  });
  it('checks revocation before any device read', async () => {
    m.authority.mockRejectedValue(new Error('revoked'));
    await expect(listStaffRemoteComputers(principal)).rejects.toThrow('revoked');
    expect(m.select).not.toHaveBeenCalled();
  });
  it('keeps offline machines in the same paginated directory with disabled transports', async () => {
    m.rows = Array.from({ length: 51 }, (_, n) => ({ device: { id: `${n}`, orgId: org, status: 'offline', hostname: `PC${n}` },
      peerId: '123', organizationName: 'Client', currentUser: null, previousUsers: ['Alice'] }));
    const result = await listStaffRemoteComputers(principal);
    expect(result.devices).toHaveLength(50); expect(result.nextCursor).toBe('49');
    expect(result.devices[0]).toMatchObject({ currentUser: null, previousUsers: ['Alice'],
      transports: { rustdesk: { available: false }, webrtc: { available: false } } });
  });
});
