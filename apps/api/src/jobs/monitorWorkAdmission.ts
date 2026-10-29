import { DelayedError, type Job } from 'bullmq';
import { canRunBackgroundWork } from '../services/capacityGuard';

type MonitorWorkType = 'monitor-scheduler' | 'check-monitor' | 'process-check-result';
type WorkSample = { completed: number; failed: number; deferred: number; durationMs: number; maxDurationMs: number };
const samples = new Map<MonitorWorkType, WorkSample>();
let lastReport = Date.now();

export function readMonitorConcurrency(value = process.env.MONITOR_WORKER_CONCURRENCY): number {
  const parsed = Number(value);
  return value?.trim() && Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : 2;
}

function record(type: MonitorWorkType, outcome: 'completed' | 'failed' | 'deferred', durationMs: number): void {
  const sample = samples.get(type) ?? { completed: 0, failed: 0, deferred: 0, durationMs: 0, maxDurationMs: 0 };
  sample[outcome]++;
  sample.durationMs += durationMs;
  sample.maxDurationMs = Math.max(sample.maxDurationMs, durationMs);
  samples.set(type, sample);
  if (Date.now() - lastReport < 60_000) return;
  // Fixed labels and aggregate counters only: no device IDs, targets or payloads.
  // Elapsed duration includes I/O; it is deliberately not labelled CPU time.
  try { console.info('[MonitorWorker] Workload', Object.fromEntries(samples)); } catch { /* Reporting must not affect job delivery. */ }
  samples.clear();
  lastReport = Date.now();
}

/** Admit new probes before any DB context; already-received results must drain. */
export async function runMonitorWork<T>(
  job: Pick<Job, 'moveToDelayed'> & { opts?: { repeat?: unknown }; repeatJobKey?: string },
  token: string | undefined,
  type: MonitorWorkType,
  operation: () => Promise<T>,
): Promise<T | { deferred: true; coalesced: true }> {
  const started = performance.now();
  let outcome: 'completed' | 'failed' | 'deferred' = 'failed';
  try {
    if (type !== 'process-check-result' && !canRunBackgroundWork()) {
      // A recurring tick is a wake-up, not a unit of device work. Complete
      // only actual repeat ticks without reading/advancing monitor due state;
      // the next tick retries due monitors. Delaying every repeat occurrence
      // would accumulate scheduler jobs throughout a sustained outage.
      if (type === 'monitor-scheduler' && (job.opts?.repeat || job.repeatJobKey)) {
        outcome = 'deferred';
        return { deferred: true, coalesced: true };
      }
      if (!token) throw new Error('Monitor capacity deferral requires a worker lock token');
      await job.moveToDelayed(Date.now() + 60_000, token);
      outcome = 'deferred';
      // BullMQ does not increment attemptsMade for DelayedError.
      throw new DelayedError();
    }
    const result = await operation();
    outcome = 'completed';
    return result;
  } finally {
    record(type, outcome, Math.max(0, Math.round(performance.now() - started)));
  }
}
