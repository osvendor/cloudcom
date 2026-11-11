import { cpus, freemem, platform, totalmem } from 'node:os';
import { readFile } from 'node:fs/promises';
import { readEventLoopLag, type EventLoopLagReading } from './eventLoopMonitor';
import { AgentUpdateCapacityWindow, type AgentUpdateCapacitySnapshot } from './agentUpdateCapacity';
import {
  capacityPressureReasons, EMPTY_CAPACITY_METRICS, readCapacityGuardConfig,
  type CapacityGuardConfig, type CapacityGuardMetrics, type CapacityGuardReason,
} from './capacityGuardPolicy';

export type CapacityGuardState = 'disabled' | 'warming' | 'healthy' | 'paused' | 'stopped';
export interface CapacityGuardSnapshot {
  enabled: boolean;
  state: CapacityGuardState;
  canRunBackgroundWork: boolean;
  observedAt: string | null;
  sampleAgeMs: number | null;
  healthyForMs: number;
  reasons: CapacityGuardReason[];
  metrics: CapacityGuardMetrics;
  thresholds: CapacityGuardConfig;
  agentUpdates: AgentUpdateCapacitySnapshot;
}
export type HostCapacitySample = Pick<CapacityGuardMetrics,
  'cpuBusyPercent' | 'cpuStealPercent' | 'cpuIowaitPercent' | 'memoryUsedPercent'>;
export interface CapacityGuardOptions {
  checkDependencies: () => Promise<boolean>;
  config?: CapacityGuardConfig;
  collect?: () => Promise<HostCapacitySample>;
  readEventLoop?: (windowMs: number) => EventLoopLagReading;
  now?: () => number;
  monotonicNow?: () => number;
  /** Bounded state changes only; logging/reporting failures cannot affect admission. */
  onTransition?: (snapshot: CapacityGuardSnapshot) => void;
}

type CpuTotals = { count: number; values: number[] };
type LinuxTotals = { total: number; busy: number; idle: number; steal: number; iowait: number };
const validCounter = (n: number) => Number.isSafeInteger(n) && n >= 0;

export function cpuBusyPercent(previous: CpuTotals | null, current: CpuTotals): number | null {
  if (!previous || previous.count !== current.count || !current.count || current.values.length !== 5 || previous.values.length !== 5) return null;
  const deltas = current.values.map((n, i) => n - previous.values[i]!);
  if (![...previous.values, ...current.values, ...deltas].every(validCounter)) return null;
  const total = deltas.reduce((sum, n) => sum + n, 0);
  return total > 0 ? (total - deltas[3]!) / total * 100 : null;
}

export function parseLinuxCpu(stat: string): LinuxTotals | null {
  const values = stat.split('\n').find(line => /^cpu\s/.test(line))?.trim().split(/\s+/).slice(1, 9).map(Number);
  if (!values || values.length !== 8 || !values.every(validCounter)) return null;
  const total = values.reduce((sum, n) => sum + n, 0);
  const idle = values[3]!, iowait = values[4]!, steal = values[7]!;
  return validCounter(total) ? { total, busy: total - idle - iowait - steal, idle, iowait, steal } : null;
}

export function linuxCpuPercent(previous: LinuxTotals | null, current: LinuxTotals | null, key: 'busy' | 'steal' | 'iowait'): number | null {
  if (!previous || !current) return null;
  const total = current.total - previous.total, delta = current[key] - previous[key];
  return total > 0 && delta >= 0 && delta <= total ? delta / total * 100 : null;
}

export function parseLinuxMemory(meminfo: string): number | null {
  const total = Number(meminfo.match(/^MemTotal:\s+(\d+) kB$/m)?.[1]);
  const available = Number(meminfo.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]);
  return total > 0 && Number.isFinite(available) && available >= 0 && available <= total ? (1 - available / total) * 100 : null;
}

/** Each guard owns its counter baseline; no files, SQL or Redis are read on admission. */
export function createHostCapacityCollector(): () => Promise<HostCapacitySample> {
  let previousCpu: CpuTotals | null = null, previousLinux: LinuxTotals | null = null;
  return async () => {
    if (platform() === 'linux') {
      // os.cpus() omits steal/softirq from its denominator. /proc includes both,
      // so hypervisor throttling cannot turn a small busy delta into "100% CPU".
      // Linux observations are mandatory; unreadable/malformed files deny work.
      const [stat, mem] = await Promise.all([readFile('/proc/stat', 'utf8'), readFile('/proc/meminfo', 'utf8')]);
      const current = parseLinuxCpu(stat), memory = parseLinuxMemory(mem);
      if (!current || memory === null) { previousLinux = null; throw new Error('capacity_host_observation_unavailable'); }
      const result = { cpuBusyPercent: linuxCpuPercent(previousLinux, current, 'busy'),
        cpuStealPercent: linuxCpuPercent(previousLinux, current, 'steal'),
        cpuIowaitPercent: linuxCpuPercent(previousLinux, current, 'iowait'), memoryUsedPercent: memory };
      if (previousLinux && result.cpuStealPercent === null) {
        previousLinux = current;
        throw new Error('capacity_host_observation_unavailable');
      }
      previousLinux = current;
      return result;
    }
    const visible = cpus();
    const current = { count: visible.length, values: [0, 0, 0, 0, 0] };
    for (const cpu of visible) [cpu.times.user, cpu.times.nice, cpu.times.sys, cpu.times.idle, cpu.times.irq]
      .forEach((n, i) => { current.values[i]! += n; });
    const busy = cpuBusyPercent(previousCpu, current);
    previousCpu = current;
    const total = totalmem(), free = freemem();
    const memory = total > 0 && free >= 0 && free <= total ? (1 - free / total) * 100 : null;
    return { cpuBusyPercent: busy, cpuStealPercent: null, cpuIowaitPercent: null, memoryUsedPercent: memory };
  };
}

/** Optional background admission only. Never wrap request auth, heartbeats, command delivery or recovery work. */
export class CapacityGuard {
  private readonly config: CapacityGuardConfig;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly collect: () => Promise<HostCapacitySample>;
  private readonly loop: (windowMs: number) => EventLoopLagReading;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sampling: Promise<void> | null = null;
  private dependencyProbe: Promise<boolean> | null = null;
  private active = false;
  private generation = 0;
  private state: CapacityGuardState;
  private observedAt: number | null = null;
  private healthySince: number | null = null;
  private metrics: CapacityGuardMetrics = { ...EMPTY_CAPACITY_METRICS };
  private reasons: CapacityGuardReason[] = ['not_started'];
  private lastReportedTransition: string | null = null;
  private lastReportedAt: number | null = null;
  private readonly updateCapacity: AgentUpdateCapacityWindow;
  private monotonicObservedAt: number | null = null;

  constructor(private readonly options: CapacityGuardOptions) {
    this.config = { ...(options.config ?? readCapacityGuardConfig()) };
    this.updateCapacity = new AgentUpdateCapacityWindow(this.config);
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.collect = options.collect ?? createHostCapacityCollector();
    this.loop = options.readEventLoop ?? readEventLoopLag;
    this.state = this.config.enabled ? 'warming' : 'disabled';
  }

  start(): void {
    if (this.active || !this.config.enabled) return;
    this.active = true;
    this.generation++;
    this.state = 'warming';
    this.healthySince = null;
    this.observedAt = null;
    this.reasons = ['warming_up'];
    this.updateCapacity.reset();
    this.monotonicObservedAt = null;
    this.reportTransition();
    this.timer = setInterval(() => { void this.sampleNow(); }, this.config.sampleIntervalMs);
    this.timer.unref?.();
    void this.sampleNow();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.active = false;
    this.generation++;
    this.healthySince = null;
    this.state = this.config.enabled ? 'stopped' : 'disabled';
    this.reasons = ['stopped'];
    this.updateCapacity.reset('stopped');
    this.monotonicObservedAt = null;
    this.reportTransition();
  }

  private async dependencies(): Promise<{ ready: boolean; reason?: CapacityGuardReason }> {
    // A timed-out check may still own sockets. Do not start another until it actually settles.
    if (this.dependencyProbe) return { ready: false, reason: 'dependency_probe_pending' };
    const probe = Promise.resolve().then(this.options.checkDependencies).then(value => value === true, () => false);
    this.dependencyProbe = probe;
    void probe.then(() => { if (this.dependencyProbe === probe) this.dependencyProbe = null; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        probe.then(ready => ({ ready })),
        new Promise<{ ready: false; reason: CapacityGuardReason }>(resolve => {
          timer = setTimeout(() => resolve({ ready: false, reason: 'dependency_probe_timeout' }), this.config.dependencyTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  sampleNow(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.sampling) { this.reportTransition(); return this.sampling; }
    const generation = this.generation;
    this.sampling = this.sample(generation).finally(() => { this.sampling = null; });
    return this.sampling;
  }

  private async sample(generation: number): Promise<void> {
    const started = this.now();
    const monotonicStarted = this.monotonicNow();
    const monotonicGap = this.monotonicObservedAt === null ? 0 : monotonicStarted - this.monotonicObservedAt;
    const gap = this.observedAt === null ? 0 : started - this.observedAt;
    const clockChanged = this.monotonicObservedAt !== null && Math.abs(gap - monotonicGap) > 1000;
    if (clockChanged) this.updateCapacity.reset('clock_discontinuity');
    if (gap > this.config.staleAfterMs || gap < 0) {
      this.state = 'paused'; this.healthySince = null; this.updateCapacity.reset('observation_gap');
    }
    try {
      const [host, dependencies] = await Promise.all([this.collect(), this.dependencies()]);
      if (!this.active || generation !== this.generation) return;
      // Cover the actual CPU observation interval when a timer tick is delayed.
      const elapsed = Math.max(0, this.monotonicNow() - monotonicStarted);
      const loop = this.loop(Math.max(this.config.sampleIntervalMs,
        monotonicGap > 0 && monotonicGap <= this.config.staleAfterMs ? monotonicGap : 0) + elapsed);
      this.metrics = { ...host, dependenciesReady: dependencies.ready,
        eventLoopLagMs: loop.monitored && loop.coversWindow ? loop.worstLagMs : null };
      this.observedAt = started;
      this.monotonicObservedAt = monotonicStarted;
      const reasons = capacityPressureReasons(this.metrics, this.config, this.state !== 'healthy');
      if (dependencies.reason) reasons.push(dependencies.reason);
      if (this.now() - started > this.config.staleAfterMs || this.now() < started) reasons.push('stale_sample');
      if (dependencies.reason || reasons.includes('stale_sample') || clockChanged || elapsed > this.config.staleAfterMs) {
        this.updateCapacity.reset('observations_unavailable');
      } else this.updateCapacity.record(monotonicStarted, this.metrics);
      if (reasons.length) {
        this.state = 'paused'; this.healthySince = null; this.reasons = reasons;
      } else {
        this.healthySince ??= started;
        if (started - this.healthySince >= this.config.recoveryAfterMs) this.state = 'healthy';
        this.reasons = this.state === 'healthy' ? [] : [this.state === 'warming' ? 'warming_up' : 'recovering'];
      }
    } catch {
      if (!this.active || generation !== this.generation) return;
      this.state = 'paused'; this.healthySince = null; this.observedAt = started;
      this.metrics = { ...EMPTY_CAPACITY_METRICS }; this.reasons = ['sample_failed'];
      this.updateCapacity.reset('sample_failed');
    }
    this.reportTransition();
  }

  private reportTransition(): void {
    if (!this.options.onTransition) return;
    const snapshot = this.read();
    const key = `${snapshot.state}:${snapshot.reasons.join(',')}:${snapshot.agentUpdates.allowed}:${snapshot.agentUpdates.reasons.join(',')}`;
    const now = this.now();
    if (key === this.lastReportedTransition) return;
    if (this.lastReportedAt !== null && now >= this.lastReportedAt && now - this.lastReportedAt < 30_000) return;
    this.lastReportedAt = now; this.lastReportedTransition = key;
    try { this.options.onTransition(snapshot); } catch { /* Observability must not change admission. */ }
  }

  read(): CapacityGuardSnapshot {
    const now = this.now();
    const age = this.observedAt === null ? null : now - this.observedAt;
    const stale = age !== null && (age > this.config.staleAfterMs || age < 0);
    const monotonicAge = this.monotonicObservedAt === null ? null : this.monotonicNow() - this.monotonicObservedAt;
    if (stale || (age !== null && monotonicAge !== null && Math.abs(age - monotonicAge) > 1000)) {
      this.updateCapacity.reset('clock_or_sample_invalid');
    }
    const disabled = !this.config.enabled;
    const reasons = disabled ? [] : [...this.reasons];
    if (stale && !reasons.includes('stale_sample')) reasons.push('stale_sample');
    return {
      enabled: this.config.enabled, state: stale && this.active ? 'paused' : this.state,
      canRunBackgroundWork: disabled || (this.active && this.state === 'healthy' && age !== null && !stale),
      observedAt: this.observedAt === null ? null : new Date(this.observedAt).toISOString(),
      sampleAgeMs: age, healthyForMs: this.healthySince === null || stale ? 0 : Math.max(0, now - this.healthySince),
      reasons, metrics: { ...this.metrics }, thresholds: { ...this.config },
      agentUpdates: this.updateCapacity.read(this.monotonicNow()),
    };
  }
}

let guard: CapacityGuard | null = null;
export function startCapacityGuard(options: CapacityGuardOptions): CapacityGuard {
  if (!guard) guard = new CapacityGuard({ ...options, onTransition: options.onTransition ?? (snapshot => {
    console.info('[capacity-guard] background admission changed', {
      state: snapshot.state, reasons: snapshot.reasons,
      cpuBusyPercent: snapshot.metrics.cpuBusyPercent, cpuStealPercent: snapshot.metrics.cpuStealPercent,
      memoryUsedPercent: snapshot.metrics.memoryUsedPercent, eventLoopLagMs: snapshot.metrics.eventLoopLagMs,
      dependenciesReady: snapshot.metrics.dependenciesReady,
      agentUpdates: snapshot.agentUpdates,
    });
  }) });
  guard.start();
  return guard;
}
export function stopCapacityGuard(): void { guard?.stop(); }
export function readCapacityGuard(): CapacityGuardSnapshot {
  return (guard ?? new CapacityGuard({ checkDependencies: async () => false })).read();
}
export function canRunBackgroundWork(): boolean { return readCapacityGuard().canRunBackgroundWork; }
export function canRunAgentUpdateWork(): boolean { return readCapacityGuard().agentUpdates.allowed; }
