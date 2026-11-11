import { sql } from 'drizzle-orm';
import { db } from '../db';
import type { HarmonyComputer } from '@cloudcom/ext-cloud-command';

export type HarmonySecurityEvidence = {
  provider: 'Check Point Harmony Endpoint'; source: 'cloud'; checkedAt: string; stale: boolean;
  antiMalwareStatus: string | null; engineStatus: string | null; clientVersion: string | null;
  realTimeProtection: boolean | null; definitionsVersion: string | null; definitionsUpdatedAt: string | null;
  lastScanAt: string | null; isolationStatus: string | null;
};
export function harmonySecurityEvidence(e: HarmonyComputer, checkedAt: Date | string, now = Date.now()): HarmonySecurityEvidence {
  const at = new Date(checkedAt).toISOString();
  return { provider:'Check Point Harmony Endpoint',source:'cloud',checkedAt:at,stale:now-Date.parse(at)>30*60_000,
    antiMalwareStatus:e.antiMalwareStatus,engineStatus:e.engineStatus,clientVersion:e.clientVersion,
    realTimeProtection:e.realTimeProtection,definitionsVersion:e.definitionsVersion,definitionsUpdatedAt:e.definitionsUpdatedAt,
    lastScanAt:e.lastScanAt,isolationStatus:e.isolationStatus };
}
/** IDs must come from the already org/site-filtered native device query.
 * Cache RLS and the device/org FK provide an additional boundary. This additive
 * evidence never overwrites agent security_status or turns unknown RTP into true.
 */
export async function attachHarmonySecurity<T extends {deviceId:string}>(statuses:T[]):Promise<Array<T & {cloudAntivirus?:HarmonySecurityEvidence}>> {
  if (process.env.CLOUDCOM_THREECX_ENABLED !== 'true' || statuses.length===0) return statuses;
  const [present] = await db.execute(sql`SELECT to_regclass('public.cloudcommand_harmony_endpoints') IS NOT NULL AND to_regclass('public.cloudcommand_harmony_clients') IS NOT NULL AS present`) as unknown as Array<{present:boolean}>;
  if (!present?.present) return statuses;
  const ids = statuses.map(s => s.deviceId);
  const rows = await db.execute(sql`SELECT e.device_id,e.evidence,c.checked_at FROM cloudcommand_harmony_endpoints e
    JOIN cloudcommand_harmony_clients c ON c.org_id=e.org_id AND c.integration_id=e.integration_id AND c.partner_id=e.partner_id
    WHERE e.device_id IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`) as unknown as Array<{device_id:string;evidence:HarmonyComputer;checked_at:Date}>;
  const evidence = new Map(rows.map(r => [r.device_id,harmonySecurityEvidence(r.evidence,r.checked_at)]));
  return statuses.map(s => evidence.has(s.deviceId) ? {...s,cloudAntivirus:evidence.get(s.deviceId)!} : s);
}
