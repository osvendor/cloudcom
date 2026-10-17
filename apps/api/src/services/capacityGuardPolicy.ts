/** Host-visible measurements only: these are not container quota or provider burst-credit readings. */
export interface CapacityGuardMetrics {
  cpuBusyPercent: number | null;
  cpuStealPercent: number | null;
  cpuIowaitPercent: number | null;
  memoryUsedPercent: number | null;
  eventLoopLagMs: number | null;
  dependenciesReady: boolean | null;
}

export interface CapacityGuardConfig {
  enabled: boolean;
  sampleIntervalMs: number;
  staleAfterMs: number;
  recoveryAfterMs: number;
  dependencyTimeoutMs: number;
  cpuPausePercent: number;
  cpuResumePercent: number;
  eventLoopPauseMs: number;
  eventLoopResumeMs: number;
  memoryPausePercent: number;
  memoryResumePercent: number;
  stealPausePercent: number;
  stealResumePercent: number;
}

export type CapacityGuardReason = 'not_started' | 'stopped' | 'warming_up' | 'recovering'
  | 'stale_sample' | 'cpu_unknown' | 'cpu_busy' | 'cpu_steal' | 'memory_pressure'
  | 'event_loop_unknown' | 'event_loop_lag' | 'dependencies_unavailable'
  | 'dependency_probe_timeout' | 'dependency_probe_pending' | 'sample_failed';

export const EMPTY_CAPACITY_METRICS: Readonly<CapacityGuardMetrics> = Object.freeze({
  cpuBusyPercent: null, cpuStealPercent: null, cpuIowaitPercent: null,
  memoryUsedPercent: null, eventLoopLagMs: null, dependenciesReady: null,
});

/** Reject malformed tuning instead of silently disabling protection with NaN or inverted hysteresis. */
export function readCapacityGuardConfig(env: NodeJS.ProcessEnv = process.env): CapacityGuardConfig {
  const ENABLED_ENV = 'CLOUDCOM_CAPACITY_GUARD_ENABLED';
  const CPU_PAUSE_ENV = 'CLOUDCOM_CAPACITY_GUARD_CPU_PAUSE_PERCENT';
  const CPU_RESUME_ENV = 'CLOUDCOM_CAPACITY_GUARD_CPU_RESUME_PERCENT';
  const LOOP_PAUSE_ENV = 'CLOUDCOM_CAPACITY_GUARD_EVENT_LOOP_PAUSE_MS';
  const LOOP_RESUME_ENV = 'CLOUDCOM_CAPACITY_GUARD_EVENT_LOOP_RESUME_MS';
  const MEMORY_PAUSE_ENV = 'CLOUDCOM_CAPACITY_GUARD_MEMORY_PAUSE_PERCENT';
  const MEMORY_RESUME_ENV = 'CLOUDCOM_CAPACITY_GUARD_MEMORY_RESUME_PERCENT';
  const STEAL_PAUSE_ENV = 'CLOUDCOM_CAPACITY_GUARD_STEAL_PAUSE_PERCENT';
  const STEAL_RESUME_ENV = 'CLOUDCOM_CAPACITY_GUARD_STEAL_RESUME_PERCENT';
  const enabled = env[ENABLED_ENV]?.trim().toLowerCase() ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new Error(`${ENABLED_ENV} must be true or false`);
  const number = (name: string, fallback: number, maximum = 100): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^\d+(?:\.\d+)?$/.test(raw.trim())) throw new Error(`${name} must be a nonnegative number`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value > maximum) throw new Error(`${name} is out of range`);
    return value;
  };
  const pair = (pauseEnv: string, resumeEnv: string, pause: number, resume: number, max = 100): [number, number] => {
    const values: [number, number] = [number(pauseEnv, pause, max), number(resumeEnv, resume, max)];
    if (values[1] >= values[0]) throw new Error(`${resumeEnv} threshold must be below ${pauseEnv}`);
    return values;
  };
  const [cpuPausePercent, cpuResumePercent] = pair(CPU_PAUSE_ENV, CPU_RESUME_ENV, 70, 50);
  const [eventLoopPauseMs, eventLoopResumeMs] = pair(LOOP_PAUSE_ENV, LOOP_RESUME_ENV, 250, 100, 60_000);
  const [memoryPausePercent, memoryResumePercent] = pair(MEMORY_PAUSE_ENV, MEMORY_RESUME_ENV, 90, 85);
  const [stealPausePercent, stealResumePercent] = pair(STEAL_PAUSE_ENV, STEAL_RESUME_ENV, 5, 2);
  return {
    enabled: enabled === 'true', sampleIntervalMs: 5_000, staleAfterMs: 20_000,
    recoveryAfterMs: 60_000, dependencyTimeoutMs: 3_000,
    cpuPausePercent, cpuResumePercent, eventLoopPauseMs, eventLoopResumeMs,
    memoryPausePercent, memoryResumePercent, stealPausePercent, stealResumePercent,
  };
}

const percent = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0 && value <= 100;

/** The collector requires Linux /proc observations; unsupported platform observations stay null. */
export function capacityPressureReasons(
  metrics: CapacityGuardMetrics, config: CapacityGuardConfig, recovering: boolean,
): CapacityGuardReason[] {
  const reasons: CapacityGuardReason[] = [];
  const threshold = (pause: number, resume: number) => recovering ? resume : pause;
  if (!percent(metrics.cpuBusyPercent)) reasons.push('cpu_unknown');
  else if (metrics.cpuBusyPercent >= threshold(config.cpuPausePercent, config.cpuResumePercent)) reasons.push('cpu_busy');
  if (percent(metrics.cpuStealPercent) && metrics.cpuStealPercent >= threshold(config.stealPausePercent, config.stealResumePercent)) reasons.push('cpu_steal');
  if (percent(metrics.memoryUsedPercent) && metrics.memoryUsedPercent >= threshold(config.memoryPausePercent, config.memoryResumePercent)) reasons.push('memory_pressure');
  if (metrics.eventLoopLagMs === null || !Number.isFinite(metrics.eventLoopLagMs) || metrics.eventLoopLagMs < 0) reasons.push('event_loop_unknown');
  else if (metrics.eventLoopLagMs >= threshold(config.eventLoopPauseMs, config.eventLoopResumeMs)) reasons.push('event_loop_lag');
  if (metrics.dependenciesReady !== true) reasons.push('dependencies_unavailable');
  return reasons;
}
