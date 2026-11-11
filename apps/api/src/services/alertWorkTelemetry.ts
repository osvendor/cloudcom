import { AsyncLocalStorage } from 'node:async_hooks';

const GROUP_LABELS = {
  preparation: 'Shared preparation',
  cpu_memory_disk: 'CPU / memory / disk',
  hardware: 'Hardware',
  time_sync: 'Time sync',
  patch_reboot: 'Patches / reboot',
  scripts: 'Scripts / RustDesk',
  containers: 'Containers',
  network: 'Network',
  other: 'Other',
} as const;
export type AlertWorkGroup = keyof typeof GROUP_LABELS;
export interface AlertWorkSpan { queryCount: number; dbElapsedMs: number; failed: boolean }
export interface AlertWorkMonitor { id: string; label: string }
const activeSpan = new AsyncLocalStorage<AlertWorkSpan>();
export function getActiveAlertWorkSpan(): AlertWorkSpan | undefined { return activeSpan.getStore(); }
export function markAlertWorkSpanFailed(): void { const span = activeSpan.getStore(); if (span) span.failed = true; }

const WINDOW_MS = 300_000;
const BUCKET_MS = 5_000;
const SCRIPT_MONITOR_LIMIT = 64;
const OTHER_MONITOR = { id: '__other_script_monitors__', label: 'Other script monitors (detail limit reached or identity unavailable)' };
type Totals = { evaluations: number; totalMs: number; maxMs: number; errors: number; queryCount: number; dbElapsedMs: number };
const empty = (): Totals => ({ evaluations: 0, totalMs: 0, maxMs: 0, errors: 0, queryCount: 0, dbElapsedMs: 0 });
const finite = (n: number): number => Number.isFinite(n) ? Math.max(0, n) : 0;

/** Fixed groups and bounded monitor identities in 60 five-second buckets. No SQL or device IDs. */
export function createAlertWorkTelemetry(options: { now?: () => number; monotonic?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const startedAt = now();
  const buckets = new Map<number, Partial<Record<AlertWorkGroup, Totals>>>();
  const monitorBuckets = new Map<number, Map<string, Totals>>();
  const monitorLabels = new Map<string, string>();
  function currentBucket(): number {
    const key = Math.floor(now() / BUCKET_MS);
    for (const existing of buckets.keys()) if (existing <= key - WINDOW_MS / BUCKET_MS || existing > key) buckets.delete(existing);
    let expired = false;
    for (const existing of monitorBuckets.keys()) {
      if (existing <= key - WINDOW_MS / BUCKET_MS || existing > key) { monitorBuckets.delete(existing); expired = true; }
    }
    if (expired) {
      const retained = new Set([...monitorBuckets.values()].flatMap(bucket => [...bucket.keys()]));
      for (const id of monitorLabels.keys()) if (!retained.has(id)) monitorLabels.delete(id);
    }
    return key;
  }
  async function withSpan<T>(group: AlertWorkGroup, operation: () => Promise<T>, monitor?: AlertWorkMonitor): Promise<T> {
    const span: AlertWorkSpan = { queryCount: 0, dbElapsedMs: 0, failed: false };
    let started = 0;
    try { started = monotonic(); } catch { /* A broken clock must not stop evaluation. */ }
    return activeSpan.run(span, async () => {
      try { return await operation(); }
      catch (error) { span.failed = true; throw error; }
      finally {
        // Observability must never alter delivery or mask the operation error.
        try {
          const key = currentBucket();
          const bucket = buckets.get(key) ?? {};
          const safeGroup = Object.hasOwn(GROUP_LABELS, group) ? group : 'other';
          const row = bucket[safeGroup] ??= empty();
          const elapsed = finite(monotonic() - started);
          const record = (target: Totals) => {
            target.evaluations++;
            target.totalMs += elapsed;
            target.maxMs = Math.max(target.maxMs, elapsed);
            target.errors += Number(span.failed);
            target.queryCount += finite(span.queryCount);
            target.dbElapsedMs += finite(span.dbElapsedMs);
          };
          record(row);
          buckets.set(key, bucket);
          if (safeGroup === 'scripts') {
            // Names are admin-visible metadata from the already loaded rule;
            // never fetch extra DB rows or retain device/condition payloads.
            const valid = typeof monitor?.id === 'string' && monitor.id.length > 0 && monitor.id.length <= 128
              && monitor.id !== OTHER_MONITOR.id && typeof monitor.label === 'string';
            const namedCount = monitorLabels.size - Number(monitorLabels.has(OTHER_MONITOR.id));
            const detail = valid && (monitorLabels.has(monitor.id) || namedCount < SCRIPT_MONITOR_LIMIT)
              ? { id: monitor.id, label: monitor.label.slice(0, 200) || 'Unnamed script monitor' } : OTHER_MONITOR;
            monitorLabels.set(detail.id, detail.label);
            const details = monitorBuckets.get(key) ?? new Map<string, Totals>();
            const detailRow = details.get(detail.id) ?? empty();
            record(detailRow);
            details.set(detail.id, detailRow);
            monitorBuckets.set(key, details);
          }
        } catch { /* In-memory telemetry is best effort. */ }
      }
    });
  }
  function snapshot() {
    currentBucket();
    const observedMs = Math.min(WINDOW_MS, finite(now() - startedAt));
    const groups = (Object.entries(GROUP_LABELS) as Array<[AlertWorkGroup, string]>).map(([group, label]) => {
      const total = empty();
      for (const bucket of buckets.values()) {
        const row = bucket[group];
        if (!row) continue;
        total.evaluations += row.evaluations;
        total.totalMs += row.totalMs;
        total.maxMs = Math.max(total.maxMs, row.maxMs);
        total.errors += row.errors;
        total.queryCount += row.queryCount;
        total.dbElapsedMs += row.dbElapsedMs;
      }
      return { group, label, ...total, perMinute: observedMs > 0 ? total.evaluations * 60_000 / observedMs : 0,
        averageMs: total.evaluations > 0 ? total.totalMs / total.evaluations : 0 };
    });
    const scriptMonitors = [...monitorLabels].map(([id, label]) => {
      const total = empty();
      for (const bucket of monitorBuckets.values()) {
        const row = bucket.get(id);
        if (!row) continue;
        total.evaluations += row.evaluations;
        total.totalMs += row.totalMs;
        total.maxMs = Math.max(total.maxMs, row.maxMs);
        total.errors += row.errors;
        total.queryCount += row.queryCount;
        total.dbElapsedMs += row.dbElapsedMs;
      }
      return { id, label, ...total, perMinute: observedMs > 0 ? total.evaluations * 60_000 / observedMs : 0,
        averageMs: total.evaluations > 0 ? total.totalMs / total.evaluations : 0 };
    });
    return { windowMs: WINDOW_MS, bucketMs: BUCKET_MS, observedMs, groups, scriptMonitors, scriptMonitorLimit: SCRIPT_MONITOR_LIMIT };
  }
  return { withSpan, snapshot };
}

const telemetry = createAlertWorkTelemetry();
export const withAlertWorkSpan = telemetry.withSpan;
export const getAlertWorkTelemetrySnapshot = telemetry.snapshot;
export type AlertWorkTelemetrySnapshot = ReturnType<typeof getAlertWorkTelemetrySnapshot>;

/** Classification inspects only known kind/type fields; payloads never become labels. */
export function classifyAlertWorkGroup(kind: unknown, conditions: unknown, templateCategory?: unknown): AlertWorkGroup {
  const condition = conditions && typeof conditions === 'object' && !Array.isArray(conditions)
    ? conditions as { type?: unknown; metric?: unknown } : undefined;
  const value = typeof kind === 'string' ? kind : typeof condition?.type === 'string' ? condition.type : '';
  if (['cpu', 'memory', 'disk', 'cpu_high', 'memory_high', 'disk_low', 'disk_io', 'disk_io_high', 'threshold', 'metric', 'process_resource', 'process_cpu_high', 'process_memory_high'].includes(value)) return 'cpu_memory_disk';
  if (['hardware_health', 'raid_health', 'hardware'].includes(value)) return 'hardware';
  if (value === 'time_sync') return 'time_sync';
  if (['patch_compliance', 'reboot_required', 'patch', 'pending_reboot'].includes(value)) return 'patch_reboot';
  if (['script', 'script_monitor', 'rustdesk', 'service', 'process'].includes(value)) return 'scripts';
  if (['container_image_currency', 'container', 'container_health'].includes(value)) return 'containers';
  if (['network_check', 'network_errors', 'bandwidth', 'bandwidth_high', 'cert_expiry'].includes(value)) return 'network';
  // Some legacy reboot rules have no typed condition leaf. Only this fixed
  // category mapping is admitted; arbitrary category/name strings stay private.
  if (templateCategory === 'patching') return 'patch_reboot';
  return 'other';
}
