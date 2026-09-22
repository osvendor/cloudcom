import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getRedis } from './redis';

/** Short-lived, single-use credential for a portal-owned desktop WS upgrade. */
export const PORTAL_REMOTE_WS_TICKET_TTL_SECONDS = 60;
const PORTAL_REMOTE_WS_TICKET_TTL_MS = PORTAL_REMOTE_WS_TICKET_TTL_SECONDS * 1000;
const REDIS_KEY_PREFIX = 'portal:remote:ws_ticket:';
const UA_HASH_LEN = 16;

export interface PortalRemoteWsTicketClaims {
  sessionId: string;
  orgId: string;
  portalUserId: string;
  authEpoch: number;
  assignmentId: string;
  assignmentVersion: number;
}

interface StoredPortalRemoteWsTicket extends PortalRemoteWsTicketClaims {
  version: 1;
  jti: string;
  expiresAt: number;
  ip: string;
  uaHash: string;
}

export type ConsumePortalRemoteWsTicketResult =
  | ({ ok: true; expiresAt: number; ticketJti: string } & PortalRemoteWsTicketClaims)
  | { ok: false; reason: 'not_found' | 'expired' | 'ip_mismatch' | 'ua_mismatch' | 'invalid' | 'unavailable' };

function hashUa(userAgent: string): string {
  return createHash('sha256').update(userAgent).digest('hex').slice(0, UA_HASH_LEN);
}

function ticketKey(ticket: string): string {
  return `${REDIS_KEY_PREFIX}${ticket}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isStoredTicket(value: unknown): value is StoredPortalRemoteWsTicket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1
    && isNonEmptyString(candidate.jti)
    && isNonEmptyString(candidate.sessionId)
    && isNonEmptyString(candidate.orgId)
    && isNonEmptyString(candidate.portalUserId)
    && isPositiveSafeInteger(candidate.authEpoch)
    && isNonEmptyString(candidate.assignmentId)
    && isPositiveSafeInteger(candidate.assignmentVersion)
    && typeof candidate.expiresAt === 'number'
    && Number.isFinite(candidate.expiresAt)
    && isNonEmptyString(candidate.ip)
    && isNonEmptyString(candidate.uaHash)
  );
}

/**
 * Issues a ticket only when Redis is available. Portal remote access must
 * never fall back to process memory because the eventual WS upgrade may land
 * on another API replica.
 */
export async function createPortalRemoteWsTicket(
  claims: PortalRemoteWsTicketClaims,
  caller: { ip: string; userAgent: string },
): Promise<{ ticket: string; expiresInSeconds: number }> {
  if (!isNonEmptyString(caller.ip)) {
    throw new Error('Portal remote WebSocket tickets require a trusted client IP');
  }
  if (!isNonEmptyString(claims.sessionId) || !isNonEmptyString(claims.orgId)
    || !isNonEmptyString(claims.portalUserId) || !isNonEmptyString(claims.assignmentId)
    || !isPositiveSafeInteger(claims.authEpoch) || !isPositiveSafeInteger(claims.assignmentVersion)) {
    throw new Error('Invalid portal remote WebSocket ticket claims');
  }

  const redis = getRedis();
  if (!redis) {
    throw new Error('Portal remote WebSocket tickets are unavailable');
  }

  const ticket = randomBytes(32).toString('base64url');
  const record: StoredPortalRemoteWsTicket = {
    version: 1,
    jti: randomUUID(),
    ...claims,
    expiresAt: Date.now() + PORTAL_REMOTE_WS_TICKET_TTL_MS,
    ip: caller.ip,
    uaHash: hashUa(caller.userAgent),
  };

  await redis.setex(ticketKey(ticket), PORTAL_REMOTE_WS_TICKET_TTL_SECONDS, JSON.stringify(record));
  return { ticket, expiresInSeconds: PORTAL_REMOTE_WS_TICKET_TTL_SECONDS };
}

/**
 * Atomically consumes the ticket before validating its bindings. A mismatch is
 * intentionally terminal, preventing retries from probing a stolen ticket.
 */
export async function consumePortalRemoteWsTicket(
  ticket: string,
  caller: { ip: string; userAgent: string },
): Promise<ConsumePortalRemoteWsTicketResult> {
  const redis = getRedis();
  if (!redis) return { ok: false, reason: 'unavailable' };

  let raw: unknown;
  try {
    raw = await redis.eval(
      "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]); end; return v",
      1,
      ticketKey(ticket),
    );
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (typeof raw !== 'string') return { ok: false, reason: 'not_found' };

  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isStoredTicket(record)) return { ok: false, reason: 'invalid' };
  if (Date.now() >= record.expiresAt) return { ok: false, reason: 'expired' };
  if (caller.ip !== record.ip) return { ok: false, reason: 'ip_mismatch' };
  if (hashUa(caller.userAgent) !== record.uaHash) return { ok: false, reason: 'ua_mismatch' };

  return {
    ok: true,
    sessionId: record.sessionId,
    orgId: record.orgId,
    portalUserId: record.portalUserId,
    authEpoch: record.authEpoch,
    assignmentId: record.assignmentId,
    assignmentVersion: record.assignmentVersion,
    expiresAt: record.expiresAt,
    ticketJti: record.jti,
  };
}
