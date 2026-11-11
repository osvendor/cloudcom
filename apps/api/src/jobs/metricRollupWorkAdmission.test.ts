import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DelayedError } from 'bullmq';
const { canRunBackgroundWorkMock } = vi.hoisted(() => ({ canRunBackgroundWorkMock: vi.fn(() => true) }));
vi.mock('../services/capacityGuard', () => ({ canRunBackgroundWork: canRunBackgroundWorkMock }));
import { readMetricRollupConcurrency, runMetricRollupWork } from './metricRollupWorkAdmission';

describe('metric rollup capacity admission', () => {
  beforeEach(() => { canRunBackgroundWorkMock.mockReturnValue(true); });

  it.each([undefined, '', '0', '-1', '3', 'Infinity', 'no', '1.5'])('defaults invalid concurrency %s to one', value => {
    expect(readMetricRollupConcurrency(value)).toBe(1);
  });
  it.each(['1', '2'])('accepts bounded concurrency %s', value => {
    expect(readMetricRollupConcurrency(value)).toBe(Number(value));
  });
  it('defers with the actual lock token and never enters the operation', async () => {
    canRunBackgroundWorkMock.mockReturnValue(false);
    const moveToDelayed = vi.fn().mockResolvedValue(undefined), operation = vi.fn();
    const before = Date.now();
    await expect(runMetricRollupWork({ data: {}, moveToDelayed }, 'worker-token', operation)).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'worker-token');
    expect(moveToDelayed.mock.calls[0]![0]).toBeGreaterThanOrEqual(before + 60_000);
    expect(operation).not.toHaveBeenCalled();
  });
  it('does not consume a deferral when no lock token exists', async () => {
    canRunBackgroundWorkMock.mockReturnValue(false);
    const moveToDelayed = vi.fn();
    await expect(runMetricRollupWork({ data: {}, moveToDelayed }, undefined, vi.fn())).rejects.toThrow('worker lock token');
    expect(moveToDelayed).not.toHaveBeenCalled();
  });
  it('preserves genuine delay failures instead of classifying them as capacity deferrals', async () => {
    canRunBackgroundWorkMock.mockReturnValue(false);
    const failure = new Error('redis unavailable');
    await expect(runMetricRollupWork({ data: {}, moveToDelayed: vi.fn().mockRejectedValue(failure) }, 't', vi.fn())).rejects.toBe(failure);
  });
  it('returns genuine completion and propagates operation failures', async () => {
    const job = { data: {}, moveToDelayed: vi.fn() };
    await expect(runMetricRollupWork(job, 't', async () => ({ statements: 6 }))).resolves.toEqual({ statements: 6 });
    const failure = new Error('database error');
    await expect(runMetricRollupWork(job, 't', async () => { throw failure; })).rejects.toBe(failure);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
