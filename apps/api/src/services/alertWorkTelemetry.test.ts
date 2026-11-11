import { describe, expect, it } from 'vitest';
import { classifyAlertWorkGroup, createAlertWorkTelemetry, getActiveAlertWorkSpan, markAlertWorkSpanFailed, type AlertWorkGroup } from './alertWorkTelemetry';

describe('bounded alert work telemetry', () => {
  it('attributes script work to distinct monitor IDs without double-counting parent totals', async () => {
    let time = 0;
    const tracker = createAlertWorkTelemetry({ now: () => time, monotonic: () => time });
    for (const id of ['first', 'second', 'first']) {
      await tracker.withSpan('scripts', async () => {
        getActiveAlertWorkSpan()!.queryCount = 2;
        getActiveAlertWorkSpan()!.dbElapsedMs = 7;
        time += 10;
        if (id === 'second') markAlertWorkSpanFailed();
      }, { id, label: 'Same name' });
    }
    time = 60_000;
    const result = tracker.snapshot();
    expect(result.scriptMonitors).toHaveLength(2);
    expect(result.scriptMonitors.find(row => row.id === 'first')).toMatchObject({ label: 'Same name', evaluations: 2, perMinute: 2, totalMs: 20, averageMs: 10, dbElapsedMs: 14, queryCount: 4, errors: 0 });
    expect(result.scriptMonitors.find(row => row.id === 'second')).toMatchObject({ evaluations: 1, errors: 1 });
    expect(result.groups.find(row => row.group === 'scripts')).toMatchObject({ evaluations: 3, totalMs: 30, dbElapsedMs: 21, queryCount: 6, errors: 1 });
    result.scriptMonitors[0]!.evaluations = 999;
    expect(tracker.snapshot().scriptMonitors[0]!.evaluations).toBe(2);
    time = 305_000;
    expect(tracker.snapshot().scriptMonitors).toEqual([]);
  });

  it('caps monitor cardinality, bounds names, aggregates overflow and releases expired identities', async () => {
    let time = 0;
    const tracker = createAlertWorkTelemetry({ now: () => time, monotonic: () => time });
    for (let i = 0; i < 80; i++) await tracker.withSpan('scripts', async () => undefined, { id: `id-${i}`, label: 'x'.repeat(300) });
    await tracker.withSpan('hardware', async () => undefined, { id: 'not-script', label: 'Never stored' });
    const result = tracker.snapshot();
    expect(result.scriptMonitorLimit).toBe(64);
    expect(result.scriptMonitors).toHaveLength(65);
    expect(result.scriptMonitors.every(row => row.label.length <= 200)).toBe(true);
    expect(result.scriptMonitors.find(row => row.id === '__other_script_monitors__')?.evaluations).toBe(16);
    expect(result.scriptMonitors.reduce((sum, row) => sum + row.evaluations, 0)).toBe(80);
    expect(result.groups.find(row => row.group === 'scripts')?.evaluations).toBe(80);
    time = 305_000;
    await tracker.withSpan('scripts', async () => undefined, { id: 'new', label: 'New monitor' });
    expect(tracker.snapshot().scriptMonitors).toEqual([expect.objectContaining({ id: 'new', label: 'New monitor', evaluations: 1 })]);
  });

  it('keeps scripts with missing identities visible in the bounded fallback row', async () => {
    const tracker = createAlertWorkTelemetry();
    await tracker.withSpan('scripts', async () => undefined);
    expect(tracker.snapshot().scriptMonitors).toEqual([expect.objectContaining({ id: '__other_script_monitors__', evaluations: 1 })]);
  });

  it('records elapsed work, DB work, rate, errors and isolated async scope', async () => {
    let time = 0;
    const tracker = createAlertWorkTelemetry({ now: () => time, monotonic: () => time });
    expect(getActiveAlertWorkSpan()).toBeUndefined();
    await tracker.withSpan('hardware', async () => {
      await Promise.resolve();
      const span = getActiveAlertWorkSpan()!;
      span.queryCount = 3; span.dbElapsedMs = 12;
      time = 20;
    });
    const failure = new Error('operation failed');
    await expect(tracker.withSpan('hardware', async () => { time = 30; throw failure; })).rejects.toBe(failure);
    time = 60_000;
    const row = tracker.snapshot().groups.find(row => row.group === 'hardware')!;
    expect(row).toMatchObject({ evaluations: 2, perMinute: 2, totalMs: 30, averageMs: 15, maxMs: 20, errors: 1, queryCount: 3, dbElapsedMs: 12 });
    expect(getActiveAlertWorkSpan()).toBeUndefined();
  });

  it('counts swallowed errors once and restores an outer span after nested work', async () => {
    const tracker = createAlertWorkTelemetry();
    await tracker.withSpan('scripts', async () => {
      const outer = getActiveAlertWorkSpan();
      await tracker.withSpan('preparation', async () => { expect(getActiveAlertWorkSpan()).not.toBe(outer); });
      expect(getActiveAlertWorkSpan()).toBe(outer);
      markAlertWorkSpanFailed(); markAlertWorkSpanFailed();
    });
    expect(tracker.snapshot().groups.find(row => row.group === 'scripts')).toMatchObject({ evaluations: 1, errors: 1 });
  });

  it('expires old buckets and exposes only a fixed group set after many labels/windows', async () => {
    let time = 0;
    const tracker = createAlertWorkTelemetry({ now: () => time, monotonic: () => time });
    for (let i = 0; i < 200; i++) {
      time = i * 5_000;
      await tracker.withSpan(`private-label-${i}` as AlertWorkGroup, async () => undefined);
    }
    const snapshot = tracker.snapshot();
    expect(snapshot.groups).toHaveLength(9);
    expect(JSON.stringify(snapshot)).not.toContain('private-label');
    expect(snapshot.groups.find(row => row.group === 'other')?.evaluations).toBe(60);
    time += 300_000;
    expect(tracker.snapshot().groups.every(row => row.evaluations === 0 && row.totalMs === 0)).toBe(true);
  });

  it('does not mask success or failure when the reporting clock fails', async () => {
    let failClock = false;
    const tracker = createAlertWorkTelemetry({ now: () => { if (failClock) throw new Error('clock'); return 0; } });
    await expect(tracker.withSpan('other', async () => { failClock = true; return 42; })).resolves.toBe(42);
    const failure = new Error('original');
    await expect(tracker.withSpan('other', async () => { throw failure; })).rejects.toBe(failure);
  });

  it('does not return mutable internal accumulators or non-finite counters', async () => {
    let time = 0;
    const tracker = createAlertWorkTelemetry({ now: () => time, monotonic: () => time });
    await tracker.withSpan('network', async () => {
      getActiveAlertWorkSpan()!.queryCount = Infinity;
      getActiveAlertWorkSpan()!.dbElapsedMs = NaN;
      time = 10;
    });
    const first = tracker.snapshot();
    first.groups.find(row => row.group === 'network')!.evaluations = 999;
    expect(tracker.snapshot().groups.find(row => row.group === 'network')).toMatchObject({ evaluations: 1, queryCount: 0, dbElapsedMs: 0 });
  });

  it.each([
    ['cpu', 'cpu_memory_disk'], ['disk_io', 'cpu_memory_disk'], ['hardware_health', 'hardware'], ['time_sync', 'time_sync'],
    ['patch_compliance', 'patch_reboot'], ['script', 'scripts'], ['container_image_currency', 'containers'], ['bandwidth', 'network'], ['secret-customer-id', 'other'],
  ])('maps fixed kind %s to %s without storing arbitrary labels', (kind, group) => {
    expect(classifyAlertWorkGroup(kind, null)).toBe(group);
  });
  it('classifies legacy patching templates without inspecting a rule name or logging its payload', () => {
    expect(classifyAlertWorkGroup(undefined, { private: 'not-logged' }, 'patching')).toBe('patch_reboot');
    expect(classifyAlertWorkGroup(undefined, null, 'private-tenant-name')).toBe('other');
  });
});
