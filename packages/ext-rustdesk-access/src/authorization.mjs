/**
 * Pure decision boundary for a future enforced RustDesk transport.
 * Inputs must come from live, server-owned auth and database reads, never a
 * browser/client capability claim. This module does not issue credentials,
 * make stock RustDesk enforce grants, or authorize any production connection.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requiredEnforcement = Object.freeze([
  'endpointChecksEveryConnection',
  'rejectsLegacyPasswordAndClickFallback',
  'oneTimeTargetBoundRedemption',
  'clientProofOfPossession',
  'rechecksLiveGrantAtRedemption',
  'terminatesRevokedSessions',
]);
export const REQUIRED_ENFORCEMENT = requiredEnforcement;
const deny = code => Object.freeze({ allowed: false, code });
const validId = value => typeof value === 'string' && UUID.test(value);

/** No administrator or "same partner" bypass: every user needs a live grant. */
export function evaluateAccess({ actor, device, grant, enforcement, now } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) return deny('invalid_clock');
  if (!actor || !validId(actor.id) || actor.active !== true || actor.sessionActive !== true) return deny('authentication_required');
  if (actor.remoteAccessAllowed !== true || actor.mfaPolicySatisfied !== true) return deny('access_denied');
  if (!device || !validId(device.id) || !validId(device.orgId) || !validId(device.partnerId) || !validId(device.siteId) || device.active !== true) return deny('device_unavailable');
  if (actor.partnerId !== device.partnerId || !Array.isArray(actor.allowedOrgIds) || !actor.allowedOrgIds.includes(device.orgId)) return deny('access_denied');
  if (actor.allowedSiteIds !== undefined && (!Array.isArray(actor.allowedSiteIds) || !actor.allowedSiteIds.includes(device.siteId))) return deny('access_denied');
  if (!grant || !validId(grant.id) || grant.active !== true || grant.userId !== actor.id || grant.deviceId !== device.id || grant.orgId !== device.orgId || grant.partnerId !== device.partnerId) return deny('assignment_required');
  if (!Number.isSafeInteger(grant.version) || grant.version < 1 || !Number.isSafeInteger(grant.notBefore) || !Number.isSafeInteger(grant.expiresAt) || grant.notBefore > now || grant.expiresAt <= now || grant.notBefore >= grant.expiresAt) return deny('assignment_expired');
  if (!enforcement || requiredEnforcement.some(key => enforcement[key] !== true)) return deny('enforcement_unavailable');
  // This is an eligibility decision, never a bearer credential. The broker must
  // repeat live checks and atomically consume its ticket at endpoint redemption.
  return Object.freeze({ allowed: true, code: 'eligible', userId: actor.id, deviceId: device.id, orgId: device.orgId, grantId: grant.id, grantVersion: grant.version });
}

/** A deployment with the stock client remains closed regardless of UI settings. */
export function integrationStatus() {
  return Object.freeze({
    accountAccessEnabled: false,
    credentialHandoffEnabled: false,
    code: 'enforcement_adapter_required',
    requiredEnforcement,
  });
}
