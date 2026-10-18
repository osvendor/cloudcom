import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readCapacityGuardConfig } from '../services/capacityGuardPolicy';
import type { CapacityGuardSnapshot } from '../services/capacityGuard';
const state = vi.hoisted(() => ({ execute: vi.fn(), limit: vi.fn(), lag: vi.fn(), capacity: vi.fn(), rolloutEnabled: vi.fn(), rolloutLimits: vi.fn() }));
vi.mock('../db', () => ({ db: { execute: state.execute, select: () => ({ from: () => ({ where: () => ({ limit: state.limit }) }) }) },
  runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../db/schema', () => ({ users: { id: 'id', status: 'status', isPlatformAdmin: 'platform' } }));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/eventLoopMonitor', () => ({ readEventLoopLag: state.lag }));
vi.mock('../services/capacityGuard', () => ({ readCapacityGuard: state.capacity }));
vi.mock('../services/agentRolloutAdmission', () => ({ agentRolloutLimits: state.rolloutLimits, isAgentUpdateGuardEnabled: state.rolloutEnabled }));
vi.mock('../services/workerReadinessRegistry', () => ({ workerReadinessRegistry: { snapshot: () => ({}) }, summarizeConsumerReadiness: () => ({ required: 0, runnable: 0, unavailable: 0, optionalRunning: 0 }) }));
vi.mock('node:fs/promises', () => ({ readFile: async () => 'MemAvailable: 1024\n', statfs: async () => ({ bavail: 90, blocks: 100, bsize: 1024 }) }));
const admin = { user: { id: 'operator', isPlatformAdmin: true }, scope: 'system', principal: { kind: 'user_session' } };
function capacity(overrides: Partial<CapacityGuardSnapshot> = {}): CapacityGuardSnapshot {
  return {
    enabled: false, state: 'disabled', canRunBackgroundWork: true, observedAt: null, sampleAgeMs: null,
    healthyForMs: 0, reasons: [], metrics: { cpuBusyPercent: null, cpuStealPercent: null,
      cpuIowaitPercent: null, memoryUsedPercent: null, eventLoopLagMs: null, dependenciesReady: null },
    thresholds: readCapacityGuardConfig({ CLOUDCOM_CAPACITY_GUARD_CPU_PAUSE_PERCENT: '35',
      CLOUDCOM_CAPACITY_GUARD_CPU_RESUME_PERCENT: '25' }),
    agentUpdates: { allowed: true, reasons: [], windowMs: 60_000, observedMs: 60_000,
      averages: { cpuBusyPercent: 15, cpuStealPercent: 0, eventLoopLagMs: 25 } }, ...overrides,
  };
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  state.limit.mockResolvedValue([{ status: 'active', platform: true }]);
  state.lag.mockReturnValue({ monitored: false, coversWindow: false, worstLagMs: 0 });
  state.capacity.mockReturnValue(capacity());
  state.rolloutEnabled.mockReturnValue(false);
  state.rolloutLimits.mockReturnValue({ concurrent: 2, perSite: 1, starts: 2, windowMs: 120_000,
    leaseMs: 600_000, retryMs: 1_800_000, settleMs: 60_000 });
  state.execute.mockImplementation(async statement => {
    const text = new PgDialect().sqlToQuery(statement).sql;
    if (text.includes('SET LOCAL')) return [];
    if (text.includes('pg_stat_activity')) return [{ connections: 2, maximum: 100 }];
    if (text.includes('FROM devices WHERE')) return [{ total: 500, recent: 480, stale: 1, quarantined: 0, versions: 2 }];
    if (text.includes('FROM device_commands')) return [{ total: 5, failed: 1, pending: 1, delayed: 0 }];
    return [{ total: 0, failed: 0, active: 0 }];
  });
});
describe('operations health collector', () => {
  it('denies scope escalation before touching storage', async () => {
    const { readOperationsHealth } = await import('./operationsHealth');
    expect(await readOperationsHealth({ ...admin, scope: 'partner', user: { id: 'operator', isPlatformAdmin: false } })).toBeNull();
    expect(state.limit).not.toHaveBeenCalled(); expect(state.execute).not.toHaveBeenCalled();
    expect(state.capacity).not.toHaveBeenCalled(); expect(state.rolloutLimits).not.toHaveBeenCalled();
  });
  it('rechecks active platform status even when results are cached', async () => {
    const { readOperationsHealth } = await import('./operationsHealth');
    const first = await readOperationsHealth(admin);
    const calls = state.execute.mock.calls.length;
    expect(await readOperationsHealth(admin)).toBe(first);
    expect(state.execute).toHaveBeenCalledTimes(calls);
    expect(state.capacity).toHaveBeenCalledTimes(1);
    state.limit.mockResolvedValue([{ status: 'disabled', platform: true }]);
    expect(await readOperationsHealth(admin)).toBeNull();
  });
  it('returns scoped aggregates with truthful unknown and attention states', async () => {
    const { readOperationsHealth } = await import('./operationsHealth');
    const result = await readOperationsHealth(admin);
    expect(result!.enrolled).toBe(500);
    expect(result!.cards.find(x => x.id === 'fleet')?.status).toBe('attention');
    expect(result!.cards.find(x => x.id === 'api')?.status).toBe('unknown');
    expect(result!.cards.find(x => x.id === 'remote')?.status).toBe('unknown');
    expect(result!.cards.find(x => x.id === 'commands')?.status).toBe('attention');
    expect(result!.cards.find(x => x.id === 'relay')?.status).toBe('unknown');
  });
  it('degrades individual failed probes without fabricating zero counts', async () => {
    state.execute.mockRejectedValue(new Error('secret host'));
    const { readOperationsHealth } = await import('./operationsHealth');
    const result = await readOperationsHealth(admin);
    expect(result!.enrolled).toBeNull(); expect(result!.cards.find(x => x.id === 'fleet')?.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('secret host');
  });
  it('allows platform administrators with partner membership and rechecks live flag before cache', async () => {
    const { readOperationsHealth } = await import('./operationsHealth');
    const partner = { ...admin, scope: 'partner' };
    expect((await readOperationsHealth(partner))!.enrolled).toBe(500);
    expect(await readOperationsHealth({ ...partner, allowedSiteIds: [] })).toBeNull();
    expect(await readOperationsHealth({ ...partner, user: { id: 'other', isPlatformAdmin: false } })).toBeNull();
    state.limit.mockResolvedValue([{ status: 'active', platform: false }]);
    expect(await readOperationsHealth(partner)).toBeNull();
  });
  it('bounds probe latency and classifies thresholds', async () => {
    const { pressure, deadline } = await import('./operationsHealth');
    expect([74,75,89,90].map(pressure)).toEqual(['healthy','attention','attention','critical']);
    await expect(deadline(new Promise(() => {}), 5)).rejects.toThrow('timed out');
  });

  it('shows disabled safeguards explicitly without portraying disabled admission as healthy', async () => {
    const { readOperationsHealth } = await import('./operationsHealth');
    const result = await readOperationsHealth(admin);
    expect(result!.cards.find(card => card.id === 'capacity-guard'))
      .toMatchObject({ status: 'attention', value: 'Disabled' });
    expect(result!.cards.find(card => card.id === 'agent-rollout-guard'))
      .toMatchObject({ status: 'attention', value: 'Disabled' });
  });

  it('shows current CPU and configured thresholds only when the guard admits background work', async () => {
    const healthy = capacity({ enabled: true, state: 'healthy', canRunBackgroundWork: true, healthyForMs: 60_000 });
    healthy.metrics.cpuBusyPercent = 12.34;
    state.capacity.mockReturnValue(healthy);
    const { readOperationsHealth } = await import('./operationsHealth');
    const card = (await readOperationsHealth(admin))!.cards.find(card => card.id === 'capacity-guard')!;
    expect(card).toMatchObject({ status: 'healthy', value: 'Ready for background work' });
    expect(card.detail).toContain('CPU 12.3%');
    expect(card.detail).toContain('pause at 35%, resume below 25%');
    expect(card.detail).toContain('after 60 healthy seconds');
    expect(card.detail).toContain('AWS burst credits are not measured');
  });

  it.each(['warming_up', 'cpu_busy', 'stale_sample', 'dependencies_unavailable'] as const)(
    'shows deferred work with the %s reason and preserves an unknown CPU reading', async reason => {
      state.capacity.mockReturnValue(capacity({ enabled: true, state: reason === 'warming_up' ? 'warming' : 'paused',
        canRunBackgroundWork: false, reasons: [reason] }));
      const { readOperationsHealth } = await import('./operationsHealth');
      const card = (await readOperationsHealth(admin))!.cards.find(card => card.id === 'capacity-guard')!;
      expect(card).toMatchObject({ status: 'attention', value: 'Heavy background work paused' });
      expect(card.detail).toContain('CPU unknown');
      expect(card.detail).toContain(`Waiting: ${reason}.`);
      expect(card.detail).toContain('Routine script probes and Harmony refresh defer');
      expect(card.detail).toContain('sign-in, check-ins and remote tools remain available');
    },
  );

  it('reports configured rollout concurrency, start window and the completion timeout honestly', async () => {
    state.rolloutEnabled.mockReturnValue(true);
    state.capacity.mockReturnValue(capacity({ enabled: true, state: 'paused', canRunBackgroundWork: false }));
    state.rolloutLimits.mockReturnValue({ concurrent: 1, perSite: 1, starts: 3, windowMs: 180_000,
      leaseMs: 600_000, retryMs: 1_800_000, settleMs: 60_000 });
    const { readOperationsHealth } = await import('./operationsHealth');
    const card = (await readOperationsHealth(admin))!.cards.find(card => card.id === 'agent-rollout-guard')!;
    expect(card).toMatchObject({ status: 'healthy', value: 'Ready · 1 at once' });
    expect(card.detail).toContain('at most 3 new starts every 3 minutes');
    expect(card.detail).toContain('Missing completion holds its slot for 10 minutes');
    expect(card.detail).toContain('30-minute retry window');
    expect(card.detail).toContain('Signed emergency rollback and independent local repair are excluded');
  });
});
