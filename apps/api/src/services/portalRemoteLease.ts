import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, portalRemoteSessions } from '../db/schema';
import { authorizePortalRemote, type PortalRemotePrincipal } from './portalRemoteAuthority';
import { getRedis } from './redis';
import type { RenewRevocationLeaseResult, RevocationLeaseGrant, RevocationReason } from './remoteRevocationLease';

export const PORTAL_REMOTE_LEASE_TTL_MS = 60_000;
export const PORTAL_REMOTE_LEASE_RENEW_EVERY_SEC = 20;
export const PORTAL_REMOTE_LEASE_GRACE_SEC = 15;
const PORTAL_REMOTE_LEASE_KEY_PREFIX = 'portal:remote:lease:';
const PORTAL_REMOTE_VIEWER_KEY_PREFIX = 'portal:remote:viewer:';
const LIVE = ['connecting', 'active'] as const;
const MAX_HARD_DEADLINE_AHEAD_MS = 12 * 60 * 60 * 1000;

type LeaseRow = {
  id: string; orgId: string; portalUserId: string; deviceId: string;
  assignmentId: string; assignmentVersion: number; authEpoch: number;
  status: string; terminationPhase: 'none' | 'pending' | 'confirmed';
  hardDeadline: Date; startGeneration: bigint; terminalGeneration: bigint | null;
  revocationLeaseProtocolVersion: number; desktopFenceProtocolVersion: number;
};

function key(sessionId: string): string { return `${PORTAL_REMOTE_LEASE_KEY_PREFIX}${sessionId}`; }
function viewerKey(sessionId: string): string { return `${PORTAL_REMOTE_VIEWER_KEY_PREFIX}${sessionId}`; }
function now(): number { return Date.now(); }
function asBigInt(value: bigint | string | number | null): bigint | null { return value == null ? null : BigInt(value); }
function secret(): string { return randomBytes(32).toString('base64url'); }

async function readLeaseRow(sessionId: string): Promise<LeaseRow | null> {
  const [row] = await db.select({
    id: portalRemoteSessions.id, orgId: portalRemoteSessions.orgId, portalUserId: portalRemoteSessions.portalUserId,
    deviceId: portalRemoteSessions.deviceId, assignmentId: portalRemoteSessions.assignmentId,
    assignmentVersion: portalRemoteSessions.assignmentVersion, authEpoch: portalRemoteSessions.authEpoch,
    status: portalRemoteSessions.status, terminationPhase: portalRemoteSessions.terminationPhase,
    hardDeadline: portalRemoteSessions.hardDeadline, startGeneration: portalRemoteSessions.desktopStartGeneration,
    terminalGeneration: portalRemoteSessions.terminalGeneration,
    revocationLeaseProtocolVersion: devices.revocationLeaseProtocolVersion,
    desktopFenceProtocolVersion: devices.desktopFenceProtocolVersion,
  }).from(portalRemoteSessions).innerJoin(devices, and(
    eq(devices.id, portalRemoteSessions.deviceId), eq(devices.orgId, portalRemoteSessions.orgId),
  )).where(and(eq(portalRemoteSessions.id, sessionId), eq(portalRemoteSessions.transport, 'webrtc'))).limit(1);
  return row ? {
    ...row,
    status: String(row.status),
    terminationPhase: (row.terminationPhase ?? 'none') as LeaseRow['terminationPhase'],
    startGeneration: BigInt(row.startGeneration ?? 0), terminalGeneration: asBigInt(row.terminalGeneration),
  } : null;
}

async function freshLeaseRow(sessionId: string): Promise<LeaseRow | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => readLeaseRow(sessionId), 'portalRemoteLease.read'));
}

async function liveAuthorization(row: LeaseRow): Promise<{ ok: true } | { ok: false; reason: RevocationReason }> {
  if (!LIVE.includes(row.status as (typeof LIVE)[number]) || row.terminationPhase !== 'none') {
    return { ok: false, reason: 'session_ended' };
  }
  const deadline = row.hardDeadline.getTime();
  if (deadline <= now() || deadline - now() > MAX_HARD_DEADLINE_AHEAD_MS) return { ok: false, reason: 'hard_deadline' };
  if (row.revocationLeaseProtocolVersion !== 1 || row.desktopFenceProtocolVersion !== 1) {
    return { ok: false, reason: 'permissions_changed' };
  }
  const principal: PortalRemotePrincipal = { id: row.portalUserId, orgId: row.orgId, authEpoch: row.authEpoch };
  const authorized = await authorizePortalRemote(principal, row.deviceId, 'webrtc', {
    assignmentId: row.assignmentId, assignmentVersion: row.assignmentVersion,
  });
  return authorized.ok ? { ok: true } : { ok: false, reason: 'permissions_changed' };
}

async function markRevoked(sessionId: string): Promise<{ terminalGeneration?: string } | null> {
  const [updated] = await db.update(portalRemoteSessions).set({
    status: 'disconnected', endedAt: new Date(),
    desktopStartGeneration: sql`${portalRemoteSessions.desktopStartGeneration} + 1`,
    terminalGeneration: sql`${portalRemoteSessions.desktopStartGeneration} + 1`,
    terminationPhase: 'pending',
  }).where(and(
    eq(portalRemoteSessions.id, sessionId), inArray(portalRemoteSessions.status, [...LIVE]),
    eq(portalRemoteSessions.terminationPhase, 'none'),
  )).returning({ terminalGeneration: portalRemoteSessions.terminalGeneration });
  if (!updated) return null;
  return { terminalGeneration: BigInt(updated.terminalGeneration ?? 0).toString() };
}

async function revoke(row: LeaseRow, reason: RevocationReason): Promise<RenewRevocationLeaseResult> {
  try {
    const terminal = await runOutsideDbContext(() => withSystemDbAccessContext(
      () => markRevoked(row.id), 'portalRemoteLease.revoke',
    ));
    const knownGeneration = terminal?.terminalGeneration ?? row.terminalGeneration?.toString();
    return { status: 'revoked', reason, ...(knownGeneration ? { terminalGeneration: knownGeneration } : {}) };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Creates a Redis-backed lease only after the committed WebRTC session passes live authorization. */
export async function preparePortalRemoteLease(
  sessionId: string,
  principal: PortalRemotePrincipal,
): Promise<{ ok: true; lease: RevocationLeaseGrant } | { ok: false; reason: string }> {
  let row: LeaseRow | null;
  try { row = await freshLeaseRow(sessionId); } catch { return { ok: false, reason: 'unavailable' }; }
  if (!row || row.portalUserId !== principal.id || row.orgId !== principal.orgId || row.authEpoch !== principal.authEpoch) {
    return { ok: false, reason: 'session_unavailable' };
  }
  const verdict = await runOutsideDbContext(() => withSystemDbAccessContext(() => liveAuthorization(row!), 'portalRemoteLease.prepare'))
    .catch(() => ({ ok: false as const, reason: 'permissions_changed' as RevocationReason }));
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  const redis = getRedis();
  if (!redis) return { ok: false, reason: 'unavailable' };
  const issuedAt = now();
  const lease: RevocationLeaseGrant = {
    token: secret(), expiresAt: Math.min(issuedAt + PORTAL_REMOTE_LEASE_TTL_MS, row.hardDeadline.getTime()),
    hardDeadline: row.hardDeadline.getTime(), renewEverySec: PORTAL_REMOTE_LEASE_RENEW_EVERY_SEC,
    graceSec: PORTAL_REMOTE_LEASE_GRACE_SEC,
  };
  const redisTtlMs = Math.min(PORTAL_REMOTE_LEASE_TTL_MS, lease.hardDeadline - issuedAt);
  if (redisTtlMs <= 0) return { ok: false, reason: 'hard_deadline' };
  try {
    await redis.set(key(sessionId), JSON.stringify({ token: lease.token, hardDeadline: lease.hardDeadline }), 'PX', redisTtlMs);
    // Browser presence is a distinct expiring proof. Agent renewals read it but
    // never refresh it, so a lost browser cannot leave a P2P stream alive.
    await redis.set(viewerKey(sessionId), '1', 'PX', redisTtlMs);
  } catch {
    try { await redis.del(key(sessionId)); } catch { /* TTL collects it. */ }
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, lease };
}

/**
 * Browser-only presence heartbeat. A denied/missing session deliberately has
 * one generic answer so this endpoint does not disclose another portal user's
 * session ownership or existence.
 */
export async function touchPortalRemoteViewer(
  sessionId: string,
  principal: PortalRemotePrincipal,
): Promise<{ ok: true; expiresAt: number } | { ok: false; reason: 'forbidden' | 'unavailable' }> {
  let row: LeaseRow | null;
  try { row = await freshLeaseRow(sessionId); } catch { return { ok: false, reason: 'unavailable' }; }
  if (!row || row.portalUserId !== principal.id || row.orgId !== principal.orgId || row.authEpoch !== principal.authEpoch) {
    return { ok: false, reason: 'forbidden' };
  }
  let verdict: { ok: true } | { ok: false; reason: RevocationReason };
  try {
    verdict = await runOutsideDbContext(() => withSystemDbAccessContext(() => liveAuthorization(row!), 'portalRemoteLease.viewerTouch'));
  } catch { return { ok: false, reason: 'unavailable' }; }
  if (!verdict.ok) return { ok: false, reason: 'forbidden' };
  const redis = getRedis();
  if (!redis) return { ok: false, reason: 'unavailable' };
  const ttlMs = Math.min(PORTAL_REMOTE_LEASE_TTL_MS, row.hardDeadline.getTime() - now());
  if (ttlMs <= 0) return { ok: false, reason: 'forbidden' };
  try {
    await redis.set(viewerKey(sessionId), '1', 'PX', ttlMs);
  } catch { return { ok: false, reason: 'unavailable' }; }
  return { ok: true, expiresAt: Math.min(now() + PORTAL_REMOTE_LEASE_TTL_MS, row.hardDeadline.getTime()) };
}

/**
 * Returns null only when this is not a portal session, allowing the agent
 * renew caller to fall through to the staff lease path without conflation.
 */
export async function renewPortalRemoteLeaseIfPresent(
  sessionId: string,
  options: { expectDeviceId: string },
): Promise<RenewRevocationLeaseResult | null> {
  let row: LeaseRow | null;
  try { row = await freshLeaseRow(sessionId); } catch { return { status: 'unavailable' }; }
  if (!row) return null;
  if (options.expectDeviceId !== row.deviceId) return { status: 'forbidden' };
  let verdict: { ok: true } | { ok: false; reason: RevocationReason };
  try {
    verdict = await runOutsideDbContext(() => withSystemDbAccessContext(() => liveAuthorization(row!), 'portalRemoteLease.renew'));
  } catch { return { status: 'unavailable' }; }
  if (!verdict.ok) return revoke(row, verdict.reason);
  const redis = getRedis();
  if (!redis) return { status: 'unavailable' };
  const current = now();
  const leaseTtlMs = Math.min(PORTAL_REMOTE_LEASE_TTL_MS, row.hardDeadline.getTime() - current);
  if (leaseTtlMs <= 0) return revoke(row, 'hard_deadline');
  try {
    // Do this before the lease read/renew and deliberately never extend it:
    // only touchPortalRemoteViewer() may extend customer presence.
    const viewer = await redis.get(viewerKey(sessionId));
    if (!viewer) return revoke(row, 'session_ended');
    const raw = await redis.eval(
      "local v = redis.call('GET', KEYS[1]); if not v then return nil end; redis.call('PEXPIRE', KEYS[1], ARGV[1]); return v",
      1, key(sessionId), String(leaseTtlMs),
    );
    if (!raw) return { status: 'unavailable' }; // never recreate a missing lease
    if (typeof raw !== 'string') return { status: 'unavailable' };
    let stored: unknown;
    try { stored = JSON.parse(raw); } catch { return { status: 'unavailable' }; }
    if (!stored || typeof stored !== 'object' || (stored as { hardDeadline?: unknown }).hardDeadline !== row.hardDeadline.getTime()) {
      return { status: 'unavailable' };
    }
  } catch { return { status: 'unavailable' }; }
  return {
    status: 'renewed', expiresAt: Math.min(current + PORTAL_REMOTE_LEASE_TTL_MS, row.hardDeadline.getTime()),
    hardDeadline: row.hardDeadline.getTime(), renewEverySec: PORTAL_REMOTE_LEASE_RENEW_EVERY_SEC,
    graceSec: PORTAL_REMOTE_LEASE_GRACE_SEC, startGeneration: row.startGeneration.toString(),
    terminationPhase: row.terminationPhase,
  };
}
