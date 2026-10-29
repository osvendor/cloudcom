import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { devices, organizations } from '../db/schema';
import { portalNativeTargets } from '../db/schema/portalNative';
import { canAccessOrg, hasPermission } from './permissions';
import { getActiveOrgTenant } from './tenantStatus';
import { revalidateStaffNativePrincipal, type StaffNativePrincipal } from './staffNativeAuthority';
import { NativeAdmissionError } from './portalNativeAdmissionSchemas';

/** Only the display name is writable through the managed viewer. The native
 * bearer remains separate from browser/API credentials, with live permissions. */
export async function renameStaffNativeDevice(principal: StaffNativePrincipal, deviceId: string, displayName: string | null) {
  const { permissions } = await revalidateStaffNativePrincipal(principal);
  if (!hasPermission(permissions, 'devices', 'write')) throw new NativeAdmissionError(403);
  const [device] = await db.select({ id: devices.id, orgId: devices.orgId, displayName: devices.displayName })
    .from(devices)
    .innerJoin(organizations, and(eq(organizations.id, devices.orgId), eq(organizations.partnerId, principal.partnerId)))
    .innerJoin(portalNativeTargets, and(eq(portalNativeTargets.deviceId, devices.id),
      eq(portalNativeTargets.orgId, devices.orgId), eq(portalNativeTargets.enabled, true)))
    .where(eq(devices.id, deviceId)).limit(1);
  if (!device || !canAccessOrg(permissions, device.orgId)) throw new NativeAdmissionError(404);
  const tenant = await getActiveOrgTenant(device.orgId);
  if (!tenant || tenant.partnerId !== principal.partnerId) throw new NativeAdmissionError(404);
  const [updated] = await db.update(devices).set({ displayName, updatedAt: new Date() })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, device.orgId)))
    .returning({ id: devices.id, displayName: devices.displayName });
  if (!updated) throw new NativeAdmissionError(404);
  return { ...updated, orgId: device.orgId, previousName: device.displayName };
}
