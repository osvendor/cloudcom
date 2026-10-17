import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';

export const table = 'credentials_records';
export type CredentialSecrets = { password: string; otpSecret: string; notes: string };
type Crypto = ExtensionRuntimeContext['secrets'];
const failure = (): never => { throw new Error('credential_encryption_unavailable'); };
// Uses core row-bound AAD, compatible with encryptedColumnRegistry rotation.
export function seal(crypto: Crypto, orgId: string, id: string, value: CredentialSecrets): string {
  const result = crypto.encryptForColumn(table, `secret_ciphertext:${id}`, JSON.stringify({ version: 1, orgId, id, ...value }));
  if (!result.startsWith('enc:v3:')) return failure();
  return result;
}
export function unseal(crypto: Crypto, orgId: string, id: string, ciphertext: string): CredentialSecrets {
  try {
    if (!ciphertext.startsWith('enc:v3:')) return failure();
    const value = JSON.parse(crypto.decryptForColumn(table, `secret_ciphertext:${id}`, ciphertext));
    if (value.version !== 1 || value.orgId !== orgId || value.id !== id ||
      typeof value.password !== 'string' || typeof value.otpSecret !== 'string' || typeof value.notes !== 'string') return failure();
    return { password: value.password, otpSecret: value.otpSecret, notes: value.notes };
  } catch { return failure(); }
}
