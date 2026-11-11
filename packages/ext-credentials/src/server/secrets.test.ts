import { describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { seal, unseal } from './secrets';

describe('credential bindings', () => {
  const key = randomBytes(32);
  const crypto = {
    encryptForColumn(table: string, column: string, plaintext: string) {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`${table}.${column}`));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `enc:v3:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
    },
    decryptForColumn(table: string, column: string, ciphertext: string) {
      const b = Buffer.from(ciphertext.slice(7), 'base64'); const decipher = createDecipheriv('aes-256-gcm', key, b.subarray(0,12));
      decipher.setAAD(Buffer.from(`${table}.${column}`)); decipher.setAuthTag(b.subarray(12,28));
      return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
  const value = { password: 'synthetic password', otpSecret: 'SYNTHETIC', notes: 'private note' };
  it('roundtrips only in original organization and record', () => {
    const ct = seal(crypto, 'a', 'one', value);
    expect(ct).not.toContain(value.password);
    expect(unseal(crypto, 'a', 'one', ct)).toEqual(value);
    expect(() => unseal(crypto, 'b', 'one', ct)).toThrow('credential_encryption_unavailable');
    expect(() => unseal(crypto, 'a', 'two', ct)).toThrow('credential_encryption_unavailable');
  });
  it('rejects legacy ciphertext and encryption without authenticated binding', () => {
    expect(() => unseal(crypto, 'a', 'one', 'enc:v1:synthetic')).toThrow();
    expect(() => seal({ ...crypto, encryptForColumn: () => 'enc:v2:synthetic' }, 'a', 'one', value)).toThrow();
  });
});
