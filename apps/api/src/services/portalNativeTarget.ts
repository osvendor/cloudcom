import { and, eq } from 'drizzle-orm';
import { db, hasDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, portalNativeTargets } from '../db/schema';
import { getActiveOrgTenant } from './tenantStatus';
import { hashNativeTicket } from './portalNativeProof';
import { NativeAdmissionError, nativeAdmissionEnabled, type NativeEnrollment, type NativeTarget } from './portalNativeAdmissionSchemas';
import type { AgentAuthContext } from '../middleware/agentAuth';

export function requireNativeContext() {
  if (!nativeAdmissionEnabled()) throw new NativeAdmissionError(404);
  if (!hasDbAccessContext()) throw new Error('Native admission requires a transaction-scoped database context');
}
export async function lockNativeTarget(target: NativeTarget) {
  requireNativeContext();
  const [row] = await db.select().from(portalNativeTargets).where(and(eq(portalNativeTargets.id, target.id),
    eq(portalNativeTargets.orgId, target.orgId), eq(portalNativeTargets.deviceId, target.deviceId))).for('update');
  if (!row || !row.enabled || row.generation !== target.generation || row.credentialHash !== target.credentialHash) throw new NativeAdmissionError(403);
  return row;
}
/** Credential lookup is the only system-scoped operation; callers establish the resolved org context next. */
export async function authenticateNativeTarget(bearer: string | undefined): Promise<NativeTarget | null> {
  if (!nativeAdmissionEnabled() || !bearer?.startsWith('Bearer cct1.')) return null;
  let hash: string;
  try { hash = hashNativeTicket(bearer.slice('Bearer cct1.'.length)); } catch { return null; }
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db.select({ target: portalNativeTargets, device: devices }).from(portalNativeTargets)
      .innerJoin(devices, and(eq(devices.id, portalNativeTargets.deviceId), eq(devices.orgId, portalNativeTargets.orgId)))
      .where(and(eq(portalNativeTargets.credentialHash, hash), eq(portalNativeTargets.enabled, true))).limit(1);
    if (!row || row.device.status !== 'online' || row.device.agentTokenSuspendedAt || row.device.quarantinedAt
      || !await getActiveOrgTenant(row.target.orgId)) return null;
    return { id: row.target.id, orgId: row.target.orgId, deviceId: row.target.deviceId,
      generation: row.target.generation, credentialHash: hash };
  }, 'nativeTarget.authenticate'));
}
/** Target persists its random credential before enrollment. Identical retries do not rotate or return secrets. */
export async function enrollNativeTarget(agent: AgentAuthContext, input: NativeEnrollment, expectedGeneration?: number) {
  requireNativeContext();
  if (agent.role !== 'agent' || !agent.authTokenHash || agent.tenantDraining || agent.deviceUninstallDraining) throw new NativeAdmissionError(403);
  const [device] = await db.select().from(devices).where(and(eq(devices.id, agent.deviceId), eq(devices.orgId, agent.orgId))).for('update');
  if (!device || device.agentTokenHash !== agent.authTokenHash || device.agentTokenSuspendedAt || device.quarantinedAt
    || device.status !== 'online' || !await getActiveOrgTenant(agent.orgId)) throw new NativeAdmissionError(403);
  const [current] = await db.select().from(portalNativeTargets).where(eq(portalNativeTargets.deviceId, agent.deviceId)).for('update');
  const credentialHash = hashNativeTicket(input.targetCredential);
  const values = { installationId: input.installationId, rustdeskId: input.rustdeskId,
    publicKey: input.targetPublicKey, credentialHash };
  let row = current;
  if (!current) {
    if (expectedGeneration !== undefined) throw new NativeAdmissionError(409);
    [row] = await db.insert(portalNativeTargets).values({ ...values, deviceId: agent.deviceId, orgId: agent.orgId }).returning();
  } else if (expectedGeneration === undefined) {
    if (!current.enabled || current.orgId !== agent.orgId || current.installationId !== input.installationId
      || current.publicKey !== input.targetPublicKey || current.credentialHash !== credentialHash || current.rustdeskId !== input.rustdeskId) throw new NativeAdmissionError(409);
  } else {
    // Explicit compare-and-swap rotation; never recover/overwrite an installation silently.
    if (current.orgId !== agent.orgId || current.generation !== expectedGeneration || credentialHash === current.credentialHash) throw new NativeAdmissionError(409);
    [row] = await db.update(portalNativeTargets).set({ ...values, generation: expectedGeneration + 1, enabled: true, updatedAt: new Date() })
      .where(and(eq(portalNativeTargets.id, current.id), eq(portalNativeTargets.orgId, agent.orgId))).returning();
  }
  if (!row) throw new NativeAdmissionError(503);
  return { version: 2 as const, targetId: row.id, deviceId: row.deviceId, orgId: row.orgId,
    targetGeneration: row.generation, targetPublicKey: row.publicKey, peerId: row.rustdeskId };
}
