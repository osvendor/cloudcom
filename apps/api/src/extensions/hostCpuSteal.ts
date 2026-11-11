/** Linux aggregate counters; guest time is already included in user/nice. */
export type CpuCounters = { total: number; steal: number };

export function parseCpuCounters(stat: string): CpuCounters | null {
  const line = stat.split('\n').find(value => /^cpu\s/.test(value));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1, 9);
  if (fields.length !== 8 || fields.some(value => !/^\d+$/.test(value))) return null;
  const values = fields.map(Number);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) return null;
  return { total, steal: values[7]! };
}

/** Delta sampling avoids reporting a lifetime average that hides a recent throttle. */
export function cpuStealPercent(previous: CpuCounters | null, current: CpuCounters | null): number | null {
  if (!previous || !current) return null;
  const elapsed = current.total - previous.total;
  const stolen = current.steal - previous.steal;
  if (elapsed <= 0 || stolen < 0 || stolen > elapsed) return null;
  return stolen / elapsed * 100;
}
