import { describe, expect, it, vi } from 'vitest';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';
import type { MicrosoftRequest } from './native-microsoft';
import { createAdministrationServices } from './admin-services';

const { store } = vi.hoisted(() => ({ store: { load: vi.fn(), start: vi.fn(), claim: vi.fn(), advance: vi.fn(), finish: vi.fn(), save: vi.fn(), disable: vi.fn() } }));
vi.mock('./admin-store', () => ({ createAdministrationStore: () => store }));
const org = '11111111-1111-4111-8111-111111111111', actor = '22222222-2222-4222-8222-222222222222';
const tenant = '33333333-3333-4333-8333-333333333333', client = '44444444-4444-4444-8444-444444444444';
const request = { orgId: org, auth: {}, authorization: {} } as MicrosoftRequest;
function setup() {
  for (const fn of Object.values(store)) fn.mockReset();
  store.load.mockResolvedValue(null); store.advance.mockResolvedValue(true); store.save.mockResolvedValue(true);
  const runtime = {
    configuration: vi.fn(async () => ({ clientId: client, credentialVersion: 'cert-1', redirectUri: 'https://app.example.com/extensions/cloudcommand/connect' })),
    authorize: vi.fn(async (_request: MicrosoftRequest, _orgId: string, _mutation: boolean) => ({ actorId: actor } as { actorId: string } | null)),
    audit: vi.fn(async () => {}),
    acquireToken: vi.fn(async () => `header.${Buffer.from(JSON.stringify({ roles: ['Organization.Read.All', 'User.ReadWrite.All', 'Group.ReadWrite.All', 'User.EnableDisableAccount.All'] })).toString('base64url')}.signature`),
    verifyAuthorization: vi.fn(async () => ({ tenantId: tenant, administratorObjectId: actor })),
    exchange: vi.fn(async (): Promise<any> => null),
  };
  const context = { secrets: { encryptForColumn: vi.fn(() => 'enc:v3:opaque'), decryptForColumn: vi.fn(() => 'verifier') } } as unknown as ExtensionRuntimeContext;
  const fetch = vi.fn(async () => Response.json({ value: [{ id: tenant, displayName: 'Fixture tenant' }] }));
  const services = createAdministrationServices(context, fetch, runtime);
  return { runtime, context, fetch, services, admin: services.administration! };
}
function attempt() { return { org_id: org, actor_id: actor, tenant_id: tenant, client_id: client, credential_version: 'cert-1',
  expected_generation: null, nonce: 'nonce', verifier_ciphertext: 'enc:v3:opaque', state_hash: 'hashed', stage: 'processing' }; }
describe('unified administration onboarding', () => {
  it.each(['user.create', 'user.license.assign', 'user.update', 'user.password.reset', 'user.sessions.revoke', 'user.globalAdmin.get', 'user.globalAdmin.set',
    'user.mfa.methods.list', 'user.mfa.method.remove', 'group.member.add'])(
    'requires manager authorization for %s before credential access', async type => {
      const h = setup();
      h.runtime.authorize.mockImplementation(async (_request, _orgId, mutation) => mutation ? null : { actorId: actor });
      const input = type === 'user.create' ? { type, user: { displayName: 'New User', userPrincipalName: 'new@example.test' } }
        : type === 'user.license.assign' ? { type, id: actor, license: { skuId: actor } }
        : type === 'user.update' ? { type, id: actor, update: { displayName: 'Changed' } }
        : type === 'user.globalAdmin.set' ? { type, id: actor, enabled: true, confirmation: 'GLOBAL_ADMIN' }
        : type === 'user.mfa.methods.list' || type === 'user.globalAdmin.get' ? { type, id: actor }
        : type === 'user.mfa.method.remove' ? { type, id: actor, kind: 'phone', methodId: actor, confirmation: 'REMOVE_AUTH_METHOD' }
        : type === 'group.member.add' ? { type, groupId: actor, userId: actor } : { type, id: actor };
      await expect(h.admin.execute(request, input)).rejects.toMatchObject({ code: 'access_denied' });
      expect(h.runtime.authorize).toHaveBeenCalledWith(request, org, true);
      expect(h.runtime.acquireToken).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
    });
  it('starts one tenant-bound consent using encrypted PKCE state and server configuration', async () => {
    const h = setup();
    const result = await h.admin.start(request, { tenantId: tenant, version: null }) as { authorizationUrl: string };
    const url = new URL(result.authorizationUrl);
    expect(url.pathname).toBe(`/${tenant}/adminconsent`);
    expect(url.searchParams.get('client_id')).toBe(client);
    expect(store.start).toHaveBeenCalledWith(expect.objectContaining({ org_id: org, actor_id: actor, tenant_id: tenant, expected_generation: null, verifier_ciphertext: 'enc:v3:opaque' }));
    expect(store.start.mock.calls[0][0].state_hash).not.toBe(url.searchParams.get('state'));
  });
  it('rejects stale onboarding and nonmanagers before replacing consent state', async () => {
    const h = setup(); store.load.mockResolvedValue({ generation: 2 });
    await expect(h.admin.start(request, { tenantId: tenant, version: 1 })).rejects.toMatchObject({ code: 'connection_changed' });
    expect(store.start).not.toHaveBeenCalled();
    h.runtime.authorize.mockResolvedValue(null);
    await expect(h.admin.start(request, { tenantId: tenant, version: 2 })).rejects.toMatchObject({ code: 'access_denied' });
  });
  it('rejects consumed, expired, wrong-user and wrong-org callbacks through scoped atomic claim', async () => {
    const h = setup(); store.claim.mockResolvedValue(null);
    await expect(h.admin.complete(request, { state: 'a'.repeat(43), code: 'code' })).rejects.toMatchObject({ code: 'consent_expired_or_used' });
    expect(store.claim).toHaveBeenCalledWith(org, actor, expect.stringMatching(/^[a-f0-9]{64}$/), 'identity');
    expect(h.runtime.verifyAuthorization).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
  });
  it('never treats an admin_consent query as proof of administrator identity', async () => {
    const h = setup(); store.claim.mockResolvedValue(attempt());
    const result = await h.admin.complete(request, { state: 'a'.repeat(43), adminConsent: true, tenant }) as { authorizationUrl: string };
    const url = new URL(result.authorizationUrl);
    expect(url.pathname).toBe(`/${tenant}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe('nonce');
    expect(store.save).not.toHaveBeenCalled();
  });
  it('rejects a forged tenant or credential rotation during consent', async () => {
    const h = setup(); store.claim.mockResolvedValue(attempt());
    await expect(h.admin.complete(request, { state: 'a'.repeat(43), adminConsent: true, tenant: org })).rejects.toMatchObject({ code: 'consent_rejected' });
    store.claim.mockResolvedValue({ ...attempt(), credential_version: 'old' });
    await expect(h.admin.complete(request, { state: 'b'.repeat(43), code: 'code' })).rejects.toMatchObject({ code: 'consent_rejected' });
    expect(store.save).not.toHaveBeenCalled();
  });
  it('saves only after identity, application permissions and tenant verification', async () => {
    const h = setup(); store.claim.mockResolvedValue(attempt());
    await expect(h.admin.complete(request, { state: 'a'.repeat(43), code: 'code' })).resolves.toEqual({ success: true });
    expect(h.runtime.verifyAuthorization).toHaveBeenCalledWith(expect.objectContaining({ code: 'code', codeVerifier: 'verifier', nonce: 'nonce', tenantId: tenant }));
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: tenant }), 'Fixture tenant');
    expect(store.finish).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.runtime.audit.mock.calls)).not.toContain('verifier');
  });
  it('does not persist a connection when signed administrator identity fails', async () => {
    const h = setup(); store.claim.mockResolvedValue(attempt()); h.runtime.verifyAuthorization.mockRejectedValue(new Error('invalid'));
    await expect(h.admin.complete(request, { state: 'a'.repeat(43), code: 'code' })).rejects.toThrow();
    expect(h.fetch).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
  });
  it('does not mark an inventory-only credential ready for administration', async () => {
    const h = setup(); store.claim.mockResolvedValue(attempt());
    h.runtime.acquireToken.mockResolvedValue(`h.${Buffer.from(JSON.stringify({ roles: ['Organization.Read.All'] })).toString('base64url')}.s`);
    await expect(h.admin.complete(request, { state: 'a'.repeat(43), code: 'code' })).rejects.toMatchObject({ code: 'administration_permissions_missing' });
    expect(store.save).not.toHaveBeenCalled();
  });
  it('does not require optional password-reset and session-revocation roles during the single onboarding step', async () => {
    const h = setup(); store.claim.mockResolvedValue(attempt());
    h.runtime.acquireToken.mockResolvedValue(`h.${Buffer.from(JSON.stringify({ roles: ['Organization.Read.All', 'User.ReadWrite.All', 'Group.ReadWrite.All', 'User.EnableDisableAccount.All'] })).toString('base64url')}.s`);
    await expect(h.admin.complete(request, { state: 'a'.repeat(43), code: 'code' })).resolves.toEqual({ success: true });
    expect(store.save).toHaveBeenCalledOnce();
  });
  it('attaches fixed mailbox inventory to the existing connection and revokes the descriptor on disconnect', async () => {
    const h = setup();
    const row = { id: client, orgId: org, tenantId: tenant, clientId: client, credentialVersion: 'cert-1', permissionManifestVersion: 'business-standard-v1', enabled: true, generation: 3, tenantName: 'Fixture', verifiedAt: null };
    store.load.mockResolvedValue(row);
    const registry = { provision: vi.fn(async () => {}), revoke: vi.fn(async () => {}) };
    const worker = { dispatch: vi.fn(async value => ({ requestId: value.requestId, ok: true, data: { records: [], partial: false, collectedAt: '2026-09-22T00:00:00.000Z' } })) };
    h.runtime.exchange = vi.fn(async () => ({ registry, worker }));
    await expect(h.admin.execute(request, { type: 'mailbox.inventory', pageSize: 10 })).resolves.toMatchObject({ records: [] });
    expect(registry.provision).toHaveBeenCalledWith(expect.objectContaining({ organizationId: org, tenantId: tenant, connectionGeneration: 3 }));
    expect(worker.dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'mailbox.inventory', parameters: { pageSize: 10 } }));
    expect(h.fetch).not.toHaveBeenCalled();
    store.disable.mockResolvedValue(true);
    await expect(h.admin.disconnect(request, { version: 3 })).resolves.toEqual({ success: true });
    expect(registry.revoke).toHaveBeenCalledWith(org);
  });
});
