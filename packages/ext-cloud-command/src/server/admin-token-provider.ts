import { constants, createHash, createPrivateKey, randomUUID, sign, X509Certificate } from 'node:crypto';
import { z } from 'zod';
import type { GuardedFetch } from './transport';

export class MicrosoftCredentialError extends Error {
  constructor(public readonly code: 'invalid_tenant' | 'credential_unavailable' | 'token_unavailable') { super(code); }
}
export type AdministrationCertificate = { clientId: string; credentialVersion: string; certificatePem: string; privateKeyPem: string };
const uuid = z.string().uuid();

/** Server/worker-only port. Never accept certificate material or tenant selection from an operation request. */
export function createAdministrationTokenProvider(ports: {
  clientId: string;
  credentialVersion: string;
  loadCertificate(credentialVersion: string): Promise<AdministrationCertificate>;
  fetch: GuardedFetch;
  now?: () => number;
}) {
  return async (tenantId: string): Promise<string> => {
    if (!uuid.safeParse(tenantId).success) throw new MicrosoftCredentialError('invalid_tenant');
    const endpoint = `https://login.microsoftonline.com/${tenantId.toLowerCase()}/oauth2/v2.0/token`;
    let assertion: string;
    let clientId: string;
    try {
      const expectedClientId = uuid.parse(ports.clientId).toLowerCase();
      const expectedVersion = z.string().min(1).max(128).parse(ports.credentialVersion);
      const credential = await ports.loadCertificate(expectedVersion);
      clientId = uuid.parse(credential.clientId).toLowerCase();
      if (clientId !== expectedClientId || credential.credentialVersion !== expectedVersion) throw new Error('credential binding mismatch');
      const certificate = new X509Certificate(credential.certificatePem);
      const key = createPrivateKey(credential.privateKeyPem);
      const now = ports.now?.() ?? Date.now();
      if (!Number.isFinite(now) || Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now
        || key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
        || !certificate.checkPrivateKey(key)) throw new Error('invalid certificate');
      const seconds = Math.floor(now / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const header = encode({ alg: 'PS256', typ: 'JWT', 'x5t#S256': createHash('sha256').update(certificate.raw).digest('base64url') });
      const payload = encode({ aud: endpoint, iss: clientId, sub: clientId, jti: randomUUID(), nbf: seconds - 30, iat: seconds, exp: seconds + 300 });
      const input = `${header}.${payload}`;
      assertion = `${input}.${sign('sha256', Buffer.from(input), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url')}`;
    } catch { throw new MicrosoftCredentialError('credential_unavailable'); }
    try {
      const response = await ports.fetch(endpoint, {
        method: 'POST', redirect: 'error', timeoutMs: 15000, maxBytes: 128 * 1024,
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, grant_type: 'client_credentials',
          scope: 'https://graph.microsoft.com/.default',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion }).toString(),
      });
      if (!response.ok || response.status >= 300) throw new Error('token request rejected');
      const data: unknown = await response.json();
      const parsed = z.object({ access_token: z.string().min(1).max(32768), token_type: z.literal('Bearer'), expires_in: z.number().positive().finite() }).safeParse(data);
      if (!parsed.success || /[\r\n]/.test(parsed.data.access_token)) throw new Error('invalid token');
      return parsed.data.access_token;
    } catch { throw new MicrosoftCredentialError('token_unavailable'); }
  };
}
