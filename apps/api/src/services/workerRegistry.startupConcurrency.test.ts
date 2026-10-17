import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getWorkerStartupConcurrency,
  _startWorkersForTest,
  _startRedisIndependentWorkersForTest,
  _buildShutdownTasksForTest,
  _resetLoadedShutdownsForTest,
  type WorkerRegistration,
} from './workerRegistry';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('worker startup concurrency', () => {
  beforeEach(() => {
    _resetLoadedShutdownsForTest();
    vi.stubEnv('WORKER_STARTUP_CONCURRENCY', undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, '', '0', '-1', 'NaN', 'Infinity', '2.5', '2workers', '1e2', '999999999999999999999']) (
    'falls back to four for invalid or missing configuration %s', (value) => {
      vi.stubEnv('WORKER_STARTUP_CONCURRENCY', value);
      expect(getWorkerStartupConcurrency()).toBe(4);
    },
  );

  it.each([[undefined, 4], ['2', 2], ['99', 8], [' 1 ', 1]] as const)(
    'bounds load plus init at %s (effective %i), starts in order, and refills any free slot',
    async (configured, limit) => {
      vi.stubEnv('WORKER_STARTUP_CONCURRENCY', configured);
      const gates = Array.from({ length: 12 }, () => ({ load: deferred(), init: deferred() }));
      const loaded: number[] = [];
      const initializing: number[] = [];
      let active = 0;
      let peak = 0;
      const entries: WorkerRegistration[] = gates.map((gate, index) => ({
        name: `worker-${index}`, placement: 'global',
        load: async () => {
          loaded.push(index);
          peak = Math.max(peak, ++active);
          await gate.load.promise;
          return {
            init: async () => {
              initializing.push(index);
              await gate.init.promise;
              active--;
            },
          };
        },
      }));
      const onResult = vi.fn();
      const result = _startWorkersForTest(entries, 'all', { onResult });
      expect(loaded).toEqual(Array.from({ length: limit }, (_, i) => i));

      gates.slice(0, limit).forEach((gate) => gate.load.resolve());
      await vi.waitFor(() => expect(initializing).toHaveLength(limit));
      // Finishing only load() must not release the slot while init() is pending.
      expect(loaded).toHaveLength(limit);
      expect(onResult).not.toHaveBeenCalled();
      gates[limit - 1]!.init.resolve();
      await vi.waitFor(() => expect(loaded).toHaveLength(limit + 1));
      expect(onResult).toHaveBeenCalledWith(`worker-${limit - 1}`, true);

      gates.forEach((gate) => { gate.load.resolve(); gate.init.resolve(); });
      await result;
      expect(peak).toBe(limit);
      expect(active).toBe(0);
      expect(loaded).toEqual(Array.from({ length: 12 }, (_, i) => i));
      expect(onResult).toHaveBeenCalledTimes(12);
      expect(onResult.mock.calls.every(([, ok]) => ok)).toBe(true);
    },
  );

  it('continues after load, init, and result-hook failures without retrying partial initialization', async () => {
    vi.stubEnv('WORKER_STARTUP_CONCURRENCY', '1');
    const loadFailure = new Error('load failed');
    const initFailure = new Error('init failed after opening a connection');
    const failedLoad = vi.fn(async () => { throw loadFailure; });
    const failedInit = vi.fn(async () => { throw initFailure; });
    const shutdown = vi.fn(async () => {});
    const finalInit = vi.fn();
    const excludedLoad = vi.fn();
    const entries: WorkerRegistration[] = [
      { name: 'load-failure', placement: 'global', load: failedLoad },
      { name: 'init-failure', placement: 'global', load: async () => ({ init: failedInit, shutdown }) },
      { name: 'hook-failure', placement: 'global', load: async () => ({ init: () => {} }) },
      { name: 'excluded', placement: 'socket-owner', load: excludedLoad },
      { name: 'final', placement: 'global', load: async () => ({ init: finalInit }) },
    ];
    const onResult = vi.fn((name: string) => { if (name === 'hook-failure') throw new Error('hook failed'); });
    await expect(_startWorkersForTest(entries, 'worker', { onResult })).resolves.toBeUndefined();
    expect(onResult).toHaveBeenCalledWith('load-failure', false, loadFailure);
    expect(onResult).toHaveBeenCalledWith('init-failure', false, initFailure);
    expect(onResult).toHaveBeenCalledWith('final', true);
    expect(failedLoad).toHaveBeenCalledTimes(1);
    expect(failedInit).toHaveBeenCalledTimes(1);
    expect(finalInit).toHaveBeenCalledTimes(1);
    expect(excludedLoad).not.toHaveBeenCalled();
    expect(await _buildShutdownTasksForTest(entries, 'worker')).toEqual([shutdown]);
  });

  it('also bounds Redis-independent fallbacks without loading queue-only entries', async () => {
    vi.stubEnv('WORKER_STARTUP_CONCURRENCY', '1');
    const first = deferred();
    const firstFallback = vi.fn(() => first.promise);
    const nextFallback = vi.fn();
    const init = vi.fn();
    const excludedLoad = vi.fn();
    const entries: WorkerRegistration[] = [
      { name: 'first', placement: 'global', runsWithoutRedis: true, load: async () => ({ init, startWithoutRedis: firstFallback }) },
      { name: 'queue-only', placement: 'global', load: excludedLoad },
      { name: 'next', placement: 'global', runsWithoutRedis: true, load: async () => ({ init, startWithoutRedis: nextFallback }) },
    ];
    const result = _startRedisIndependentWorkersForTest(entries, 'all', { onResult: vi.fn() });
    await vi.waitFor(() => expect(firstFallback).toHaveBeenCalledOnce());
    expect(nextFallback).not.toHaveBeenCalled();
    first.resolve();
    await result;
    expect(nextFallback).toHaveBeenCalledOnce();
    expect(init).not.toHaveBeenCalled();
    expect(excludedLoad).not.toHaveBeenCalled();
  });
});
