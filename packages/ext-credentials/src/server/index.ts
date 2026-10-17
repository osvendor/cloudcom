import { randomUUID } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BreezeExtensionV1, ExtensionRuntimeContext, ExtensionRequestAuthorization } from '@breeze/extension-sdk';
import { parseItGlueCsv, previewItGlue } from '../import/itGlue';
import { seal, unseal } from './secrets';
import { generateTotp } from './totp';
import { createDocumentRoutes } from './documents';
import { createBrowserCompanionRoutes } from './browserCompanion';

type Auth = { user: { id: string }; partnerId: string | null; canAccessOrg(id: string): boolean };
type Variables = { auth: Auth; extensionAuthorization: ExtensionRequestAuthorization; orgId: string; actorId: string; sessionId?: string; deviceId?: string };
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const importBody = z.object({ csv: z.string().max(500_000), sourceOrganization: z.string().min(1).max(500) }).strict();
const rows = <T>(value: unknown): T[] => {
  if (!Array.isArray(value)) throw new Error('Unexpected database result');
  return value as T[];
};
// Shared by authorization and the actual record read, so ending/revoking a
// session between those two statements cannot disclose credential material.
const liveSession = (sessionId: string, actorId: string, orgId?: string, deviceId?: string) => sql`SELECT s.org_id,s.device_id FROM remote_sessions s JOIN devices d ON d.id=s.device_id AND d.org_id=s.org_id JOIN users u ON u.id=s.user_id JOIN organizations o ON o.id=s.org_id JOIN partners p ON p.id=o.partner_id WHERE s.id=${sessionId}::uuid AND s.user_id=${actorId}::uuid AND s.type='desktop' AND s.status='active' AND s.ended_at IS NULL AND s.termination_phase='none' AND s.terminal_generation IS NULL AND s.permissions_epoch_snapshot=u.permissions_epoch AND u.status='active' AND d.status NOT IN ('decommissioned','quarantined') AND o.deleted_at IS NULL AND o.status IN ('active','trial') AND p.deleted_at IS NULL AND p.status='active' ${orgId ? sql`AND s.org_id=${orgId}::uuid` : sql``} ${deviceId ? sql`AND s.device_id=${deviceId}::uuid` : sql``}`;

/** Authenticated gateway only. Never expose a global search or seed endpoint. */
export type DurableAudit = (event: { orgId: string; actorId: string; actorType: 'user'; action: string; resourceType: string; resourceId: string; result: 'success'; details: Record<string, unknown> }) => Promise<void>;
export type CompanionAuthorize = (auth: unknown, input: unknown) => Promise<{redirectUri:string}>;
export function createRoutes(context: ExtensionRuntimeContext, durableAudit: DurableAudit, companionAuthorize?: CompanionAuthorize) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.use('*', bodyLimit({ maxSize: 12 * 1024 * 1024 }));
  app.route('/', createDocumentRoutes(context, durableAudit));
  app.route('/browser', createBrowserCompanionRoutes(context, durableAudit, companionAuthorize));
  const authorize: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    const auth = c.get('auth'), permissions = c.get('extensionAuthorization');
    if (!auth || !permissions) return c.json({ error: 'Authentication required' }, 401);
    let orgValue = c.req.param('orgId');
    const sessionValue = c.req.param('sessionId');
    if (sessionValue !== undefined) {
      const sessionId = uuid.safeParse(sessionValue);
      if (!sessionId.success) return c.json({ error: 'Session unavailable' }, 404);
      if (!permissions.hasPermission('remote', 'access') || !permissions.mfaSatisfied || !permissions.hasPermission('credentials', 'read') || permissions.allowedSiteIds !== undefined) return c.json({ error: 'Access denied' }, 403);
      // Bind the vault to the server-owned live desktop. A caller-supplied org,
      // device, disconnected session, or a session owned by another user never
      // grants access. Epoch equality rejects revoked session permissions.
      const session = rows<{ org_id: string; device_id: string }>(await context.db.execute(liveSession(sessionId.data, auth.user.id)))[0];
      if (!session) return c.json({ error: 'Session unavailable' }, 404);
      orgValue = session.org_id;
      c.set('sessionId', sessionId.data); c.set('deviceId', session.device_id);
    }
    const org = uuid.safeParse(orgValue);
    if (!org.success) return c.json({ error: 'Invalid client' }, 400);
    if (!auth.canAccessOrg(org.data) || permissions.allowedSiteIds !== undefined || !permissions.hasPermission('credentials', 'read')) return c.json({ error: 'Access denied' }, 403);
    const action = c.req.path.endsWith('/otp') ? 'otp' : c.req.path.endsWith('/reveal') ? 'reveal' : c.req.method === 'GET' ? 'read' : 'import';
    if (!permissions.hasPermission('credentials', action) || (action !== 'read' && !permissions.mfaSatisfied)) return c.json({ error: 'Credential permission and account verification required' }, 403);
    const found = rows<{partner_id: string}>(await context.db.execute(sql`SELECT o.partner_id FROM organizations o JOIN partners p ON p.id=o.partner_id WHERE o.id=${org.data}::uuid AND o.deleted_at IS NULL AND o.status IN ('active','trial') AND p.deleted_at IS NULL AND p.status='active'`))[0];
    if (!found || (auth.partnerId && auth.partnerId !== found.partner_id)) return c.json({ error: 'Client unavailable' }, 404);
    c.set('orgId', org.data); c.set('actorId', auth.user.id);
    await next();
  };
  app.use('/orgs/:orgId/*', authorize);
  app.use('/sessions/:sessionId/*', authorize);
  app.onError((_error, c) => {
    // Do not log database parameters, parser inputs or cryptographic errors.
    context.log('error', 'Credential operation failed');
    return c.json({ error: 'Unable to complete credential operation' }, 500);
  });
  const audit = (orgId: string, actorId: string, action: string, resourceId: string, details: Record<string, unknown> = {}) => durableAudit({ orgId, actorId, actorType: 'user', action: `credentials.${action}`, resourceType: 'credential', resourceId, result: 'success', details });

  app.on('GET', ['/orgs/:orgId/credentials', '/sessions/:sessionId/credentials'], async c => {
    const query = c.req.query('q') ?? '';
    if (query.length > 200) return c.json({ error: 'Search is too long' }, 400);
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const guard = c.get('sessionId') ? sql`AND EXISTS (${liveSession(c.get('sessionId')!, c.get('actorId'), c.get('orgId'), c.get('deviceId'))})` : sql``;
    const credentials = rows(await context.db.execute(sql`SELECT id,name,category,username,email,url,has_password AS "hasPassword",has_otp AS "hasOtp" FROM credentials_records WHERE org_id=${c.get('orgId')}::uuid AND archived=false ${guard} AND (name ILIKE ${pattern} OR username ILIKE ${pattern} OR email ILIKE ${pattern} OR category ILIKE ${pattern}) ORDER BY name,id LIMIT 200`));
    return c.json({ credentials });
  });
  for (const action of ['reveal', 'otp'] as const) {
    app.on('POST', [`/orgs/:orgId/credentials/:id/${action}`, `/sessions/:sessionId/credentials/:id/${action}`], async c => {
      const id = uuid.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'Credential unavailable' }, 404);
      if (action === 'reveal') {
        const input = z.object({ field: z.literal('password') }).strict().safeParse(await c.req.json().catch(() => null));
        if (!input.success) return c.json({ error: 'Invalid reveal request' }, 400);
      }
      const orgId = c.get('orgId');
      const sessionId = c.get('sessionId');
      const guard = sessionId ? sql`AND EXISTS (${liveSession(sessionId, c.get('actorId'), orgId, c.get('deviceId'))})` : sql``;
      const found = rows<{secret_ciphertext: string}>(await context.db.execute(sql`SELECT secret_ciphertext FROM credentials_records WHERE org_id=${orgId}::uuid AND id=${id.data}::uuid AND archived=false ${guard}`))[0];
      if (!found) return c.json({ error: 'Credential unavailable' }, 404);
      const secret = unseal(context.secrets, orgId, id.data, found.secret_ciphertext);
      if (action === 'otp' && !secret.otpSecret) return c.json({ error: 'No OTP configured' }, 409);
      const result = action === 'otp' ? generateTotp(secret.otpSecret) : { value: secret.password };
      // Audit must succeed before anything sensitive is returned.
      await audit(orgId, c.get('actorId'), action, id.data, c.get('sessionId') ? { sessionId: c.get('sessionId'), deviceId: c.get('deviceId') } : {});
      // The durable audit is asynchronous too. Recheck after it and suppress
      // the response if the session ended while the audit was being recorded.
      if (sessionId && !rows(await context.db.execute(liveSession(sessionId, c.get('actorId'), orgId, c.get('deviceId')))).length) return c.json({ error: 'Session unavailable' }, 404);
      return c.json(result);
    });
  }
  for (const action of ['preview', 'commit'] as const) {
    app.post(`/orgs/:orgId/import/${action}`, async c => {
      const parsed = importBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Invalid import' }, 400);
      let imported;
      try { imported = parseItGlueCsv(parsed.data.csv); } catch { return c.json({ error: 'Invalid IT Glue CSV' }, 400); }
      // A submission belongs to exactly one explicitly chosen source client.
      if (imported.length > 1000) return c.json({ error: 'Import at most 1000 records per batch' }, 413);
      if (!imported.length || imported.some(row => row.sourceOrganization !== parsed.data.sourceOrganization)) return c.json({ error: 'Import must contain exactly the selected client' }, 400);
      const preview = previewItGlue(imported);
      if (action === 'preview') return c.json(preview);
      if (imported.some(row => row.issues.some(issue => !['missing_username', 'missing_password'].includes(issue)))) return c.json({ error: 'Resolve invalid credential records before importing' }, 422);
      const orgId = c.get('orgId');
      const values = imported.map(row => {
        const id = randomUUID();
        const encrypted = seal(context.secrets, orgId, id, { password: row.password, otpSecret: row.otpSecret, notes: row.notes });
        return sql`(${id}::uuid,${orgId}::uuid,${row.name},${row.category},${row.username},${row.email},${row.url},${encrypted},${Boolean(row.password)},${Boolean(row.otpSecret)},${row.archived},${row.sourceOrganization},${row.sourceId})`;
      });
      await audit(orgId, c.get('actorId'), 'import.requested', orgId, { count: imported.length });
      // One statement is atomic. Retries never overwrite existing credentials.
      const inserted = rows(await context.db.execute(sql`INSERT INTO credentials_records (id,org_id,name,category,username,email,url,secret_ciphertext,has_password,has_otp,archived,source_organization,source_id) VALUES ${sql.join(values, sql`, `)} ON CONFLICT (org_id,source_organization,source_id) DO NOTHING RETURNING id`));
      await audit(orgId, c.get('actorId'), 'import.completed', orgId, { inserted: inserted.length, existing: imported.length - inserted.length });
      return c.json({ inserted: inserted.length, existing: imported.length - inserted.length });
    });
  }
  return app;
}
export function createCredentialsExtension(durableAudit: DurableAudit, companionAuthorize?: CompanionAuthorize): BreezeExtensionV1 {
  return { register(registrar, context) { registrar.mountRoute(createRoutes(context, durableAudit, companionAuthorize) as unknown as Hono); } };
}
