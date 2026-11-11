import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelayedError } from 'bullmq';
const state = vi.hoisted(() => ({ capacity: true }));
vi.mock('../services/capacityGuard', () => ({ canRunBackgroundWork: () => state.capacity }));
import { readMonitorConcurrency, runMonitorWork } from './monitorWorkAdmission';

beforeEach(() => { state.capacity = true; });
afterEach(() => { vi.restoreAllMocks(); });

describe('monitor admission', () => {
  it.each(['monitor-scheduler', 'check-monitor'] as const)('defers %s before work without consuming a failure attempt', async (type) => {
    state.capacity = false;
    const job = { moveToDelayed: vi.fn(async (_at: number, _token?: string) => {}) };
    const work = vi.fn();
    const before = Date.now();
    await expect(runMonitorWork(job, 'lock', type, work)).rejects.toBeInstanceOf(DelayedError);
    expect(work).not.toHaveBeenCalled();
    expect(job.moveToDelayed).toHaveBeenCalledOnce();
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'lock');
    expect(job.moveToDelayed.mock.calls[0]![0]).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('keeps result processing available under pressure so alerts are not lost', async () => {
    state.capacity = false;
    const job = { moveToDelayed: vi.fn(async () => {}) };
    await expect(runMonitorWork(job, 'lock', 'process-check-result', async () => 'alert saved')).resolves.toBe('alert saved');
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it.each([{ opts: { repeat: { every: 30_000 } } }, { repeatJobKey: 'scheduler-repeat' }])('coalesces only real recurring scheduler ticks: %j', async (repeat) => {
    state.capacity = false;
    const job = { moveToDelayed: vi.fn(async () => {}), ...repeat };
    const work = vi.fn();
    await expect(runMonitorWork(job, 'lock', 'monitor-scheduler', work)).resolves.toEqual({ deferred: true, coalesced: true });
    expect(work).not.toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('does not coalesce individual probes even if repeat metadata is present', async () => {
    state.capacity = false;
    const job = { moveToDelayed: vi.fn(async () => {}), opts: { repeat: { every: 30_000 } } };
    await expect(runMonitorWork(job, 'lock', 'check-monitor', async () => 4)).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledOnce();
  });

  it('preserves healthy results and real operation errors', async () => {
    const job = { moveToDelayed: vi.fn(async () => {}) };
    await expect(runMonitorWork(job, 'lock', 'check-monitor', async () => 4)).resolves.toBe(4);
    const error = new Error('database unavailable');
    await expect(runMonitorWork(job, 'lock', 'check-monitor', async () => { throw error; })).rejects.toBe(error);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('does not claim a deferral when Redis cannot move the job', async () => {
    state.capacity = false;
    const error = new Error('Redis unavailable');
    const job = { moveToDelayed: vi.fn(async () => { throw error; }) };
    await expect(runMonitorWork(job, 'lock', 'check-monitor', async () => 4)).rejects.toBe(error);
  });

  it('fails visibly rather than losing work when the lock token is absent', async () => {
    state.capacity = false;
    const job = { moveToDelayed: vi.fn(async () => {}) };
    const work = vi.fn();
    await expect(runMonitorWork(job, undefined, 'check-monitor', work)).rejects.toThrow('lock token');
    expect(work).not.toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it.each(['', '0', '-1', '11', '2.5', 'NaN', 'Infinity'])('bounds invalid concurrency %s', (value) => {
    expect(readMonitorConcurrency(value)).toBe(2);
  });
  it.each(['1', '2', '10'])('accepts bounded concurrency %s', (value) => {
    expect(readMonitorConcurrency(value)).toBe(Number(value));
  });

  it('bounds workload logging to one aggregate per minute without identifiers', async () => {
    const base = Date.now() + 120_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(base);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const job = { moveToDelayed: vi.fn(async () => {}) };
    await runMonitorWork(job, 'lock', 'check-monitor', async () => 1);
    log.mockClear();
    for (let i = 0; i < 5; i++) await runMonitorWork(job, 'lock', 'process-check-result', async () => 1);
    expect(log).not.toHaveBeenCalled();
    now.mockReturnValue(base + 60_000);
    await runMonitorWork(job, 'lock', 'process-check-result', async () => 1);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![1]).toEqual({ 'process-check-result': {
      completed: 6, failed: 0, deferred: 0, durationMs: expect.any(Number), maxDurationMs: expect.any(Number),
    } });
  });

  it('reporting failures cannot replace a successful result or capacity deferral', async () => {
    let current = Date.now() + 600_000;
    vi.spyOn(Date, 'now').mockImplementation(() => current);
    vi.spyOn(console, 'info').mockImplementation(() => { throw Error('logging failed'); });
    const job = { moveToDelayed: vi.fn(async () => {}) };
    await expect(runMonitorWork(job, 'lock', 'check-monitor', async () => 4)).resolves.toBe(4);
    state.capacity = false;
    current += 60_000;
    await expect(runMonitorWork(job, 'lock', 'check-monitor', async () => 4)).rejects.toBeInstanceOf(DelayedError);
  });
});
