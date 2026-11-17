import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('sets one shared cooldown and does not enter work under pressure', async () => {
    canRunBackgroundWorkMock.mockReturnValue(false);
    const rateLimit = vi.fn().mockResolvedValue(undefined), operation = vi.fn();
    await expect(runMetricRollupWork({ data: {} }, rateLimit, operation)).rejects.toThrow('bullmq:rateLimitExceeded');
    expect(rateLimit).toHaveBeenCalledExactlyOnceWith(60_000);
    expect(operation).not.toHaveBeenCalled();
  });
  it('propagates a Redis cooldown failure', async () => {
    canRunBackgroundWorkMock.mockReturnValue(false);
    const failure = new Error('redis unavailable');
    await expect(runMetricRollupWork({ data: {} }, vi.fn().mockRejectedValue(failure), vi.fn())).rejects.toBe(failure);
  });
  it('returns completion and propagates genuine operation failures', async () => {
    const rateLimit = vi.fn();
    await expect(runMetricRollupWork({ data: {} }, rateLimit, async () => 42)).resolves.toBe(42);
    const failure = new Error('database error');
    await expect(runMetricRollupWork({ data: {} }, rateLimit, async () => { throw failure; })).rejects.toBe(failure);
    expect(rateLimit).not.toHaveBeenCalled();
  });
});
