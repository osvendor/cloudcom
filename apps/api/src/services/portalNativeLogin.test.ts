import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { getRedisMock } = vi.hoisted(() => ({ getRedisMock: vi.fn() }));
vi.mock('./redis', () => ({ getRedis: getRedisMock }));
import { exchangeNativeLoginCode, issueNativeLoginCode, nativeSessionAllows,
  NATIVE_CLIENT_ID, NATIVE_SESSION_SECONDS, validateNativeLoginRequest } from './portalNativeLogin';

const principal = { portalUserId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222', authEpoch: 3 };
const parentToken = 'browser_session_only_1234567890';
// RFC 7636 appendix B vector, independent of our implementation.
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const request = { clientId: NATIVE_CLIENT_ID, redirectUri: 'http://127.0.0.1:49871/cloudcom/callback',
  codeChallengeMethod: 'S256' as const, codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  state: Buffer.alloc(32, 7).toString('base64url') };

function store() {
  const values = new Map<string, string>([[`portal:session:${parentToken}`, JSON.stringify(principal)]]);
  return { values, get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { if (values.has(key)) return null; values.set(key, value); return 'OK'; }),
    eval: vi.fn(async (_script: string, count: number, ...args: string[]) => {
      if (count === 1) { const value = values.get(args[0]!); values.delete(args[0]!); return value ?? null; }
      if (values.get(args[0]!) !== args[3] || values.has(args[1]!)) return 0;
      values.set(args[1]!, args[4]!);
      return 1;
    }),
  };
}
async function issue() {
  const issued = await issueNativeLoginCode(principal, parentToken, request);
  const callback = new URL(issued.redirectUri);
  expect(callback.searchParams.get('state')).toBe(request.state);
  return { code: callback.searchParams.get('code')!, clientId: request.clientId,
    redirectUri: request.redirectUri, codeVerifier: verifier };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-22T12:00:00Z')); getRedisMock.mockReset(); });
afterEach(() => vi.useRealTimers());

describe('native browser PKCE handoff', () => {
  it('denies a different company before creating a native session', async () => {
    const redis = store(); getRedisMock.mockReturnValue(redis);
    const exchange = await issue();
    expect(await exchangeNativeLoginCode(exchange, '33333333-3333-4333-8333-333333333333')).toBeNull();
    expect([...redis.values.keys()].some(key => key.startsWith('portal:session:ccn1.'))).toBe(false);
    expect(await exchangeNativeLoginCode(exchange, principal.orgId)).toBeNull();
    expect(await exchangeNativeLoginCode(await issue(), principal.orgId)).not.toBeNull();
  });
  it('accepts only the registered loopback client/path and S256 values', () => {
    expect(validateNativeLoginRequest(request)).toBe(true);
    for (const redirectUri of ['http://localhost:49871/cloudcom/callback', 'http://127.0.0.1:65536/cloudcom/callback',
      'http://127.0.0.1:80/cloudcom/callback', 'http://127.1:49871/cloudcom/callback',
      request.redirectUri + '?redirect=https://example.com', request.redirectUri + '#fragment',
      'http://127.0.0.1:49871/a/../cloudcom/callback', 'https://example.com/cloudcom/callback']) {
      expect(validateNativeLoginRequest({ ...request, redirectUri })).toBe(false);
    }
    expect(validateNativeLoginRequest({ ...request, codeChallengeMethod: 'plain' as 'S256' })).toBe(false);
    expect(validateNativeLoginRequest({ ...request, clientId: 'unregistered' })).toBe(false);
    expect(validateNativeLoginRequest({ ...request, codeChallenge: request.codeChallenge + '=' })).toBe(false);
  });
  it('exchanges the RFC vector once and never returns the browser token', async () => {
    const redis = store(); getRedisMock.mockReturnValue(redis);
    const exchange = await issue();
    const result = await exchangeNativeLoginCode(exchange);
    expect(result).toMatchObject({ tokenType: 'Bearer', expiresIn: NATIVE_SESSION_SECONDS });
    expect(result?.accessToken).toMatch(/^ccn1\.[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(result)).not.toContain(parentToken);
    const session = JSON.parse(redis.values.get(`portal:session:${result!.accessToken}`)!);
    expect(session).toEqual({ ...principal, nativeClientId: NATIVE_CLIENT_ID,
      nativeExpiresAt: Date.now() + NATIVE_SESSION_SECONDS * 1000 });
    expect(await exchangeNativeLoginCode(exchange)).toBeNull();
  });
  it('burns wrong-client, wrong-redirect and wrong-verifier codes', async () => {
    const redis = store(); getRedisMock.mockReturnValue(redis);
    for (const change of [{ clientId: 'other' }, { redirectUri: request.redirectUri.replace('49871', '49872') },
      { codeVerifier: 'x'.repeat(43) }]) {
      const exchange = await issue();
      expect(await exchangeNativeLoginCode({ ...exchange, ...change })).toBeNull();
      expect(await exchangeNativeLoginCode(exchange)).toBeNull();
    }
  });
  it('denies expiry, browser logout and identity replacement before exchange', async () => {
    for (const mutate of [
      () => vi.advanceTimersByTime(60000),
      (redis: ReturnType<typeof store>) => redis.values.delete(`portal:session:${parentToken}`),
      (redis: ReturnType<typeof store>) => redis.values.set(`portal:session:${parentToken}`, JSON.stringify({ ...principal, authEpoch: 4 })),
    ]) {
      const redis = store(); getRedisMock.mockReturnValue(redis);
      const exchange = await issue(); mutate(redis);
      expect(await exchangeNativeLoginCode(exchange)).toBeNull();
    }
  });
  it('fails closed on unavailable Redis and malformed code records', async () => {
    getRedisMock.mockReturnValue(null);
    await expect(issue()).rejects.toThrow('unavailable');
    expect(await exchangeNativeLoginCode({ code: Buffer.alloc(32).toString('base64url'),
      clientId: request.clientId, redirectUri: request.redirectUri, codeVerifier: verifier })).toBeNull();
    const redis = store(); getRedisMock.mockReturnValue(redis);
    const exchange = await issue();
    redis.values.set('portal:native:code:' + createHash('sha256').update(exchange.code).digest('hex'), '{broken');
    expect(await exchangeNativeLoginCode(exchange)).toBeNull();
  });
  it('limits native sessions to bearer remote APIs with a hard lifetime', () => {
    const token = 'ccn1.' + Buffer.alloc(32, 1).toString('base64url');
    const session = { ...principal, nativeClientId: NATIVE_CLIENT_ID, nativeExpiresAt: Date.now() + 1000 };
    expect(nativeSessionAllows(token, session, 'GET', '/api/v1/portal/remote/devices', true)).toBe(true);
    expect(nativeSessionAllows(token, session, 'GET', '/api/v1/portal/remote/devices', false)).toBe(false);
    for (const path of ['/api/v1/portal/devices', '/api/v1/portal/profile', '/api/v1/portal/remote/native/authorize']) {
      expect(nativeSessionAllows(token, session, 'GET', path, true)).toBe(false);
    }
    expect(nativeSessionAllows(token, principal, 'GET', '/api/v1/portal/remote/devices', true)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(nativeSessionAllows(token, session, 'GET', '/api/v1/portal/remote/devices', true)).toBe(false);
    expect(nativeSessionAllows(parentToken, principal, 'GET', '/api/v1/portal/profile', false)).toBe(true);
    expect(nativeSessionAllows('ccn1_' + 'A'.repeat(43), principal, 'GET', '/api/v1/portal/profile', false)).toBe(true);
  });
});
