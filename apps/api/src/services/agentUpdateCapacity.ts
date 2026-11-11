import {
  capacityPressureReasons, type CapacityGuardConfig, type CapacityGuardMetrics,
} from './capacityGuardPolicy';

export interface AgentUpdateCapacitySnapshot {
  allowed: boolean;
  reasons: string[];
  windowMs: number;
  observedMs: number;
  averages: { cpuBusyPercent: number | null; cpuStealPercent: number | null; eventLoopLagMs: number | null };
}
type Interval = { from: number; to: number; metrics: CapacityGuardMetrics };
const percent = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0 && n <= 100;

/** Small, rate-limited updates use sustained capacity, not the heavy-job recovery latch.
 * CPU deltas describe the interval ENDING at an observation. Never carry an old
 * low reading forward across an unobserved interval. No I/O occurs on admission.
 */
export class AgentUpdateCapacityWindow {
  private intervals: Interval[] = [];
  private lastAt: number | null = null;
  private latest: CapacityGuardMetrics | null = null;
  private resetReason = 'warming_up';

  constructor(private readonly config: CapacityGuardConfig) {}

  reset(reason = 'warming_up'): void {
    this.intervals = []; this.lastAt = null; this.latest = null; this.resetReason = reason;
  }

  record(at: number, metrics: CapacityGuardMetrics): void {
    if (!Number.isFinite(at) || !percent(metrics.cpuBusyPercent) || !percent(metrics.cpuStealPercent)
      || !percent(metrics.memoryUsedPercent) || metrics.dependenciesReady !== true
      || metrics.eventLoopLagMs === null || !Number.isFinite(metrics.eventLoopLagMs) || metrics.eventLoopLagMs < 0) {
      this.reset('observations_unavailable'); return;
    }
    // Severe pressure must earn a new full observation window. It cannot be
    // diluted by earlier idle samples. Ordinary brief spikes remain in averages.
    if (metrics.cpuBusyPercent >= Math.max(85, this.config.cpuPausePercent)
      || metrics.cpuStealPercent >= Math.max(20, this.config.stealPausePercent)
      || metrics.eventLoopLagMs >= Math.max(1000, this.config.eventLoopPauseMs)
      || metrics.memoryUsedPercent >= this.config.memoryPausePercent) {
      this.reset('severe_pressure'); return;
    }
    const previous = this.lastAt;
    if (previous !== null && (at <= previous || at - previous > this.config.staleAfterMs)) this.reset('observation_gap');
    if (this.lastAt !== null) this.intervals.push({ from: this.lastAt, to: at, metrics: { ...metrics } });
    this.lastAt = at; this.latest = { ...metrics };
    const cutoff = at - this.config.recoveryAfterMs;
    this.intervals = this.intervals.filter(interval => interval.to > cutoff);
    // Bound storage even if a caller samples much more often than the timer.
    if (this.intervals.length > 256) this.reset('observation_frequency_invalid');
  }

  read(now: number): AgentUpdateCapacitySnapshot {
    const result: AgentUpdateCapacitySnapshot = { allowed: false, reasons: [], windowMs: this.config.recoveryAfterMs,
      observedMs: 0, averages: { cpuBusyPercent: null, cpuStealPercent: null, eventLoopLagMs: null } };
    if (!this.config.enabled) return { ...result, allowed: true };
    if (this.lastAt === null || !this.latest) return { ...result, reasons: [this.resetReason] };
    if (!Number.isFinite(now) || now < this.lastAt || now - this.lastAt > this.config.staleAfterMs) {
      this.reset('stale_sample');
      return { ...result, reasons: ['stale_sample'] };
    }
    const cutoff = this.lastAt - result.windowMs;
    let cpu = 0, steal = 0, lag = 0, memory = this.latest.memoryUsedPercent!;
    for (const interval of this.intervals) {
      const duration = interval.to - Math.max(interval.from, cutoff);
      result.observedMs += duration;
      cpu += interval.metrics.cpuBusyPercent! * duration;
      steal += interval.metrics.cpuStealPercent! * duration;
      lag += interval.metrics.eventLoopLagMs! * duration;
      memory = Math.max(memory, interval.metrics.memoryUsedPercent!);
    }
    if (result.observedMs > 0) result.averages = { cpuBusyPercent: cpu / result.observedMs,
      cpuStealPercent: steal / result.observedMs, eventLoopLagMs: lag / result.observedMs };
    // Never start during a current pressure spike, even when the average is low.
    result.reasons = capacityPressureReasons(this.latest, this.config, false).map(reason => `current_${reason}`);
    if (result.observedMs < result.windowMs) result.reasons.push('warming_up');
    else result.reasons.push(...capacityPressureReasons({ ...this.latest, ...result.averages, memoryUsedPercent: memory },
      this.config, true).map(reason => `sustained_${reason}`));
    result.allowed = result.reasons.length === 0;
    return result;
  }
}
