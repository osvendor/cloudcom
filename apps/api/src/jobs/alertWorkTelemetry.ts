/** Bounded wall-clock/queue-age reporting, not CPU accounting or per-device logs. */
export function createAlertWorkReporter(
  now: () => number = Date.now,
  report: (line: string) => void = console.log,
): (job: { data: { type: string }; timestamp?: number; processedOn?: number; finishedOn?: number } | undefined, failed: boolean) => void {
  let windowStart = now();
  let totals: Record<string, { completed: number; failed: number; workMs: number; maxQueueAgeMs: number }> = {};
  return (job, failed) => {
    if (!job) return;
    const kind = ['evaluate-all', 'evaluate-device', 'auto-resolve', 'evaluate-network-checks'].includes(job.data.type)
      ? job.data.type : 'other';
    const end = now();
    const entry = totals[kind] ??= { completed: 0, failed: 0, workMs: 0, maxQueueAgeMs: 0 };
    entry[failed ? 'failed' : 'completed']++;
    if (job.processedOn !== undefined) {
      entry.workMs += Math.max(0, (job.finishedOn ?? end) - job.processedOn);
      if (job.timestamp !== undefined) {
        entry.maxQueueAgeMs = Math.max(entry.maxQueueAgeMs, Math.max(0, job.processedOn - job.timestamp));
      }
    }
    if (end - windowStart < 60_000) return;
    try {
      report(`[AlertWorker] Workload ${JSON.stringify({ windowMs: end - windowStart, jobs: totals })}`);
    } catch {
      // Telemetry must never fail a Worker event callback or turn a successful
      // job into a worker error. Drop this report and start a bounded window.
    }
    totals = {};
    windowStart = end;
  };
}
