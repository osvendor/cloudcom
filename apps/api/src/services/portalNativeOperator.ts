import type { PortalAuthContext } from '../routes/portal/schemas';
import { runOutsideDbContext } from '../db';
import { getRedis } from './redis';
import { NATIVE_CLIENT_ID } from './portalNativeLogin';
import { currentCompanyGatewayFingerprint } from './portalCompanyGateway';
import { nativeSessionHash } from './portalNativeAdmission';
import { NativeAdmissionError, type NativeOperator } from './portalNativeAdmissionSchemas';

/** No cookie or technician shortcut: both the native personal session and company assertion are mandatory. */
export async function authenticateNativeOperator(auth: PortalAuthContext): Promise<NativeOperator> {
  if (auth.authMethod !== 'bearer' || !/^ccn1\.[A-Za-z0-9_-]{43}$/.test(auth.token)
    || auth.user.accessMode !== 'remote_only' || !Number.isSafeInteger(auth.user.authEpoch)
    || process.env.CLOUDCOM_COMPANY_GATEWAY_ENABLED !== 'true') throw new NativeAdmissionError(403);
  const redis = getRedis(); if (!redis) throw new NativeAdmissionError(503);
  const raw = await runOutsideDbContext(() => redis.get(`portal:session:${auth.token}`));
  if (!raw) throw new NativeAdmissionError(401);
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch { throw new NativeAdmissionError(401); }
  if (!value || value.nativeClientId !== NATIVE_CLIENT_ID || value.portalUserId !== auth.user.id
    || value.orgId !== auth.user.orgId || value.authEpoch !== auth.user.authEpoch || !Number.isSafeInteger(value.nativeExpiresAt)
    || (value.nativeExpiresAt as number) <= Date.now() || (value.nativeExpiresAt as number) > Date.now() + 12 * 3600_000
    || value.companyOrgId !== auth.user.orgId || !Number.isSafeInteger(value.companyExpiresAt)
    || value.companyConfigFingerprint !== currentCompanyGatewayFingerprint()
    || !/^[0-9a-f]{64}$/.test(String(value.companyConfigFingerprint ?? ''))
    || (value.companyExpiresAt as number) <= Date.now() || (value.nativeExpiresAt as number) > (value.companyExpiresAt as number)) {
    throw new NativeAdmissionError(401);
  }
  return { id: auth.user.id, orgId: auth.user.orgId, authEpoch: auth.user.authEpoch!, sessionHash: nativeSessionHash(auth.token),
    expiresAt: Math.min(value.nativeExpiresAt as number, value.companyExpiresAt as number) };
}
