import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ store: new Map<string, string>(), live: vi.fn() }));
vi.mock('./redis', () => ({ getRedis: () => ({
  set: async (key: string, value: string) => { mocks.store.set(key, value); return 'OK'; },
  get: async (key: string) => mocks.store.get(key) ?? null,
  del: async (key: string) => Number(mocks.store.delete(key)),
  eval: async (_script: string, _count: number, key: string) => {
    const value = mocks.store.get(key) ?? null; mocks.store.delete(key); return value;
  },
}) }));
vi.mock('./staffNativeAuthority', async original => ({
  ...await original<typeof import('./staffNativeAuthority')>(), revalidateStaffNativePrincipal: mocks.live,
}));
import { issueStaffNativeLoginCode, exchangeStaffNativeLoginCode, authenticateStaffNativeOperator,
  endStaffNativeLogin } from './staffNativeLogin';
import type { StaffNativePrincipal } from './staffNativeAuthority';
const verifier = 'A'.repeat(43);
const request = () => ({ clientId: 'cloudcom-rustdesk-v1', redirectUri: 'http://127.0.0.1:54321/cloudcom/callback',
  codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' as const,
  state: Buffer.alloc(32, 1).toString('base64url') });
const principal = (): StaffNativePrincipal => ({ kind: 'staff_native',
  userId: '11111111-1111-4111-8111-111111111111', partnerId: '22222222-2222-4222-8222-222222222222',
  familyId: '33333333-3333-4333-8333-333333333333', authEpoch: 1, mfaEpoch: 0,
  issuedAt: Math.floor(Date.now() / 1000), expiresAt: Date.now() + 3600_000, mfa: true });
async function code() {
  const result = await issueStaffNativeLoginCode(principal(), request());
  return new URL(result.redirectUri).searchParams.get('code')!;
}
const exchange = (value: string, extra = {}) => exchangeStaffNativeLoginCode({ code: value,
  codeVerifier: verifier, redirectUri: request().redirectUri, clientId: request().clientId, ...extra });
beforeEach(() => { mocks.store.clear(); mocks.live.mockReset().mockResolvedValue({});
  vi.stubEnv('CLOUDCOM_STAFF_NATIVE_ENABLED', 'true'); });
afterEach(() => vi.unstubAllEnvs());
describe('separate staff PKCE login', () => {
  it('exchanges once, authenticates current authority and ends the session', async () => {
    const value = await code(); const result = await exchange(value);
    expect(result.accessToken).toMatch(/^ccs1\./);
    const operator = await authenticateStaffNativeOperator('Bearer ' + result.accessToken);
    expect(operator.principal.userId).toBe(principal().userId);
    expect(operator).not.toHaveProperty('token');
    await expect(exchange(value)).rejects.toThrow();
    await endStaffNativeLogin(operator.sessionHash);
    await expect(authenticateStaffNativeOperator('Bearer ' + result.accessToken)).rejects.toThrow();
  });
  it.each([{ codeVerifier: 'B'.repeat(43) }, { clientId: 'other' },
    { redirectUri: 'http://127.0.0.1:54322/cloudcom/callback' }])('burns a code on invalid exchange %j', async change => {
    const value = await code(); await expect(exchange(value, change)).rejects.toThrow();
    await expect(exchange(value)).rejects.toThrow();
  });
  it.each(['https://attacker.example/callback', 'http://localhost:54321/cloudcom/callback',
    'http://127.0.0.1:80/cloudcom/callback', 'http://127.0.0.1:54321/cloudcom/callback?redirect=evil'])('rejects unregistered callback %s', async redirectUri => {
    await expect(issueStaffNativeLoginCode(principal(), { ...request(), redirectUri })).rejects.toThrow();
    expect(mocks.store.size).toBe(0);
  });
  it.each(['ccn1.' + 'A'.repeat(43), 'eyJ.browser.jwt', '', 'ccs1.invalid'])('denies other token families', async token => {
    await expect(authenticateStaffNativeOperator('Bearer ' + token)).rejects.toThrow();
  });
  it('denies role removal between browser approval and exchange', async () => {
    const value = await code(); mocks.live.mockRejectedValue(new Error('revoked'));
    await expect(exchange(value)).rejects.toThrow();
    expect([...mocks.store.keys()].some(key => key.startsWith('staff:native:session:'))).toBe(false);
  });
  it('rechecks the live identity on every native request', async () => {
    const result = await exchange(await code()); mocks.live.mockRejectedValue(new Error('revoked'));
    await expect(authenticateStaffNativeOperator('Bearer ' + result.accessToken)).rejects.toThrow();
  });
  it('is unavailable until explicitly enabled', async () => {
    vi.stubEnv('CLOUDCOM_STAFF_NATIVE_ENABLED', 'false');
    await expect(code()).rejects.toThrow(); expect(mocks.store.size).toBe(0);
  });
});
