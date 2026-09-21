import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { requireCapability } from '../../services/partnerTrust';
import { readPartnerRemoteAccessSettings } from '../../services/remoteAccessProviders';
import { launchRemoteAccessOption, listRemoteAccessOptions } from '../../services/cloudcom/remoteAccessOptions';
import { writeRouteAudit } from '../../services/auditEvents';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const cloudcomRemoteAccessRoutes = new Hono();

// Per-route middleware only: a wildcard would affect sibling upstream routes.
const guards = [
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REMOTE_ACCESS.resource, PERMISSIONS.REMOTE_ACCESS.action),
  requireMfa(),
  requireCapability('remote_control'),
] as const;
const deviceParams = z.object({ id: z.string().uuid() });
const launchParams = deviceParams.extend({ providerId: z.string().min(1).max(128) });

cloudcomRemoteAccessRoutes.get('/:id/remote-access-options', ...guards,
  zValidator('param', deviceParams), async c => {
    c.header('Cache-Control', 'no-store');
    const device = await getDeviceWithOrgAndSiteCheck(c, c.req.valid('param').id, c.get('auth'));
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    try {
      const settings = await readPartnerRemoteAccessSettings(device.orgId);
      return c.json({ providers: listRemoteAccessOptions({ customFields: device.customFields as Record<string, unknown> | null }, settings) });
    } catch {
      // Errors from config/decryption may contain secrets. Do not log the input
      // or raw exception, or convert a configuration failure into an empty list.
      return c.json({ error: 'Unable to load remote tools', code: 'config_error' }, 500);
    }
  });

cloudcomRemoteAccessRoutes.post('/:id/remote-access-options/:providerId/launch', ...guards,
  zValidator('param', launchParams), async c => {
    c.header('Cache-Control', 'no-store');
    const { id: deviceId, providerId } = c.req.valid('param');
    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, c.get('auth'));
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    let launcher;
    try {
      // Read again at issuance so disabling/removing a provider after opening
      // the menu cannot launch it from a stale client-side snapshot.
      const settings = await readPartnerRemoteAccessSettings(device.orgId);
      launcher = launchRemoteAccessOption({ customFields: device.customFields as Record<string, unknown> | null }, settings, providerId);
    } catch {
      return c.json({ error: 'Unable to launch remote tool', code: 'config_error' }, 500);
    }
    if (!launcher.launchUrl) {
      const rejected = launcher.skipReason === 'scheme_not_allowed';
      if (rejected) writeRouteAudit(c, {
        orgId: device.orgId, action: 'device.remote_access_launch_url.scheme_rejected',
        resourceType: 'device', resourceId: deviceId, resourceName: device.hostname,
        details: { deviceId, providerId }, result: 'denied',
      });
      return c.json({ error: 'Remote tool unavailable', code: launcher.skipReason ?? 'unavailable' }, rejected ? 422 : 404);
    }
    writeRouteAudit(c, {
      orgId: device.orgId, action: 'device.remote_access_launch_url',
      resourceType: 'device', resourceId: deviceId, resourceName: device.hostname,
      details: { deviceId, providerId: launcher.providerId, scheme: launcher.scheme, selection: 'explicit' },
    });
    return c.json({ launchUrl: launcher.launchUrl, providerId: launcher.providerId, scheme: launcher.scheme });
  });
