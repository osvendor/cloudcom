import { describe, expect, it, vi } from 'vitest';
import { createAuthenticationMethodsProvider } from './admin-auth-methods';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PHONE = '3179e48a-750b-4051-897c-87b9720928f7';
const AUTHENTICATOR = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://graph.microsoft.com/v1.0';
const token = (roles: string[]) => `h.${Buffer.from(JSON.stringify({ roles })).toString('base64url')}.s`;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function harness(roles = ['UserAuthenticationMethod.ReadWrite.All']) {
  const fetch = vi.fn().mockResolvedValueOnce(response({ value: [{ id: TENANT }] }));
  const acquireToken = vi.fn().mockResolvedValue(token(roles));
  return { fetch, acquireToken, provider: createAuthenticationMethodsProvider({ tenantId: TENANT, fetch, acquireToken }) };
}
const methods = { value: [
  { id: PHONE, '@odata.type': '#microsoft.graph.phoneAuthenticationMethod', phoneType: 'mobile', phoneNumber: '+1 555 123 4567', secret: 'never' },
  { id: AUTHENTICATOR, '@odata.type': '#microsoft.graph.microsoftAuthenticatorAuthenticationMethod', displayName: 'Ada phone', deviceTag: 'never' },
  { id: 'fido-opaque', '@odata.type': '#microsoft.graph.fido2AuthenticationMethod', publicKey: 'never' },
] };

describe('tenant-bound authentication methods provider', () => {
  it('verifies the app role and tenant before listing, then returns sanitized method summaries only', async () => {
    const h = harness(['UserAuthenticationMethod.Read.All']);
    h.fetch.mockResolvedValueOnce(response(methods));
    const listed = await h.provider.list(USER);
    expect(listed).toEqual({ items: [
      { id: PHONE, type: 'phone', detail: 'mobile ending 4567', removable: true },
      { id: AUTHENTICATOR, type: 'microsoftAuthenticator', detail: 'Ada phone', removable: true },
      { type: 'fido2', removable: false },
    ] });
    expect(h.fetch.mock.calls[1]).toEqual([`${ORIGIN}/users/${USER}/authentication/methods`, expect.objectContaining({ method: 'GET' })]);
    expect(JSON.stringify(listed)).not.toMatch(/secret|deviceTag|publicKey/);
  });

  it.each([['no role', []], ['wrong role', ['User.Read.All']]])('fails closed for %s before Graph calls', async (_label, roles) => {
    const h = harness(roles);
    await expect(h.provider.list(USER)).rejects.toMatchObject({ code: 'provider_access_denied' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('uses a fixed phone delete path after confirming the typed UUID target and guard', async () => {
    const h = harness();
    const guard = vi.fn(async () => {});
    h.fetch.mockResolvedValueOnce(response(methods)).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(h.provider.remove(USER, { kind: 'phone', methodId: PHONE }, guard)).resolves.toEqual({ accepted: true });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(h.fetch.mock.calls[2]).toEqual([`${ORIGIN}/users/${USER}/authentication/phoneMethods/${PHONE}`, expect.objectContaining({ method: 'DELETE' })]);
    expect(h.fetch.mock.calls[2]![1]).not.toHaveProperty('body');
  });

  it('uses the fixed Microsoft Authenticator delete collection, never an arbitrary route or body', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response(methods)).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await h.provider.remove(USER, { kind: 'microsoftAuthenticator', methodId: AUTHENTICATOR });
    expect(h.fetch.mock.calls[2]).toEqual([`${ORIGIN}/users/${USER}/authentication/microsoftAuthenticatorMethods/${AUTHENTICATOR}`, expect.objectContaining({ method: 'DELETE' })]);
    expect(h.fetch.mock.calls[2]![1]).not.toHaveProperty('body');
    expect(JSON.stringify(h.fetch.mock.calls)).not.toContain('secret');
  });

  it.each([
    [{ kind: 'phone', methodId: 'not-a-uuid' }],
    [{ kind: 'email', methodId: PHONE }],
    [{ kind: 'phone', methodId: PHONE, path: '/users/other' }],
  ])('rejects unallowlisted method input before token acquisition: %j', input => {
    const h = harness();
    return expect(h.provider.remove(USER, input as never)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('does not delete a mismatched, opaque, or unavailable method', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response(methods));
    await expect(h.provider.remove(USER, { kind: 'phone', methodId: AUTHENTICATOR })).rejects.toMatchObject({ code: 'method_not_removable' });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failed delete and treats a 5xx write response as unknown', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response(methods)).mockResolvedValueOnce(response({}, 503));
    await expect(h.provider.remove(USER, { kind: 'phone', methodId: PHONE })).rejects.toMatchObject({ code: 'unknown_write_outcome' });
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  it('creates a recovery email through the fixed Graph path and verifies the resulting address', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response(methods))
      .mockResolvedValueOnce(response({ id: '3ddfcfc8-9383-446f-83cc-3ab9be4be18f' }, 201))
      .mockResolvedValueOnce(response({ value: [...methods.value, { '@odata.type': '#microsoft.graph.emailAuthenticationMethod', emailAddress: 'qa@example.net' }] }));
    await expect(h.provider.setRecoveryEmail(USER, 'qa@example.net')).resolves.toEqual({ accepted: true, verified: true });
    expect(h.fetch.mock.calls[2]).toEqual([`${ORIGIN}/users/${USER}/authentication/emailMethods`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ emailAddress: 'qa@example.net' }) })]);
  });

  it('updates the existing recovery email by its fixed ID and leaves uncertain readback unverified', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ value: [{ '@odata.type': '#microsoft.graph.emailAuthenticationMethod', emailAddress: 'old@example.net' }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({ value: [{ '@odata.type': '#microsoft.graph.emailAuthenticationMethod', emailAddress: 'old@example.net' }] }));
    await expect(h.provider.setRecoveryEmail(USER, 'new@example.net')).resolves.toEqual({ accepted: true, verified: false });
    expect(h.fetch.mock.calls[2]).toEqual([`${ORIGIN}/users/${USER}/authentication/emailMethods/3ddfcfc8-9383-446f-83cc-3ab9be4be18f`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ emailAddress: 'new@example.net' }) })]);
  });

  it('rejects invalid recovery email before acquiring a token', async () => {
    const h = harness();
    await expect(h.provider.setRecoveryEmail(USER, 'not-an-email')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('creates a mobile phone through the fixed Graph collection and verifies its exact readback', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ value: [] }))
      .mockResolvedValueOnce(response({ id: PHONE }, 201))
      .mockResolvedValueOnce(response({ id: PHONE, phoneType: 'mobile', phoneNumber: '+1 5555551234' }));
    await expect(h.provider.setMobilePhone(USER, '+1 5555551234')).resolves.toEqual({ accepted: true, verified: true });
    expect(h.fetch.mock.calls[2]).toEqual([`${ORIGIN}/users/${USER}/authentication/phoneMethods`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ phoneNumber: '+1 5555551234', phoneType: 'mobile' }) })]);
    expect(h.fetch.mock.calls[3]).toEqual([`${ORIGIN}/users/${USER}/authentication/phoneMethods/${PHONE}`,
      expect.objectContaining({ method: 'GET' })]);
  });

  it('updates an existing mobile phone without exposing the number in its result', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response(methods))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({ id: PHONE, phoneType: 'mobile', phoneNumber: '+1 5555550000' }));
    await expect(h.provider.setMobilePhone(USER, '+1 5555551234')).resolves.toEqual({ accepted: true, verified: false });
    expect(h.fetch.mock.calls[2]).toEqual([`${ORIGIN}/users/${USER}/authentication/phoneMethods/${PHONE}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ phoneNumber: '+1 5555551234', phoneType: 'mobile' }) })]);
  });

  it('rejects an invalid mobile phone before token acquisition', async () => {
    const h = harness();
    await expect(h.provider.setMobilePhone(USER, '555-1234')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
