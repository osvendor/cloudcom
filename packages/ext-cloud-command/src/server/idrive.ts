import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';
import type { IDriveDbRunner, Variables } from './index';
import type { GuardedFetch } from './transport';
import { backupAttention, companyId, idriveAction } from './idrive-contract';
import { assertIDriveTargets, clientOperationResult, createIDriveProvider, IDriveError, scopeIDriveInventory } from './idrive-provider';

type C = Context<{ Variables: Variables }>;
type Connection = { id: string; org_id: string; company_id: number; group_id: number | null; company_name: string; group_name: string | null; secret_ciphertext: string; enabled: boolean; version: number; stale_hours: number; last_verified_at: string | null };
const TABLE = 'cloudcommand_idrive_connections';
const OPS = 'cloudcommand_idrive_operations';
const keySchema = z.string().trim().min(16).max(8192).regex(/^[^\s\r\n]+$/);
const configSchema = z.object({ apiKey: keySchema.optional(), companyId, groupId: companyId.nullable(), enabled: z.boolean(), staleHours: z.number().int().min(1).max(2160), version: z.number().int().positive().nullable() }).strict();
const rows = <T>(v: unknown): T[] => { if (!Array.isArray(v)) throw new Error('Invalid DB result'); return v as T[]; };
async function body<T>(c: C, schema: z.ZodType<T>) { try { return schema.parse(await c.req.json()); } catch { throw new IDriveError('invalid_idrive_input', 400); } }
export function mountIDriveRoutes(app: Hono<{ Variables: Variables }>, context: ExtensionRuntimeContext, fetch: GuardedFetch, runDb?: IDriveDbRunner) {
  const execute = (c: C, query: Parameters<ExtensionRuntimeContext['db']['execute']>[0]) => {
    if (!runDb) throw new IDriveError('idrive_database_runtime_unavailable');
    return runDb(c.get('auth'), () => context.db.execute(query));
  };
  const provider = createIDriveProvider(fetch);
  const configure = (c: C) => c.get('canManage') && c.get('auth').user.isPlatformAdmin === true;
  function requireConfigure(c: C) { if (!configure(c)) throw new IDriveError('idrive_owner_setup_required', 403); }
  function requireManage(c: C) { if (!c.get('canManage')) throw new IDriveError('idrive_write_access_required', 403); }
  const get = async (c: C) => rows<Connection>(await execute(c, sql`SELECT * FROM cloudcommand_idrive_connections WHERE org_id=${c.get('scope').organizationId}::uuid`))[0];
  const key = (row: Connection) => context.secrets.decryptForColumn(TABLE, `secret_ciphertext:${row.org_id}`, row.secret_ciphertext);
  const summary = (c: C, row?: Connection) => ({ available: true, connected: !!row, canManage: c.get('canManage'), canConfigure: configure(c), ...(row ? { companyId: Number(row.company_id), companyName: row.company_name, groupId: row.group_id === null ? null : Number(row.group_id), groupName: row.group_name, enabled: row.enabled, version: row.version, staleHours: row.stale_hours, lastVerifiedAt: row.last_verified_at } : {}) });
  async function connected(c: C) { const row = await get(c); if (!row?.enabled) throw new IDriveError('idrive_not_connected', 404); if (row.group_id === null && !configure(c)) throw new IDriveError('idrive_owner_setup_required', 403); return row; }
  const inventory = async (row: Connection) => scopeIDriveInventory(await provider.inventory(key(row), Number(row.company_id)), row.group_id === null ? null : Number(row.group_id));
  async function audit(c: C, action: string, result: 'success' | 'failure', id: string) {
    await context.audit({ orgId: c.get('scope').organizationId, actorId: c.get('scope').actorId, actorType: 'user', action: `cloudcommand.idrive.${action}`, resourceType: 'integration', resourceId: id, result });
  }
  app.get('/idrive/connection', async c => c.json(summary(c, await get(c))));
  app.post('/idrive/discover', async c => {
    requireConfigure(c);
    const input = await body(c, z.object({ apiKey: keySchema, name: z.string().max(255).optional(), companyId: companyId.optional() }).strict());
    const companies = await provider.companies(input.apiKey, input.name);
    const groups = input.companyId ? (await provider.inventory(input.apiKey, input.companyId)).groups.map(g => ({ id: String(g.id), name: String(g.name ?? ''), devicesCount: Number(g.devices_count ?? 0) })) : [];
    return c.json({ companies, groups });
  });
  app.put('/idrive/connection', async c => {
    requireConfigure(c); const input = await body(c, configSchema); const previous = await get(c);
    if ((previous?.version ?? null) !== input.version) throw new IDriveError('idrive_configuration_changed', 409);
    if (!input.apiKey && !previous) throw new IDriveError('idrive_key_required', 400);
    const plaintext = input.apiKey ?? key(previous!);
    const disabling = previous && !input.enabled && !input.apiKey && Number(previous.company_id) === input.companyId && (previous.group_id === null ? null : Number(previous.group_id)) === input.groupId;
    const company = disabling ? { name: previous.company_name } : await provider.company(plaintext, input.companyId);
    let groupName = previous?.group_name ?? null;
    if (!disabling) {
      const all = await provider.inventory(plaintext, input.companyId);
      const group = input.groupId === null ? null : all.groups.find(g => String(g.id) === String(input.groupId));
      if (input.groupId !== null && !group) throw new IDriveError('idrive_group_unavailable', 400);
      groupName = group ? String(group.name) : null;
    }
    const org = c.get('scope').organizationId;
    const encrypted = context.secrets.encryptForColumn(TABLE, `secret_ciphertext:${org}`, plaintext);
    if (!encrypted.startsWith('enc:v3:')) throw new Error('AAD encryption required');
    const saved = previous ? rows<Connection>(await execute(c, sql`UPDATE cloudcommand_idrive_connections SET company_id=${input.companyId},group_id=${input.groupId},company_name=${company.name},group_name=${groupName},secret_ciphertext=${encrypted},enabled=${input.enabled},stale_hours=${input.staleHours},version=version+1,last_verified_at=now(),updated_at=now() WHERE org_id=${org}::uuid AND version=${input.version} RETURNING *`))[0]
      : rows<Connection>(await execute(c, sql`INSERT INTO cloudcommand_idrive_connections(org_id,company_id,group_id,company_name,group_name,secret_ciphertext,enabled,stale_hours,last_verified_at) VALUES (${org}::uuid,${input.companyId},${input.groupId},${company.name},${groupName},${encrypted},${input.enabled},${input.staleHours},now()) ON CONFLICT (org_id) DO NOTHING RETURNING *`))[0];
    if (!saved) throw new IDriveError('idrive_configuration_changed', 409);
    await audit(c, 'configure', 'success', saved.id); return c.json(summary(c, saved));
  });
  app.get('/idrive/inventory', async c => {
    const row = await connected(c); const data = await inventory(row);
    const attention = data.devices.map(d => ({ deviceId: String(d.device_id), name: String(d.name), reason: backupAttention(d, row.stale_hours) })).filter(d => d.reason);
    return c.json({ ...data, attention, checkedAt: new Date().toISOString(), companyName: row.company_name, groupName: row.group_name });
  });
  app.get('/idrive/installer', async c => {
    requireManage(c); const row = await connected(c);
    const options = z.object({ build_type: z.enum(['WIN', 'MAC', 'RPM', 'DEB', 'MSI', 'PKG']), private_encryption: z.enum(['true', 'false']), full_client: z.enum(['true', 'false']) }).safeParse(c.req.query());
    // orgId belongs to the outer host bridge; strip it before validation.
    if (!options.success) throw new IDriveError('invalid_installer_options', 400);
    return c.json({ ...await provider.installer(key(row), Number(row.company_id), { build_type: options.data.build_type, private_encryption: options.data.private_encryption === 'true', full_client: options.data.full_client === 'true' }), groupAssignmentRequired: row.group_id !== null });
  });
  app.post('/idrive/preview', async c => {
    requireManage(c); const action = await body(c, idriveAction); const row = await connected(c);
    if (row.group_id !== null && ['company.create', 'group.create'].includes(action.kind)) throw new IDriveError('company_scope_required', 403);
    const data = await inventory(row); assertIDriveTargets(action, data);
    if (row.group_id !== null && action.kind === 'plan.create' && !action.data.device_ids?.length && !action.data.group_ids?.length) throw new IDriveError('choose_client_plan_targets', 400);
    const preview = await provider.action(key(row), Number(row.company_id), action, true);
    const id = randomUUID(); const org = c.get('scope').organizationId;
    const cipher = context.secrets.encryptForColumn(OPS, `payload_ciphertext:${org}:${id}`, JSON.stringify(action));
    if (!cipher.startsWith('enc:v3:')) throw new Error('AAD encryption required');
    await execute(c, sql`INSERT INTO cloudcommand_idrive_operations(id,org_id,actor_id,connection_version,kind,payload_ciphertext,expires_at) VALUES (${id}::uuid,${org}::uuid,${c.get('scope').actorId}::uuid,${row.version},${action.kind},${cipher},now()+interval '10 minutes')`);
    return c.json({ previewId: id, action, companyName: row.company_name, groupName: row.group_name, providerPreview: clientOperationResult(preview, row.group_id, true), expiresInSeconds: 600 });
  });
  app.post('/idrive/execute', async c => {
    requireManage(c); const input = await body(c, z.object({ previewId: z.uuid(), confirmed: z.literal(true) }).strict());
    const row = await connected(c); const org = c.get('scope').organizationId;
    const op = rows<{ id: string; payload_ciphertext: string }>(await execute(c, sql`UPDATE cloudcommand_idrive_operations SET status='running' WHERE id=${input.previewId}::uuid AND org_id=${org}::uuid AND actor_id=${c.get('scope').actorId}::uuid AND connection_version=${row.version} AND status='preview' AND expires_at>now() RETURNING id,payload_ciphertext`))[0];
    if (!op) throw new IDriveError('idrive_preview_expired_or_used', 409);
    try {
      const action = idriveAction.parse(JSON.parse(context.secrets.decryptForColumn(OPS, `payload_ciphertext:${org}:${op.id}`, op.payload_ciphertext)));
      const data = await inventory(row); assertIDriveTargets(action, data);
    if (row.group_id !== null && action.kind === 'plan.create' && !action.data.device_ids?.length && !action.data.group_ids?.length) throw new IDriveError('choose_client_plan_targets', 400);
      if (row.group_id !== null && ['company.create', 'group.create'].includes(action.kind)) throw new IDriveError('company_scope_required', 403);
      await audit(c, `${action.kind}.attempt`, 'success', op.id);
      const current = await connected(c);
      if (current.version !== row.version) throw new IDriveError('idrive_configuration_changed', 409);
      const result = await provider.action(key(row), Number(row.company_id), action, false);
      await execute(c, sql`UPDATE cloudcommand_idrive_operations SET status='completed',payload_ciphertext='',completed_at=now() WHERE id=${op.id}::uuid AND org_id=${org}::uuid`);
      await audit(c, action.kind, 'success', op.id);
      return c.json({ result: clientOperationResult(result, row.group_id), operationId: op.id });
    } catch (error) {
      await execute(c, sql`UPDATE cloudcommand_idrive_operations SET status='failed',payload_ciphertext='',completed_at=now() WHERE id=${op.id}::uuid AND org_id=${org}::uuid`);
      await audit(c, 'execute', 'failure', op.id); throw error;
    }
  });
  app.get('/idrive/history', async c => c.json({ operations: rows(await execute(c, sql`SELECT id,kind,status,created_at,completed_at FROM cloudcommand_idrive_operations WHERE org_id=${c.get('scope').organizationId}::uuid ORDER BY created_at DESC LIMIT 50`)) }));
}
