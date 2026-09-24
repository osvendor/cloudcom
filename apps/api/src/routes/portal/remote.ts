import { portalNativeAdmissionRoutes } from './nativeAdmission';
import { Hono } from 'hono';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { bodyLimit } from 'hono/body-limit';
import { portalDesktopRoutes } from './remoteDesktop';
import { portalNativeAuthorizeRoutes } from './nativeLogin';
import { db } from '../../db';
import { devices, portalNativeTargets, portalRemoteAssignments, portalRemoteSettings } from '../../db/schema';
import { isPortalRemoteFeatureEnabled } from '../../services/portalRemoteFeature';
import { authorizePortalRemote } from '../../services/portalRemoteAuthority';
import { checkPortalCompanyGateway } from '../../services/portalCompanyGateway';
import { NATIVE_SESSION_PREFIX } from '../../services/portalNativeLogin';
import { nativeAdmissionEnabled } from '../../services/portalNativeAdmissionSchemas';


export const portalRemoteRoutes = new Hono();

portalRemoteRoutes.use('/remote/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!await isPortalRemoteFeatureEnabled()) return c.json({ error: 'Remote access is not enabled' }, 403);
  const auth = c.get('portalAuth');
  if (auth.user.accessMode !== 'remote_only' || !Number.isSafeInteger(auth.user.authEpoch)) {
    return c.json({ error: 'Remote access is not enabled for this account' }, 403);
  }
  // Native bearer sessions already carry the company claim verified during
  // the browser authorization ceremony, and portalAuthMiddleware rechecks its
  // expiry and organization on every request. All browser and other bearer
  // sessions still need a fresh Cloudflare assertion here.
  if (!(auth.authMethod === 'bearer' && auth.token.startsWith(NATIVE_SESSION_PREFIX))) {
    const company = await checkPortalCompanyGateway(c.req.header('Cf-Access-Jwt-Assertion'), auth.user.orgId);
    if (!company.ok) return c.json({ error: 'Company authentication is required' }, company.status);
  }
  await next();
});

// Cloudflare bypasses its browser challenge on the native path. Keep the
// cookie-based portal list on a separate, Access-protected path so it always
// receives the company assertion. Never allow either credential on the other
// transport's path.
portalRemoteRoutes.on('GET', ['/remote/devices', '/remote/browser/devices'], async c => {
  const auth = c.get('portalAuth');
  const browserPath = c.req.path.endsWith('/remote/browser/devices');
  if (browserPath
    ? auth.authMethod !== 'cookie'
    : auth.authMethod !== 'bearer' || !auth.token.startsWith(NATIVE_SESSION_PREFIX)) {
    return c.json({ error: 'Remote session is not valid for this endpoint' }, 403);
  }
  const { user } = auth;
  // The organization-wide /devices route is deliberately never called here.
  const rows = await db.select({ id: devices.id, hostname: devices.hostname,
    displayName: devices.displayName, status: devices.status,
  }).from(portalRemoteAssignments)
    .innerJoin(devices, and(eq(devices.id, portalRemoteAssignments.deviceId), eq(devices.orgId, portalRemoteAssignments.orgId)))
    .innerJoin(portalRemoteSettings, eq(portalRemoteSettings.orgId, portalRemoteAssignments.orgId))
    .where(and(eq(portalRemoteAssignments.portalUserId, user.id),
      eq(portalRemoteAssignments.orgId, user.orgId), eq(portalRemoteAssignments.enabled, true),
      eq(portalRemoteSettings.enabled, true),
      or(isNull(portalRemoteAssignments.expiresAt), gt(portalRemoteAssignments.expiresAt, new Date()))))
    .orderBy(devices.hostname).limit(200);
  const principal = { id: user.id, orgId: user.orgId, authEpoch: user.authEpoch! };
  const listed = [];
  // Use the same live authority as session creation. This remains advisory:
  // every start and renewal checks authorization again after this response.
  // Sequential queries share the request's transaction without pool fan-out.
  for (const device of rows) {
    const access = await authorizePortalRemote(principal, device.id, 'webrtc');
    const available = access.ok && access.device.revocationLeaseProtocolVersion === 1
      && access.device.desktopFenceProtocolVersion === 1;
    let rustdesk: { available: false; reason: string } | { available: true; peerId: string } = {
      available: false, reason: 'Managed RustDesk client is not ready on this computer',
    };
    if (nativeAdmissionEnabled()) {
      try {
        const nativeAccess = await authorizePortalRemote(principal, device.id, 'rustdesk');
        if (nativeAccess.ok) {
          const [target] = await db.select({ rustdeskId: portalNativeTargets.rustdeskId })
            .from(portalNativeTargets)
            .where(and(eq(portalNativeTargets.orgId, user.orgId), eq(portalNativeTargets.deviceId, device.id),
              eq(portalNativeTargets.enabled, true))).limit(1);
          if (target?.rustdeskId) rustdesk = { available: true, peerId: target.rustdeskId };
        }
      } catch {
        // Native availability is advisory. Its failure must not hide an
        // otherwise authorized browser remote connection.
        rustdesk = { available: false, reason: 'Managed RustDesk availability is temporarily unavailable' };
      }
    }
    listed.push({ ...device, transports: {
      rustdesk,
      webrtc: available ? { available: true } : { available: false, reason: 'Browser remote access is unavailable on this computer' },
    } });
  }
  return c.json({ devices: listed });
});

portalRemoteRoutes.use('/remote/*', bodyLimit({ maxSize: 70000 }));
portalRemoteRoutes.route('/', portalDesktopRoutes);
portalRemoteRoutes.route('/', portalNativeAuthorizeRoutes);
portalRemoteRoutes.route('/', portalNativeAdmissionRoutes);
