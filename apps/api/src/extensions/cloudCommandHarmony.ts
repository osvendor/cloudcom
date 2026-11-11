import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  createHarmonyProvider, HarmonyError, partitionHarmonyInventory, validateHarmonyMappingSelection,
  type HarmonyCredentials, type HarmonyMapping, type HarmonyRequest, type NativeHarmonyServices,
  type HarmonyConnectionStatus, type HarmonyComputer,
} from '@cloudcom/ext-cloud-command';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { withAuthDbAccessContext, type AuthContext } from '../middleware/auth';
import { encryptSecret, decryptForColumn } from '../services/secretCrypto';
import { safeFetch } from '../services/urlSafety';
import { createAuditLog } from '../services/auditService';

type Connection = {
  id: string; partner_id: string; region: HarmonyCredentials['region']; credentials_encrypted: string;
  enabled: boolean; version: number; checked_at: Date | null; last_status: 'pending' | 'ready' | 'failed'; error_code: string | null;
};
type Scope = { org_id: string; kind: 'group' | 'endpoint'; external_id: string };
const rows = <T>(value: unknown): T[] => { if (!Array.isArray(value)) throw new Error('Invalid DB result'); return value as T[]; };
const query = async <T>(statement: Parameters<typeof db.execute>[0]) => rows<T>(await db.execute(statement));
const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;
const tx = <T>(auth: AuthContext, work: () => Promise<T>) => withAuthDbAccessContext(auth, work);
// A platform administrator may log in through a normal partner membership.
// Once the complete-partner setup gate passes, read every mapping (including
// suspended clients) for that explicit connection. Partial membership must never
// produce a seemingly complete partition. Call only after the owner gate.
const ownerTx = <T>(work: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(work));
const provider = createHarmonyProvider((url, init) => runOutsideDbContext(() => safeFetch(url, {
  ...init, signal: init?.signal ?? undefined, allowPrivateNetwork: false, allowCarrierNat: false,
})));

export function authorizeHarmony(input: HarmonyRequest, configure = false): AuthContext {
  const auth = input.auth as AuthContext | undefined;
  if (!auth?.user?.id || !['system','partner','organization'].includes(auth.scope)
    || typeof auth.canAccessOrg !== 'function' || !auth.canAccessOrg(input.orgId)
    || auth.scope === 'organization' && auth.orgId !== input.orgId
    || auth.scope === 'system' && !auth.user.isPlatformAdmin
    || auth.allowedSiteIds !== undefined || input.authorization.allowedSiteIds !== undefined
    || auth.principal?.kind === 'ai_agent'
    || !input.authorization.hasPermission('organizations','read')) throw new HarmonyError('harmony_access_denied',403);
  // Shared-tenant discovery and partitioning must see every approved mapping.
  // Do not run them under an organization/partial partner scope.
  const fullOwnerScope = auth.scope === 'system' || (auth.scope === 'partner' && !!auth.partnerId && auth.partnerOrgAccess === 'all');
  if (configure && (!fullOwnerScope || !auth.user.isPlatformAdmin || auth.principal?.kind !== 'user_session'
    || !input.authorization.hasPermission('organizations','write') || !input.authorization.mfaSatisfied)) {
    throw new HarmonyError('harmony_owner_setup_required',403);
  }
  return auth;
}
function canConfigure(input: HarmonyRequest) { try { authorizeHarmony(input,true); return true; } catch { return false; } }
async function organization(input: HarmonyRequest) {
  const [org] = await query<{ partner_id: string }>(sql`SELECT partner_id FROM organizations WHERE id=${input.orgId}::uuid AND deleted_at IS NULL AND status IN ('active','trial')`);
  const auth = input.auth as AuthContext;
  if (!org || auth.partnerId && auth.partnerId !== org.partner_id) throw new HarmonyError('harmony_access_denied',403);
  return org;
}
async function getConnection(partnerId: string, lock = false) {
  return (await query<Connection>(sql`SELECT * FROM harmony_integrations WHERE partner_id=${partnerId}::uuid ${lock ? sql`FOR UPDATE` : sql``}`))[0];
}
async function loadOwner(input: HarmonyRequest) {
  authorizeHarmony(input,true);
  return ownerTx(async () => {
    const org = await organization(input);
    const row = await getConnection(org.partner_id);
    if (!row?.enabled) throw new HarmonyError('harmony_not_connected',404);
    return row;
  });
}
function credentials(row: Connection): HarmonyCredentials {
  if (!row.credentials_encrypted.startsWith('enc:v3:')) throw new HarmonyError('harmony_credentials_unavailable');
  const value = decryptForColumn('harmony_integrations',`credentials_encrypted:${row.id}`,row.credentials_encrypted,{ strict:true });
  if (!value) throw new HarmonyError('harmony_credentials_unavailable');
  const parsed = JSON.parse(value) as HarmonyCredentials;
  return { region: row.region, clientId: parsed.clientId, accessKey: parsed.accessKey };
}
function encrypt(id: string, value: HarmonyCredentials) {
  const encrypted = encryptSecret(JSON.stringify({ clientId:value.clientId, accessKey:value.accessKey }),{
    aad:`harmony_integrations.credentials_encrypted:${id}`,
  });
  if (!encrypted?.startsWith('enc:v3:')) throw new HarmonyError('harmony_credentials_unavailable');
  return encrypted;
}
async function audit(input: HarmonyRequest, action: string, resourceId: string) {
  await createAuditLog({ orgId:input.orgId, actorType:'user', actorId:(input.auth as AuthContext).user.id,
    action:`cloudcommand.harmony.${action}`, resourceType:'integration',resourceId,result:'success' });
}
async function scopes(id: string) {
  return query<Scope>(sql`SELECT org_id,kind,external_id FROM cloudcommand_harmony_scopes WHERE integration_id=${id}::uuid ORDER BY org_id,kind,external_id`);
}
const mapping = (s: Scope): HarmonyMapping => ({ orgId:s.org_id,kind:s.kind,externalId:s.external_id });
async function invalidate(id: string) {
  // All old projections disappear in the same transaction as the new version.
  // Org readers never need permission to SELECT the partner-owned secret row.
  await db.execute(sql`DELETE FROM cloudcommand_harmony_clients WHERE integration_id=${id}::uuid`);
}
async function status(input: HarmonyRequest): Promise<HarmonyConnectionStatus> {
  const auth = authorizeHarmony(input); const owner = canConfigure(input);
  return (owner ? ownerTx : (work: () => Promise<HarmonyConnectionStatus>) => tx(auth,work))(async () => {
    const org = await organization(input);
    const selected = await query<Scope>(sql`SELECT org_id,kind,external_id FROM cloudcommand_harmony_scopes WHERE org_id=${input.orgId}::uuid`);
    const [client] = await query<{ checked_at:Date }>(sql`SELECT checked_at FROM cloudcommand_harmony_clients WHERE org_id=${input.orgId}::uuid`);
    const row = owner ? await getConnection(org.partner_id) : undefined;
    const connected = owner ? !!row : !!selected.length;
    return { available:true, connected, enabled:owner ? !!row?.enabled : !!client,
      canConfigure:owner, version:row?.version ?? null, region:row?.region ?? null,
      checkedAt:iso(client?.checked_at), errorCode:row?.error_code ?? null,
      status:!connected ? 'not_connected' : owner && !row?.enabled ? 'disabled' : !selected.length ? 'not_mapped'
        : row?.last_status === 'failed' ? 'failed' : client ? 'ready' : 'pending',
      mappings:selected.map(s => ({ kind:s.kind,externalId:s.external_id })) };
  });
}

async function syncWithContext(
  runDb: <T>(work: () => Promise<T>) => Promise<T>,
  selectOrg: () => Promise<{ partner_id: string }>,
  selectedOrgId: string,
) {
  const lease = randomUUID();    const claimed = await runDb(async () => {
      const org = await selectOrg();
      const [row] = await query<Connection>(sql`UPDATE harmony_integrations SET lease_id=${lease}::uuid,lease_expires_at=now()+interval '3 minutes'
        WHERE partner_id=${org.partner_id}::uuid AND enabled=true AND (lease_id IS NULL OR lease_expires_at<now()) RETURNING *`);
      if (!row) throw new HarmonyError('harmony_sync_busy_or_disabled',409);
      return { row,mappings:(await scopes(row.id)).map(mapping) };
    });
    const { row } = claimed;
    try {
      const all = await provider.administrativeInventory(credentials(row));
      const partition = partitionHarmonyInventory(all,claimed.mappings);
      await runDb(async () => {
        await selectOrg();
        const matched = await query(sql`UPDATE harmony_integrations SET lease_id=NULL,lease_expires_at=NULL,checked_at=${all.checkedAt}::timestamptz,last_status='ready',error_code=NULL,updated_at=now()
          WHERE id=${row.id}::uuid AND enabled=true AND version=${row.version} AND lease_id=${lease}::uuid AND lease_expires_at>now() RETURNING id`);
        if (!matched.length) throw new HarmonyError('harmony_configuration_changed',409);
        // Links survive only when both external identity and client are unchanged.
        const old = await query<{ external_id:string;org_id:string;device_id:string|null }>(sql`SELECT external_id,org_id,device_id FROM cloudcommand_harmony_endpoints WHERE integration_id=${row.id}::uuid`);
        const links = new Map(old.map(e => [`${e.org_id}:${e.external_id}`,e.device_id]));
        await invalidate(row.id);
        for (const projected of partition.projections) {
          // Deleted, merged or suspended clients cannot receive new evidence.
          const [org] = await query(sql`SELECT id FROM organizations WHERE id=${projected.orgId}::uuid AND partner_id=${row.partner_id}::uuid AND deleted_at IS NULL AND status IN ('active','trial')`);
          if (!org) continue;
          await db.execute(sql`INSERT INTO cloudcommand_harmony_clients(org_id,partner_id,integration_id,version,checked_at)
            VALUES(${projected.orgId}::uuid,${row.partner_id}::uuid,${row.id}::uuid,${row.version},${all.checkedAt}::timestamptz)`);
          // A complete sanitized projection is published atomically. No raw vendor rows.
          if (projected.computers.length) {
            const values = projected.computers.map(c => ({ external_id:c.id,device_id:links.get(`${projected.orgId}:${c.id}`) ?? null,evidence:c }));
            await db.execute(sql`INSERT INTO cloudcommand_harmony_endpoints(org_id,partner_id,integration_id,external_id,device_id,evidence)
              SELECT ${projected.orgId}::uuid,${row.partner_id}::uuid,${row.id}::uuid,x.external_id,d.id,x.evidence
              FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS x(external_id text,device_id uuid,evidence jsonb)
              LEFT JOIN devices d ON d.id=x.device_id AND d.org_id=${projected.orgId}::uuid AND d.status<>'decommissioned'`);
          }
        }
      });

      return { checkedAt:all.checkedAt,count:partition.projections.find(p => p.orgId === selectedOrgId)?.computers.length ?? 0,...partition.setup };
    } catch(error) {
      const code = error instanceof HarmonyError ? error.code : 'harmony_sync_failed';
      await runDb(() => db.execute(sql`UPDATE harmony_integrations SET lease_id=NULL,lease_expires_at=NULL,last_status='failed',error_code=${code},updated_at=now()
        WHERE id=${row.id}::uuid AND version=${row.version} AND lease_id=${lease}::uuid`));
      throw error instanceof HarmonyError ? error : new HarmonyError('harmony_sync_failed');
    }

}

export const nativeHarmonyServices: NativeHarmonyServices = {
  version:1, connection:status,
  async configure(input, value) {
    authorizeHarmony(input,true);
    const before = await ownerTx(async () => { const org = await organization(input); return { org, row:await getConnection(org.partner_id) }; });
    if ((before.row?.version ?? null) !== value.version) throw new HarmonyError('harmony_configuration_changed',409);
    const replacing = value.clientId !== undefined || value.accessKey !== undefined || before.row?.region !== value.region;
    if ((!before.row || replacing) && (!value.clientId || !value.accessKey)) throw new HarmonyError('harmony_credentials_required',400);
    const secret: HarmonyCredentials = value.clientId && value.accessKey
      ? { region:value.region,clientId:value.clientId,accessKey:value.accessKey } : credentials(before.row!);
    // Disabling remains possible during a provider outage.
    if (value.enabled || replacing) await provider.administrativeInventory(secret);
    const id = before.row?.id ?? randomUUID(); const cipher = encrypt(id,secret);
    await audit(input,'configure.attempt',id);
    await ownerTx(async () => {
      await organization(input);
      const saved = before.row ? await query(sql`UPDATE harmony_integrations SET region=${value.region},credentials_encrypted=${cipher},enabled=${value.enabled},version=version+1,
        lease_id=NULL,lease_expires_at=NULL,checked_at=NULL,last_status='pending',error_code=NULL,updated_at=now()
        WHERE id=${id}::uuid AND partner_id=${before.org.partner_id}::uuid AND version=${value.version} RETURNING id`)
        : await query(sql`INSERT INTO harmony_integrations(id,partner_id,region,credentials_encrypted,enabled)
          VALUES(${id}::uuid,${before.org.partner_id}::uuid,${value.region},${cipher},${value.enabled}) ON CONFLICT(partner_id) DO NOTHING RETURNING id`);
      if (!saved.length) throw new HarmonyError('harmony_configuration_changed',409);
      await invalidate(id);
      // A changed credential may refer to a different CP tenant with reused IDs.
      if (replacing) await db.execute(sql`DELETE FROM cloudcommand_harmony_scopes WHERE integration_id=${id}::uuid`);
    });
    await audit(input,'configure',id); return status(input);
  },
  async discover(input) {
    const row = await loadOwner(input);
    const all = await provider.administrativeInventory(credentials(row));
    const current = await loadOwner(input);
    if (current.id !== row.id || current.version !== row.version) throw new HarmonyError('harmony_configuration_changed',409);
    return { version:row.version,groups:all.groups.filter(g => g.type === 'GROUP'),computers:all.computers.filter(c => c.deleted !== true).map(c => ({ id:c.id,name:c.name })) };
  },
  async map(input,value) {
    authorizeHarmony(input,true); const row = await loadOwner(input);
    if (row.version !== value.version) throw new HarmonyError('harmony_configuration_changed',409);
    const all = await provider.administrativeInventory(credentials(row));
    await audit(input,'map.attempt',row.id);
    await ownerTx(async () => {
      const org = await organization(input); const current = await getConnection(org.partner_id,true);
      if (!current?.enabled || current.id !== row.id || current.version !== value.version) throw new HarmonyError('harmony_configuration_changed',409);
      const combined = (await scopes(row.id)).filter(s => s.org_id !== input.orgId).map(mapping)
        .concat(value.mappings.map(s => ({ ...s,orgId:input.orgId })));
      // Validate only newly requested scopes; a vanished scope on another client
      // must not prevent removing/fixing this client's mapping.
      validateHarmonyMappingSelection(all,value.mappings.map(s => ({ ...s,orgId:input.orgId })));
      partitionHarmonyInventory(all,combined);
      await db.execute(sql`DELETE FROM cloudcommand_harmony_scopes WHERE org_id=${input.orgId}::uuid AND integration_id=${row.id}::uuid`);
      for (const scope of new Map(value.mappings.map(s => [`${s.kind}:${s.externalId}`,s])).values()) {
        await db.execute(sql`INSERT INTO cloudcommand_harmony_scopes(org_id,partner_id,integration_id,kind,external_id)
          VALUES(${input.orgId}::uuid,${row.partner_id}::uuid,${row.id}::uuid,${scope.kind},${scope.externalId})`);
      }
      await db.execute(sql`UPDATE harmony_integrations SET version=version+1,lease_id=NULL,lease_expires_at=NULL,last_status='pending',error_code=NULL,checked_at=NULL,updated_at=now() WHERE id=${row.id}::uuid`);
      await invalidate(row.id);
    });
    await audit(input,'map',row.id); return status(input);
  },
  async sync(input) {
    authorizeHarmony(input,true);
    const result = await syncWithContext(ownerTx,() => organization(input),input.orgId);
    await audit(input,'sync',input.orgId);
    return result;
  },
  async refreshDue() {
    const runDb = <T>(work: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(work));
    // One connection per tick, never a fleet-wide burst of provider requests.
    const [due] = await runDb(() => query<{partner_id:string;org_id:string}>(sql`
      SELECT i.partner_id,s.org_id FROM harmony_integrations i
      JOIN cloudcommand_harmony_scopes s ON s.integration_id=i.id
      JOIN organizations o ON o.id=s.org_id AND o.partner_id=i.partner_id
      WHERE i.enabled=true AND i.updated_at<now()-interval '15 minutes'
        AND (i.lease_id IS NULL OR i.lease_expires_at<now())
        AND o.deleted_at IS NULL AND o.status IN ('active','trial')
      ORDER BY i.updated_at,s.org_id LIMIT 1`));
    if (!due) return;
    await syncWithContext(runDb,async () => {
      const [org] = await query<{partner_id:string}>(sql`SELECT partner_id FROM organizations WHERE id=${due.org_id}::uuid AND partner_id=${due.partner_id}::uuid AND deleted_at IS NULL AND status IN ('active','trial')`);
      if (!org) throw new HarmonyError('harmony_client_unavailable',409);
      return org;
    },due.org_id);
  },
  async inventory(input) {
    const auth = authorizeHarmony(input);
    return tx(auth,async () => {
      await organization(input);
      const [client] = await query<{ checked_at:Date }>(sql`SELECT checked_at FROM cloudcommand_harmony_clients WHERE org_id=${input.orgId}::uuid`);
      const data = await query<{ evidence:HarmonyComputer;device_id:string|null }>(sql`SELECT evidence,device_id FROM cloudcommand_harmony_endpoints WHERE org_id=${input.orgId}::uuid ORDER BY evidence->>'name',external_id`);
      const devices = canConfigure(input) ? await query<{id:string;name:string}>(sql`SELECT id,COALESCE(display_name,hostname) AS name FROM devices WHERE org_id=${input.orgId}::uuid AND status<>'decommissioned' ORDER BY hostname LIMIT 10000`) : [];
      const checkedAt = iso(client?.checked_at);
      return { computers:data.map(e => ({ ...e.evidence,deviceId:e.device_id })),checkedAt,
        stale:!checkedAt || Date.now()-Date.parse(checkedAt)>30*60_000, devices };
    });
  },
  async link(input,value) {
    authorizeHarmony(input,true);
    await ownerTx(async () => {
      const org = await organization(input);
      // Serialize links with cache publication/config changes.
      const connection = await getConnection(org.partner_id,true);
      if (!connection?.enabled) throw new HarmonyError('harmony_not_connected',404);
      if (value.deviceId) {
        const [device] = await query(sql`SELECT id FROM devices WHERE id=${value.deviceId}::uuid AND org_id=${input.orgId}::uuid AND status<>'decommissioned' FOR KEY SHARE`);
        if (!device) throw new HarmonyError('harmony_device_unavailable',404);
        const [used] = await query(sql`SELECT external_id FROM cloudcommand_harmony_endpoints WHERE device_id=${value.deviceId}::uuid AND external_id<>${value.externalId}`);
        if (used) throw new HarmonyError('harmony_device_already_linked',409);
      }
      const changed = await query(sql`UPDATE cloudcommand_harmony_endpoints e SET device_id=${value.deviceId}::uuid
        FROM cloudcommand_harmony_clients c WHERE e.org_id=${input.orgId}::uuid AND e.integration_id=${connection.id}::uuid AND e.external_id=${value.externalId}
          AND c.org_id=e.org_id AND c.integration_id=e.integration_id AND c.checked_at=${value.checkedAt}::timestamptz AND c.version=${connection.version} RETURNING e.external_id`);
      if (!changed.length) throw new HarmonyError('harmony_inventory_changed',409);
    });
    await audit(input,'link',value.deviceId ?? input.orgId); return { success:true };
  },
};
