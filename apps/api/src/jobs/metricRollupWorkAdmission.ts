import { DelayedError, type Job } from 'bullmq';
import { canRunBackgroundWork } from '../services/capacityGuard';

/** A rollup rewrites overlapping buckets: serialize by default, including replicas. */
export function readMetricRollupConcurrency(value = process.env.METRIC_ROLLUP_WORKER_CONCURRENCY): number {
  const parsed = Number(value);
  return value?.trim() && Number.isInteger(parsed) && parsed >= 1 && parsed <= 2 ? parsed : 1;
}

type Sample = { completed: number; failed: number; deferred: number; durationMs: number; maxDurationMs: number; maxQueueAgeMs: number };
let sample: Sample = { completed: 0, failed: 0, deferred: 0, durationMs: 0, maxDurationMs: 0, maxQueueAgeMs: 0 };
let lastReport = Date.now();

/** Call outside a DB context. Historical windows must be retained when deferred. */
export async function runMetricRollupWork<T>(
  job: Pick<Job, 'moveToDelayed'> & { data: { queuedAt?: string } },
  token: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let outcome: 'completed' | 'failed' | 'deferred' = 'failed';
  try {
    if (!canRunBackgroundWork()) {
      if (!token) throw new Error('Metric rollup capacity deferral requires a worker lock token');
      await job.moveToDelayed(Date.now() + 60_000, token);
      outcome = 'deferred';
      // Retain the exact range and day-rollup plan; do not acknowledge success,
      // consume a failure attempt, or discard a window in favour of a newer one.
      throw new DelayedError();
    }
    const result = await operation();
    outcome = 'completed';
    return result;
  } finally {
    const elapsed = Math.max(0, Math.round(performance.now() - started));
    const queuedAt = Date.parse(job.data.queuedAt ?? '');
    sample[outcome]++;
    sample.durationMs += elapsed;
    sample.maxDurationMs = Math.max(sample.maxDurationMs, elapsed);
    if (Number.isFinite(queuedAt)) sample.maxQueueAgeMs = Math.max(sample.maxQueueAgeMs, Date.now() - queuedAt);
    if (Date.now() - lastReport >= 60_000) {
      // I/O-inclusive elapsed time, not CPU time. Fixed labels, no tenant IDs.
      try { console.info('[MetricRollupsWorker] Workload', sample); } catch { /* Reporting cannot change delivery. */ }
      sample = { completed: 0, failed: 0, deferred: 0, durationMs: 0, maxDurationMs: 0, maxQueueAgeMs: 0 };
      lastReport = Date.now();
    }
  }
}
