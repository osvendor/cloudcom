import { getActiveOrgTenant } from './tenantStatus';
import { checkRemoteAccess } from './remoteAccessPolicy';
import { resolveRemoteSessionPromptConfig } from '../routes/remote/helpers';
import { evaluateCapability } from './partnerTrust';
import { partnerTrustMode } from '../config/partnerTrustMode';
import { nativeAdmissionEnabled } from './portalNativeAdmissionSchemas';
import type { StaffNativePrincipal } from './staffNativeAuthority';

type DirectoryDevice = { id: string; orgId: string; status: string;
  agentTokenSuspendedAt: Date | null; quarantinedAt: Date | null };

/** Request-local availability hint, after staff authentication and directory RLS.
 * Admission still performs its full live authorization independently. */
export function staffNativeAvailability(principal: StaffNativePrincipal) {
  const tenants = new Map<string, Awaited<ReturnType<typeof getActiveOrgTenant>>>();
  return async (device: DirectoryDevice) => {
    const unavailable = { available: false, reason: 'Remote access is unavailable for this computer.' };
    if (!nativeAdmissionEnabled() || device.status !== 'online'
      || device.agentTokenSuspendedAt || device.quarantinedAt) return unavailable;
    if (!tenants.has(device.orgId)) tenants.set(device.orgId, await getActiveOrgTenant(device.orgId));
    const tenant = tenants.get(device.orgId);
    if (!tenant || tenant.partnerId !== principal.partnerId) return unavailable;
    if (partnerTrustMode() !== 'off') {
      const trust = await evaluateCapability('remote_control', { partnerId: tenant.partnerId,
        orgId: device.orgId, deviceId: device.id, userId: principal.userId, detail: { kind: 'staff_native' } });
      if (!trust.allow) return unavailable;
    }
    if (!(await checkRemoteAccess(device.id, 'remoteTools')).allowed
      || (await resolveRemoteSessionPromptConfig(device.id)).mode !== 'off') return unavailable;
    return { available: true, reason: 'Ready to connect.' };
  };
}
