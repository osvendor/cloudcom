import { describe, expect, it } from 'vitest';
import { capacityPressureReasons, readCapacityGuardConfig, type CapacityGuardMetrics } from './capacityGuardPolicy';

const healthy: CapacityGuardMetrics = {
  cpuBusyPercent: 10, cpuStealPercent: 0, cpuIowaitPercent: 0,
  memoryUsedPercent: 50, eventLoopLagMs: 20, dependenciesReady: true,
};

describe('capacity guard configuration and pressure policy', () => {
  it('defaults off with bounded sampling and recovery thresholds', () => {
    expect(readCapacityGuardConfig({})).toMatchObject({ enabled: false, sampleIntervalMs: 5000,
      staleAfterMs: 20000, recoveryAfterMs: 60000, cpuPausePercent: 70, cpuResumePercent: 50,
      eventLoopPauseMs: 250, eventLoopResumeMs: 100, memoryPausePercent: 90, memoryResumePercent: 85,
      stealPausePercent: 5, stealResumePercent: 2 });
  });
  it('accepts explicit deployment tuning', () => {
    expect(readCapacityGuardConfig({ CLOUDCOM_CAPACITY_GUARD_ENABLED: 'true',
      CLOUDCOM_CAPACITY_GUARD_CPU_PAUSE_PERCENT: '35', CLOUDCOM_CAPACITY_GUARD_CPU_RESUME_PERCENT: '25' }))
      .toMatchObject({ enabled: true, cpuPausePercent: 35, cpuResumePercent: 25 });
  });
  it.each(['', 'NaN', 'Infinity', '-1', '101', '35junk', '1e2'])('rejects malformed CPU threshold %s', value => {
    expect(() => readCapacityGuardConfig({ CLOUDCOM_CAPACITY_GUARD_CPU_PAUSE_PERCENT: value })).toThrow();
  });
  it('rejects ambiguous enable flags and inverted hysteresis', () => {
    expect(() => readCapacityGuardConfig({ CLOUDCOM_CAPACITY_GUARD_ENABLED: 'yes' })).toThrow();
    expect(() => readCapacityGuardConfig({ CLOUDCOM_CAPACITY_GUARD_CPU_PAUSE_PERCENT: '50' })).toThrow();
    expect(() => readCapacityGuardConfig({ CLOUDCOM_CAPACITY_GUARD_EVENT_LOOP_RESUME_MS: '251' })).toThrow();
  });
  it.each([
    ['cpuBusyPercent', 70, 'cpu_busy'], ['eventLoopLagMs', 250, 'event_loop_lag'],
    ['cpuStealPercent', 5, 'cpu_steal'], ['memoryUsedPercent', 90, 'memory_pressure'],
  ] as const)('pauses at the %s boundary', (field, value, reason) => {
    expect(capacityPressureReasons({ ...healthy, [field]: value }, readCapacityGuardConfig({}), false)).toEqual([reason]);
  });
  it('requires lower thresholds throughout recovery, while a healthy guard tolerates the middle band', () => {
    const metrics = { ...healthy, cpuBusyPercent: 60, cpuStealPercent: 3, memoryUsedPercent: 87, eventLoopLagMs: 150 };
    expect(capacityPressureReasons(metrics, readCapacityGuardConfig({}), false)).toEqual([]);
    expect(capacityPressureReasons(metrics, readCapacityGuardConfig({}), true))
      .toEqual(['cpu_busy', 'cpu_steal', 'memory_pressure', 'event_loop_lag']);
  });
  it.each([null, NaN, -1, Infinity, 101])('does not treat unknown or invalid CPU %s as healthy', cpuBusyPercent => {
    expect(capacityPressureReasons({ ...healthy, cpuBusyPercent }, readCapacityGuardConfig({}), false)).toEqual(['cpu_unknown']);
  });
  it('requires dependencies and event-loop observations but preserves optional platform unknowns', () => {
    expect(capacityPressureReasons({ ...healthy, cpuStealPercent: null, cpuIowaitPercent: null, memoryUsedPercent: null }, readCapacityGuardConfig({}), true)).toEqual([]);
    expect(capacityPressureReasons({ ...healthy, eventLoopLagMs: null, dependenciesReady: null }, readCapacityGuardConfig({}), false))
      .toEqual(['event_loop_unknown', 'dependencies_unavailable']);
  });
});
