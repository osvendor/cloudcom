import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';
import type { AdministrationRuntime } from './admin-runtime';
import { createAdministrationStore } from './admin-store';
import { createAdministrationExecutor, type AdministrationConnection } from './admin-execution';
import { createExchangeMailboxInventoryService } from './exchange-services';
import type { MicrosoftRequest, NativeMicrosoftServices } from './native-microsoft';
import type { GuardedFetch } from './transport';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');
const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const startSchema = z.object({ tenantId: uuid, version: z.number().int().positive().nullable() }).strict();
const completeSchema = z.object({ state: stateSchema, code: z.string().min(1).max(8192).optional(),
  tenant: uuid.optional(), adminConsent: z.boolean().optional(), error: z.string().max(256).optional() }).strict();
const requiredRoles = ['Organization.Read.All', 'User.ReadWrite.All', 'Group.ReadWrite.All', 'User.EnableDisableAccount.All'];
const safeError = (code: string) => ({ ok: false as const, code, message: code === 'unknown_write_outcome'
  ? 'The change may have been applied. Refresh the resource before attempting another change.'
  : 'Microsoft administration could not complete this request. Check the connection and try again.' });
export class AdministrationSetupError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function createAdministrationServices(context: ExtensionRuntimeContext, fetch: GuardedFetch, runtime: AdministrationRuntime): NativeMicrosoftServices {
  const store = createAdministrationStore(context);
  async function authorize(request: MicrosoftRequest, mutation: boolean) {
    const principal = await runtime.authorize(request, request.orgId, mutation);
    if (!principal) throw new AdministrationSetupError('access_denied');
    return principal;
  }
  async function configuration() {
    const config = await runtime.configuration();
    if (!config) throw new AdministrationSetupError('administration_unavailable');
    return config;
  }
  async function audit(request: MicrosoftRequest, action: string, details: Record<string, unknown> = {}) {
    const principal = await authorize(request, true);
    await runtime.audit({ orgId: request.orgId, actorId: principal.actorId, action: `cloudcommand.microsoft.${action}`,
      resourceId: request.orgId, details, result: 'success' });
  }
  const execute = createAdministrationExecutor<MicrosoftRequest>({
    authorize: (request, orgId, operation) => runtime.authorize(request, orgId,
      operation === 'user.create' || operation === 'user.license.assign' || operation === 'user.update' || operation === 'user.password.reset'
      || operation === 'group.create' || operation === 'group.update'
      || operation === 'user.sessions.revoke' || operation === 'user.globalAdmin.get'
      || operation === 'user.globalAdmin.set'
      || operation === 'user.mfa.methods.list' || operation === 'user.mfa.method.remove'
      || operation.startsWith('group.member.')),
    loadConnection: async (_request, orgId) => {
      const row = await store.load(orgId);
      if (!row) return null;
      const { tenantName: _name, verifiedAt: _date, ...connection } = row;
      return connection;
    },
    acquireToken: connection => runtime.acquireToken(connection), fetch,
    audit: event => runtime.audit({ orgId: event.orgId, actorId: event.actorId,
      action: `cloudcommand.microsoft.${event.operation}.${event.phase}`, resourceId: event.connectionId,
      result: event.outcome === 'rejected' || event.outcome === 'unknown' ? 'failure' : 'success',
      details: { executionId: event.executionId, targets: event.targets, changedFields: event.changedFields, outcome: event.outcome ?? 'pending' } }),
  });
  const mailboxInventory = z.object({ type: z.literal('mailbox.inventory'), pageSize: z.number().int().min(1).max(200).optional() }).strict();
  async function exchangeService() {
    const bridge = await runtime.exchange?.();
    if (!bridge) throw new AdministrationSetupError('exchange_unavailable');
    return createExchangeMailboxInventoryService<MicrosoftRequest>({
      authorize: async (request, organizationId) => runtime.authorize(request, organizationId, false),
      loadConnection: async (_request, organizationId) => {
        const row = await store.load(organizationId);
        if (!row) return null;
        const { tenantName: _tenantName, verifiedAt: _verifiedAt, ...value } = row;
        return value;
      },
      registry: bridge.registry, worker: bridge.worker,
      audit: event => runtime.audit({ orgId: event.organizationId, actorId: event.actorId, action: event.action,
        resourceId: event.details.connectionId as string ?? event.organizationId, details: event.details, result: event.result }),
    });
  }
  async function probe(connection: Pick<AdministrationConnection, 'tenantId' | 'clientId' | 'credentialVersion'>) {
    const token = await runtime.acquireToken(connection);
    // Token is obtained only from the fixed Microsoft token endpoint using the bound certificate.
    // Graph's organization response independently verifies which tenant accepts it.
    let roles: string[];
    try { roles = z.object({ roles: z.array(z.string()).max(256) }).parse(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).roles; }
    catch { throw new AdministrationSetupError('permission_check_failed'); }
    const response = await fetch('https://graph.microsoft.com/v1.0/organization?$select=id,displayName', {
      method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
      signal: AbortSignal.timeout(15000), timeoutMs: 15000, maxBytes: 128 * 1024,
    });
    if (!response.ok) throw new AdministrationSetupError('tenant_verification_failed');
    const data = z.object({ value: z.array(z.object({ id: uuid, displayName: z.string().max(512) })).length(1) }).parse(await response.json());
    if (data.value[0]!.id !== connection.tenantId) throw new AdministrationSetupError('tenant_verification_failed');
    if (requiredRoles.some(role => !roles.includes(role))) throw new AdministrationSetupError('administration_permissions_missing');
    return data.value[0]!.displayName;
  }
  const services: NativeMicrosoftServices = {
    version: 1,
    async connection(request) {
      await authorize(request, false);
      const config = await runtime.configuration();
      const row = await store.load(request.orgId);
      const canManage = !!await runtime.authorize(request, request.orgId, true);
      const available = !!config;
      const enabled = !!row?.enabled && row.clientId === config?.clientId && row.credentialVersion === config?.credentialVersion;
      return { available, connected: !!row, enabled, canManage,
        ...(row ? { tenantId: row.tenantId, tenantName: row.tenantName, status: enabled ? 'active' : 'disabled' } : {}),
        ...(!enabled ? { reason: 'Connect Microsoft 365 under Extensions > Connect.' } : {}) };
    },
    async read(request, resource) {
      if (resource === 'sites') return safeError('service_not_available');
      try {
        const result = await execute(request, request.orgId, { type: `${resource}.list` }) as { items: Record<string, unknown>[]; partial: boolean };
        return { ok: true, items: result.items, truncated: result.partial };
      } catch (error) { return safeError(error && typeof error === 'object' && 'code' in error ? String(error.code) : 'provider_failed'); }
    },
    administration: {
      async status(request, recheck) {
        const connection = await services.connection(request);
        const row = await store.load(request.orgId);
        let exchangeReady = false;
        try { exchangeReady = !!await runtime.exchange?.(); } catch { /* capability remains pending */ }
        let verified = false;
        if (recheck && connection.enabled && row) {
          await authorize(request, true);
          await probe(row);
          const after = await store.load(request.orgId);
          if (!after?.enabled || after.generation !== row.generation) throw new AdministrationSetupError('connection_changed');
          verified = true;
        }
        return { state: connection.enabled ? 'ready' : row ? 'needs_attention' : 'not_connected',
          canManage: connection.canManage, canStart: connection.available,
          tenantId: row?.tenantId, tenantName: row?.tenantName, version: row?.generation ?? null,
          reason: connection.enabled ? 'Connected for directory administration. Additional service capabilities are listed separately.' : connection.reason,
          capabilities: [
            { id: 'inventory', label: 'Directory inventory', status: connection.enabled ? 'ready' : 'pending', message: verified ? 'Tenant and application permissions verified.' : undefined },
            { id: 'administration', label: 'User and group administration', status: connection.enabled ? 'ready' : 'pending' },
            { id: 'exchange', label: 'Exchange administration', status: 'pending', message: exchangeReady ? 'Worker configured; mailbox inventory requires a successful provider check.' : 'Exchange worker is not configured in this host.' },
            { id: 'collaboration', label: 'Teams, SharePoint and OneDrive', status: 'pending', message: 'Uses this same connection; service implementation is pending.' },
            { id: 'content-search', label: 'Basic content search and export', status: 'pending', message: 'Search and export API support is still being validated.' },
          ] };
      },
      async start(request, input) {
        const principal = await authorize(request, true);
        const data = startSchema.parse(input), config = await configuration();
        const current = await store.load(request.orgId);
        if ((current?.generation ?? null) !== data.version) throw new AdministrationSetupError('connection_changed');
        const state = opaque(), verifier = opaque(), nonce = opaque();
        const encrypted = context.secrets.encryptForColumn('cloudcommand_microsoft_admin_consent', `verifier_ciphertext:${request.orgId}:${principal.actorId}`, verifier);
        if (!encrypted.startsWith('enc:v3:')) throw new AdministrationSetupError('encryption_unavailable');
        await audit(request, 'consent.start', { tenantId: data.tenantId });
        await store.start({ org_id: request.orgId, actor_id: principal.actorId, tenant_id: data.tenantId,
          client_id: config.clientId, credential_version: config.credentialVersion, expected_generation: data.version,
          state_hash: digest(state), verifier_ciphertext: encrypted, nonce, stage: 'consent' });
        const url = new URL(`https://login.microsoftonline.com/${data.tenantId}/adminconsent`);
        url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, state }).toString();
        return { authorizationUrl: url.href };
      },
      async complete(request, input) {
        const principal = await authorize(request, true), data = completeSchema.parse(input), config = await configuration();
        const stage = data.code ? 'identity' : 'consent';
        const attempt = await store.claim(request.orgId, principal.actorId, digest(data.state), stage);
        if (!attempt) throw new AdministrationSetupError('consent_expired_or_used');
        if (data.error || attempt.client_id !== config.clientId || attempt.credential_version !== config.credentialVersion)
          throw new AdministrationSetupError('consent_rejected');
        const current = await store.load(request.orgId);
        if ((current?.generation ?? null) !== attempt.expected_generation) throw new AdministrationSetupError('connection_changed');
        const verifier = context.secrets.decryptForColumn('cloudcommand_microsoft_admin_consent', `verifier_ciphertext:${request.orgId}:${principal.actorId}`, attempt.verifier_ciphertext);
        if (stage === 'consent') {
          if (data.adminConsent !== true || data.tenant !== attempt.tenant_id) throw new AdministrationSetupError('consent_rejected');
          const state = opaque();
          if (!await store.advance(request.orgId, digest(data.state), digest(state))) throw new AdministrationSetupError('consent_expired_or_used');
          const url = new URL(`https://login.microsoftonline.com/${attempt.tenant_id}/oauth2/v2.0/authorize`);
          url.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', response_mode: 'query',
            redirect_uri: config.redirectUri, scope: 'openid profile', state, nonce: attempt.nonce,
            code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
          return { authorizationUrl: url.href };
        }
        const verified = await runtime.verifyAuthorization({ tenantId: attempt.tenant_id, clientId: attempt.client_id,
          credentialVersion: attempt.credential_version, code: data.code!, codeVerifier: verifier, nonce: attempt.nonce });
        if (verified.tenantId !== attempt.tenant_id) throw new AdministrationSetupError('tenant_verification_failed');
        const tenantName = await probe({ tenantId: attempt.tenant_id, clientId: attempt.client_id, credentialVersion: attempt.credential_version });
        await audit(request, 'consent.verified', { tenantId: verified.tenantId, administratorObjectId: verified.administratorObjectId });
        if (!await store.save(attempt, tenantName)) throw new AdministrationSetupError('connection_changed');
        // Exchange is provisioned from this one saved connection when its host sidecar exists.
        // A worker configuration gap must not invalidate otherwise successful Graph Connect.
        try {
          const saved = await store.load(request.orgId);
          if (saved) await (await exchangeService()).provision((({ tenantName: _name, verifiedAt: _verifiedAt, ...value }) => value)(saved));
        } catch { /* inventory will retry provisioning only after its own authorization/fence */ }
        await store.finish(request.orgId, digest(data.state));
        return { success: true };
      },
      async execute(request, input) {
        const exchange = mailboxInventory.safeParse(input);
        if (exchange.success) return (await exchangeService()).inventory(request, request.orgId, { pageSize: exchange.data.pageSize });
        return execute(request, request.orgId, input);
      },
      async disconnect(request, input) {
        await authorize(request, true);
        const data = z.object({ version: z.number().int().positive() }).strict().parse(input);
        await audit(request, 'disconnect');
        if (!await store.disable(request.orgId, data.version)) throw new AdministrationSetupError('connection_changed');
        try { await (await exchangeService()).revoke(request.orgId); } catch { /* disabled generation fences all future dispatches */ }
        return { success: true };
      },
    },
  };
  return services;
}
