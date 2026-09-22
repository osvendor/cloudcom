import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BreezeExtensionV1, ExtensionRuntimeContext, ExtensionRequestAuthorization } from '@breeze/extension-sdk';

type Auth = { user: { id: string }; partnerId: string | null; canAccessOrg(id: string): boolean };
type Variables = { auth: Auth; extensionAuthorization: ExtensionRequestAuthorization; orgId: string; actorId: string };
const uuid = z.string().uuid();
const settingsSchema = z.object({ enabled: z.boolean(), webrtcEnabled: z.boolean(), rustdeskEnabled: z.boolean() }).strict();
const assignmentSchema = z.object({ portalUserId: uuid, deviceId: uuid, expiresAt: z.string().datetime().optional() }).strict();
function rows<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error('Unexpected database result');
  return value as T[];
}

export function createRoutes(context: ExtensionRuntimeContext) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', bodyLimit({ maxSize: 8192 }));
  app.use('/orgs/:orgId/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const auth = c.get('auth');
    const permissions = c.get('extensionAuthorization');
    const parsed = uuid.safeParse(c.req.param('orgId'));
    if (!auth || !permissions) return c.json({ error: 'Authentication required' }, 401);
    if (!parsed.success) return c.json({ error: 'Invalid organization' }, 400);
    // Assignment administration requires organization-wide authority. Site-
    // scoped staff cannot grant access to a device outside their own ceiling.
    if (!auth.canAccessOrg(parsed.data) || permissions.allowedSiteIds !== undefined
      || !permissions.hasPermission('organizations', 'read') || !permissions.hasPermission('remote', 'access')) {
      return c.json({ error: 'Access denied' }, 403);
    }
    if (c.req.method !== 'GET' && (!permissions.mfaSatisfied
      || !permissions.hasPermission('organizations', 'write') || !permissions.hasPermission('users', 'write'))) {
      return c.json({ error: 'Account administration and MFA are required' }, 403);
    }
    const org = rows<{ partner_id: string }>(await context.db.execute(sql`SELECT o.partner_id FROM organizations o JOIN partners p ON p.id=o.partner_id WHERE o.id=${parsed.data}::uuid AND o.deleted_at IS NULL AND o.status IN ('active','trial') AND p.deleted_at IS NULL AND p.status='active'`))[0];
    if (!org || (auth.partnerId && auth.partnerId !== org.partner_id)) return c.json({ error: 'Organization unavailable' }, 404);
    c.set('orgId', parsed.data); c.set('actorId', auth.user.id);
    await next();
  });
  app.onError((_error, c) => {
    context.log('error', 'Remote access administration failed');
    return c.json({ error: 'Unable to complete remote access administration' }, 500);
  });
  app.get('/orgs/:orgId/settings', async c => {
    const found = rows(await context.db.execute(sql`SELECT enabled, webrtc_enabled AS "webrtcEnabled", rustdesk_enabled AS "rustdeskEnabled" FROM portal_remote_settings WHERE org_id=${c.get('orgId')}::uuid`))[0];
    return c.json(found ?? { enabled: false, webrtcEnabled: false, rustdeskEnabled: false });
  });
  app.put('/orgs/:orgId/settings', async c => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid settings' }, 400);
    const input = parsed.data;
    await context.db.execute(sql`INSERT INTO portal_remote_settings(org_id,enabled,webrtc_enabled,rustdesk_enabled) VALUES (${c.get('orgId')}::uuid,${input.enabled},${input.webrtcEnabled},${input.rustdeskEnabled}) ON CONFLICT (org_id) DO UPDATE SET enabled=EXCLUDED.enabled,webrtc_enabled=EXCLUDED.webrtc_enabled,rustdesk_enabled=EXCLUDED.rustdesk_enabled,updated_at=now()`);
    await context.audit({ orgId: c.get('orgId'), actorId: c.get('actorId'), actorType: 'user', result: 'success', action: 'remote_access.settings.updated', resourceType: 'organization', resourceId: c.get('orgId'), details: { orgId: c.get('orgId'), actorId: c.get('actorId'), ...input } });
    return c.json(input);
  });
  app.get('/orgs/:orgId/options', async c => {
    const orgId = c.get('orgId');
    const users = rows(await context.db.execute(sql`SELECT id,name,email,access_mode AS "accessMode" FROM portal_users WHERE org_id=${orgId}::uuid AND status='active' AND auth_method='password' ORDER BY email LIMIT 500`));
    const devices = rows(await context.db.execute(sql`SELECT id,hostname FROM devices WHERE org_id=${orgId}::uuid AND status NOT IN ('decommissioned','quarantined','pending') ORDER BY hostname LIMIT 500`));
    return c.json({ users, devices });
  });
  app.get('/orgs/:orgId/assignments', async c => {
    const assignments = rows(await context.db.execute(sql`SELECT a.id,a.portal_user_id AS "portalUserId",a.device_id AS "deviceId",a.enabled,a.expires_at AS "expiresAt",u.name AS "userName",u.email,d.hostname FROM portal_remote_assignments a JOIN portal_users u ON u.id=a.portal_user_id AND u.org_id=a.org_id JOIN devices d ON d.id=a.device_id AND d.org_id=a.org_id WHERE a.org_id=${c.get('orgId')}::uuid ORDER BY u.email,d.hostname LIMIT 500`));
    return c.json({ assignments });
  });
  app.post('/orgs/:orgId/assignments', async c => {
    const parsed = assignmentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || (parsed.data.expiresAt && Date.parse(parsed.data.expiresAt) <= Date.now())) return c.json({ error: 'Invalid assignment' }, 400);
    const input = parsed.data; const orgId = c.get('orgId');
    // Lock both principals, restrict identity and device within the SAME query,
    // convert the account and write the grant atomically. No intermediate
    // promotion to technician or reliance on linked_user_id.
    const result = rows(await context.db.execute(sql`WITH eligible AS (
      SELECT u.id AS user_id,d.id AS device_id FROM portal_users u JOIN devices d ON d.org_id=u.org_id
      WHERE u.id=${input.portalUserId}::uuid AND d.id=${input.deviceId}::uuid AND u.org_id=${orgId}::uuid
        AND u.status='active' AND u.auth_method='password' AND d.status NOT IN ('decommissioned','quarantined','pending')
      FOR UPDATE OF u,d
    ), converted AS (
      UPDATE portal_users u SET access_mode='remote_only',auth_epoch=CASE WHEN u.access_mode='remote_only' THEN u.auth_epoch ELSE u.auth_epoch+1 END,updated_at=now()
      FROM eligible e WHERE u.id=e.user_id RETURNING u.id
    ) INSERT INTO portal_remote_assignments(org_id,portal_user_id,device_id,created_by_user_id,expires_at)
      SELECT ${orgId}::uuid,e.user_id,e.device_id,${c.get('actorId')}::uuid,${input.expiresAt ?? null}::timestamp FROM eligible e JOIN converted c ON c.id=e.user_id
      ON CONFLICT (portal_user_id,device_id) DO UPDATE SET enabled=true,expires_at=EXCLUDED.expires_at
      RETURNING id,enabled,version`));
    if (!result[0]) return c.json({ error: 'Account or computer unavailable' }, 404);
    await context.audit({ orgId: c.get('orgId'), actorId: c.get('actorId'), actorType: 'user', result: 'success', action: 'remote_access.assignment.granted', resourceType: 'device', resourceId: input.deviceId, details: { orgId, portalUserId: input.portalUserId, actorId: c.get('actorId') } });
    return c.json({ assignment: result[0] }, 201);
  });
  app.delete('/orgs/:orgId/assignments/:id', async c => {
    const parsed = uuid.safeParse(c.req.param('id'));
    if (!parsed.success) return c.json({ error: 'Invalid assignment' }, 400);
    const changed = rows(await context.db.execute(sql`UPDATE portal_remote_assignments SET enabled=false WHERE id=${parsed.data}::uuid AND org_id=${c.get('orgId')}::uuid RETURNING id`));
    if (!changed[0]) return c.json({ error: 'Assignment unavailable' }, 404);
    await context.audit({ orgId: c.get('orgId'), actorId: c.get('actorId'), actorType: 'user', result: 'success', action: 'remote_access.assignment.revoked', resourceType: 'assignment', resourceId: parsed.data, details: { orgId: c.get('orgId'), actorId: c.get('actorId') } });
    return c.json({ success: true });
  });
  return app;
}

const extension: BreezeExtensionV1 = {
  register(registrar, context) { registrar.mountRoute(createRoutes(context) as unknown as Hono); },
};
export default extension;
