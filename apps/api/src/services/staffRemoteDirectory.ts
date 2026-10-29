import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { devices, organizations } from '../db/schema';
import { portalNativeTargets } from '../db/schema/portalNative';
import { currentDeviceUser, previousDeviceUsers } from './deviceIdentity';
import { revalidateStaffNativePrincipal, type StaffNativePrincipal } from './staffNativeAuthority';
import { hasPermission } from './permissions';
import { staffNativeAvailability } from './staffNativeAvailability';
import { checkRemoteAccess } from './remoteAccessPolicy';

/** One directory for native and browser staff viewers. Caller establishes the
 * partner RLS context. Fresh org/site restrictions also apply BEFORE pagination,
 * so stale middleware permission caches cannot expose a revoked device name. */
export async function listStaffRemoteComputers(principal: StaffNativePrincipal, cursor?: string) {
  const { permissions } = await revalidateStaffNativePrincipal(principal);
  const orgFilter = permissions.orgAccess === 'all' ? undefined
    : permissions.allowedOrgIds?.length ? inArray(devices.orgId, permissions.allowedOrgIds) : sql`false`;
  const siteFilter = permissions.allowedSiteIds === undefined ? undefined
    : Array.isArray(permissions.allowedSiteIds) && permissions.allowedSiteIds.length
      ? inArray(devices.siteId, permissions.allowedSiteIds) : sql`false`;
  const rows = await db.select({ device: devices, peerId: portalNativeTargets.rustdeskId,
    organizationName: organizations.name, currentUser: currentDeviceUser, previousUsers: previousDeviceUsers })
    .from(devices).innerJoin(portalNativeTargets, and(eq(portalNativeTargets.deviceId, devices.id),
      eq(portalNativeTargets.orgId, devices.orgId), eq(portalNativeTargets.enabled, true)))
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(and(eq(organizations.partnerId, principal.partnerId), orgFilter, siteFilter,
      cursor ? gt(devices.id, cursor) : undefined))
    .orderBy(devices.id).limit(51);
  const page = rows.slice(0, 50);
  const availability = staffNativeAvailability(principal);
  const directory = [];
  for (const { device, peerId, organizationName, currentUser, previousUsers } of page) {
    const native = await availability(device);
    // Transport readiness can differ, but the authorized device set cannot.
    const browserReady = native.available && device.revocationLeaseProtocolVersion === 1
      && device.desktopFenceProtocolVersion === 1 && (await checkRemoteAccess(device.id, 'webrtcDesktop')).allowed;
    directory.push({ id: device.id, hostname: device.hostname, displayName: device.displayName,
      organizationName, organizationId: device.orgId, status: device.status, currentUser, previousUsers,
      canRename: hasPermission(permissions, 'devices', 'write'),
      transports: { rustdesk: { peerId, ...native }, webrtc: browserReady ? { available: true }
        : { available: false, reason: 'Browser remote access is unavailable on this computer.' } } });
  }
  return { devices: directory, nextCursor: rows.length > 50 ? page[page.length - 1]!.device.id : null };
}
