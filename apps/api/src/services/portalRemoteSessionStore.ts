import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, hasDbAccessContext } from '../db';
import { portalRemoteSessions } from '../db/schema';
import {
  authorizePortalRemote,
  type PortalRemotePrincipal,
} from './portalRemoteAuthority';
import { resolveDesktopSessionPolicy } from './remoteAccessPolicy';

export type PortalDesktopPrincipal = PortalRemotePrincipal;
export const PORTAL_DESKTOP_MAX_DURATION_MS = 12 * 60 * 60 * 1000;
const LIVE_PORTAL_DESKTOP_STATUSES = ['pending', 'connecting', 'active'] as const;
const MAX_SDP_BYTES = 65_535;
export const PORTAL_DESKTOP_START_TIMEOUT_MS = 120_000;

export type PortalDesktopStartResult =
  | { ok: true; generation: bigint }
  | { ok: false; reason: 'not_found' | 'terminal' | 'not_pending' | 'expired' | 'authorization_denied' | 'state_changed' };

export type PortalDesktopEndResult =
  | {
      ok: true;
      sessionId: string;
      orgId: string;
      portalUserId: string;
      deviceId: string;
      terminalGeneration: bigint;
    }
  | { ok: false; reason: 'not_found' | 'not_live' };

function requireDbAccessContext(operation: string): void {
  if (hasDbAccessContext()) return;
  throw new Error(
    `[portalRemoteSessionStore] ${operation} requires an open db access context: ` +
    'the row lock and state transition must share one transaction.',
  );
}

function asGeneration(value: bigint | string | number | null): bigint {
  if (value === null) throw new Error('Portal remote session transition returned no generation');
  return BigInt(value);
}

/** Create only an authorized WebRTC session and snapshot the exact assignment/auth generation. */
export async function createPortalDesktopSession(
  principal: PortalDesktopPrincipal,
  deviceId: string,
): Promise<{ ok: true; session: typeof portalRemoteSessions.$inferSelect } | { ok: false; reason: string }> {
  requireDbAccessContext('createPortalDesktopSession');
  const authorized = await authorizePortalRemote(principal, deviceId, 'webrtc');
  if (!authorized.ok) return authorized;
  const policy = await resolveDesktopSessionPolicy(deviceId);
  const durationMs = Math.min(
    PORTAL_DESKTOP_MAX_DURATION_MS,
    Math.max(1, Math.trunc(policy.maxSessionDurationHours)) * 60 * 60 * 1000,
  );

  const [session] = await db.insert(portalRemoteSessions).values({
    orgId: principal.orgId,
    portalUserId: principal.id,
    deviceId,
    assignmentId: authorized.assignment.id,
    assignmentVersion: authorized.assignment.version,
    authEpoch: principal.authEpoch,
    transport: 'webrtc',
    status: 'pending',
    hardDeadline: new Date(Date.now() + durationMs),
  }).returning();

  if (!session) throw new Error('Portal remote session insert returned no row');
  return { ok: true, session };
}

/**
 * The only initial WebRTC start transition. It intentionally accepts only a
 * pending row: retrying/re-offering requires a future, explicit protocol, not
 * a way to replace the SDP or command identity of an already-started session.
 */
export async function commitPortalDesktopStartIntent(
  sessionId: string,
  principal: PortalDesktopPrincipal,
  commandId: string,
  offer: string,
  promptMode: 'off' | 'notify' | 'consent' = 'notify',
): Promise<PortalDesktopStartResult> {
  requireDbAccessContext('commitPortalDesktopStartIntent');

  const [locked] = await db.select({
    id: portalRemoteSessions.id,
    deviceId: portalRemoteSessions.deviceId,
    assignmentId: portalRemoteSessions.assignmentId,
    assignmentVersion: portalRemoteSessions.assignmentVersion,
    status: portalRemoteSessions.status,
    createdAt: portalRemoteSessions.createdAt,
    terminationPhase: portalRemoteSessions.terminationPhase,
    hardDeadline: portalRemoteSessions.hardDeadline,
  }).from(portalRemoteSessions).where(and(
    eq(portalRemoteSessions.id, sessionId),
    eq(portalRemoteSessions.orgId, principal.orgId),
    eq(portalRemoteSessions.portalUserId, principal.id),
    eq(portalRemoteSessions.authEpoch, principal.authEpoch),
    eq(portalRemoteSessions.transport, 'webrtc'),
  )).limit(1).for('update');

  if (!locked) return { ok: false, reason: 'not_found' };
  if ((locked.terminationPhase ?? 'none') !== 'none') return { ok: false, reason: 'terminal' };
  if (locked.status !== 'pending') return { ok: false, reason: 'not_pending' };
  if (!locked.createdAt || Date.now() - locked.createdAt.getTime() >= PORTAL_DESKTOP_START_TIMEOUT_MS) {
    return { ok: false, reason: 'terminal' };
  }
  if (locked.hardDeadline.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (!commandId || !offer || Buffer.byteLength(offer, 'utf8') > MAX_SDP_BYTES) {
    return { ok: false, reason: 'state_changed' };
  }

  const authorized = await authorizePortalRemote(principal, locked.deviceId, 'webrtc', {
    assignmentId: locked.assignmentId,
    assignmentVersion: locked.assignmentVersion,
  });
  if (!authorized.ok) return { ok: false, reason: 'authorization_denied' };

  const [updated] = await db.update(portalRemoteSessions).set({
    webrtcOffer: offer,
    webrtcAnswer: null,
    desktopStartCommandId: commandId,
    desktopPromptMode: promptMode,
    desktopStartGeneration: sql`${portalRemoteSessions.desktopStartGeneration} + 1`,
    status: 'connecting',
  }).where(and(
    eq(portalRemoteSessions.id, sessionId),
    eq(portalRemoteSessions.orgId, principal.orgId),
    eq(portalRemoteSessions.portalUserId, principal.id),
    eq(portalRemoteSessions.authEpoch, principal.authEpoch),
    eq(portalRemoteSessions.assignmentId, locked.assignmentId),
    eq(portalRemoteSessions.assignmentVersion, locked.assignmentVersion),
    eq(portalRemoteSessions.status, 'pending'),
    eq(portalRemoteSessions.terminationPhase, 'none'),
  )).returning({ generation: portalRemoteSessions.desktopStartGeneration });

  if (!updated) return { ok: false, reason: 'state_changed' };
  return { ok: true, generation: asGeneration(updated.generation) };
}

/**
 * Agent-only finalization. The agent proves only device and exact start command
 * ownership; it never substitutes or infers a portal principal.
 */
export async function finalizePortalDesktopStart(
  sessionId: string,
  deviceId: string,
  commandId: string,
  result: { ok: boolean; answer?: string | null; consentReason?: string },
): Promise<
  | { status: 'active' }
  | { status: 'failed'; sessionId: string; deviceId: string; terminalGeneration: bigint }
  | { status: 'no_match' }
> {
  const answer = result.ok && typeof result.answer === 'string' && result.answer.length > 0
    && Buffer.byteLength(result.answer, 'utf8') <= MAX_SDP_BYTES
    ? result.answer
    : null;
  const [updated] = await db.update(portalRemoteSessions).set(
    answer === null
      ? {
          status: 'failed',
          endedAt: new Date(),
          desktopStartGeneration: sql`${portalRemoteSessions.desktopStartGeneration} + 1`,
          terminalGeneration: sql`${portalRemoteSessions.desktopStartGeneration} + 1`,
          // A failed start can race with capture initialization. Leave a
          // terminal fence for the route/agent dispatcher to acknowledge with
          // a durable stop rather than claiming the endpoint is already down.
          terminationPhase: 'pending',
        }
      : { status: 'active', webrtcAnswer: answer },
  ).where(and(
    eq(portalRemoteSessions.id, sessionId),
    eq(portalRemoteSessions.deviceId, deviceId),
    eq(portalRemoteSessions.desktopStartCommandId, commandId),
    eq(portalRemoteSessions.status, 'connecting'),
    eq(portalRemoteSessions.terminationPhase, 'none'),
    ...(answer !== null && result.consentReason !== 'user' ? [ne(portalRemoteSessions.desktopPromptMode, 'consent')] : []),
  )).returning({
    id: portalRemoteSessions.id,
    deviceId: portalRemoteSessions.deviceId,
    terminalGeneration: portalRemoteSessions.terminalGeneration,
  });
  if (!updated) return { status: 'no_match' };
  if (answer !== null) return { status: 'active' };
  return {
    status: 'failed',
    sessionId,
    deviceId: updated.deviceId,
    terminalGeneration: asGeneration(updated.terminalGeneration),
  };
}

/** Terminal server decision; its returned identity is the durable stop-command input. */
export async function endPortalDesktopSession(
  sessionId: string,
  principal: PortalDesktopPrincipal,
): Promise<PortalDesktopEndResult> {
  requireDbAccessContext('endPortalDesktopSession');

  const [locked] = await db.select({
    id: portalRemoteSessions.id,
    orgId: portalRemoteSessions.orgId,
    portalUserId: portalRemoteSessions.portalUserId,
    deviceId: portalRemoteSessions.deviceId,
    status: portalRemoteSessions.status,
  }).from(portalRemoteSessions).where(and(
    eq(portalRemoteSessions.id, sessionId),
    eq(portalRemoteSessions.orgId, principal.orgId),
    eq(portalRemoteSessions.portalUserId, principal.id),
    eq(portalRemoteSessions.authEpoch, principal.authEpoch),
    eq(portalRemoteSessions.transport, 'webrtc'),
  )).limit(1).for('update');
  if (!locked) return { ok: false, reason: 'not_found' };
  if (!(LIVE_PORTAL_DESKTOP_STATUSES as readonly string[]).includes(locked.status)) {
    return { ok: false, reason: 'not_live' };
  }

  const [updated] = await db.update(portalRemoteSessions).set({
    status: 'disconnected',
    endedAt: new Date(),
    desktopStartGeneration: sql`${portalRemoteSessions.desktopStartGeneration} + 1`,
    terminalGeneration: sql`${portalRemoteSessions.desktopStartGeneration} + 1`,
    terminationPhase: 'pending',
  }).where(and(
    eq(portalRemoteSessions.id, sessionId),
    eq(portalRemoteSessions.orgId, principal.orgId),
    eq(portalRemoteSessions.portalUserId, principal.id),
    eq(portalRemoteSessions.authEpoch, principal.authEpoch),
    inArray(portalRemoteSessions.status, [...LIVE_PORTAL_DESKTOP_STATUSES]),
    eq(portalRemoteSessions.terminationPhase, 'none'),
  )).returning({ terminalGeneration: portalRemoteSessions.terminalGeneration });
  if (!updated) return { ok: false, reason: 'not_live' };

  return {
    ok: true,
    sessionId: locked.id,
    orgId: locked.orgId,
    portalUserId: locked.portalUserId,
    deviceId: locked.deviceId,
    terminalGeneration: asGeneration(updated.terminalGeneration),
  };
}
