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
  const authorize = vi.fn(async (_request: unknown, _organizationId: string, _operation: string) => ({ actorId } as { actorId: string } | null));
  const loadConnection = vi.fn(async () => connection);
  const acquireToken = vi.fn(async () => `h.${Buffer.from(JSON.stringify({ roles: ['User-PasswordProfile.ReadWrite.All', 'User.RevokeSessions.All'] })).toString('base64url')}.s`);
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
  it('authorizes, audits, and fences one typed group creation write', async () => {
    const s = setup();
    s.acquireToken.mockResolvedValue(`h.${Buffer.from(JSON.stringify({ roles: ['Group.ReadWrite.All', 'User.ReadWrite.All'] })).toString('base64url')}.s`);
    s.fetch.mockImplementation(async (url, init) => {
      if (url.includes('/organization?')) return Response.json({ value: [{ id: tenantId }] });
      if (url.includes(`/users/${actorId}?`)) return Response.json({ id: actorId });
      if (url.endsWith('/groups') && init.method === 'POST') return Response.json({ id }, { status: 201 });
      if (url.includes(`/groups/${id}?`)) return Response.json({ id, displayName: 'Ops', mailEnabled: true, securityEnabled: false, groupTypes: ['Unified'], onPremisesSyncEnabled: null, isAssignableToRole: false });
      if (url.includes(`/groups/${id}/owners?`)) return Response.json({ value: [{ id: actorId }] });
      throw new Error(`Unexpected ${url}`);
    });
    await expect(s.run(request, orgId, { type: 'group.create', group: { displayName: 'Ops', mailNickname: 'ops', ownerId: actorId } }))
      .resolves.toMatchObject({ accepted: true, id, verified: true });
    expect(s.audit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ phase: 'intent', operation: 'group.create', changedFields: ['displayName', 'mailNickname', 'owners'] }),
      expect.objectContaining({ phase: 'outcome', operation: 'group.create', outcome: 'success' }),
    ]);
    expect(s.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
  });
  it('fences and audits read-only service health without dispatching writes', async () => {
    const s = setup();
    s.acquireToken.mockResolvedValue(`h.${Buffer.from(JSON.stringify({ roles: ['ServiceHealth.Read.All'] })).toString('base64url')}.s`);
    s.fetch.mockImplementation(async url => url.includes('/organization?')
      ? Response.json({ value: [{ id: tenantId }] })
      : Response.json({ value: [{ id: 'Exchange Online', service: 'Exchange Online', status: 'serviceOperational' }] }));
    await expect(s.run(request, orgId, { type: 'service.health.get' }))
      .resolves.toMatchObject({ services: [{ service: 'Exchange Online' }], partial: false });
    expect(s.authorize).toHaveBeenCalledWith(request, orgId, 'service.health.get');
    expect(s.audit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ phase: 'intent', operation: 'service.health.get', changedFields: [] }),
      expect.objectContaining({ phase: 'outcome', operation: 'service.health.get', outcome: 'success' }),
    ]);
    expect(s.fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });
  it('creates a user with manager authorization, audit fencing, and no password in audit events', async () => {
    const s = setup();
    s.acquireToken.mockResolvedValue(`h.${Buffer.from(JSON.stringify({ roles: ['User.ReadWrite.All'] })).toString('base64url')}.s`);
    s.fetch.mockImplementation(async (url, init) => {
      if (url.includes('/organization?$select=id,verifiedDomains')) return Response.json({ value: [{ id: tenantId, verifiedDomains: [{ name: 'example.test', isVerified: true }] }] });
      if (url.includes('/organization?')) return Response.json({ value: [{ id: tenantId }] });
      if (url.endsWith('/users') && init.method === 'POST') return Response.json({ id, userPrincipalName: 'new@example.test' }, { status: 201 });
      throw new Error(`Unexpected ${url}`);
    });
    const result = await s.run(request, orgId, { type: 'user.create', user: { displayName: 'New User', userPrincipalName: 'new@example.test' } });
    expect(result).toMatchObject({ accepted: true, id, userPrincipalName: 'new@example.test', forceChangePasswordNextSignIn: true });
    expect(s.authorize.mock.calls.every(([, , operation]) => operation === 'user.create')).toBe(true);
    expect(s.audit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ phase: 'intent', operation: 'user.create', changedFields: ['displayName', 'userPrincipalName', 'passwordProfile'] }),
      expect.objectContaining({ phase: 'outcome', operation: 'user.create', outcome: 'success' }),
    ]);
    expect(JSON.stringify(s.audit.mock.calls)).not.toContain((result as { temporaryPassword: string }).temporaryPassword);
    expect(s.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
  });
  it('rejects injected create properties before authorization', async () => {
    const s = setup();
    await expect(s.run(request, orgId, { type: 'user.create', user: { displayName: 'A', userPrincipalName: 'a@example.test', roles: ['admin'] } }))
      .rejects.toMatchObject({ code: 'invalid_operation' });
    expect(s.authorize).not.toHaveBeenCalled();
  });
  it('audits a separate license assignment with the same org and connection fences', async () => {
    const s = setup();
    const skuId = '55555555-5555-4555-8555-555555555555';
    s.acquireToken.mockResolvedValue(`h.${Buffer.from(JSON.stringify({ roles: ['LicenseAssignment.ReadWrite.All'] })).toString('base64url')}.s`);
    s.fetch.mockImplementation(async (url, init) => {
      if (url.includes('/organization?')) return Response.json({ value: [{ id: tenantId }] });
      if (url.includes('/subscribedSkus?')) return Response.json({ value: [{ id: 'sku', skuId, skuPartNumber: 'O365_BUSINESS_PREMIUM', consumedUnits: 0, capabilityStatus: 'Enabled', prepaidUnits: { enabled: 1, suspended: 0, warning: 0 } }] });
      if (url.includes('/assignLicense')) return Response.json({ id });
      if (url.includes('?$select=id,assignedLicenses') && init.method === 'GET') return Response.json({ id, assignedLicenses: [{ skuId }] });
      if (url.includes('?$select=id,usageLocation,assignedLicenses')) return Response.json({ id, usageLocation: 'GB', assignedLicenses: [] });
      throw new Error(`Unexpected ${url}`);
    });
    await expect(s.run(request, orgId, { type: 'user.license.assign', id, license: { skuId } }))
      .resolves.toEqual({ accepted: true, changed: true, verified: true });
    expect(s.audit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ phase: 'intent', operation: 'user.license.assign', targets: { userId: id, licenseSkuId: skuId }, changedFields: ['assignedLicenses'] }),
      expect.objectContaining({ phase: 'outcome', outcome: 'success', changedFields: ['assignedLicenses'] }),
    ]);
    expect(s.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
  });
  it('rejects arbitrary license assignment data before authorization', async () => {
    const s = setup();
    await expect(s.run(request, orgId, { type: 'user.license.assign', id, license: { skuId: id, disabledPlans: [] } }))
      .rejects.toMatchObject({ code: 'invalid_operation' });
    expect(s.authorize).not.toHaveBeenCalled();
  });
  it('audits accepted but unverified license assignment as unknown without a second write', async () => {
    const s = setup();
    const skuId = '55555555-5555-4555-8555-555555555555';
    s.acquireToken.mockResolvedValue(`h.${Buffer.from(JSON.stringify({ roles: ['User.ReadWrite.All'] })).toString('base64url')}.s`);
    s.fetch.mockImplementation(async (url, init) => {
      if (url.includes('/organization?')) return Response.json({ value: [{ id: tenantId }] });
      if (url.includes('?$select=id,usageLocation,assignedLicenses')) return Response.json({ id, usageLocation: 'CA', assignedLicenses: [] });
      if (url.includes('/subscribedSkus?')) return Response.json({ value: [{ id: 'sku', skuId, skuPartNumber: 'O365_BUSINESS_PREMIUM', consumedUnits: 0, capabilityStatus: 'Enabled', prepaidUnits: { enabled: 1, suspended: 0, warning: 0 } }] });
      if (url.includes('/assignLicense')) return Response.json({ id });
      if (url.includes('?$select=id,assignedLicenses')) return Response.json({ id, assignedLicenses: [] });
      throw new Error(`Unexpected ${init.method} ${url}`);
    });
    await expect(s.run(request, orgId, { type: 'user.license.assign', id, license: { skuId } }))
      .resolves.toEqual({ accepted: true, changed: true, verified: false });
    expect(s.audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'unknown' }));
    expect(s.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
  });
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
  it('reads the fixed Global Administrator state without dispatching a mutation', async () => {
    const s = setup();
    const role = '62e90394-69f5-4237-9190-012177145e10';
    s.fetch.mockImplementation(async (url, init) => {
      if (url.includes('/organization?')) return Response.json({ value: [{ id: tenantId }] });
      if (url.includes('/roleManagement/directory/roleAssignments'))
        return Response.json({ value: [{ id, principalId: id, roleDefinitionId: role, directoryScopeId: '/' }] });
      return Response.json({ id, displayName: 'Fixture' });
    });
    await expect(s.run(request, orgId, { type: 'user.globalAdmin.get', id })).resolves.toEqual({ enabled: true });
    expect(s.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
    expect(s.audit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ phase: 'intent', operation: 'user.globalAdmin.get', changedFields: [] }),
      expect.objectContaining({ phase: 'outcome', outcome: 'success', changedFields: [] }),
    ]);
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
  it('requires the explicit Global Administrator confirmation before authorization', async () => {
    const s = setup();
    await expect(s.run(request, orgId, { type: 'user.globalAdmin.set', id, enabled: true, confirmation: 'yes' }))
      .rejects.toMatchObject({ code: 'invalid_operation' });
    expect(s.authorize).not.toHaveBeenCalled(); expect(s.acquireToken).not.toHaveBeenCalled();
  });
  it('requires an explicit confirmation and typed UUID input before authorizing MFA-method removal', async () => {
    const s = setup();
    await expect(s.run(request, orgId, { type: 'user.mfa.method.remove', id, kind: 'phone', methodId: actorId, confirmation: 'remove' }))
      .rejects.toMatchObject({ code: 'invalid_operation' });
    await expect(s.run(request, orgId, { type: 'user.mfa.method.remove', id, kind: 'email', methodId: actorId, confirmation: 'REMOVE_AUTH_METHOD' }))
      .rejects.toMatchObject({ code: 'invalid_operation' });
    expect(s.authorize).not.toHaveBeenCalled(); expect(s.acquireToken).not.toHaveBeenCalled();
  });
  it('lists sanitized MFA methods as a read and audits no method detail', async () => {
    const s = setup();
    s.acquireToken.mockResolvedValue(`h.${Buffer.from(JSON.stringify({ roles: ['UserAuthenticationMethod.Read.All'] })).toString('base64url')}.s`);
    s.fetch.mockImplementation(async (url, init) => {
      if (url.includes('/organization?')) return Response.json({ value: [{ id: tenantId }] });
      if (url.includes('/authentication/methods')) return Response.json({ value: [{ id: actorId, '@odata.type': '#microsoft.graph.phoneAuthenticationMethod', phoneType: 'mobile', phoneNumber: '+1 555 123 4567', secret: 'never' }] });
      throw new Error(`unexpected ${init.method} ${url}`);
    });
    await expect(s.run(request, orgId, { type: 'user.mfa.methods.list', id })).resolves.toEqual({
      items: [{ id: actorId, type: 'phone', detail: 'mobile ending 4567', removable: true }],
    });
    expect(s.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
    expect(s.audit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ phase: 'intent', operation: 'user.mfa.methods.list', targets: { userId: id }, changedFields: [] }),
      expect.objectContaining({ phase: 'outcome', outcome: 'success', targets: { userId: id }, changedFields: [] }),
    ]);
    expect(JSON.stringify(s.audit.mock.calls)).not.toMatch(/4567|secret/);
  });
  it('fences and audits one typed MFA removal without recording method details', async () => {
    const s = setup();
    const methodId = actorId;
    s.acquireToken.mockResolvedValue(`h.${Buffer.from(JSON.stringify({ roles: ['UserAuthenticationMethod.ReadWrite.All'] })).toString('base64url')}.s`);
    s.fetch.mockImplementation(async (url, init) => {
      if (init.method !== 'GET') return new Response(null, { status: 204 });
      if (url.includes('/organization?')) return Response.json({ value: [{ id: tenantId }] });
      if (url.includes('/authentication/methods')) return Response.json({ value: [{ id: methodId, '@odata.type': '#microsoft.graph.phoneAuthenticationMethod', phoneType: 'mobile', phoneNumber: '+1 555 123 4567' }] });
      throw new Error(`unexpected ${init.method} ${url}`);
    });
    await expect(s.run(request, orgId, { type: 'user.mfa.method.remove', id, kind: 'phone', methodId, confirmation: 'REMOVE_AUTH_METHOD' }))
      .resolves.toEqual({ accepted: true });
    expect(s.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
    expect(s.audit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ phase: 'intent', operation: 'user.mfa.method.remove', targets: { userId: id, methodKind: 'phone', methodId }, changedFields: ['authenticationMethod'] }),
      expect.objectContaining({ phase: 'outcome', outcome: 'success', targets: { userId: id, methodKind: 'phone', methodId }, changedFields: ['authenticationMethod'] }),
    ]);
    expect(JSON.stringify(s.audit.mock.calls)).not.toMatch(/4567|REMOVE_AUTH_METHOD/);
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
  it.each([
    { type: 'user.password.reset', expected: ['passwordProfile'] },
    { type: 'user.sessions.revoke', expected: ['signInSessions'] },
  ])('audits $type without secrets and dispatches exactly one mutation', async ({ type, expected }) => {
    const s = setup();
    s.fetch.mockImplementation(async (url, init) => {
      if (init.method !== 'GET') return Response.json({ accepted: true, temporaryPassword: 'never-in-audit' }, { status: 200 });
      if (url.includes('/organization?')) return Response.json({ value: [{ id: tenantId }] });
      return Response.json({ id, displayName: 'Fixture' });
    });
    const result = await s.run(request, orgId, { type, id });
    expect(result).toMatchObject({ accepted: true });
    if (type === 'user.password.reset') expect(result).toMatchObject({ forceChangePasswordNextSignIn: true, temporaryPassword: expect.any(String) });
    expect(s.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
    expect(s.audit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ phase: 'intent', changedFields: expected }),
      expect.objectContaining({ phase: 'outcome', outcome: 'success', changedFields: expected }),
    ]);
    expect(JSON.stringify(s.audit.mock.calls)).not.toContain('never-in-audit');
  });
  it('reports audit failure after an accepted write without retrying the write', async () => {
    const s = setup(); s.audit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('internal'));
    await expect(s.run(request, orgId, { type: 'user.update', id, update: { displayName: 'Changed' } }))
      .rejects.toMatchObject({ code: 'unknown_write_outcome' });
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });
  it('audits a Global Administrator elevation without recording its confirmation and dispatches only one write', async () => {
    const s = setup();
    s.acquireToken.mockResolvedValue(`h.${Buffer.from(JSON.stringify({ roles: ['RoleManagement.ReadWrite.Directory'] })).toString('base64url')}.s`);
    const otherAdmin = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const role = '62e90394-69f5-4237-9190-012177145e10';
    let assignmentReads = 0;
    s.fetch.mockImplementation(async (url, init) => {
      if (init.method !== 'GET') return Response.json({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, { status: 201 });
      if (url.includes('/organization?')) return Response.json({ value: [{ id: tenantId }] });
      if (url.includes('/roleManagement/directory/roleAssignments')) {
        assignmentReads += 1;
        return Response.json({ value: assignmentReads === 1
          ? [{ id: otherAdmin, principalId: otherAdmin, roleDefinitionId: role, directoryScopeId: '/' }]
          : [{ id: otherAdmin, principalId: otherAdmin, roleDefinitionId: role, directoryScopeId: '/' }, { id, principalId: id, roleDefinitionId: role, directoryScopeId: '/' }] });
      }
      return Response.json({ id, displayName: 'Fixture' });
    });
    await expect(s.run(request, orgId, { type: 'user.globalAdmin.set', id, enabled: true, confirmation: 'GLOBAL_ADMIN' }))
      .resolves.toEqual({ accepted: true, changed: true, enabled: true });
    expect(s.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
    expect(s.audit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ phase: 'intent', operation: 'user.globalAdmin.set', changedFields: ['globalAdministrator'] }),
      expect.objectContaining({ phase: 'outcome', outcome: 'success', changedFields: ['globalAdministrator'] }),
    ]);
    expect(JSON.stringify(s.audit.mock.calls)).not.toContain('GLOBAL_ADMIN');
  });
});
