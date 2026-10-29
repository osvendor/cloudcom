import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ revalidate: vi.fn(), permission: vi.fn(), access: vi.fn(), tenant: vi.fn(),
  select: vi.fn(), join: vi.fn(), where: vi.fn(), limit: vi.fn(), update: vi.fn(), set: vi.fn(), updateWhere: vi.fn(), returning: vi.fn() }));
vi.mock('../db', () => ({ db: { select: m.select, update: m.update } }));
vi.mock('./staffNativeAuthority', () => ({ revalidateStaffNativePrincipal: m.revalidate }));
vi.mock('./permissions', () => ({ hasPermission: m.permission, canAccessOrg: m.access }));
vi.mock('./tenantStatus', () => ({ getActiveOrgTenant: m.tenant }));
import { renameStaffNativeDevice } from './staffNativeDirectory';
import type { StaffNativePrincipal } from './staffNativeAuthority';
const id = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const partnerId = '33333333-3333-4333-8333-333333333333';
const principal = { userId: id, partnerId } as StaffNativePrincipal;
beforeEach(() => {
  vi.resetAllMocks();
  const query = { from: () => query, innerJoin: m.join, where: m.where, limit: m.limit };
  m.select.mockReturnValue(query); m.join.mockReturnValue(query); m.where.mockReturnValue(query);
  m.limit.mockResolvedValue([{ id, orgId, displayName: 'Old' }]);
  m.revalidate.mockResolvedValue({ permissions: { test: 'permissions' } });
  m.permission.mockReturnValue(true); m.access.mockReturnValue(true); m.tenant.mockResolvedValue({ partnerId });
  m.update.mockReturnValue({ set: m.set }); m.set.mockReturnValue({ where: m.updateWhere });
  m.updateWhere.mockReturnValue({ returning: m.returning }); m.returning.mockResolvedValue([{ id, displayName: 'Desk' }]);
});
describe('native viewer custom names', () => {
  it('writes only the alias and timestamp, scoped to both device and org', async () => {
    expect(await renameStaffNativeDevice(principal, id, 'Desk')).toEqual({ id, orgId, displayName: 'Desk', previousName: 'Old' });
    expect(m.revalidate).toHaveBeenCalledWith(principal);
    expect(m.permission).toHaveBeenCalledWith({ test: 'permissions' }, 'devices', 'write');
    expect(m.set).toHaveBeenCalledWith({ displayName: 'Desk', updatedAt: expect.any(Date) });
    const dialect = new PgDialect();
    const where = dialect.sqlToQuery(m.updateWhere.mock.calls[0]![0]);
    expect(where.params).toEqual([id, orgId]);
    const join = dialect.sqlToQuery(m.join.mock.calls[0]![1]);
    expect(join.params).toContain(partnerId);
  });
  it.each(['permission', 'org', 'tenant', 'missing', 'revoked'])('denies %s without a write', async reason => {
    if (reason === 'permission') m.permission.mockReturnValue(false);
    if (reason === 'org') m.access.mockReturnValue(false);
    if (reason === 'tenant') m.tenant.mockResolvedValue({ partnerId: 'other' });
    if (reason === 'missing') m.limit.mockResolvedValue([]);
    if (reason === 'revoked') m.revalidate.mockRejectedValue(new Error('revoked'));
    await expect(renameStaffNativeDevice(principal, id, 'Desk')).rejects.toThrow();
    expect(m.update).not.toHaveBeenCalled();
  });
  it('can clear an alias without requiring an online desktop', async () => {
    await renameStaffNativeDevice(principal, id, null);
    expect(m.set).toHaveBeenCalledWith({ displayName: null, updatedAt: expect.any(Date) });
  });
});
