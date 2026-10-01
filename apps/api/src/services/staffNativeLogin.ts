import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getRedis } from './redis';
import { validateNativeLoginRequest, type NativeLoginRequest } from './portalNativeLogin';
import { NativeAdmissionError } from './portalNativeAdmissionSchemas';
import { revalidateStaffNativePrincipal, staffNativePrincipalSchema, type StaffNativePrincipal } from './staffNativeAuthority';

export const STAFF_NATIVE_TOKEN_PREFIX = 'ccs1.';
const CODE_PREFIX = 'staff:native:code:';
const SESSION_PREFIX = 'staff:native:session:';
const hash = (value: string) => createHash('sha256').update(value, 'ascii').digest('base64url');
const canonical32 = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
const consume = "local v=redis.call('GET',KEYS[1]); if v then redis.call('DEL',KEYS[1]); end; return v";
export const staffNativeEnabled = () => process.env.CLOUDCOM_STAFF_NATIVE_ENABLED === 'true';
function redisOrFail() { const redis = getRedis(); if (!redis) throw new NativeAdmissionError(503); return redis; }
function requireEnabled() { if (!staffNativeEnabled()) throw new NativeAdmissionError(404); }

export async function issueStaffNativeLoginCode(principal: StaffNativePrincipal, request: NativeLoginRequest) {
  requireEnabled();
  if (!validateNativeLoginRequest(request)) throw new NativeAdmissionError(400);
  await revalidateStaffNativePrincipal(principal);
  const code = randomBytes(32).toString('base64url');
  const expiresAt = Math.min(Date.now() + 60_000, principal.expiresAt);
  const stored = await redisOrFail().set(CODE_PREFIX + hash(code),
    JSON.stringify({ version: 1, principal, request, expiresAt }), 'EX', 60, 'NX');
  if (stored !== 'OK') throw new NativeAdmissionError(503);
  const callback = new URL(request.redirectUri);
  callback.searchParams.set('code', code); callback.searchParams.set('state', request.state);
  return { redirectUri: callback.toString(), expiresIn: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) };
}

export async function exchangeStaffNativeLoginCode(input: {
  code: string; codeVerifier: string; redirectUri: string; clientId: string;
}) {
  requireEnabled();
  if (!canonical32(input.code) || typeof input.codeVerifier !== 'string'
    || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) throw new NativeAdmissionError(401);
  const redis = redisOrFail();
  const raw = await redis.eval(consume, 1, CODE_PREFIX + hash(input.code));
  if (typeof raw !== 'string') throw new NativeAdmissionError(401);
  let record;
  try { record = JSON.parse(raw); } catch { throw new NativeAdmissionError(401); }
  if (!record || record.version !== 1 || !validateNativeLoginRequest(record.request)
    || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= Date.now()
    || record.expiresAt > Date.now() + 60_000 || record.request.clientId !== input.clientId
    || record.request.redirectUri !== input.redirectUri) throw new NativeAdmissionError(401);
  const challenge = createHash('sha256').update(input.codeVerifier, 'ascii').digest();
  if (!timingSafeEqual(challenge, Buffer.from(record.request.codeChallenge, 'base64url'))) throw new NativeAdmissionError(401);
  const parsed = staffNativePrincipalSchema.safeParse(record.principal);
  if (!parsed.success) throw new NativeAdmissionError(401);
  // Logout, role removal and MFA changes between issue and exchange deny minting.
  await revalidateStaffNativePrincipal(parsed.data);
  const accessToken = STAFF_NATIVE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const expiresIn = Math.floor((parsed.data.expiresAt - Date.now()) / 1000);
  if (expiresIn <= 0) throw new NativeAdmissionError(401);
  const stored = await redis.set(SESSION_PREFIX + hash(accessToken), JSON.stringify(parsed.data), 'EX', expiresIn, 'NX');
  if (stored !== 'OK') throw new NativeAdmissionError(503);
  return { accessToken, tokenType: 'Bearer' as const, expiresIn };
}

export async function authenticateStaffNativeOperator(authorization: string | undefined) {
  requireEnabled();
  if (!authorization?.startsWith('Bearer ')) throw new NativeAdmissionError(401);
  const token = authorization.slice(7);
  if (!token.startsWith(STAFF_NATIVE_TOKEN_PREFIX) || !canonical32(token.slice(STAFF_NATIVE_TOKEN_PREFIX.length))) {
    throw new NativeAdmissionError(401);
  }
  const sessionHash = hash(token);
  const principal = await loadStaffNativeSession(sessionHash);
  await revalidateStaffNativePrincipal(principal);
  return { principal, sessionHash };
}

/** Target consume/renew uses only the server-recorded session hash. */
export async function loadStaffNativeSession(sessionHash: string): Promise<StaffNativePrincipal> {
  requireEnabled();
  if (!canonical32(sessionHash)) throw new NativeAdmissionError(401);
  const raw = await redisOrFail().get(SESSION_PREFIX + sessionHash);
  if (!raw) throw new NativeAdmissionError(401);
  let parsed;
  try { parsed = staffNativePrincipalSchema.safeParse(JSON.parse(raw)); } catch { throw new NativeAdmissionError(401); }
  if (!parsed.success || parsed.data.expiresAt <= Date.now()) throw new NativeAdmissionError(401);
  return parsed.data;
}

export async function endStaffNativeLogin(sessionHash: string) {
  if (!canonical32(sessionHash)) throw new NativeAdmissionError(401);
  await redisOrFail().del(SESSION_PREFIX + sessionHash);
}
