import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db } from '../db';
import { devices, portalUsers, portalRemoteAssignments, portalRemoteSettings } from '../db/schema';
import { getActiveOrgTenant } from './tenantStatus';
import { checkRemoteAccess } from './remoteAccessPolicy';
import { partnerTrustMode } from '../config/partnerTrustMode';
import { evaluateCapability } from './partnerTrust';
import { isPortalRemoteFeatureEnabled } from './portalRemoteFeature';

export type PortalRemotePrincipal = { id: string; orgId: string; authEpoch: number };

/** Always scoped to both customer identity and organization; never linkedUserId. */
export async function loadPortalRemoteAssignment(principal: PortalRemotePrincipal, deviceId: string) {
  const [row] = await db.select({
    assignment: portalRemoteAssignments,
    device: devices,
    user: { id: portalUsers.id, authEpoch: portalUsers.authEpoch, name: portalUsers.name },
    settings: portalRemoteSettings,
  }).from(portalRemoteAssignments)
    .innerJoin(portalUsers, and(eq(portalUsers.id, portalRemoteAssignments.portalUserId), eq(portalUsers.orgId, portalRemoteAssignments.orgId)))
    .innerJoin(devices, and(eq(devices.id, portalRemoteAssignments.deviceId), eq(devices.orgId, portalRemoteAssignments.orgId)))
    .innerJoin(portalRemoteSettings, eq(portalRemoteSettings.orgId, portalRemoteAssignments.orgId))
    .where(and(
      eq(portalRemoteAssignments.orgId, principal.orgId),
      eq(portalRemoteAssignments.portalUserId, principal.id),
      eq(portalRemoteAssignments.deviceId, deviceId),
      eq(portalRemoteAssignments.enabled, true),
      or(isNull(portalRemoteAssignments.expiresAt), gt(portalRemoteAssignments.expiresAt, new Date())),
      eq(portalUsers.status, 'active'), eq(portalUsers.authMethod, 'password'),
      eq(portalUsers.accessMode, 'remote_only'), eq(portalUsers.authEpoch, principal.authEpoch),
      eq(portalRemoteSettings.enabled, true),
    )).limit(1);
  return row ?? null;
}

/** Shared live authorization for start, signaling, ticket redemption and renewal. */
export async function authorizePortalRemote(
  principal: PortalRemotePrincipal,
  deviceId: string,
  transport: 'webrtc' | 'rustdesk',
  expected?: { assignmentId: string; assignmentVersion: number },
) {
  if (!await isPortalRemoteFeatureEnabled()) return { ok: false as const, reason: 'extension_disabled' };
  const row = await loadPortalRemoteAssignment(principal, deviceId);
  if (!row) return { ok: false as const, reason: 'assignment_unavailable' };
  if (expected && (row.assignment.id !== expected.assignmentId || row.assignment.version !== expected.assignmentVersion)) {
    return { ok: false as const, reason: 'assignment_changed' };
  }
  if (!Number.isSafeInteger(principal.authEpoch) || principal.authEpoch < 1 || row.device.status !== 'online'
    || row.device.agentTokenSuspendedAt || row.device.quarantinedAt) {
    return { ok: false as const, reason: 'device_unavailable' };
  }
  if (!(transport === 'webrtc' ? row.settings.webrtcEnabled : row.settings.rustdeskEnabled)) {
    return { ok: false as const, reason: 'transport_disabled' };
  }
  const tenant = await getActiveOrgTenant(principal.orgId);
  if (!tenant) return { ok: false as const, reason: 'organization_unavailable' };
  if (partnerTrustMode() !== 'off') {
    // No technician user id is synthesized for this customer principal.
    const trust = await evaluateCapability('remote_control', {
      partnerId: tenant.partnerId, deviceId,
      detail: { kind: 'portal_remote', portalUserId: principal.id },
    });
    if (!trust.allow) return { ok: false as const, reason: 'remote_control_denied' };
  }
  const policy = await checkRemoteAccess(deviceId, transport === 'webrtc' ? 'webrtcDesktop' : 'remoteTools');
  if (!policy.allowed) return { ok: false as const, reason: 'policy_denied' };
  return { ok: true as const, ...row };
}
