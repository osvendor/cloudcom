import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { staffNativeSessions } from '../db/schema/staffNative';
import { portalNativeTargets } from '../db/schema/portalNative';
import { hashNativeTicket, verifyNativeAdmissionProofV2 } from './portalNativeProof';
import { requireNativeContext, lockNativeTarget } from './portalNativeTarget';
import { NativeAdmissionError, type NativeTarget, type NativeConsume } from './portalNativeAdmissionSchemas';
import { authorizeStaffNativeDevice, type StaffNativePrincipal } from './staffNativeAuthority';
import { loadStaffNativeSession, staffNativeEnabled } from './staffNativeLogin';
import { resolveRemoteSessionPromptConfig } from '../routes/remote/helpers';
import { resolveDesktopSessionPolicy } from './remoteAccessPolicy';

export type StaffNativeOperator = { principal: StaffNativePrincipal; sessionHash: string };
type Session = typeof staffNativeSessions.$inferSelect;
const deny = (): never => { throw new NativeAdmissionError(403); };
const secret = () => randomBytes(32).toString('base64url');
function context() { requireNativeContext(); if (!staffNativeEnabled()) throw new NativeAdmissionError(404); }
async function lockSession(target: NativeTarget, id: string) {
  await lockNativeTarget(target);
  const [session] = await db.select().from(staffNativeSessions).where(and(eq(staffNativeSessions.id, id),
    eq(staffNativeSessions.orgId, target.orgId), eq(staffNativeSessions.deviceId, target.deviceId),
    eq(staffNativeSessions.targetId, target.id))).for('update');
  if (!session || session.targetGeneration !== target.generation) return deny();
  return session;
}
async function live(session: Session) {
  if (!['pending', 'active'].includes(session.status) || session.endedAt
    || session.hardDeadline.getTime() <= Date.now() || session.presenceUntil.getTime() <= Date.now()) return deny();
  const principal = await loadStaffNativeSession(session.operatorSessionHash);
  if (principal.userId !== session.staffUserId) return deny();
  const authority = await authorizeStaffNativeDevice(principal, session.deviceId);
  if (authority.device.orgId !== session.orgId) return deny();
  // Native protocol has no consent UI. Required endpoint prompts cannot be bypassed.
  if ((await resolveRemoteSessionPromptConfig(session.deviceId)).mode !== 'off') return deny();
  const policy = await resolveDesktopSessionPolicy(session.deviceId);
  const deadline = Math.min(session.hardDeadline.getTime(), principal.expiresAt,
    session.createdAt.getTime() + Math.max(1, policy.maxSessionDurationHours) * 3600_000);
  if (deadline <= Date.now()) return deny();
  if (deadline < session.hardDeadline.getTime()) {
    session.hardDeadline = new Date(deadline);
    await db.update(staffNativeSessions).set({ hardDeadline: session.hardDeadline }).where(eq(staffNativeSessions.id, session.id));
  }
  return { clipboard: false, fileTransfer: false, tunnel: false, audio: false, idleTimeoutSeconds: policy.idleTimeoutMinutes * 60 };
}
function expiry(session: Session) { return Math.min(Date.now() + 60_000, session.hardDeadline.getTime(), session.presenceUntil.getTime()); }
function response(session: Session, expiresAt: number, policy: Awaited<ReturnType<typeof live>>, leaseToken?: string) {
  return { version: 2 as const, sessionId: session.id, connectionId: session.connectionId!,
    ...(leaseToken ? { leaseToken } : {}), deviceId: session.deviceId, targetGeneration: session.targetGeneration,
    revision: session.leaseRevision, ttlMs: Math.max(0, expiresAt - Date.now()), expiresAt,
    hardDeadline: session.hardDeadline.getTime(), renewEverySec: 20, graceSec: 0, policy };
}
export async function issueStaffNativeAdmission(operator: StaffNativeOperator, deviceId: string, operatorPublicKey: string) {
  context();
  const { device } = await authorizeStaffNativeDevice(operator.principal, deviceId);
  const [target] = await db.select().from(portalNativeTargets).where(and(eq(portalNativeTargets.deviceId, deviceId),
    eq(portalNativeTargets.orgId, device.orgId), eq(portalNativeTargets.enabled, true))).for('update');
  if (!target || (await resolveRemoteSessionPromptConfig(deviceId)).mode !== 'off') return deny();
  const policy = await resolveDesktopSessionPolicy(deviceId);
  const hardDeadline = new Date(Math.min(operator.principal.expiresAt, Date.now() + Math.max(1, policy.maxSessionDurationHours) * 3600_000));
  const ticket = secret(); const ticketExpiresAt = Math.min(Date.now() + 45_000, hardDeadline.getTime());
  const [session] = await db.insert(staffNativeSessions).values({ orgId: device.orgId, deviceId,
    staffUserId: operator.principal.userId, targetId: target.id, targetGeneration: target.generation,
    targetPublicKey: target.publicKey, operatorPublicKey, operatorSessionHash: operator.sessionHash,
    hardDeadline, ticketHash: hashNativeTicket(ticket), ticketExpiresAt: new Date(ticketExpiresAt),
    presenceUntil: new Date(ticketExpiresAt) }).returning();
  if (!session) throw new NativeAdmissionError(503);
  return { version: 2 as const, sessionId: session.id, orgId: device.orgId, deviceId, ticket, ticketExpiresAt,
    hardDeadline: hardDeadline.getTime(), targetId: target.id, targetGeneration: target.generation,
    targetPublicKey: target.publicKey, peerId: target.rustdeskId, transport: 'tcp' as const,
    policy: { clipboard: false, fileTransfer: false, tunnel: false, audio: false, idleTimeoutSeconds: policy.idleTimeoutMinutes * 60 } };
}
export async function consumeStaffNativeAdmission(target: NativeTarget, input: NativeConsume) {
  context(); const session = await lockSession(target, input.sessionId);
  if (session.status !== 'pending' || session.consumedAt || session.ticketExpiresAt.getTime() <= Date.now()
    || session.ticketHash !== hashNativeTicket(input.ticket)) return deny();
  const policy = await live(session);
  if (!verifyNativeAdmissionProofV2({ orgId: session.orgId, deviceId: session.deviceId, sessionId: session.id,
    connectionId: input.connectionId, targetGeneration: session.targetGeneration, ticketHash: session.ticketHash,
    targetChallenge: input.targetChallenge, operatorPublicKey: session.operatorPublicKey,
    targetPublicKey: session.targetPublicKey, channelBinding: input.channelBinding }, input.operatorSignature)) return deny();
  const leaseToken = secret(); const expiresAt = expiry(session);
  await db.update(staffNativeSessions).set({ status: 'active', consumedAt: new Date(), connectionId: input.connectionId,
    targetChallenge: input.targetChallenge, channelBinding: input.channelBinding, leaseRevision: 1,
    leaseHash: hashNativeTicket(leaseToken), leaseExpiresAt: new Date(expiresAt) }).where(eq(staffNativeSessions.id, session.id));
  return response({ ...session, connectionId: input.connectionId, leaseRevision: 1 }, expiresAt, policy, leaseToken);
}
async function owned(operator: StaffNativeOperator, id: string) {
  const [row] = await db.select({ target: portalNativeTargets }).from(staffNativeSessions)
    .innerJoin(portalNativeTargets, eq(portalNativeTargets.id, staffNativeSessions.targetId))
    .where(and(eq(staffNativeSessions.id, id), eq(staffNativeSessions.staffUserId, operator.principal.userId),
      eq(staffNativeSessions.operatorSessionHash, operator.sessionHash))).limit(1);
  if (!row) return deny();
  return lockSession({ id: row.target.id, orgId: row.target.orgId, deviceId: row.target.deviceId,
    generation: row.target.generation, credentialHash: row.target.credentialHash }, id);
}
export async function touchStaffNativePresence(operator: StaffNativeOperator, id: string, connectionId: string) {
  context(); const session = await owned(operator, id);
  if (session.status !== 'active' || session.connectionId !== connectionId
    || !session.leaseExpiresAt || session.leaseExpiresAt.getTime() <= Date.now()) return deny();
  await live(session);
  const expiresAt = Math.min(Date.now() + 60_000, session.hardDeadline.getTime(), operator.principal.expiresAt);
  await db.update(staffNativeSessions).set({ presenceUntil: new Date(expiresAt) }).where(eq(staffNativeSessions.id, id));
  return { version: 2 as const, expiresAt };
}
export async function renewStaffNativeAdmission(target: NativeTarget, id: string, connectionId: string, leaseToken: string) {
  context(); const session = await lockSession(target, id);
  if (session.status !== 'active' || session.connectionId !== connectionId || session.leaseHash !== hashNativeTicket(leaseToken)
    || !session.leaseExpiresAt || session.leaseExpiresAt.getTime() <= Date.now() || session.leaseRevision >= 2147483646) return deny();
  const policy = await live(session); const expiresAt = expiry(session); const revision = session.leaseRevision + 1;
  await db.update(staffNativeSessions).set({ leaseRevision: revision, leaseExpiresAt: new Date(expiresAt) }).where(eq(staffNativeSessions.id, id));
  return response({ ...session, leaseRevision: revision }, expiresAt, policy);
}
async function end(session: Session) {
  await db.update(staffNativeSessions).set({ status: 'disconnected', endedAt: new Date() }).where(eq(staffNativeSessions.id, session.id));
  return { version: 2 as const, ended: true };
}
export async function endStaffNativeAdmission(operator: StaffNativeOperator, id: string) {
  context(); return end(await owned(operator, id));
}
export async function closeStaffNativeAdmission(target: NativeTarget, id: string, connectionId: string) {
  context(); const session = await lockSession(target, id);
  if (session.connectionId !== connectionId) return deny();
  return end(session);
}
export async function isStaffNativeSession(target: NativeTarget, id: string) {
  if (!staffNativeEnabled()) return false;
  const [session] = await db.select({ id: staffNativeSessions.id }).from(staffNativeSessions)
    .where(and(eq(staffNativeSessions.id, id), eq(staffNativeSessions.orgId, target.orgId),
      eq(staffNativeSessions.deviceId, target.deviceId), eq(staffNativeSessions.targetId, target.id))).limit(1);
  return Boolean(session);
}
