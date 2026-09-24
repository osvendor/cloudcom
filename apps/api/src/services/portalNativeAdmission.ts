import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, hasDbAccessContext } from '../db';
import { portalNativeTargets, portalNativeAdmissions, portalRemoteSessions } from '../db/schema';
import { authorizePortalRemote } from './portalRemoteAuthority';
import { resolveRemoteSessionPromptConfig } from '../routes/remote/helpers';
import { resolveDesktopSessionPolicy } from './remoteAccessPolicy';
import { hashNativeTicket, verifyNativeAdmissionProofV2 } from './portalNativeProof';
import { requireNativeContext, lockNativeTarget } from './portalNativeTarget';
import { NativeAdmissionError, type NativeConsume, type NativeOperator, type NativeTarget } from './portalNativeAdmissionSchemas';

export const NATIVE_LEASE_MS = 60_000;
export const NATIVE_RENEW_SECONDS = 20;
/** Retire native rows whose ticket or fail-closed lease is no longer usable.
 * Called under the device's WebRTC start lock so a disconnected native client
 * cannot reserve the computer until its much later hard deadline. */
export async function expireStaleNativeSessionsForDevice(orgId: string, deviceId: string): Promise<void> {
  if (!hasDbAccessContext()) throw new Error('Native session expiry requires a DB access transaction');
  await db.execute(sql`UPDATE portal_remote_sessions AS s SET status='disconnected', ended_at=now()
    WHERE s.org_id=${orgId}::uuid AND s.device_id=${deviceId}::uuid AND s.transport='rustdesk'
      AND s.status IN ('pending','connecting','active')
      AND (s.hard_deadline<=now() OR EXISTS (
        SELECT 1 FROM portal_native_admissions AS a WHERE a.session_id=s.id
          AND (a.presence_until<=now()
            OR (a.consumed_at IS NULL AND a.ticket_expires_at<=now())
            OR (a.consumed_at IS NOT NULL AND a.lease_expires_at<=now()))))`);
}
const randomSecret = () => randomBytes(32).toString('base64url');
export const nativeSessionHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('base64url');
function validDeadline(expiresAt: number) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 12 * 3600_000) throw new NativeAdmissionError(403);
}
const deny = (): never => { throw new NativeAdmissionError(403); };
type Admission = typeof portalNativeAdmissions.$inferSelect;
type Session = typeof portalRemoteSessions.$inferSelect;

async function lockSession(sessionId: string, target: NativeTarget) {
  await lockNativeTarget(target);
  const [session] = await db.select().from(portalRemoteSessions).where(and(eq(portalRemoteSessions.id, sessionId),
    eq(portalRemoteSessions.orgId, target.orgId), eq(portalRemoteSessions.deviceId, target.deviceId),
    eq(portalRemoteSessions.transport, 'rustdesk'))).for('update');
  const [admission] = await db.select().from(portalNativeAdmissions).where(and(eq(portalNativeAdmissions.sessionId, sessionId),
    eq(portalNativeAdmissions.orgId, target.orgId), eq(portalNativeAdmissions.deviceId, target.deviceId),
    eq(portalNativeAdmissions.targetId, target.id))).for('update');
  if (!session || !admission || admission.targetGeneration !== target.generation) return deny();
  return { session, admission };
}
async function live(session: Session, admission: Admission) {
  if (!['pending','active'].includes(session.status) || session.terminationPhase !== 'none' || session.endedAt
    || session.hardDeadline.getTime() <= Date.now() || admission.presenceUntil.getTime() <= Date.now()) return deny();
  const verdict = await authorizePortalRemote({ id: session.portalUserId, orgId: session.orgId, authEpoch: session.authEpoch },
    session.deviceId, 'rustdesk', { assignmentId: session.assignmentId, assignmentVersion: session.assignmentVersion });
  if (!verdict.ok) return deny();
  if ((await resolveRemoteSessionPromptConfig(session.deviceId)).mode !== 'off') return deny();
  const policy = await resolveDesktopSessionPolicy(session.deviceId);
  const deadline = Math.min(session.hardDeadline.getTime(), session.createdAt.getTime() + Math.max(1, policy.maxSessionDurationHours) * 3600_000);
  if (deadline <= Date.now()) return deny();
  if (deadline < session.hardDeadline.getTime()) {
    session.hardDeadline = new Date(deadline);
    await db.update(portalRemoteSessions).set({ hardDeadline: session.hardDeadline }).where(eq(portalRemoteSessions.id, session.id));
  }
  return { clipboard: false, fileTransfer: false, tunnel: false, audio: false, idleTimeoutSeconds: policy.idleTimeoutMinutes * 60 };
}
function leaseExpiry(session: Session, admission: Admission) {
  return Math.min(Date.now() + NATIVE_LEASE_MS, session.hardDeadline.getTime(), admission.presenceUntil.getTime());
}
function leaseResponse(session: Session, admission: Admission, expiresAt: number, policy: Awaited<ReturnType<typeof live>>, token?: string) {
  return { version: 2 as const, sessionId: session.id, connectionId: admission.connectionId!,
    ...(token ? { leaseToken: token } : {}), deviceId: session.deviceId, targetGeneration: admission.targetGeneration,
    revision: admission.leaseRevision, ttlMs: Math.max(0, expiresAt - Date.now()), expiresAt, hardDeadline: session.hardDeadline.getTime(),
    renewEverySec: NATIVE_RENEW_SECONDS, graceSec: 0, policy };
}

export async function issueNativeAdmission(operator: NativeOperator, deviceId: string, operatorPublicKey: string) {
  requireNativeContext(); validDeadline(operator.expiresAt);
  const verdict = await authorizePortalRemote(operator, deviceId, 'rustdesk');
  if (!verdict.ok) return deny();
  const [target] = await db.select().from(portalNativeTargets).where(and(eq(portalNativeTargets.orgId, operator.orgId),
    eq(portalNativeTargets.deviceId, deviceId), eq(portalNativeTargets.enabled, true))).for('update');
  if (!target) return deny();
  const policy = await resolveDesktopSessionPolicy(deviceId);
  // First slice has no native consent ceremony. Never bypass a required prompt.
  if ((await resolveRemoteSessionPromptConfig(deviceId)).mode !== 'off') return deny();
  const hardDeadline = new Date(Math.min(operator.expiresAt, Date.now() + Math.max(1, policy.maxSessionDurationHours) * 3600_000, Date.now() + 12 * 3600_000));
  const [session] = await db.insert(portalRemoteSessions).values({ orgId: operator.orgId, portalUserId: operator.id,
    deviceId, assignmentId: verdict.assignment.id, assignmentVersion: verdict.assignment.version,
    authEpoch: operator.authEpoch, transport: 'rustdesk', status: 'pending', hardDeadline }).returning();
  if (!session) throw new NativeAdmissionError(503);
  const ticket = randomSecret();
  // Leave room for clock skew; the native client rejects tickets with >60s remaining.
  const ticketExpiresAt = Math.min(Date.now() + 45_000, hardDeadline.getTime());
  await db.insert(portalNativeAdmissions).values({ sessionId: session.id, orgId: operator.orgId,
    deviceId, portalUserId: operator.id, targetId: target.id, targetGeneration: target.generation,
    targetPublicKey: target.publicKey, operatorPublicKey, ticketHash: hashNativeTicket(ticket),
    ticketExpiresAt: new Date(ticketExpiresAt), presenceUntil: new Date(ticketExpiresAt), operatorSessionHash: operator.sessionHash });
  return { version: 2 as const, sessionId: session.id, orgId: operator.orgId, deviceId, ticket, ticketExpiresAt,
    hardDeadline: hardDeadline.getTime(), targetId: target.id, targetGeneration: target.generation,
    targetPublicKey: target.publicKey, peerId: target.rustdeskId, transport: 'tcp' as const,
    policy: { clipboard: false, fileTransfer: false, tunnel: false, audio: false, idleTimeoutSeconds: policy.idleTimeoutMinutes * 60 } };
}
export async function consumeNativeAdmission(target: NativeTarget, input: NativeConsume) {
  requireNativeContext();
  const { session, admission } = await lockSession(input.sessionId, target);
  if (session.status !== 'pending' || admission.consumedAt || admission.ticketExpiresAt.getTime() <= Date.now()
    || admission.ticketHash !== hashNativeTicket(input.ticket)) return deny();
  const policy = await live(session, admission);
  const proof = { orgId: session.orgId, deviceId: session.deviceId, sessionId: session.id,
    connectionId: input.connectionId, targetGeneration: admission.targetGeneration, ticketHash: admission.ticketHash,
    targetChallenge: input.targetChallenge, operatorPublicKey: admission.operatorPublicKey,
    targetPublicKey: admission.targetPublicKey, channelBinding: input.channelBinding };
  if (!verifyNativeAdmissionProofV2(proof, input.operatorSignature)) return deny();
  const leaseToken = randomSecret(); const expiresAt = leaseExpiry(session, admission);
  await db.update(portalNativeAdmissions).set({ consumedAt: new Date(), connectionId: input.connectionId,
    targetChallenge: input.targetChallenge, channelBinding: input.channelBinding,
    leaseRevision: 1, leaseHash: hashNativeTicket(leaseToken), leaseExpiresAt: new Date(expiresAt) }).where(eq(portalNativeAdmissions.sessionId, session.id));
  await db.update(portalRemoteSessions).set({ status: 'active' }).where(eq(portalRemoteSessions.id, session.id));
  return leaseResponse(session, { ...admission, connectionId: input.connectionId, leaseRevision: 1 }, expiresAt, policy, leaseToken);
}
async function ownedSession(operator: NativeOperator, sessionId: string) {
  const [target] = await db.select({ target: portalNativeTargets }).from(portalNativeAdmissions)
    .innerJoin(portalNativeTargets, eq(portalNativeTargets.id, portalNativeAdmissions.targetId))
    .where(and(eq(portalNativeAdmissions.sessionId, sessionId), eq(portalNativeAdmissions.orgId, operator.orgId),
      eq(portalNativeAdmissions.portalUserId, operator.id), eq(portalNativeAdmissions.operatorSessionHash, operator.sessionHash))).limit(1);
  if (!target) return deny();
  const result = await lockSession(sessionId, { id: target.target.id, orgId: operator.orgId, deviceId: target.target.deviceId,
    generation: target.target.generation, credentialHash: target.target.credentialHash });
  if (result.session.portalUserId !== operator.id || result.session.authEpoch !== operator.authEpoch) return deny();
  return result;
}
export async function touchNativePresence(operator: NativeOperator, sessionId: string, connectionId: string) {
  requireNativeContext(); validDeadline(operator.expiresAt);
  const { session, admission } = await ownedSession(operator, sessionId);
  if (session.status !== 'active' || admission.connectionId !== connectionId
    || !admission.leaseExpiresAt || admission.leaseExpiresAt.getTime() <= Date.now()) return deny();
  await live(session, admission);
  const expiresAt = Math.min(Date.now() + NATIVE_LEASE_MS, session.hardDeadline.getTime(), operator.expiresAt);
  await db.update(portalNativeAdmissions).set({ presenceUntil: new Date(expiresAt) }).where(eq(portalNativeAdmissions.sessionId, sessionId));
  return { version: 2 as const, expiresAt };
}
export async function renewNativeAdmission(target: NativeTarget, sessionId: string, connectionId: string, leaseToken: string) {
  requireNativeContext();
  const { session, admission } = await lockSession(sessionId, target);
  if (session.status !== 'active' || admission.connectionId !== connectionId || admission.leaseHash !== hashNativeTicket(leaseToken)
    || !admission.leaseExpiresAt || admission.leaseExpiresAt.getTime() <= Date.now()) return deny();
  const policy = await live(session, admission);
  if (admission.leaseRevision >= 2147483646) return deny();
  const revision = admission.leaseRevision + 1;
  const expiresAt = leaseExpiry(session, admission);
  await db.update(portalNativeAdmissions).set({ leaseRevision: revision, leaseExpiresAt: new Date(expiresAt) }).where(eq(portalNativeAdmissions.sessionId, sessionId));
  return leaseResponse(session, { ...admission, leaseRevision: revision }, expiresAt, policy);
}
async function endSession(session: Session) {
  if (session.status !== 'disconnected') {
    await db.update(portalRemoteSessions).set({ status: 'disconnected', endedAt: new Date() }).where(eq(portalRemoteSessions.id, session.id));
    // No WebRTC terminal fence/agent command is synthesized. Native lease expiry is authoritative.
  }
  return { version: 2 as const, ended: true };
}
export async function endNativeAdmission(operator: NativeOperator, sessionId: string) {
  requireNativeContext(); const { session } = await ownedSession(operator, sessionId); return endSession(session);
}
export async function closeNativeAdmission(target: NativeTarget, sessionId: string, connectionId: string) {
  requireNativeContext(); const { session, admission } = await lockSession(sessionId, target);
  if (admission.connectionId !== connectionId) return deny();
  return endSession(session);
}
