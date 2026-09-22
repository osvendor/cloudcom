import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BreezeExtensionV1, ExtensionRuntimeContext, ExtensionRequestAuthorization } from '@breeze/extension-sdk';
import { createThreeCxReadService, normalizePbxOrigin, ThreeCxReadError } from '../threecx/read-service.mjs';
import { createProvider, ProviderError, type GuardedFetch } from './transport';
import { readCippDeployment, type CippDeployment } from './cipp-config';
import { CippError } from './cipp-provider';
import { mountMicrosoftRoutes } from './microsoft';

const table = 'cloudcommand_threecx_connections';
type Row = { id: string; org_id: string; origin: string; client_id: string; secret_ciphertext: string;
  department_id: number | null; enabled: boolean; version: number; last_verified_at: string | Date | null };
type Auth = { user: { id: string; isPlatformAdmin?: boolean }; scope?: 'system' | 'partner' | 'organization'; partnerId: string | null; canAccessOrg(id: string): boolean };
type Scope = { organizationId: string; partnerId: string; actorId: string };
export type Variables = { auth: Auth; extensionAuthorization: ExtensionRequestAuthorization; scope: Scope; canManage: boolean };
const uuid = z.string().uuid();
const configSchema = z.object({
  origin: z.string().min(1).max(2048), clientId: z.string().trim().min(1).max(512),
  secret: z.string().min(1).max(8192).optional(), departmentId: z.number().int().min(0).max(2147483647).nullable(),
  enabled: z.boolean(), version: z.number().int().positive().nullable(),
}).strict();
class RouteError extends Error {
  constructor(public code: string, public status: 400 | 401 | 403 | 404 | 409 | 502 = 400) { super(code); }
}
function rows<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  throw new Error('Unexpected database result');
}
function summary(row: Row, canManage: boolean) {
  return { connected: true, canManage, origin: row.origin, clientId: row.client_id,
    departmentId: row.department_id, enabled: row.enabled, version: row.version, lastVerifiedAt: row.last_verified_at };
}

/** Only the statically compiled host can provide this public-egress transport. */
export function createCloudCommandExtension(fetch: GuardedFetch): BreezeExtensionV1 {
  return { register(registrar, context) { registrar.mountRoute(createRoutes(context, fetch) as unknown as Hono); } };
}

export function createRoutes(context: ExtensionRuntimeContext, fetch: GuardedFetch, cippConfig: CippDeployment | null = readCippDeployment(process.env)) {
  const app = new Hono<{ Variables: Variables }>();
  const provider = createProvider(fetch);
  async function connection(orgId: string) {
    return rows<Row>(await context.db.execute(sql`SELECT * FROM cloudcommand_threecx_connections WHERE org_id = ${orgId}::uuid`))[0];
  }
  function secret(row: Row) {
    // Bind ciphertext to this organization as well as the column; copied rows cannot decrypt across tenants.
    return context.secrets.decryptForColumn(table, `secret_ciphertext:${row.org_id}`, row.secret_ciphertext);
  }
  app.use('*', bodyLimit({ maxSize: 16384, onError: c => c.json({ error: 'Request too large', code: 'body_too_large' }, 413) }));
  app.use('*', async (c, next) => {
    const auth = c.get('auth');
    const permissions = c.get('extensionAuthorization');
    if (!auth || !permissions) throw new RouteError('unauthenticated', 401);
    const org = uuid.safeParse(c.req.query('orgId'));
    if (!org.success) throw new RouteError('invalid_organization');
    if (!auth.canAccessOrg(org.data) || !permissions.hasPermission('organizations', 'read') || permissions.allowedSiteIds !== undefined) throw new RouteError('access_denied', 403);
    const canManage = permissions.hasPermission('organizations', 'write') && permissions.mfaSatisfied;
    if (c.req.method !== 'GET' && !canManage) throw new RouteError('configuration_access_denied', 403);
    const organization = rows<{ partner_id: string }>(await context.db.execute(sql`SELECT partner_id FROM organizations WHERE id = ${org.data}::uuid AND deleted_at IS NULL AND status IN ('active', 'trial')`))[0];
    if (!organization || (auth.partnerId && auth.partnerId !== organization.partner_id)) throw new RouteError('not_available', 404);
    c.set('scope', { organizationId: org.data, partnerId: organization.partner_id, actorId: auth.user.id });
    c.set('canManage', canManage);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof CippError) return c.json({ error: 'The Microsoft 365 request could not be completed. Check the CIPP connection and assigned API permissions.', code: error.code }, 502);
    if (error instanceof RouteError) return c.json({ error: error.code.replaceAll('_', ' '), code: error.code }, error.status);
    if (error instanceof ProviderError || error instanceof ThreeCxReadError) return c.json({ error: 'The PBX request could not be completed.', code: error.code }, 502);
    // Never log upstream bodies, URLs, request payloads, token or DB query values.
    context.log('error', '3CX request failed');
    return c.json({ error: 'Unable to complete the request.', code: 'request_failed' }, 500);
  });
  app.get('/threecx/connection', async c => {
    const row = await connection(c.get('scope').organizationId);
    return c.json(row ? summary(row, c.get('canManage')) : { connected: false, canManage: c.get('canManage') });
  });
  async function resolveInput(c: Context<{ Variables: Variables }>) {
    let parsed;
    try { parsed = configSchema.safeParse(await c.req.json()); } catch { throw new RouteError('invalid_configuration'); }
    if (!parsed.success) throw new RouteError('invalid_configuration');
    const input = parsed.data;
    try { input.origin = normalizePbxOrigin(input.origin); } catch { throw new RouteError('invalid_origin'); }
    const scope = c.get('scope') as Scope;
    const previous = await connection(scope.organizationId);
    if ((previous?.version ?? null) !== input.version) throw new RouteError('configuration_changed', 409);
    const sameTarget = previous?.origin === input.origin && previous?.client_id === input.clientId;
    if (!input.secret && (!previous || !sameTarget)) throw new RouteError('secret_required');
    const plaintext = input.secret ?? secret(previous!);
    if (!plaintext) throw new RouteError('secret_required');
    return { input, previous, scope, credentials: { origin: input.origin, clientId: input.clientId, secret: plaintext } };
  }
  app.post('/threecx/test', async c => {
    const { credentials, scope } = await resolveInput(c);
    const groups = await provider.groups(credentials);
    await context.audit({ orgId: scope.organizationId, actorId: scope.actorId, actorType: 'user', action: 'cloudcommand.threecx.test', resourceType: 'integration', resourceId: scope.organizationId, result: 'success' });
    return c.json({ success: true, groups });
  });
  app.put('/threecx/connection', async c => {
    const { input, previous, scope, credentials } = await resolveInput(c);
    // Disabling an existing configuration must remain possible during a PBX outage.
    const disablingOnly = previous && !input.enabled && !input.secret && input.origin === previous.origin && input.clientId === previous.client_id && input.departmentId === previous.department_id;
    let verifiedAt = previous?.last_verified_at ?? null;
    if (!disablingOnly) {
      const groups = await provider.groups(credentials);
      if (input.departmentId !== null && !groups.some(group => group.id === input.departmentId)) throw new RouteError('unknown_department');
      verifiedAt = new Date().toISOString();
    }
    const encrypted = context.secrets.encryptForColumn(table, `secret_ciphertext:${scope.organizationId}`, credentials.secret);
    if (!encrypted.startsWith('enc:v3:')) throw new Error('AAD-bound encryption unavailable');
    let saved: Row | undefined;
    if (previous) {
      saved = rows<Row>(await context.db.execute(sql`UPDATE cloudcommand_threecx_connections SET origin = ${input.origin}, client_id = ${input.clientId}, secret_ciphertext = ${encrypted}, department_id = ${input.departmentId}, enabled = ${input.enabled}, version = version + 1, last_verified_at = ${verifiedAt}, updated_at = now() WHERE org_id = ${scope.organizationId}::uuid AND version = ${input.version} RETURNING *`))[0];
    } else {
      saved = rows<Row>(await context.db.execute(sql`INSERT INTO cloudcommand_threecx_connections (org_id, origin, client_id, secret_ciphertext, department_id, enabled, last_verified_at) VALUES (${scope.organizationId}::uuid, ${input.origin}, ${input.clientId}, ${encrypted}, ${input.departmentId}, ${input.enabled}, ${verifiedAt}) ON CONFLICT (org_id) DO NOTHING RETURNING *`))[0];
    }
    if (!saved) throw new RouteError('configuration_changed', 409);
    await context.audit({ orgId: scope.organizationId, actorId: scope.actorId, actorType: 'user', action: 'cloudcommand.threecx.configure', resourceType: 'integration', resourceId: saved.id, result: 'success', details: { enabled: saved.enabled, version: saved.version } });
    return c.json(summary(saved, true));
  });
  app.get('/threecx/users', async c => {
    const scope = c.get('scope');
    const rawSkip = c.req.query('skip') ?? '0';
    if (!/^\d{1,6}$/.test(rawSkip)) throw new RouteError('invalid_page');
    const skip = Number(rawSkip);
    if (skip > 100000 || skip % 100 !== 0) throw new RouteError('invalid_page');
    const row = await connection(scope.organizationId);
    if (!row?.enabled) throw new RouteError('not_available', 404);
    const service = createThreeCxReadService({
      authorize: async () => true, // The route middleware has already checked live host authorization.
      loadConnection: async () => ({ id: row.id, organizationId: row.org_id, partnerId: scope.partnerId, origin: row.origin, enabled: row.enabled, departmentId: row.department_id }),
      readUsers: async ({ query }: { query: Record<string, string | number> }) => provider.users({ origin: row.origin, clientId: row.client_id, secret: secret(row) }, query),
    });
    return c.json(await service.listExtensions(scope, row.id, skip));
  });
  mountMicrosoftRoutes(app, context, fetch, cippConfig);
  return app;
}
