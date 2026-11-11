import { describe, expect, it, vi } from 'vitest';
import { createAlertWorkReporter } from './alertWorkTelemetry';

describe('alert workload telemetry', () => {
  it('aggregates successes/failures and queue age at most once a minute, with no identity labels', () => {
    let time = 0;
    const report = vi.fn();
    const record = createAlertWorkReporter(() => time, report);
    for (let i = 0; i < 100; i++) {
      time = i * 100;
      record({ data: { type: 'evaluate-device' }, timestamp: 0, processedOn: 100, finishedOn: 150 }, false);
    }
    expect(report).not.toHaveBeenCalled();
    time = 60_000;
    record({ data: { type: 'evaluate-device' }, timestamp: 0, processedOn: 2_000, finishedOn: 2_500 }, true);
    expect(report).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(report.mock.calls[0]![0].replace('[AlertWorker] Workload ', ''));
    expect(payload.jobs['evaluate-device']).toEqual({ completed: 100, failed: 1, workMs: 5500, maxQueueAgeMs: 2000 });
    time = 120_000;
    record({ data: { type: 'private-device-or-tenant-id' } }, false);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1]![0]).not.toContain('private-device');
    expect(JSON.parse(report.mock.calls[1]![0].replace('[AlertWorker] Workload ', '')).jobs)
      .toEqual({ other: { completed: 1, failed: 0, workMs: 0, maxQueueAgeMs: 0 } });
  });

  it('tolerates missing jobs/timestamps and clamps clock differences', () => {
    let time = 0;
    const report = vi.fn();
    const record = createAlertWorkReporter(() => time, report);
    record(undefined, true);
    time = 60_000;
    record({ data: { type: 'evaluate-all' }, timestamp: 300, processedOn: 200, finishedOn: 100 }, false);
    expect(JSON.parse(report.mock.calls[0]![0].replace('[AlertWorker] Workload ', '')).jobs['evaluate-all'])
      .toEqual({ completed: 1, failed: 0, workMs: 0, maxQueueAgeMs: 0 });
  });

  it('isolates report failures and resets the window before subsequent jobs', () => {
    let time = 0;
    const report = vi.fn().mockImplementationOnce(() => { throw new Error('logging unavailable'); });
    const record = createAlertWorkReporter(() => time, report);
    time = 60_000;
    expect(() => record({ data: { type: 'evaluate-device' } }, true)).not.toThrow();
    time = 60_001;
    record({ data: { type: 'evaluate-all' } }, false);
    expect(report).toHaveBeenCalledTimes(1);
    time = 120_000;
    record({ data: { type: 'evaluate-all' } }, false);
    expect(report).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(report.mock.calls[1]![0].replace('[AlertWorker] Workload ', ''));
    expect(payload.windowMs).toBe(60_000);
    expect(payload.jobs).toEqual({
      'evaluate-all': { completed: 2, failed: 0, workMs: 0, maxQueueAgeMs: 0 },
    });
  });
});
