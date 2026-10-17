import { describe, expect, it } from 'vitest';
import { generateTotp, parseTotpSecret } from './totp';

describe('TOTP', () => {
  const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it.each([[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']])('matches RFC 6238 at %s', (seconds, code) => {
    expect(generateTotp(`otpauth://totp/Test?secret=${seed}&digits=8`, Number(seconds) * 1000).code).toBe(code);
  });
  it('uses the next period boundary and six digit default', () => {
    expect(generateTotp(seed, 59000)).toEqual({ code: '287082', expiresAt: '1970-01-01T00:01:00.000Z' });
  });
  it.each(['bad!', '123456', 'otpauth://hotp/Test?secret=JBSWY3DPEHPK3PXP', 'otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&digits=7', 'otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&secret=OTHER', 'otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&period=0'])('rejects invalid seed without echoing input', value => {
    expect(() => parseTotpSecret(value)).toThrow('invalid_otp_secret');
  });
});
