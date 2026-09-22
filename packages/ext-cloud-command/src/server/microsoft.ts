import type { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';
import type { Variables } from './index';
import type { CippDeployment } from './cipp-config';
import { cippResources, createCippProvider, type CippResource } from './cipp-provider';
import type { GuardedFetch } from './transport';

type Row = { id: string; org_id: string; tenant_id: string; tenant_domain: string; tenant_name: string; backend_identity: string; enabled: boolean; version: number };
const inputSchema = z.object({ tenantId: z.string().uuid(), enabled: z.boolean(), version: z.number().int().positive().nullable() }).strict();
function rows<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error('Unexpected database result');
  return value as T[];
}

/** Host middleware has resolved live auth, active organization, RLS and read/write permissions. */
export function mountMicrosoftRoutes(app: Hono<{ Variables: Variables }>, context: ExtensionRuntimeContext, fetch: GuardedFetch, config: CippDeployment | null) {
  const provider = config ? createCippProvider(fetch, config) : null;
  const connection = async (orgId: string) => rows<Row>(await context.db.execute(sql`SELECT * FROM cloudcommand_microsoft_connections WHERE org_id = ${orgId}::uuid`))[0];
  function summary(row: Row | undefined, canManage: boolean) {
    if (!row) return { available: true, connected: false, canManage };
    const current = row.backend_identity === config!.identity;
    return { available: true, connected: current, canManage, enabled: row.enabled && current,
      tenantId: row.tenant_id, tenantName: row.tenant_name, version: row.version,
      ...(!current ? { reason: 'The CIPP backend changed. Reconnect this organization.' } : {}) };
  }
  app.use('/microsoft/*', async (c, next) => {
    const scope = c.get('scope');
    const auth = c.get('auth');
    const canManage = c.get('canManage') && ((auth.scope === 'system' && auth.user.isPlatformAdmin === true) || (auth.scope === 'partner' && auth.partnerId === config?.partnerId));
    c.set('canManage', canManage);
    if (!config || config.partnerId !== scope.partnerId) {
      if (c.req.path.endsWith('/connection') && c.req.method === 'GET') return c.json({ available: false, connected: false, canManage: false, reason: 'A CIPP backend has not been configured for this partner.' });
      return c.json({ error: 'Microsoft 365 is not available for this organization.', code: 'cipp_not_available' }, 503);
    }
    if ((c.req.method !== 'GET' || c.req.path.endsWith('/tenants')) && !canManage) return c.json({ error: 'Partner configuration access is required.', code: 'access_denied' }, 403);
    await next();
  });
  app.get('/microsoft/connection', async c => c.json(summary(await connection(c.get('scope').organizationId), c.get('canManage'))));
  app.get('/microsoft/tenants', async c => c.json({ items: await provider!.tenants() }));
  app.put('/microsoft/connection', async c => {
    const input = inputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: 'Invalid tenant binding.', code: 'invalid_binding' }, 400);
    const scope = c.get('scope');
    const previous = await connection(scope.organizationId);
    if ((previous?.version ?? null) !== input.data.version) return c.json({ error: 'The connection changed. Refresh before saving.', code: 'configuration_changed' }, 409);
    const disablingOnly = previous && !input.data.enabled && previous.tenant_id === input.data.tenantId;
    const tenant = disablingOnly ? { id: previous.tenant_id, name: previous.tenant_name, domain: previous.tenant_domain } : (await provider!.tenants()).find(item => item.id === input.data.tenantId.toLowerCase());
    if (!tenant) return c.json({ error: 'The tenant is not available to this CIPP connection.', code: 'tenant_not_available' }, 400);
    // Disabling a stale binding must not silently rebind it to a replacement backend.
    const identity = disablingOnly ? previous.backend_identity : config!.identity;
    let saved: Row | undefined;
    if (previous) saved = rows<Row>(await context.db.execute(sql`UPDATE cloudcommand_microsoft_connections SET tenant_id = ${tenant.id}::uuid, tenant_domain = ${tenant.domain}, tenant_name = ${tenant.name}, backend_identity = ${identity}, enabled = ${input.data.enabled}, version = version + 1, updated_at = now() WHERE org_id = ${scope.organizationId}::uuid AND version = ${input.data.version} RETURNING *`))[0];
    else saved = rows<Row>(await context.db.execute(sql`INSERT INTO cloudcommand_microsoft_connections (org_id, tenant_id, tenant_domain, tenant_name, backend_identity, enabled) VALUES (${scope.organizationId}::uuid, ${tenant.id}::uuid, ${tenant.domain}, ${tenant.name}, ${identity}, ${input.data.enabled}) ON CONFLICT (org_id) DO NOTHING RETURNING *`))[0];
    if (!saved) return c.json({ error: 'The connection changed. Refresh before saving.', code: 'configuration_changed' }, 409);
    await context.audit({ orgId: scope.organizationId, actorId: scope.actorId, actorType: 'user', action: 'cloudcommand.microsoft.bind', resourceType: 'integration', resourceId: saved.id, result: 'success', details: { tenantId: saved.tenant_id, enabled: saved.enabled, version: saved.version } });
    return c.json(summary(saved, true));
  });
  app.get('/microsoft/resources/:resource', async c => {
    const resource = c.req.param('resource');
    if (!Object.hasOwn(cippResources, resource)) return c.json({ error: 'Unsupported resource.', code: 'unsupported_resource' }, 404);
    const row = await connection(c.get('scope').organizationId);
    if (!row?.enabled || row.backend_identity !== config!.identity) return c.json({ error: 'Connect and enable this organization first.', code: 'connection_disabled' }, 409);
    // Revalidate tenant identity/domain against CIPP RBAC on every read: stale/reassigned bindings fail closed.
    const tenant = (await provider!.tenants()).find(item => item.id === row.tenant_id && item.domain === row.tenant_domain);
    if (!tenant) return c.json({ error: 'The tenant binding is no longer available. Reconnect the organization.', code: 'tenant_not_available' }, 409);
    return c.json(await provider!.resource(resource as CippResource, tenant.domain));
  });
}
