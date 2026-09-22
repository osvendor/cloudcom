import { readFileSync } from 'node:fs';
import { constants, generateKeyPairSync, verify, X509Certificate } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAdministrationTokenProvider } from './admin-token-provider';

const fixture = new URL('../../../../apps/m365-graph-read-executor/src/test/fixtures/', import.meta.url);
const certificatePem = readFileSync(new URL('client-cert.pem', fixture), 'utf8');
const privateKeyPem = readFileSync(new URL('client-key.pem', fixture), 'utf8');
const certificate = new X509Certificate(certificatePem);
const now = Date.parse(certificate.validFrom) + 60000;
const tenant = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const credentialVersion = 'cert-1';
const credential = { clientId, credentialVersion, certificatePem, privateKeyPem };
describe('administration certificate token provider', () => {
  it.each([{ clientId: '33333333-3333-4333-8333-333333333333' }, { credentialVersion: 'cert-2' }])(
    'rejects a different credential binding before token exchange', async changed => {
      const fetch = vi.fn();
      const loadCertificate = vi.fn(async () => ({ ...credential, ...changed }));
      await expect(createAdministrationTokenProvider({ clientId, credentialVersion, loadCertificate, fetch, now: () => now })(tenant))
        .rejects.toMatchObject({ code: 'credential_unavailable' });
      expect(loadCertificate).toHaveBeenCalledWith(credentialVersion);
      expect(fetch).not.toHaveBeenCalled();
    });
  it('signs a short-lived tenant-specific assertion with the matching certificate', async () => {
    const fetch = vi.fn(async () => Response.json({ access_token: 'opaque', token_type: 'Bearer', expires_in: 3600 }));
    const provider = createAdministrationTokenProvider({ clientId, credentialVersion, loadCertificate: async () => credential, fetch, now: () => now });
    expect(await provider(tenant)).toBe('opaque');
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`);
    const body = new URLSearchParams(request.body as string);
    const parts = body.get('client_assertion')!.split('.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    expect(claims).toMatchObject({ aud: url, iss: clientId, sub: clientId });
    expect(claims.exp - claims.iat).toBe(300);
    expect(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: certificate.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(parts[2], 'base64url'))).toBe(true);
    expect(request.redirect).toBe('error');
    expect(body.get('scope')).toBe('https://graph.microsoft.com/.default');
  });
  it('rejects untrusted tenant paths before reading a credential', async () => {
    const loadCertificate = vi.fn(async () => credential), fetch = vi.fn();
    await expect(createAdministrationTokenProvider({ clientId, credentialVersion, loadCertificate, fetch })('../common')).rejects.toMatchObject({ code: 'invalid_tenant' });
    expect(loadCertificate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects expired certificates without sending an assertion', async () => {
    const fetch = vi.fn();
    await expect(createAdministrationTokenProvider({ clientId, credentialVersion, loadCertificate: async () => credential, fetch, now: () => Date.parse(certificate.validTo) + 1 })(tenant)).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a mismatched private key', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fetch = vi.fn();
    await expect(createAdministrationTokenProvider({ clientId, credentialVersion, loadCertificate: async () => ({ ...credential, privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }), fetch, now: () => now })(tenant)).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not disclose token transport errors or provider bodies', async () => {
    await expect(createAdministrationTokenProvider({ clientId, credentialVersion, loadCertificate: async () => credential, now: () => now, fetch: async () => { throw new Error('private assertion and token'); } })(tenant)).rejects.toMatchObject({ message: 'token_unavailable' });
  });
});
