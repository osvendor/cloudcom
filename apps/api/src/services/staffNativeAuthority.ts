import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, users } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { getUserPermissions, hasPermission, canAccessOrg } from './permissions';
import { getActiveOrgTenant, getActivePartner } from './tenantStatus';
import { isFamilyRevoked, isUserTokenRevoked, isTokenIssuedBeforePasswordChange } from './tokenRevocation';
import { checkRemoteAccess } from './remoteAccessPolicy';
import { evaluateCapability } from './partnerTrust';
import { partnerTrustMode } from '../config/partnerTrustMode';
import { getEffectiveMfaPolicy } from './mfaPolicy';
import { nativeUuid, NativeAdmissionError } from './portalNativeAdmissionSchemas';

// Stored only by the staff browser PKCE exchange. Never accept these claims
// from a request body, a portal identity, or a company email/domain match.
export const staffNativePrincipalSchema = z.object({
  kind: z.literal('staff_native'), userId: nativeUuid, partnerId: nativeUuid,
  authEpoch: z.number().int().positive(), mfaEpoch: z.number().int().nonnegative(),
  familyId: nativeUuid, issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(), mfa: z.literal(true),
}).strict();
export type StaffNativePrincipal = z.infer<typeof staffNativePrincipalSchema>;
const deny = (): never => { throw new NativeAdmissionError(403); };

/** This grants no new role. Only an existing interactive partner session can
 * seed a staff identity; organization/customer sessions cannot be promoted. */
export function staffNativePrincipalFromAuth(auth: AuthContext, now = Date.now()): StaffNativePrincipal {
  if (auth.principal.kind !== 'user_session' || auth.scope !== 'partner'
    || !auth.partnerId || auth.orgId !== null || auth.token?.mfa !== true
    || auth.token.scope !== 'partner' || auth.token.partnerId !== auth.partnerId
    || auth.token.orgId !== null || auth.token.sub !== auth.user.id) return deny();
  const parsed = staffNativePrincipalSchema.safeParse({ kind: 'staff_native', userId: auth.user.id,
    partnerId: auth.partnerId, authEpoch: auth.token.aep, mfaEpoch: auth.token.mep,
    familyId: auth.token.sid, issuedAt: auth.token.iat, expiresAt: now + 12 * 3600_000, mfa: true });
  if (!parsed.success || parsed.data.issuedAt * 1000 > now + 30_000) return deny();
  return parsed.data;
}

/** Revalidated at login, issue, consume and renewal. Identity reads are exact
 * keyed system reads; device/session operations still require tenant RLS. */
export async function revalidateStaffNativePrincipal(input: StaffNativePrincipal) {
  const parsed = staffNativePrincipalSchema.safeParse(input);
  if (!parsed.success || parsed.data.expiresAt <= Date.now()
    || parsed.data.expiresAt > Date.now() + 12 * 3600_000
    || parsed.data.issuedAt * 1000 > Date.now() + 30_000) return deny();
  const principal = parsed.data;
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [user] = await db.select({ id: users.id, status: users.status,
      authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch, passwordChangedAt: users.passwordChangedAt,
      mfaEnabled: users.mfaEnabled,
    }).from(users).where(eq(users.id, principal.userId)).limit(1);
    if (!user || user.status !== 'active' || user.authEpoch !== principal.authEpoch
      || user.mfaEpoch !== principal.mfaEpoch
      || isTokenIssuedBeforePasswordChange(principal.issuedAt, user.passwordChangedAt)
      || await isUserTokenRevoked(principal.userId, principal.issuedAt)
      || await isFamilyRevoked(principal.familyId)
      || !await getActivePartner(principal.partnerId)) return deny();
    if (!user.mfaEnabled && (await getEffectiveMfaPolicy({ scope: 'partner',
      userId: principal.userId, partnerId: principal.partnerId, orgId: null })).required) return deny();
    const permissions = await getUserPermissions(principal.userId,
      { scope: 'partner', partnerId: principal.partnerId }, { bypassCache: true });
    if (!permissions || permissions.scope !== 'partner' || permissions.partnerId !== principal.partnerId
      || permissions.orgId !== null || !['all', 'selected'].includes(permissions.orgAccess ?? '')
      || !hasPermission(permissions, 'remote', 'access')) return deny();
    return { principal, permissions };
  }));
}

/** Caller establishes device-organization RLS before this lookup. Partner
 * ownership is checked independently of the partner's 'all orgs' permission. */
export async function authorizeStaffNativeDevice(principal: StaffNativePrincipal, deviceId: string) {
  if (!nativeUuid.safeParse(deviceId).success) return deny();
  const authority = await revalidateStaffNativePrincipal(principal);
  const [device] = await db.select({ id: devices.id, orgId: devices.orgId, status: devices.status,
    agentTokenSuspendedAt: devices.agentTokenSuspendedAt, quarantinedAt: devices.quarantinedAt,
  }).from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device || device.status !== 'online' || device.agentTokenSuspendedAt || device.quarantinedAt
    || !canAccessOrg(authority.permissions, device.orgId)) return deny();
  const tenant = await getActiveOrgTenant(device.orgId);
  if (!tenant || tenant.partnerId !== principal.partnerId) return deny();
  if (partnerTrustMode() !== 'off') {
    const trust = await evaluateCapability('remote_control', { partnerId: tenant.partnerId,
      orgId: device.orgId, deviceId, userId: principal.userId, detail: { kind: 'staff_native' } });
    if (!trust.allow) return deny();
  }
  if (!(await checkRemoteAccess(deviceId, 'remoteTools')).allowed) return deny();
  return { ...authority, device };
}
