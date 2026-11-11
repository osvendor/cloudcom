import { describe, expect, it } from 'vitest';
import { AgentUpdateCapacityWindow } from './agentUpdateCapacity';
import { readCapacityGuardConfig, type CapacityGuardMetrics } from './capacityGuardPolicy';

const config = readCapacityGuardConfig({ CLOUDCOM_CAPACITY_GUARD_ENABLED: 'true',
  CLOUDCOM_CAPACITY_GUARD_CPU_PAUSE_PERCENT: '35', CLOUDCOM_CAPACITY_GUARD_CPU_RESUME_PERCENT: '25',
  CLOUDCOM_CAPACITY_GUARD_STEAL_PAUSE_PERCENT: '10', CLOUDCOM_CAPACITY_GUARD_STEAL_RESUME_PERCENT: '5' });
const low: CapacityGuardMetrics = { cpuBusyPercent: 10, cpuStealPercent: 0, cpuIowaitPercent: 0,
  memoryUsedPercent: 50, eventLoopLagMs: 20, dependenciesReady: true };
function filled(metrics: Partial<CapacityGuardMetrics> = {}) {
  const window = new AgentUpdateCapacityWindow(config);
  for (let at = 0; at <= 60_000; at += 5_000) window.record(at, { ...low, ...metrics });
  return window;
}

describe('bounded agent-update capacity window', () => {
  it('requires a complete minute and clips a partial oldest interval', () => {
    const window = new AgentUpdateCapacityWindow(config);
    for (let at = 0; at <= 55_000; at += 5_000) window.record(at, low);
    window.record(59_999, low);
    expect(window.read(59_999)).toMatchObject({ allowed: false, observedMs: 59_999 });
    window.record(60_000, low);
    expect(window.read(60_000)).toMatchObject({ allowed: true, observedMs: 60_000 });
    window.record(62_500, low);
    expect(window.read(62_500)).toMatchObject({ allowed: true, observedMs: 60_000 });
  });
  it('weights the CPU delta over the interval ending at that sample, not equally per tick', () => {
    const window = new AgentUpdateCapacityWindow(config);
    window.record(0, low);
    window.record(5_000, { ...low, cpuBusyPercent: 70 });
    for (const at of [20_000, 40_000, 60_000]) window.record(at, low);
    expect(window.read(60_000)).toMatchObject({ allowed: true, observedMs: 60_000,
      averages: { cpuBusyPercent: 15 } });
    window.record(62_500, low);
    expect(window.read(62_500).averages.cpuBusyPercent).toBe(12.5);
  });
  it('makes progress between recurring short spikes for two hours without admitting during spikes', () => {
    const window = new AgentUpdateCapacityWindow(config);
    let opportunities = 0;
    for (let at = 0; at <= 7_200_000; at += 5_000) {
      const spike = at % 30_000 === 0;
      window.record(at, { ...low, cpuBusyPercent: spike ? 45 : 15, eventLoopLagMs: spike ? 140 : 25 });
      const reading = window.read(at);
      if (spike || at < 60_000) expect(reading.allowed).toBe(false);
      else { expect(reading.allowed).toBe(true); opportunities++; }
      expect(reading.observedMs).toBeLessThanOrEqual(60_000);
    }
    expect(opportunities).toBeGreaterThan(1000);
  });
  it.each([
    ['cpuBusyPercent', 35, 'current_cpu_busy'], ['cpuStealPercent', 10, 'current_cpu_steal'],
    ['eventLoopLagMs', 250, 'current_event_loop_lag'],
  ] as const)('denies current %s pressure despite a low average', (key, value, reason) => {
    const window = filled(); window.record(65_000, { ...low, [key]: value });
    expect(window.read(65_000)).toMatchObject({ allowed: false, reasons: [reason] });
    window.record(70_000, low); expect(window.read(70_000).allowed).toBe(true);
  });
  it.each([
    ['cpuBusyPercent', 25, 'sustained_cpu_busy'], ['cpuStealPercent', 5, 'sustained_cpu_steal'],
    ['eventLoopLagMs', 100, 'sustained_event_loop_lag'], ['memoryUsedPercent', 85, 'sustained_memory_pressure'],
  ] as const)('denies sustained %s at the resume boundary', (key, value, reason) => {
    expect(filled({ [key]: value }).read(60_000)).toMatchObject({ allowed: false, reasons: [reason] });
  });
  it.each([
    ['cpuBusyPercent', 85], ['cpuStealPercent', 20], ['eventLoopLagMs', 1000], ['memoryUsedPercent', 90],
  ] as const)('does not dilute severe %s pressure with idle history', (key, value) => {
    const window = filled(); window.record(65_000, { ...low, [key]: value });
    expect(window.read(65_000)).toMatchObject({ allowed: false, observedMs: 0, reasons: ['severe_pressure'] });
    for (let at = 70_000; at <= 125_000; at += 5_000) window.record(at, low);
    expect(window.read(125_000).allowed).toBe(false);
    window.record(130_000, low); expect(window.read(130_000).allowed).toBe(true);
  });
  it.each([
    ['cpuBusyPercent', null], ['cpuBusyPercent', NaN], ['cpuBusyPercent', Infinity], ['cpuBusyPercent', -1],
    ['cpuBusyPercent', 101], ['cpuStealPercent', null], ['memoryUsedPercent', null],
    ['eventLoopLagMs', null], ['eventLoopLagMs', -1], ['eventLoopLagMs', Infinity], ['dependenciesReady', false],
  ])('resets history when %s is unavailable or invalid (%s)', (key, value) => {
    const window = filled(); window.record(65_000, { ...low, [key as string]: value });
    expect(window.read(65_000)).toMatchObject({ allowed: false, observedMs: 0 });
    window.record(70_000, low); expect(window.read(70_000).allowed).toBe(false);
  });
  it.each([80_001, 59_999, NaN])('invalidates history on a stale or clock-invalid read at %s', now => {
    const window = filled(); expect(window.read(now).allowed).toBe(false);
    expect(window.read(60_000).allowed).toBe(false);
    window.record(65_000, low); expect(window.read(65_000).observedMs).toBe(0);
  });
  it.each([80_001, 60_000, 59_999])('does not bridge a sample gap or backwards/duplicate timestamp at %s', at => {
    const window = filled(); window.record(at, low);
    expect(window.read(at)).toMatchObject({ allowed: false, observedMs: 0 });
  });
  it('clears history on stop/restart and returns detached readings', () => {
    const window = filled(); const reading = window.read(60_000); reading.averages.cpuBusyPercent = 99;
    expect(window.read(60_000).allowed).toBe(true);
    window.reset('stopped'); expect(window.read(60_000).allowed).toBe(false);
    window.record(65_000, low); expect(window.read(65_000).allowed).toBe(false);
  });
});
