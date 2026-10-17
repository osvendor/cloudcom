import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapacityGuard, cpuBusyPercent, parseLinuxCpu, parseLinuxMemory, linuxCpuPercent, createHostCapacityCollector,
  canRunBackgroundWork, readCapacityGuard, type HostCapacitySample, type CapacityGuardSnapshot,
} from './capacityGuard';
import { readCapacityGuardConfig } from './capacityGuardPolicy';
import type { EventLoopLagReading } from './eventLoopMonitor';

const host: HostCapacitySample = { cpuBusyPercent: 10, cpuStealPercent: 0, cpuIowaitPercent: 0, memoryUsedPercent: 50 };
const loop: EventLoopLagReading = { monitored: true, coversWindow: true, sampledMaxLagMs: 20,
  inFlightLagMs: 0, worstLagMs: 20, sampleCount: 5 };
const guards: CapacityGuard[] = [];
const hostIo = vi.hoisted(() => ({ readFile: vi.fn<(path: string, encoding: string) => Promise<string>>(), platform: vi.fn(() => 'linux') }));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), readFile: hostIo.readFile }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), platform: hostIo.platform }));

function harness(options: { collect?: () => Promise<HostCapacitySample>; checkDependencies?: () => Promise<boolean>;
  onTransition?: (snapshot: CapacityGuardSnapshot) => void } = {}) {
  const collect = vi.fn(options.collect ?? (async () => ({ ...host })));
  const checkDependencies = vi.fn(options.checkDependencies ?? (async () => true));
  const readEventLoop = vi.fn(() => ({ ...loop }));
  const guard = new CapacityGuard({ config: readCapacityGuardConfig({ CLOUDCOM_CAPACITY_GUARD_ENABLED: 'true' }),
    collect, checkDependencies, readEventLoop, onTransition: options.onTransition });
  guards.push(guard);
  return { guard, collect, checkDependencies, readEventLoop };
}
async function start(guard: CapacityGuard) { guard.start(); await guard.sampleNow(); }

describe('capacity guard admission', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { guards.splice(0).forEach(guard => guard.stop()); vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('leaves the default disabled path open without collecting or checking dependencies', async () => {
    vi.stubEnv('CLOUDCOM_CAPACITY_GUARD_ENABLED', 'false');
    const collect = vi.fn(async () => host), checkDependencies = vi.fn(async () => false);
    const guard = new CapacityGuard({ config: readCapacityGuardConfig({}), collect, checkDependencies });
    guards.push(guard);
    await start(guard);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(guard.read()).toMatchObject({ state: 'disabled', canRunBackgroundWork: true, reasons: [] });
    expect(collect).not.toHaveBeenCalled(); expect(checkDependencies).not.toHaveBeenCalled();
    expect(canRunBackgroundWork()).toBe(true);
  });
  it('denies enabled admission before startup and waits for sixty continuously healthy seconds', async () => {
    vi.stubEnv('CLOUDCOM_CAPACITY_GUARD_ENABLED', 'true');
    expect(readCapacityGuard()).toMatchObject({ canRunBackgroundWork: false, reasons: ['not_started'] });
    const { guard } = harness();
    await start(guard);
    expect(guard.read()).toMatchObject({ state: 'warming', canRunBackgroundWork: false });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(guard.read().canRunBackgroundWork).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(guard.read()).toMatchObject({ state: 'healthy', canRunBackgroundWork: true, healthyForMs: 60_000 });
  });
  it('pauses immediately at high CPU, tolerates a middle band only while healthy, and requires recovery dwell', async () => {
    const { guard, collect } = harness();
    await start(guard); await vi.advanceTimersByTimeAsync(60_000);
    collect.mockResolvedValue({ ...host, cpuBusyPercent: 60 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(guard.read().canRunBackgroundWork).toBe(true);
    collect.mockResolvedValue({ ...host, cpuBusyPercent: 70 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(guard.read()).toMatchObject({ state: 'paused', reasons: ['cpu_busy'], canRunBackgroundWork: false });
    collect.mockResolvedValue({ ...host, cpuBusyPercent: 60 });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(guard.read().canRunBackgroundWork).toBe(false);
    collect.mockResolvedValue(host);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(guard.read().reasons).toEqual(['recovering']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(guard.read().canRunBackgroundWork).toBe(true);
  });
  it('denies stale samples synchronously and does not count an unobserved gap as healthy dwell', async () => {
    const { guard } = harness();
    await start(guard); await vi.advanceTimersByTimeAsync(60_000);
    vi.setSystemTime(Date.now() + 20_001);
    expect(guard.read()).toMatchObject({ state: 'paused', canRunBackgroundWork: false, reasons: ['stale_sample'] });
    await guard.sampleNow();
    expect(guard.read()).toMatchObject({ state: 'paused', canRunBackgroundWork: false, reasons: ['recovering'] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(guard.read().canRunBackgroundWork).toBe(true);
  });
  it('rejects a backwards clock jump and restarts the dwell', async () => {
    const { guard } = harness();
    await start(guard); await vi.advanceTimersByTimeAsync(60_000);
    vi.setSystemTime(Date.now() - 1);
    expect(guard.read().canRunBackgroundWork).toBe(false);
    await guard.sampleNow();
    expect(guard.read().canRunBackgroundWork).toBe(false);
  });
  it('does not accept a slow successful collection as a fresh sample', async () => {
    let resolve!: (value: HostCapacitySample) => void;
    const { guard, collect } = harness({ collect: () => new Promise(done => { resolve = done; }) });
    guard.start();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(collect).toHaveBeenCalledTimes(1);
    resolve(host); await guard.sampleNow();
    expect(guard.read()).toMatchObject({ canRunBackgroundWork: false, reasons: ['stale_sample'] });
  });
  it('keeps a timed-out unresolved dependency probe single-flight across subsequent samples', async () => {
    let resolve!: (ready: boolean) => void;
    const { guard, checkDependencies, collect } = harness({ checkDependencies: () => new Promise(done => { resolve = done; }) });
    guard.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(guard.read().reasons).toContain('dependency_probe_timeout');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkDependencies).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls.length).toBeGreaterThan(1);
    expect(guard.read().reasons).toContain('dependency_probe_pending');
    resolve(true); await Promise.resolve(); await Promise.resolve();
    expect(guard.read().canRunBackgroundWork).toBe(false);
    checkDependencies.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(checkDependencies).toHaveBeenCalledTimes(2);
    expect(guard.read().canRunBackgroundWork).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(guard.read().canRunBackgroundWork).toBe(true);
  });
  it('turns dependency failure into a deny and resets recovery after a thrown collector', async () => {
    const { guard, checkDependencies, collect } = harness();
    await start(guard); await vi.advanceTimersByTimeAsync(60_000);
    checkDependencies.mockRejectedValueOnce(new Error('do not log connection data'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(guard.read().reasons).toEqual(['dependencies_unavailable']);
    collect.mockRejectedValueOnce(new Error('private details'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(guard.read()).toMatchObject({ canRunBackgroundWork: false, reasons: ['sample_failed'], metrics: { cpuBusyPercent: null } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(guard.read().canRunBackgroundWork).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(guard.read().canRunBackgroundWork).toBe(true);
  });
  it.each(['monitored', 'coversWindow'] as const)('requires event-loop %s rather than trusting a zero measurement', async field => {
    const { guard, readEventLoop } = harness();
    readEventLoop.mockReturnValue({ ...loop, [field]: false, worstLagMs: 0 });
    await start(guard); await vi.advanceTimersByTimeAsync(90_000);
    expect(guard.read()).toMatchObject({ canRunBackgroundWork: false, reasons: ['event_loop_unknown'] });
    expect(readEventLoop).toHaveBeenCalledWith(5_000);
  });
  it('preserves unknown optional platform observations without fabricating zero', async () => {
    const { guard } = harness({ collect: async () => ({ ...host, cpuStealPercent: null, cpuIowaitPercent: null, memoryUsedPercent: null }) });
    await start(guard); await vi.advanceTimersByTimeAsync(60_000);
    expect(guard.read()).toMatchObject({ canRunBackgroundWork: true, metrics: { cpuStealPercent: null, memoryUsedPercent: null } });
  });
  it('never publishes a late sample after shutdown or overlaps repeated startup', async () => {
    let resolve!: (value: HostCapacitySample) => void;
    const { guard, collect } = harness({ collect: () => new Promise(done => { resolve = done; }) });
    guard.start(); guard.start(); guard.stop();
    resolve(host); await guard.sampleNow(); await Promise.resolve();
    expect(guard.read()).toMatchObject({ state: 'stopped', canRunBackgroundWork: false, observedAt: null });
    expect(collect).toHaveBeenCalledTimes(1);
  });
  it('returns detached snapshots so UI consumers cannot weaken the guard', async () => {
    const { guard } = harness(); await start(guard);
    const snapshot = guard.read(); snapshot.thresholds.cpuPausePercent = 100; snapshot.reasons.length = 0;
    expect(guard.read().thresholds.cpuPausePercent).toBe(70);
    expect(guard.read().reasons).toEqual(['warming_up']);
  });
  it('reports bounded transitions on a throttle and isolates reporting failures from admission', async () => {
    const report = vi.fn<(snapshot: CapacityGuardSnapshot) => void>();
    const { guard, collect } = harness({ onTransition: report });
    await start(guard); await vi.advanceTimersByTimeAsync(60_000);
    expect(report.mock.calls.map(([snapshot]) => snapshot.state)).toEqual(['warming', 'healthy']);
    collect.mockResolvedValue({ ...host, cpuBusyPercent: 80 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(guard.read().canRunBackgroundWork).toBe(false);
    expect(report).toHaveBeenCalledTimes(2);
    report.mockImplementation(() => { throw new Error('reporting unavailable'); });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(report).toHaveBeenCalledTimes(3);
    expect(report.mock.calls[2]![0]).toMatchObject({ state: 'paused', reasons: ['cpu_busy'] });
    expect(guard.read().reasons).toEqual(['cpu_busy']);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(report).toHaveBeenCalledTimes(3);
  });
});

describe('host capacity counter parsing', () => {
  it('uses interval CPU deltas and treats first sample, CPU topology changes and resets as unknown', () => {
    const before = { count: 2, values: [100, 0, 100, 800, 0] };
    expect(cpuBusyPercent(before, { count: 2, values: [150, 0, 150, 900, 0] })).toBe(50);
    expect(cpuBusyPercent(null, before)).toBeNull();
    expect(cpuBusyPercent(before, { ...before, count: 3 })).toBeNull();
    expect(cpuBusyPercent(before, before)).toBeNull();
    expect(cpuBusyPercent(before, { count: 2, values: [99, 0, 200, 1000, 0] })).toBeNull();
  });
  it('parses aggregate Linux counters without double-counting guest time', () => {
    expect(parseLinuxCpu('cpu 10 20 30 40 50 60 70 80 999 999\ncpu0 1 2 3 4 5 6 7 8'))
      .toEqual({ total: 360, busy: 190, idle: 40, iowait: 50, steal: 80 });
    expect(parseLinuxCpu('cpu 1 2 3 4 5 6 7 bad')).toBeNull();
    expect(parseLinuxCpu('cpu0 1 2 3 4 5 6 7 8')).toBeNull();
  });
  it('includes softirq and host steal in the Linux denominator, excluding steal and iowait from busy time', () => {
    const before = parseLinuxCpu('cpu 100 0 100 100 100 100 100 100 999 999');
    const after = parseLinuxCpu('cpu 110 0 110 120 120 110 110 120 1999 1999');
    expect(linuxCpuPercent(before, after, 'busy')).toBe(40);
    expect(linuxCpuPercent(before, after, 'steal')).toBe(20);
    expect(linuxCpuPercent(before, after, 'iowait')).toBe(20);
    expect(linuxCpuPercent(null, after, 'busy')).toBeNull();
  });
  it('uses MemAvailable to account for reclaimable cache and keeps invalid readings unknown', () => {
    expect(parseLinuxMemory('MemTotal: 1000 kB\nMemAvailable: 250 kB\nMemFree: 10 kB')).toBe(75);
    expect(parseLinuxMemory('MemTotal: 1000 kB\nMemAvailable: 1001 kB')).toBeNull();
    expect(parseLinuxMemory('MemTotal: 1000 kB')).toBeNull();
  });
});

describe('Linux capacity collector required observations', () => {
  beforeEach(() => { hostIo.readFile.mockReset(); hostIo.platform.mockReturnValue('linux'); });
  it('samples real host busy/steal deltas and reclaimable memory after the initial unknown baseline', async () => {
    let stat = 'cpu 100 0 100 100 100 100 100 100 999 999';
    hostIo.readFile.mockImplementation(async path => path === '/proc/stat' ? stat : 'MemTotal: 1000 kB\nMemAvailable: 250 kB');
    const collect = createHostCapacityCollector();
    expect(await collect()).toMatchObject({ cpuBusyPercent: null, cpuStealPercent: null, memoryUsedPercent: 75 });
    stat = 'cpu 110 0 110 120 120 110 110 120 1999 1999';
    expect(await collect()).toEqual({ cpuBusyPercent: 40, cpuStealPercent: 20, cpuIowaitPercent: 20, memoryUsedPercent: 75 });
  });
  it.each(['/proc/stat', '/proc/meminfo'])('rejects missing %s instead of bypassing an unavailable guard signal', async missing => {
    hostIo.readFile.mockImplementation(async path => {
      if (path === missing) throw new Error('unavailable');
      return path === '/proc/stat' ? 'cpu 1 2 3 4 5 6 7 8' : 'MemTotal: 1000 kB\nMemAvailable: 500 kB';
    });
    await expect(createHostCapacityCollector()()).rejects.toThrow();
  });
  it.each(['/proc/stat', '/proc/meminfo'])('rejects malformed %s instead of bypassing an unavailable guard signal', async malformed => {
    hostIo.readFile.mockImplementation(async path => path === malformed ? 'bad' : path === '/proc/stat'
      ? 'cpu 1 2 3 4 5 6 7 8' : 'MemTotal: 1000 kB\nMemAvailable: 500 kB');
    await expect(createHostCapacityCollector()()).rejects.toThrow('capacity_host_observation_unavailable');
  });
});
