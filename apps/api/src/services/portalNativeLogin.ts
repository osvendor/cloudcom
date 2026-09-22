import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getRedis } from './redis';

export const NATIVE_CLIENT_ID = 'cloudcom-rustdesk-v1';
// The dot cannot occur in existing nanoid browser-session tokens.
export const NATIVE_SESSION_PREFIX = 'ccn1.';
export const NATIVE_SESSION_SECONDS = 12 * 60 * 60;
const CODE_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE_PREFIX = 'portal:native:code:';

export type NativeLoginRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  state: string;
};
type Principal = { portalUserId: string; orgId: string; authEpoch: number };
type StoredCode = NativeLoginRequest & Principal & {
  version: 1;
  expiresAt: number;
  parentSessionToken: string;
};

function canonical32(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

/** A registered loopback path with a dynamic unprivileged port; no DNS, userinfo,
 * query, alternate numeric-IP spellings, URL normalization or open redirect. */
export function validateNativeLoginRequest(request: NativeLoginRequest): boolean {
  if (!request || request.clientId !== NATIVE_CLIENT_ID || request.codeChallengeMethod !== 'S256'
    || !canonical32(request.codeChallenge) || !canonical32(request.state)) return false;
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/cloudcom\/callback$/.exec(request.redirectUri);
  return Boolean(match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535);
}

function validPrincipal(value: Principal): boolean {
  return UUID.test(value.portalUserId) && UUID.test(value.orgId)
    && Number.isSafeInteger(value.authEpoch) && value.authEpoch > 0;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('hex');
}

/** Caller must already be an authenticated remote-only browser session, with
 * CSRF, account/tenant checks and request throttling. No password is handed off. */
export async function issueNativeLoginCode(
  principal: Principal, parentSessionToken: string, request: NativeLoginRequest,
): Promise<{ redirectUri: string; expiresIn: number }> {
  if (!validateNativeLoginRequest(request) || !validPrincipal(principal)
    || !/^[A-Za-z0-9_-]{20,128}$/.test(parentSessionToken)
    || parentSessionToken.startsWith(NATIVE_SESSION_PREFIX)) throw new Error('Invalid native login request');
  const redis = getRedis();
  if (!redis) throw new Error('Native login unavailable');
  const code = randomBytes(32).toString('base64url');
  const record: StoredCode = { ...request, ...principal, version: 1,
    parentSessionToken, expiresAt: Date.now() + CODE_SECONDS * 1000 };
  // This private record references the browser session for a live logout check.
  // It must never appear in audit/error output or be returned to the caller.
  const stored = await redis.set(CODE_PREFIX + hash(code), JSON.stringify(record), 'EX', CODE_SECONDS, 'NX');
  if (stored !== 'OK') throw new Error('Native login unavailable');
  const callback = new URL(request.redirectUri);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', request.state);
  return { redirectUri: callback.toString(), expiresIn: CODE_SECONDS };
}

const CONSUME_CODE = "local v=redis.call('GET',KEYS[1]); if v then redis.call('DEL',KEYS[1]); end; return v";
const CREATE_SESSION = `
if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('EXISTS',KEYS[2]) == 1 then return 0 end
redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[4])
redis.call('SADD',KEYS[3],ARGV[3])
redis.call('EXPIRE',KEYS[3],ARGV[5])
return 1`;

/** Single-use PKCE exchange. The native session has its own token and a hard
 * expiry; the browser cookie is never returned. All malformed failures are equal. */
export async function exchangeNativeLoginCode(request: {
  code: string; clientId: string; redirectUri: string; codeVerifier: string;
}): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: number } | null> {
  if (!canonical32(request.code) || typeof request.codeVerifier !== 'string'
    || !/^[A-Za-z0-9._~-]{43,128}$/.test(request.codeVerifier)) return null;
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.eval(CONSUME_CODE, 1, CODE_PREFIX + hash(request.code));
    if (typeof raw !== 'string') return null;
    const record = JSON.parse(raw) as StoredCode;
    if (!record || record.version !== 1 || !validateNativeLoginRequest(record) || !validPrincipal(record)
      || !Number.isSafeInteger(record.expiresAt) || Date.now() >= record.expiresAt
      || record.expiresAt > Date.now() + CODE_SECONDS * 1000
      || typeof record.parentSessionToken !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(record.parentSessionToken)
      || record.parentSessionToken.startsWith(NATIVE_SESSION_PREFIX)
      || request.clientId !== record.clientId || request.redirectUri !== record.redirectUri) return null;
    const challenge = createHash('sha256').update(request.codeVerifier, 'ascii').digest();
    if (!timingSafeEqual(challenge, Buffer.from(record.codeChallenge, 'base64url'))) return null;
    const parentKey = `portal:session:${record.parentSessionToken}`;
    const parentRaw = await redis.get(parentKey);
    if (!parentRaw) return null;
    const parent = JSON.parse(parentRaw) as Principal & { nativeClientId?: string };
    if (!parent || parent.portalUserId !== record.portalUserId || parent.orgId !== record.orgId
      || parent.authEpoch !== record.authEpoch || parent.nativeClientId !== undefined) return null;
    const accessToken = NATIVE_SESSION_PREFIX + randomBytes(32).toString('base64url');
    const session = JSON.stringify({ portalUserId: record.portalUserId, orgId: record.orgId,
      authEpoch: record.authEpoch, nativeClientId: NATIVE_CLIENT_ID,
      nativeExpiresAt: Date.now() + NATIVE_SESSION_SECONDS * 1000 });
    // Recheck the exact parent session inside the same operation that creates
    // the native session. Logout or replacement between the reads wins.
    const created = await redis.eval(CREATE_SESSION, 3, parentKey, `portal:session:${accessToken}`,
      `portal:user-sessions:${record.portalUserId}`, parentRaw, session, accessToken,
      String(NATIVE_SESSION_SECONDS), String(48 * 60 * 60));
    return created === 1 ? { accessToken, tokenType: 'Bearer', expiresIn: NATIVE_SESSION_SECONDS } : null;
  } catch {
    return null;
  }
}

/** Called before portal identity hydration, and again against live accessMode.
 * Native tokens cannot become ordinary portal sessions after a role change. */
export function nativeSessionAllows(
  token: string, session: Record<string, unknown>, method: string, path: string, bearer: boolean,
): boolean {
  const nativeToken = token.startsWith(NATIVE_SESSION_PREFIX);
  if (!nativeToken) return session.nativeClientId === undefined && session.nativeExpiresAt === undefined;
  if (!bearer || session.nativeClientId !== NATIVE_CLIENT_ID
    || !Number.isSafeInteger(session.nativeExpiresAt)
    || (session.nativeExpiresAt as number) <= Date.now()
    || (session.nativeExpiresAt as number) > Date.now() + NATIVE_SESSION_SECONDS * 1000) return false;
  return (method === 'POST' && path === '/api/v1/portal/auth/logout')
    || (method === 'GET' && path === '/api/v1/portal/remote/devices');
}
