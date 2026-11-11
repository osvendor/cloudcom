import { describe, expect, it, vi } from 'vitest';
import { enablePreparedPolicyReads } from './preparedPolicyReads';

const query = 'select "id" from "config_policy_feature_links" where "id" = $1';

function fixture() {
  const lazy = { values: vi.fn(), then: vi.fn() };
  const unsafe = vi.fn((_sql: string, _parameters?: unknown[], _options?: Record<string, unknown>) => lazy);
  const client = Object.assign(vi.fn(), { unsafe });
  return { client, unsafe, lazy };
}

describe('enablePreparedPolicyReads', () => {
  it('returns the original callable client and the exact unexecuted lazy Query', () => {
    const { client, unsafe, lazy } = fixture();
    expect(enablePreparedPolicyReads(client)).toBe(client);
    const result = client.unsafe(query, ['id']);
    expect(result).toBe(lazy);
    expect(lazy.then).not.toHaveBeenCalled();
    result.values();
    expect(lazy.values).toHaveBeenCalledOnce();
    expect(unsafe).toHaveBeenCalledWith(query, ['id'], { prepare: true });
    client`select 1`;
    expect(client).toHaveBeenCalledOnce();
  });

  it.each([
    ['select 1', []],
    ['select $1 from "devices"', [1]],
    ['update "config_policy_feature_links" set "enabled" = $1', [true]],
    ['with x as (select $1) select * from "config_policy_feature_links"', [1]],
    [query + '; select 1', [1]],
    [query + ' -- comment', [1]],
    [query + ' /* comment */', [1]],
    ["select 'from \"config_policy_links\"' where $1 = 1", [1]],
    ['select $$from "config_policy_links"$$ where $1 = 1', [1]],
    [query, []],
    [query, new Array(257).fill(1)],
  ])('leaves excluded SQL unchanged: %s', (sql, parameters) => {
    const { client, unsafe } = fixture();
    enablePreparedPolicyReads(client);
    client.unsafe(sql, parameters);
    expect(unsafe).toHaveBeenCalledWith(sql, parameters);
  });

  it('preserves explicit prepare choices and all other options without mutation', () => {
    const { client, unsafe } = fixture();
    enablePreparedPolicyReads(client);
    for (const prepare of [false, true, undefined]) {
      const options = { prepare, simple: false };
      client.unsafe(query, [1], options);
      expect(unsafe.mock.lastCall?.[2]).toBe(options);
    }
    const options = { simple: false };
    client.unsafe(query, [1], options);
    expect(unsafe.mock.lastCall?.[2]).toEqual({ simple: false, prepare: true });
    expect(options).toEqual({ simple: false });
    const simple = { simple: true };
    client.unsafe(query, [1], simple);
    expect(unsafe.mock.lastCall?.[2]).toBe(simple);
  });

  it('decorates callback clients for begin and nested named savepoints', () => {
    const root = fixture();
    const tx = fixture();
    const nested = fixture();
    const txClient = Object.assign(tx.client, {
      savepoint: vi.fn((name: string, callback: (sql: typeof nested.client) => unknown) => callback(nested.client)),
    });
    const rootClient = Object.assign(root.client, {
      begin: vi.fn((options: string, callback: (sql: typeof txClient) => unknown) => callback(txClient)),
    });
    enablePreparedPolicyReads(rootClient);
    const result = rootClient.begin('read only', (sql) => {
      expect(sql).toBe(txClient);
      sql.unsafe(query, [1]);
      return sql.savepoint('nested', (savepoint) => savepoint.unsafe(query, [2]));
    });
    expect(result).toBe(nested.lazy);
    expect(tx.unsafe).toHaveBeenCalledWith(query, [1], { prepare: true });
    expect(nested.unsafe).toHaveBeenCalledWith(query, [2], { prepare: true });
  });

  it('supports callback-only begin and preserves rejection', async () => {
    const root = fixture();
    const tx = fixture();
    const client = Object.assign(root.client, {
      begin: (callback: (sql: typeof tx.client) => unknown) => callback(tx.client),
    });
    enablePreparedPolicyReads(client);
    client.begin((sql) => sql.unsafe(query, [1]));
    expect(tx.unsafe).toHaveBeenCalledWith(query, [1], { prepare: true });
    const error = new Error('rollback');
    await expect(client.begin(async () => { throw error; })).rejects.toBe(error);
  });

  it('decorates reserved clients and retains release and reservation failures', async () => {
    const root = fixture();
    const reserved = fixture();
    const release = vi.fn();
    const reservedClient = Object.assign(reserved.client, { release });
    const reserve = vi.fn().mockResolvedValue(reservedClient);
    const client = Object.assign(root.client, { reserve });
    enablePreparedPolicyReads(client);
    const sql = await client.reserve();
    expect(sql).toBe(reservedClient);
    sql.unsafe(query, [1]);
    expect(reserved.unsafe).toHaveBeenCalledWith(query, [1], { prepare: true });
    sql.release();
    expect(release).toHaveBeenCalledOnce();
    const error = new Error('connection failed');
    reserve.mockRejectedValue(error);
    await expect(client.reserve()).rejects.toBe(error);
  });

  it('caps distinct shapes across pool and transaction clients, while retaining admitted shapes', () => {
    const root = fixture();
    const tx = fixture();
    const client = Object.assign(root.client, {
      begin: (callback: (sql: typeof tx.client) => unknown) => callback(tx.client),
    });
    enablePreparedPolicyReads(client);
    for (let i = 0; i < 128; i++) client.unsafe(`select "c${i}" from "config_policy_links" where "id"=$1`, [i]);
    client.begin((sql) => sql.unsafe(query, [1]));
    expect(tx.unsafe).toHaveBeenCalledWith(query, [1]);
    client.unsafe('select "c0" from "config_policy_links" where "id"=$1', [2]);
    expect(root.unsafe.mock.lastCall?.[2]).toEqual({ prepare: true });
  });

  it('does not double-wrap a client', () => {
    const { client, unsafe } = fixture();
    enablePreparedPolicyReads(client);
    const decorated = client.unsafe;
    enablePreparedPolicyReads(client);
    expect(client.unsafe).toBe(decorated);
    client.unsafe(query, [1]);
    expect(unsafe).toHaveBeenCalledOnce();
  });

  it('admits 256 parameters and callback-only savepoints', () => {
    const root = fixture();
    const nested = fixture();
    const client = Object.assign(root.client, {
      savepoint: (callback: (sql: typeof nested.client) => unknown) => callback(nested.client),
    });
    enablePreparedPolicyReads(client);
    const parameters = new Array(256).fill(1);
    client.savepoint((sql) => sql.unsafe(query, parameters));
    expect(nested.unsafe).toHaveBeenCalledWith(query, parameters, { prepare: true });
  });
});
