import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({
  execute: vi.fn(), authorize: vi.fn(), permissions: vi.fn(), encrypt: vi.fn(), audit: vi.fn(),
  scope: vi.fn(async (_auth: unknown, work: () => Promise<unknown>) => work()),
}));
vi.mock('../db', () => ({ db: { execute: state.execute } }));
vi.mock('../middleware/auth', () => ({ withAuthDbAccessContext: state.scope }));
vi.mock('../services/permissions', () => ({ getUserPermissions: state.permissions,
  hasPermission: (permissions: { rights: string[] }, resource: string, action: string) => permissions.rights.includes(`${resource}.${action}`),
}));
vi.mock('../services/secretCrypto', () => ({ encryptSecret: state.encrypt }));
vi.mock('../services/auditService', () => ({ createAuditLog: state.audit }));
vi.mock('./cloudCommandAdminAuthorization', () => ({ authorizeCloudCommandAdministration: state.authorize }));
vi.mock('@cloudcom/ext-credentials', () => ({ generateCredentialPassword: () => 'Maple!Fox27' }));

import { cloudCommandCredentialCapture as capture } from './cloudCommandCredentialCapture';
const orgId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const executionId = '33333333-3333-4333-8333-333333333333';
const connectionId = '44444444-4444-4444-8444-444444444444';
const tenantId = '55555555-5555-4555-8555-555555555555';
const providerUserId = '66666666-6666-4666-8666-666666666666';
const request = { orgId, auth: { user: { id: actorId }, scope: 'organization', orgId }, authorization: {} } as any;
const base = { executionId, connectionId, tenantId, username: 'Person@example.test' };
const prepared = { ...base, password: 'Maple!Fox27', temporaryPassword: true };
const completed = { ...base, providerUserId };
const queries = () => state.execute.mock.calls.map(([value]) => new PgDialect().sqlToQuery(value));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CLOUDCOM_CREDENTIALS_ENABLED', 'true');
  state.scope.mockImplementation(async (_auth, work) => work());
  state.authorize.mockResolvedValue({ actorId });
  state.permissions.mockResolvedValue({ rights: ['credentials.import', 'credentials.read'], scope: 'organization', orgId });
  state.encrypt.mockReturnValue('enc:v3:fixture');
  state.audit.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('Microsoft credential capture host boundary', () => {
  it('encrypts a caller-scoped draft before returning and audits no password', async () => {
    state.execute.mockResolvedValueOnce([{ id: connectionId }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: executionId }]);
    await capture.prepare(request, prepared);
    expect(state.authorize).toHaveBeenCalledWith(request, orgId, true);
    expect(state.scope).toHaveBeenCalledWith(request.auth, expect.any(Function));
    expect(state.permissions).toHaveBeenCalledWith(actorId, { scope: 'organization', orgId, partnerId: undefined }, { bypassCache: true });
    expect(state.encrypt).toHaveBeenCalledWith(JSON.stringify({ version: 1, orgId, id: executionId,
      password: prepared.password, otpSecret: '', notes: '' }), { aad: `credentials_records.secret_ciphertext:${executionId}` });
    const [connection, archive, insert] = queries();
    expect(archive!.sql).toContain("creation_state='rejected' AND archived=false");
    expect(connection!.sql).toMatch(/WHERE org_id=.*AND id=.*AND tenant_id=.*AND enabled=true/);
    expect(connection!.params).toEqual([orgId, connectionId, tenantId]);
    expect(insert!.sql).toContain('ON CONFLICT (org_id,source_organization,source_id) DO NOTHING');
    expect(insert!.params).toContain('enc:v3:fixture');
    expect(insert!.params).not.toContain(prepared.password);
    expect(insert!.params).toContain(`microsoft:${tenantId}`);
    expect(insert!.params).toContain('person@example.test');
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ orgId, actorId,
      action: 'credentials.microsoft.prepared', resourceId: executionId }));
    expect(JSON.stringify(state.audit.mock.calls)).not.toContain(prepared.password);
  });
  it.each(['disabled', 'authorization', 'import', 'read', 'site-ceiling'])('does not insert when %s is denied', async reason => {
    if (reason === 'disabled') vi.stubEnv('CLOUDCOM_CREDENTIALS_ENABLED', 'false');
    if (reason === 'authorization') state.authorize.mockResolvedValue(null);
    if (reason === 'import') state.permissions.mockResolvedValue({ rights: ['credentials.read'] });
    if (reason === 'read') state.permissions.mockResolvedValue({ rights: ['credentials.import'] });
    if (reason === 'site-ceiling') state.permissions.mockResolvedValue({ rights: ['credentials.import', 'credentials.read'], allowedSiteIds: [] });
    await expect(capture.prepare(request, prepared)).rejects.toThrow();
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.encrypt).not.toHaveBeenCalled();
    expect(state.audit).not.toHaveBeenCalled();
  });
  it('rejects a missing same-organization, same-tenant enabled connection before encryption', async () => {
    state.execute.mockResolvedValueOnce([]);
    await expect(capture.prepare(request, prepared)).rejects.toThrow('Credential connection changed');
    expect(queries()[0]!.params).toEqual([orgId, connectionId, tenantId]);
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.encrypt).not.toHaveBeenCalled();
  });
  it.each([
    { scope: 'organization', orgId: actorId },
    { scope: 'partner', orgAccess: 'selected', allowedOrgIds: [actorId] },
    { scope: 'partner', orgAccess: 'none' },
  ])('rejects a freshly revoked organization grant before querying the connection: %j', async permissionScope => {
    state.permissions.mockResolvedValue({ rights: ['credentials.import', 'credentials.read'], ...permissionScope });
    await expect(capture.prepare(request, prepared)).rejects.toThrow('Credential capture denied');
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.encrypt).not.toHaveBeenCalled();
  });
  it('rejects an existing credential without rewriting its password', async () => {
    state.execute.mockResolvedValueOnce([{ id: connectionId }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(capture.prepare(request, prepared)).rejects.toThrow('already exists');
    expect(state.execute).toHaveBeenCalledTimes(3);
    expect(queries()[1]!.sql).not.toContain('secret_ciphertext');
    expect(state.audit).not.toHaveBeenCalled();
  });
  it('rejects plaintext or unavailable encryption before an insert', async () => {
    state.execute.mockResolvedValueOnce([{ id: connectionId }]);
    state.encrypt.mockReturnValue('plaintext');
    await expect(capture.prepare(request, prepared)).rejects.toThrow('Credential encryption unavailable');
    expect(state.execute).toHaveBeenCalledTimes(1);
  });
  it('completes only a matching untouched pending draft without rewriting secrets', async () => {
    state.execute.mockResolvedValueOnce([{ id: connectionId }]).mockResolvedValueOnce([{ id: executionId }]);
    await capture.complete(request, completed);
    const update = queries()[1]!;
    expect(update.sql).toContain("creation_state='pending' AND version=1 AND archived=false");
    expect(update.sql).toContain('version=version+1');
    expect(update.params).toEqual([providerUserId, orgId, executionId, `microsoft:${tenantId}`, 'person@example.test']);
    expect(update.sql).not.toContain('secret_ciphertext');
    expect(state.encrypt).not.toHaveBeenCalled();
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'credentials.microsoft.completed', orgId, resourceId: executionId }));
  });
  it('accepts an already completed matching operation without another successful update', async () => {
    state.execute.mockResolvedValueOnce([{ id: connectionId }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: executionId }]);
    await capture.complete(request, completed);
    const prior = queries()[2]!;
    expect(prior.sql).toContain("creation_state='accepted'");
    expect(prior.params).toEqual([orgId, executionId, providerUserId, `microsoft:${tenantId}`, 'person@example.test']);
    expect(state.execute).toHaveBeenCalledTimes(3);
    expect(state.encrypt).not.toHaveBeenCalled();
  });
  it('refuses unmatched, edited, archived or foreign completion instead of upserting', async () => {
    state.execute.mockResolvedValueOnce([{ id: connectionId }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(capture.complete(request, completed)).rejects.toThrow('requires review');
    expect(queries().some(q => /\bINSERT\b/.test(q.sql))).toBe(false);
    expect(state.audit).not.toHaveBeenCalled();
  });
  it('awaits a durable audit failure rather than claiming capture succeeded', async () => {
    state.execute.mockResolvedValueOnce([{ id: connectionId }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: executionId }]);
    state.audit.mockRejectedValue(new Error('audit unavailable'));
    await expect(capture.prepare(request, prepared)).rejects.toThrow('audit unavailable');
  });
  it('rejects injected completion secrets before authorization', async () => {
    await expect(capture.complete(request, { ...completed, password: 'injected' } as never)).rejects.toThrow();
    expect(state.authorize).not.toHaveBeenCalled();
    expect(state.execute).not.toHaveBeenCalled();
  });
});
