import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_ROLLOUT_LUA } from './agentRolloutAdmissionLua';

// Opt-in only. Run against a disposable Redis container, never application Redis.
const url = process.env.CLOUDCOM_GUARD_TEST_REDIS_URL;
describe.skipIf(!url)('agent rollout admission against real Redis', () => {
  let redis: Redis;
  let prefix: string;
  beforeAll(async () => { redis = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 0 }); await redis.connect(); });
  beforeEach(() => { prefix = `test:capacity:${randomUUID()}:{rollout}:`; });
  afterEach(async () => { const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); });
  afterAll(async () => { await redis.quit(); });
  const call = (device: string, site = '', healthy = true, targets = { agent: '2' } as Record<string, string>, mode = 'admit', limit = 2) =>
    redis.eval(AGENT_ROLLOUT_LUA, 3, `${prefix}active`, `${prefix}starts`, `${prefix}device:${device}`,
      prefix, device, site, mode, JSON.stringify(targets), healthy ? '1' : '0', limit, 1, limit, 120000, 600000, 1800000, 60000) as Promise<[number, string]>;
  const age = async (device: string, complete: boolean) => {
    const key = `${prefix}device:${device}`;
    const old = JSON.parse((await redis.get(key))!);
    old.expires = 1; old.complete = complete;
    if (complete) old.retryAfter = 1;
    await redis.set(key, JSON.stringify(old));
    await redis.zadd(`${prefix}active`, 1, device);
    if (old.site) await redis.zadd(`${prefix}site:${old.site}`, 1, device);
  };

  it('atomically limits 500 simultaneous devices to two starts across replicas', async () => {
    const replies = await Promise.all(Array.from({ length: 500 }, (_, i) => call(`d${i}`, `s${i}`)));
    expect(replies.filter(r => r[0] === 1)).toHaveLength(2);
    expect(await redis.zcard(`${prefix}active`)).toBe(2);
    expect(await redis.zcard(`${prefix}starts`)).toBe(2);
  });
  it('admits exactly one of 500 requests with the cautious one-device deployment limits', async () => {
    const replies = await Promise.all(Array.from({ length: 500 }, (_, i) => call(`d${i}`, `s${i}`, true, { agent: '2' }, 'admit', 1)));
    expect(replies.filter(r => r[0] === 1)).toHaveLength(1);
    expect(await redis.zcard(`${prefix}active`)).toBe(1);
    expect(await redis.zcard(`${prefix}starts`)).toBe(1);
  });
  it('preserves existing leases when lowering limits and blocks new starts until both bounds clear', async () => {
    await call('d1', 's1'); await call('d2', 's2');
    expect(await call('d1', 's1', false, { agent: '2' }, 'admit', 1)).toEqual([1, 'already-admitted']);
    expect(await call('d3', 's3', true, { agent: '2' }, 'admit', 1)).toEqual([0, 'fleet-limit']);
    expect(await redis.zcard(`${prefix}active`)).toBe(2);
    await age('d1', true); await age('d2', true);
    expect(await call('d3', 's3', true, { agent: '2' }, 'admit', 1)).toEqual([0, 'start-rate-limit']);
    await redis.zadd(`${prefix}starts`, 1, 'd1', 1, 'd2');
    expect(await call('d3', 's3', true, { agent: '2' }, 'admit', 1)).toEqual([1, 'admitted']);
  });
  it('allows one device per site and does not count duplicate offers as new starts', async () => {
    expect(await call('d1', 's1')).toEqual([1, 'admitted']);
    expect(await call('d1', 's1')).toEqual([1, 'already-admitted']);
    expect(await call('d2', 's1')).toEqual([0, 'site-limit']);
    expect(await call('d3', 's2')).toEqual([1, 'admitted']);
    expect(await redis.zcard(`${prefix}starts`)).toBe(2);
  });
  it('uses an exclusive fleet slot when a command has no verified site', async () => {
    expect(await call('d1')).toEqual([1, 'admitted']);
    expect(await call('d2')).toEqual([0, 'site-unknown-exclusive']);
    expect(await call('d3', 'known-site')).toEqual([0, 'site-unknown-exclusive']);
    await age('d1', true);
    expect(await call('d3', 'known-site')).toEqual([1, 'admitted']);
    // The start window also bounds unknown-site starts; reset its test clock
    // history here to exercise the inverse exclusion independently.
    await redis.zadd(`${prefix}starts`, 1, 'd1', 1, 'd3');
    expect(await call('d2')).toEqual([0, 'site-unknown-exclusive']);
  });
  it('pauses new work during pressure without interrupting already admitted components', async () => {
    await call('d1', 's1');
    expect(await call('d1', 's1', false)).toEqual([1, 'already-admitted']);
    expect(await call('d2', 's2', false)).toEqual([0, 'server-pressure']);
    expect(await call('d1', 's1', false, { helper: '2' })).toEqual([0, 'server-pressure']);
    expect(await call('d1', 's1', true, { agent: '3' })).toEqual([0, 'different-update-active']);
  });
  it('waits for every component and keeps a settling reservation after reported completion', async () => {
    await call('d1', 's1', true, { agent: '2', watchdog: '2' });
    expect(await call('d1', '', true, { agent: '2' }, 'observe')).toEqual([0, 'awaiting-components']);
    expect(await call('d1', '', true, { watchdog: '2' }, 'observe')).toEqual([0, 'settling']);
    const state = JSON.parse((await redis.get(`${prefix}device:d1`))!);
    expect(state.complete).toBe(true);
    expect(state.expires - state.started).toBeGreaterThanOrEqual(120000);
    expect(await call('d1', 's1')).toEqual([0, 'settling']);
    expect(await call('d2', 's1')).toEqual([0, 'site-limit']);
  });
  it('keeps failed devices in cooldown while admitting other sites after lease expiry', async () => {
    await call('d1', 's1'); await age('d1', false);
    expect(await call('d1', 's1')).toEqual([0, 'retry-cooldown']);
    expect(await call('d2', 's1')).toEqual([1, 'admitted']);
  });
  it('enforces the start window even after completion releases concurrency slots', async () => {
    await call('d1', 's1'); await call('d2', 's2');
    await age('d1', true); await age('d2', true);
    expect(await call('d3', 's3')).toEqual([0, 'start-rate-limit']);
    await redis.zadd(`${prefix}starts`, 1, 'd1', 1, 'd2');
    expect(await call('d3', 's3')).toEqual([1, 'admitted']);
  });
});
