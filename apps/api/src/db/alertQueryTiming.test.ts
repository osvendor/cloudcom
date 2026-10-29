import { describe, expect, it, vi } from 'vitest';
// Exercise the installed driver's actual lazy Query rather than a Promise mock.
// @ts-expect-error postgres-js internal JavaScript has no declaration file
import { Query } from '../../node_modules/postgres/src/query.js';
import { enableAlertQueryTiming } from './alertQueryTiming';
import { getActiveAlertWorkSpan, withAlertWorkSpan } from '../services/alertWorkTelemetry';

function driver(error?: Error) {
  const run = vi.fn((query: any) => queueMicrotask(() => error ? query.reject(error) : query.resolve([[1]])));
  const unsafe = (_sql: string, _params?: unknown[], options?: object) => new Query(['select 1'], [], run, undefined, options);
  const client: any = {
    unsafe,
    begin: async (...args: any[]) => args.at(-1)(driver(error).client),
    savepoint: async (...args: any[]) => args.at(-1)(driver(error).client),
    reserve: async () => driver(error).client,
  };
  return { client, run, unsafe };
}

describe('alert query timing with postgres-js lazy queries', () => {
  it('keeps values/options/identity lazy and counts repeated awaits only once', async () => {
    const { client, run } = driver();
    enableAlertQueryTiming(client);
    await withAlertWorkSpan('hardware', async () => {
      const span = getActiveAlertWorkSpan()!;
      const query = client.unsafe('select 1', [], { prepare: true });
      expect(query.values()).toBe(query);
      expect(query.options.prepare).toBe(true);
      expect(query.isRaw).toBe('values');
      expect(run).not.toHaveBeenCalled();
      expect(span.queryCount).toBe(0);
      expect(await query).toEqual([[1]]);
      await query;
      expect(run).toHaveBeenCalledTimes(1);
      expect(span.queryCount).toBe(1);
      expect(span.dbElapsedMs).toBeGreaterThanOrEqual(0);
    });
  });
  it('preserves rejection and counts it exactly once', async () => {
    const error = new Error('driver failure');
    const { client } = driver(error);
    enableAlertQueryTiming(client);
    await withAlertWorkSpan('network', async () => {
      const query = client.unsafe('select 1');
      await expect(query).rejects.toBe(error);
      await expect(query).rejects.toBe(error);
      expect(getActiveAlertWorkSpan()!.queryCount).toBe(1);
    });
  });
  it('propagates decoration through transactions, savepoints and reserved clients', async () => {
    const { client } = driver();
    expect(enableAlertQueryTiming(client)).toBe(client);
    enableAlertQueryTiming(client);
    await withAlertWorkSpan('preparation', async () => {
      await client.begin('read write', async (tx: any) => {
        await tx.unsafe('select 1');
        await tx.savepoint('nested', async (nested: any) => { await nested.unsafe('select 1').values(); });
      });
      const reserved = await client.reserve();
      await reserved.unsafe('select 1');
      expect(getActiveAlertWorkSpan()!.queryCount).toBe(3);
    });
  });
  it('leaves queries outside alert spans untouched', async () => {
    const { client } = driver();
    enableAlertQueryTiming(client);
    const query = client.unsafe('select 1');
    expect(Object.hasOwn(query, 'handle')).toBe(false);
    await expect(query).resolves.toEqual([[1]]);
  });
  it('does not include construction delay or unexecuted queries', async () => {
    const { client } = driver();
    enableAlertQueryTiming(client);
    await withAlertWorkSpan('other', async () => {
      const clock = vi.spyOn(performance, 'now');
      clock.mockReturnValue(0);
      const query = client.unsafe('select 1');
      client.unsafe('select unused');
      clock.mockReturnValue(1000);
      await query.execute();
      expect(getActiveAlertWorkSpan()!.queryCount).toBe(1);
      expect(getActiveAlertWorkSpan()!.dbElapsedMs).toBe(0);
      clock.mockRestore();
    });
  });
});

