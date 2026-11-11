import { describe, expect, it } from 'vitest';
import { cpuStealPercent, parseCpuCounters } from './hostCpuSteal';

describe('host CPU steal observation', () => {
  it('ignores per-core rows and does not count guest time twice', () => {
    expect(parseCpuCounters('cpu  10 20 30 40 50 60 70 80 9 8\ncpu0 1 2 3 4 5 6 7 8\n'))
      .toEqual({ total: 360, steal: 80 });
  });
  it('reports interval pressure rather than a lifetime average', () => {
    expect(cpuStealPercent({ total: 10000, steal: 10 }, { total: 11000, steal: 710 })).toBe(70);
    expect(cpuStealPercent({ total: 100, steal: 0 }, { total: 200, steal: 0 })).toBe(0);
  });
  it.each(['', 'cpu0 1 2 3 4 5 6 7 8', 'cpu 1 2 3 4', 'cpu 1 2 3 4 5 6 7 bad', 'cpu 1 2 3 4 5 6 7 -1', 'cpu 9007199254740991 2 3 4 5 6 7 8'])('keeps unavailable or malformed counters unknown: %s', value => {
    expect(parseCpuCounters(value)).toBeNull();
  });
  it('keeps warmup, reboot and invalid deltas unknown', () => {
    expect(cpuStealPercent(null, { total: 1, steal: 0 })).toBeNull();
    expect(cpuStealPercent({ total: 100, steal: 50 }, { total: 5, steal: 1 })).toBeNull();
    expect(cpuStealPercent({ total: 100, steal: 50 }, { total: 110, steal: 49 })).toBeNull();
    expect(cpuStealPercent({ total: 100, steal: 50 }, { total: 110, steal: 61 })).toBeNull();
    expect(cpuStealPercent({ total: 100, steal: 50 }, { total: 100, steal: 50 })).toBeNull();
  });
});
