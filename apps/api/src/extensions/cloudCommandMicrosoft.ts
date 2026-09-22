import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { M365ReadAction } from '@breeze/shared/m365';
import type { MicrosoftRequest, MicrosoftResource, NativeMicrosoftServices } from '@cloudcom/ext-cloud-command';
import { db, runOutsideDbContext, withDbAccessContext } from '../db';
import { m365Connections } from '../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../middleware/auth';
import { callGraphReadExecutor, connectionExecutionSnapshot } from '../services/m365ControlPlane/readActionService';
import { isM365GraphReadToolsEnabledForOrg, loadM365CustomerGraphReadRuntimeConfig } from '../services/m365ControlPlane/runtimeConfig';

const actions: Record<MicrosoftResource, M365ReadAction> = {
  users: { type: 'm365.user.list', pageSize: 50 },
  groups: { type: 'm365.group.list', pageSize: 50 },
  licenses: { type: 'm365.org.skus.list' },
  sites: { type: 'm365.sites.list', search: '*' },
};
const denied = { ok: false as const, code: 'access_denied', message: 'Microsoft access is not permitted for this organization.' };
const notReady = { ok: false as const, code: 'connection_not_ready', message: 'Configure or retest this organization’s Microsoft connection in Integrations.' };

// Auth is supplied exclusively by the authenticated extension gateway, not serialized client input.
function authorized(input: MicrosoftRequest): AuthContext | null {
  const auth = input.auth as AuthContext | undefined;
  if (!auth?.user?.id || typeof auth.canAccessOrg !== 'function' || !auth.canAccessOrg(input.orgId)
    || (auth.scope === 'organization' && auth.orgId !== input.orgId)
    || (auth.scope === 'system' && !auth.user.isPlatformAdmin)
    || auth.allowedSiteIds !== undefined || input.authorization.allowedSiteIds !== undefined
    || !input.authorization.hasPermission('organizations', 'read')) return null;
  return auth;
}
function enabled(orgId: string): boolean {
  if (!isM365GraphReadToolsEnabledForOrg(orgId)) return false;
  // Do not infer executor readiness from the feature flag alone. Never expose config errors or secrets.
  try { loadM365CustomerGraphReadRuntimeConfig(); return true; } catch { return false; }
}
async function load(auth: AuthContext, orgId: string) {
  return withDbAccessContext(dbAccessContextFromAuth(auth), async () => {
    const [row] = await db.select().from(m365Connections).where(and(
      eq(m365Connections.orgId, orgId), eq(m365Connections.profile, 'customer-graph-read'),
    )).limit(1);
    return row;
  });
}

/** Small versioned host bridge; native lifecycle, credentials, executor, limits and audits stay upstream-owned. */
export const nativeMicrosoftServices: NativeMicrosoftServices = {
  version: 1,
  async connection(input) {
    const auth = authorized(input);
    if (!auth) return { available: false, connected: false, enabled: false, canManage: false, reason: denied.message };
    return runOutsideDbContext(async () => {
      const row = await load(auth, input.orgId);
      const available = enabled(input.orgId);
      const ready = !!connectionExecutionSnapshot(row);
      return {
        available,
        connected: ready,
        enabled: available && ready,
        canManage: input.authorization.hasPermission('organizations', 'write') && input.authorization.mfaSatisfied,
        ...(row ? { status: row.status, tenantId: row.tenantId ?? undefined, tenantName: row.displayName ?? undefined } : {}),
        ...(!available ? { reason: 'Native Microsoft reads are not configured for this organization.' }
          : !ready ? { reason: notReady.message } : {}),
      };
    });
  },
  async read(input, resource) {
    const auth = authorized(input);
    if (!auth) return denied;
    if (!Object.hasOwn(actions, resource)) return { ok: false, code: 'unsupported_resource', message: 'Unsupported Microsoft resource.' };
    if (!enabled(input.orgId)) return { ok: false, code: 'tools_disabled', message: 'Native Microsoft reads are not configured for this organization.' };
    return runOutsideDbContext(async () => {
      const before = await load(auth, input.orgId);
      const snapshot = connectionExecutionSnapshot(before);
      if (!snapshot) return notReady;
      const result = await callGraphReadExecutor(snapshot, actions[resource], {
        route: 'read', correlationId: randomUUID(), actorId: auth.user.id,
      });
      if (!result.ok) return result;
      // Consent/rebind/revocation during an in-flight read must discard the old tenant's response.
      const after = await load(auth, input.orgId);
      const current = connectionExecutionSnapshot(after);
      if (!current || current.id !== snapshot.id || current.tenantId !== snapshot.tenantId
        || current.consentGeneration !== snapshot.consentGeneration
        || current.permissionManifestVersion !== snapshot.permissionManifestVersion
        || current.credentialVersion !== snapshot.credentialVersion || current.vaultRef !== snapshot.vaultRef
        || before?.clientId !== after?.clientId || !enabled(input.orgId))
        return { ok: false, code: 'connection_changed', message: 'The Microsoft connection changed. Refresh and try again.' };
      if (result.kind !== 'collection') return { ok: false, code: 'invalid_provider_response', message: 'Microsoft returned an unexpected resource response.' };
      return { ok: true, items: result.items, truncated: result.truncated };
    });
  },
};
