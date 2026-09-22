import { describe, expect, it, vi } from 'vitest';
import { createAdministrationExecutor, type AdministrationConnection } from './admin-execution';

const orgId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const tenantId = '33333333-3333-4333-8333-333333333333';
const id = '44444444-4444-4444-8444-444444444444';
const request = Object.freeze({ authenticated: true });
function setup() {
  let connection: AdministrationConnection | null = {
    id, orgId, tenantId, clientId: actorId, enabled: true, generation: 1,
    credentialVersion: 'cert-1', permissionManifestVersion: 'standard-1',
  };
  const authorize = vi.fn(async () => ({ actorId } as { actorId: string } | null));
  const loadConnection = vi.fn(async () => connection);
  const acquireToken = vi.fn(async () => 'private-token');
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method !== 'GET') return new Response(null, { status: 204 });
    if (url.includes('/organization?')) return Response.json({ value: [{ id: tenantId }] });
    return Response.json({ value: [{ id, displayName: 'Fixture' }] });
  });
  const audit = vi.fn(async (_event: unknown) => {});
  return { authorize, loadConnection, acquireToken, fetch, audit,
    run: createAdministrationExecutor({ authorize, loadConnection, acquireToken, fetch, audit }),
    change: (update: Partial<AdministrationConnection>) => { connection = { ...connection!, ...update }; },
    disconnect: () => { connection = null; },
  };
}
describe('organization-bound Microsoft administration execution', () => {
  it('binds credentials to the server snapshot and passes the authenticated request to authorization', async () => {
    const s = setup();
    expect(await s.run(request, orgId, { type: 'users.list' })).toMatchObject({ items: [{ id }], partial: false });
    expect(s.authorize).toHaveBeenCalledWith(request, orgId, 'users.list');
    expect(s.acquireToken).toHaveBeenCalledWith(expect.objectContaining({ orgId, tenantId, credentialVersion: 'cert-1' }));
    expect(s.audit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ phase: 'intent', actorId, orgId }),
      expect.objectContaining({ phase: 'outcome', outcome: 'success' }),
    ]);
    expect((s.audit.mock.calls[0]![0] as { executionId: string }).executionId)
      .toBe((s.audit.mock.calls[1]![0] as { executionId: string }).executionId);
  });
  it.each([
    { type: 'users.list', tenantId },
    { type: 'user.update', id, update: { passwordProfile: { password: 'never-send' } } },
    { type: 'arbitrary.graph', path: '/users' },
  ])('rejects unsupported or injected operation fields before authorization', async input => {
    const s = setup();
    await expect(s.run(request, orgId, input)).rejects.toMatchObject({ code: 'invalid_operation' });
    expect(s.authorize).not.toHaveBeenCalled(); expect(s.acquireToken).not.toHaveBeenCalled();
  });
  it('denies unauthorized callers before reading a connection or credential', async () => {
    const s = setup(); s.authorize.mockResolvedValue(null);
    await expect(s.run(request, orgId, { type: 'users.list' })).rejects.toMatchObject({ code: 'access_denied' });
    expect(s.loadConnection).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled();
  });
  it('rejects a cross-organization connection even if a store returns one', async () => {
    const s = setup(); s.change({ orgId: actorId });
    await expect(s.run(request, orgId, { type: 'users.list' })).rejects.toMatchObject({ code: 'connection_not_ready' });
    expect(s.acquireToken).not.toHaveBeenCalled();
  });
  it('does not contact Microsoft if audit intent fails', async () => {
    const s = setup(); s.audit.mockRejectedValue(new Error('private database details'));
    await expect(s.run(request, orgId, { type: 'user.update', id, update: { displayName: 'Changed' } }))
      .rejects.toMatchObject({ code: 'audit_unavailable' });
    expect(s.acquireToken).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled();
  });
  it.each(['generation', 'credentialVersion', 'permissionManifestVersion', 'tenantId'] as const)(
    'prevents a write after %s changes during identity verification', async field => {
      const s = setup();
      s.fetch.mockImplementation(async () => {
        s.change({ [field]: field === 'generation' ? 2 : field === 'tenantId' ? actorId : 'version-2' });
        return Response.json({ value: [{ id: tenantId }] });
      });
      await expect(s.run(request, orgId, { type: 'user.update', id, update: { displayName: 'Changed' } })).rejects.toMatchObject({ code: 'connection_changed' });
      expect(s.fetch).toHaveBeenCalledTimes(1);
      expect(s.audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'rejected' }));
    });
  it('checks permission again after identity verification and before the mutation', async () => {
    const s = setup();
    s.fetch.mockImplementation(async () => {
      s.authorize.mockResolvedValue(null);
      return Response.json({ value: [{ id: tenantId }] });
    });
    await expect(s.run(request, orgId, { type: 'user.update', id, update: { accountEnabled: false } })).rejects.toMatchObject({ code: 'access_denied' });
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });
  it('discards a read after disconnect instead of returning the old tenant data', async () => {
    const s = setup();
    s.fetch.mockImplementation(async url => {
      if (url.includes('/organization?')) return Response.json({ value: [{ id: tenantId }] });
      s.disconnect(); return Response.json({ value: [{ id, displayName: 'Do not return' }] });
    });
    await expect(s.run(request, orgId, { type: 'users.list' })).rejects.toMatchObject({ code: 'connection_changed' });
  });
  it('reports a dispatched write as uncertain after disconnect and never retries it', async () => {
    const s = setup();
    s.fetch.mockImplementation(async (_url, init) => {
      if (init.method === 'GET') return Response.json({ value: [{ id: tenantId }] });
      s.disconnect(); return new Response(null, { status: 204 });
    });
    await expect(s.run(request, orgId, { type: 'user.update', id, update: { displayName: 'Private name' } }))
      .rejects.toMatchObject({ code: 'unknown_write_outcome' });
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'unknown' }));
    expect(s.audit).toHaveBeenLastCalledWith(expect.objectContaining({ targets: { userId: id }, changedFields: ['displayName'] }));
    expect(JSON.stringify(s.audit.mock.calls)).not.toContain('Private name');
    expect(JSON.stringify(s.audit.mock.calls)).not.toContain('private-token');
  });
  it('reports audit failure after an accepted write without retrying the write', async () => {
    const s = setup(); s.audit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('internal'));
    await expect(s.run(request, orgId, { type: 'user.update', id, update: { displayName: 'Changed' } }))
      .rejects.toMatchObject({ code: 'unknown_write_outcome' });
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });
});
