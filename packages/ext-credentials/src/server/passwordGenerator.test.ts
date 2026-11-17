import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIAL_PASSWORD_WORDS, generateCredentialPassword } from './passwordGenerator';

const { random } = vi.hoisted(() => ({ random: vi.fn<(max: number) => number>() }));
vi.mock('node:crypto', () => ({ randomInt: random }));

afterEach(() => vi.resetAllMocks());

describe('readable credential password generation', () => {
  it('uses a unique vocabulary of at least 256 short words', () => {
    expect(CREDENTIAL_PASSWORD_WORDS.length).toBeGreaterThanOrEqual(256);
    expect(new Set(CREDENTIAL_PASSWORD_WORDS).size).toBe(CREDENTIAL_PASSWORD_WORDS.length);
    expect(CREDENTIAL_PASSWORD_WORDS.every(word => /^[a-z]{3,4}$/.test(word))).toBe(true);
  });

  it('uses bounded cryptographic selections and keeps leading zero digits', () => {
    random.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(7);
    expect(generateCredentialPassword()).toBe('Ace!act07');
    expect(random.mock.calls).toEqual([
      [CREDENTIAL_PASSWORD_WORDS.length], [CREDENTIAL_PASSWORD_WORDS.length - 1], [7], [100],
    ]);
  });

  it('supports the upper bounds without selecting the same word twice', () => {
    const count = CREDENTIAL_PASSWORD_WORDS.length;
    random.mockReturnValueOnce(count - 1).mockReturnValueOnce(count - 2).mockReturnValueOnce(6).mockReturnValueOnce(99);
    expect(generateCredentialPassword()).toBe('Zoom?zone99');
  });

  it('meets length, real-word, casing, digit and symbol constraints for every first word', () => {
    for (let index = 0; index < CREDENTIAL_PASSWORD_WORDS.length; index++) {
      random.mockReturnValueOnce(index).mockReturnValueOnce(0).mockReturnValueOnce(index % 7).mockReturnValueOnce(index % 100);
      const password = generateCredentialPassword();
      const match = /^([A-Z][a-z]{2,3})([!@#$%*?])([a-z]{3,4})(\d{2})$/.exec(password);
      expect(match).not.toBeNull();
      expect(password.length).toBeLessThanOrEqual(12);
      expect(CREDENTIAL_PASSWORD_WORDS).toContain(match![1]!.toLowerCase());
      expect(CREDENTIAL_PASSWORD_WORDS).toContain(match![3]);
      expect(match![1]!.toLowerCase()).not.toBe(match![3]);
    }
  });
});
