import { createHash } from 'node:crypto';
import { getRedis } from './redis';
import { canRunBackgroundWork } from './capacityGuard';
import { AGENT_ROLLOUT_LUA } from './agentRolloutAdmissionLua';

export type UpdateTargets = Partial<Record<'agent' | 'helper' | 'watchdog' | 'backup', string>>;
export type UpdateAdmission = { allowed: boolean; reason: string };
const PREFIX = 'cloudcom:{agent-rollout}:v1:';
const pending = new Map<string, Promise<unknown>>();
let lastFailureLog = 0;

export function isAgentUpdateGuardEnabled(): boolean {
  return process.env.CLOUDCOM_UPDATE_GUARD_ENABLED === 'true';
}

/** Operator tuning is bounded; invalid values refuse startup, never disable limits. */
export function agentRolloutLimits(env: NodeJS.ProcessEnv = process.env) {
  const CONCURRENT_ENV = 'CLOUDCOM_UPDATE_MAX_CONCURRENT';
  const STARTS_ENV = 'CLOUDCOM_UPDATE_STARTS_PER_WINDOW';
  const WINDOW_ENV = 'CLOUDCOM_UPDATE_WINDOW_SECONDS';
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  if (env.CLOUDCOM_UPDATE_GUARD_ENABLED !== undefined && !['true', 'false'].includes(env.CLOUDCOM_UPDATE_GUARD_ENABLED)) {
    throw new Error('Invalid CLOUDCOM_UPDATE_GUARD_ENABLED');
  }
  return {
    concurrent: number(CONCURRENT_ENV, 2, 1, 10),
    perSite: 1,
    starts: number(STARTS_ENV, 2, 1, 10),
    windowMs: number(WINDOW_ENV, 120, 60, 3600) * 1000,
    leaseMs: 10 * 60_000,
    retryMs: 30 * 60_000,
    settleMs: 60_000,
  };
}

function targetsAreValid(targets: UpdateTargets): boolean {
  return Object.entries(targets).every(([key, value]) =>
    ['agent', 'helper', 'watchdog', 'backup'].includes(key)
      && typeof value === 'string' && value.length > 0 && value.length <= 128);
}

async function invoke(input: { deviceId: string; siteKey?: string; targets: UpdateTargets }, mode: 'admit' | 'observe'): Promise<UpdateAdmission> {
  if (!isAgentUpdateGuardEnabled()) return { allowed: true, reason: 'disabled' };
  // Identifiers come only from an authenticated device / authorized command.
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(input.deviceId) || !targetsAreValid(input.targets)) return { allowed: false, reason: 'invalid-update' };
  if (pending.has(input.deviceId)) return { allowed: false, reason: 'admission-pending' };
  const site = input.siteKey ? createHash('sha256').update(input.siteKey).digest('hex') : '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const redis = getRedis();
    if (!redis || redis.status !== 'ready') return { allowed: false, reason: 'admission-unavailable' };
    const limits = agentRolloutLimits();
    const request = redis.eval(AGENT_ROLLOUT_LUA, 3,
      `${PREFIX}active`, `${PREFIX}starts`, `${PREFIX}device:${input.deviceId}`,
      PREFIX, input.deviceId, site, mode, JSON.stringify(input.targets),
      canRunBackgroundWork() ? '1' : '0',
      limits.concurrent, limits.perSite, limits.starts, limits.windowMs,
      limits.leaseMs, limits.retryMs, limits.settleMs,
    );
    pending.set(input.deviceId, request);
    // A timed-out Redis request might later reserve a slot. It never dispatches
    // work; its unused reservation expires conservatively. Keep single-flight
    // until the actual request settles, not just until our response deadline.
    void request.then(() => pending.delete(input.deviceId), () => pending.delete(input.deviceId));
    const reply = await Promise.race([
      request,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Admission timeout')), 250); timer.unref?.(); }),
    ]) as [number, string];
    if (!Array.isArray(reply) || typeof reply[1] !== 'string') throw new Error('Invalid admission response');
    return { allowed: reply[0] === 1, reason: reply[1] };
  } catch {
    if (Date.now() - lastFailureLog > 60_000) {
      lastFailureLog = Date.now();
      console.warn('[agent-rollout] Update admission unavailable; updates deferred, ordinary traffic continues');
    }
    return { allowed: false, reason: 'admission-unavailable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function admitAgentUpdate(input: { deviceId: string; targets: UpdateTargets; siteKey?: string }): Promise<UpdateAdmission> {
  if (!Object.keys(input.targets).length) return Promise.resolve({ allowed: true, reason: 'no-update' });
  return invoke(input, 'admit');
}

/** Only actual heartbeat versions release a reservation; dispatch is not success. */
export async function observeAgentUpdate(deviceId: string, versions: UpdateTargets): Promise<void> {
  if (isAgentUpdateGuardEnabled()) await invoke({ deviceId, targets: versions }, 'observe');
}

/** Applies to version offers only. Commands and credential maintenance are intact. */
export async function guardHeartbeatUpdates(input: {
  deviceId: string; siteKey: string; versions: UpdateTargets; response: Record<string, unknown>;
}): Promise<void> {
  if (!isAgentUpdateGuardEnabled()) return;
  await observeAgentUpdate(input.deviceId, input.versions);
  const fields = { agent: 'upgradeTo', helper: 'helperUpgradeTo', watchdog: 'watchdogUpgradeTo' } as const;
  const targets: UpdateTargets = {};
  for (const [component, field] of Object.entries(fields)) {
    const value = input.response[field];
    if (typeof value === 'string' && value) targets[component as keyof UpdateTargets] = value;
  }
  const decision = await admitAgentUpdate({ deviceId: input.deviceId, siteKey: input.siteKey, targets });
  if (!decision.allowed) {
    // Preserve null versus absent wire conventions for older agents.
    for (const field of Object.values(fields)) {
      if (typeof input.response[field] === 'string') input.response[field] = field === 'upgradeTo' ? null : undefined;
    }
  }
}
