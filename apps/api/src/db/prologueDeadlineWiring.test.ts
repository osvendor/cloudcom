/**
 * #6048 — the deadline must be armed at the REAL context openers, not only in
 * the standalone helper.
 *
 * `prologueDeadline.test.ts` proves the mechanism against synthetic work. That
 * is not the same as proving `db/index.ts` uses it correctly: the bug this PR
 * fixes lives at the seam — is the deadline actually armed around
 * `applyAccessContextGucs`, is it DISARMED before the caller's `fn` runs, and
 * does an expired deadline prevent late responses from starting caller work?
 * None of that is observable from the helper's own tests, and every
 * consumer test in this repo stubs `withDbAccessContext` out with a passthrough,
 * so without this file the wiring has no coverage at all.
 *
 * `drizzle` is faked (rather than the postgres.js driver) so the transaction
 * handle is fully controllable: a statement can be made to hang forever, which
 * is exactly what the wedged backend does and what no real local database can
 * be persuaded to do on demand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { drizzleFactory, transactionImpl, requestWedgedBackendReclaim } = vi.hoisted(() => {
  const transactionImpl = vi.fn();
  const requestWedgedBackendReclaim = vi.fn(() => null);
  const drizzleFactory = vi.fn(() => ({
    transaction: (fn: (tx: unknown) => Promise<unknown>) => transactionImpl(fn),
  }));
  return { drizzleFactory, transactionImpl, requestWedgedBackendReclaim };
});

vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: drizzleFactory }));
vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { options: { parsers: {}, serializers: {} } })),
}));
// The reclaimer would otherwise open a real side connection from the expiry
// handler. We assert it is ASKED; whether it terminates anything is
// wedgedBackends.test.ts's job.
vi.mock('./wedgedBackends', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./wedgedBackends')>()),
  requestWedgedBackendReclaim,
}));

const originalEnv = { ...process.env };

/**
 * A transaction handle whose Nth `execute` never settles — the wedge. Records
 * every statement it was asked to run, so "caller work was never issued"
 * is an assertion about behaviour rather than about a mock's internals.
 */
function makeTx(hangOnStatement: number | null) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    execute: vi.fn((query: SQL) => {
      issued.push(new PgDialect().sqlToQuery(query));
      if (hangOnStatement !== null && issued.length === hangOnStatement) {
        return new Promise(() => {});
      }
      return Promise.resolve([]);
    }),
  };
  return { tx, issued };
}

async function loadDb() {
  return import('./index');
}

describe('#6048 prologue deadline wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DATABASE_URL_APP = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS = '15000';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('rejects withDbAccessContext with the typed error when the first set_config wedges', async () => {
    // The production incident exactly: backend_start == xact_start, stuck on
    // `select set_config('breeze.scope', $1, true)`.
    const { tx, issued } = makeTx(1);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withSystemDbAccessContext, DbAccessContextPrologueTimeoutError } = await loadDb();
    const fn = vi.fn(async () => 'rows');
    const result = withSystemDbAccessContext(fn, 'wiringTest');
    const assertion = expect(result).rejects.toBeInstanceOf(DbAccessContextPrologueTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    // The caller's work must never have started: that is what makes abandoning
    // the transaction safe.
    expect(fn).not.toHaveBeenCalled();
    expect(issued).toHaveLength(1);
    expect(requestWedgedBackendReclaim).toHaveBeenCalledTimes(1);
  });

  it('does not enter caller work when the batched prologue resolves after its deadline', async () => {
    // `Promise.race` does not cancel its loser. Without the per-statement abort
    // check, a statement that resolved late could run caller work on a
    // connection being torn down — or already recycled to another tenant.
    const { tx, issued } = makeTx(null);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    tx.execute.mockImplementationOnce(async (query) => {
      issued.push(new PgDialect().sqlToQuery(query));
      await pending;
      return [];
    });
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withSystemDbAccessContext, DbAccessContextPrologueTimeoutError } = await loadDb();
    const fn = vi.fn(async () => 'rows');
    const result = withSystemDbAccessContext(fn, 'wiringTest');
    const assertion = expect(result).rejects.toBeInstanceOf(DbAccessContextPrologueTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(issued).toHaveLength(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('stamps all seven transaction-local settings in one round trip before caller work', async () => {
    const { tx, issued } = makeTx(null);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withSystemDbAccessContext } = await loadDb();
    await expect(withSystemDbAccessContext(async () => 'rows', 'wiringTest')).resolves.toBe('rows');

    expect(issued).toHaveLength(1);
    expect(issued[0]!.sql.startsWith("select set_config('breeze.scope'")).toBe(true);
    expect(issued[0]!.sql.match(/set_config\(/g)).toHaveLength(7);
    expect(issued[0]!.sql.match(/, true\)/g)).toHaveLength(7);
    expect(issued[0]!.params).toEqual(['system', '', '*', '*', '', '', '']);
    expect(requestWedgedBackendReclaim).not.toHaveBeenCalled();
  });

  it('exposes distinct transaction identities for savepoints and fresh contexts, never the bare pool', async () => {
    const savepoint = makeTx(null).tx;
    const outer = Object.assign(makeTx(null).tx, {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(savepoint),
    });
    const fresh = makeTx(null).tx;
    transactionImpl.mockImplementationOnce((fn: (tx: unknown) => Promise<unknown>) => fn(outer));
    transactionImpl.mockImplementationOnce((fn: (tx: unknown) => Promise<unknown>) => fn(fresh));
    const database = await loadDb();
    expect(database.getCurrentDbTransactionIdentity()).toBeUndefined();
    await database.withSystemDbAccessContext(async () => {
      const context = database.getCurrentDbAccessContext();
      expect(database.getCurrentDbTransactionIdentity()).toBe(outer);
      await database.withDbTransaction(async () => {
        expect(database.getCurrentDbTransactionIdentity()).toBe(savepoint);
        expect(database.getCurrentDbAccessContext()).toBe(context);
      });
      await database.runOutsideDbContext(async () => {
        expect(database.getCurrentDbTransactionIdentity()).toBeUndefined();
        await database.withSystemDbAccessContext(async () => {
          expect(database.getCurrentDbTransactionIdentity()).toBe(fresh);
          // The unlabeled system context is intentionally a shared singleton.
          expect(database.getCurrentDbAccessContext()).toBe(context);
        });
      });
      expect(database.getCurrentDbTransactionIdentity()).toBe(outer);
    });
    expect(database.getCurrentDbTransactionIdentity()).toBeUndefined();
  });

  it('does NOT bound the caller work that follows a completed prologue', async () => {
    // A slow report query is not a wedged connection. If the deadline were left
    // armed around `fn`, every query over the budget would become a 500.
    const { tx } = makeTx(null);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withSystemDbAccessContext } = await loadDb();
    let release: ((value: string) => void) | null = null;
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });

    const result = withSystemDbAccessContext(() => slow, 'wiringTest');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requestWedgedBackendReclaim).not.toHaveBeenCalled();

    release!('late but fine');
    await expect(result).resolves.toBe('late but fine');
  });

  it('does not issue the prologue when a transaction is acquired after the deadline', async () => {
    const { tx } = makeTx(null);
    let acquire!: () => void;
    const pending = new Promise<void>((resolve) => { acquire = resolve; });
    transactionImpl.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => {
      await pending;
      return fn(tx);
    });
    const { withSystemDbAccessContext, DbAccessContextPrologueTimeoutError } = await loadDb();
    const fn = vi.fn(async () => 'rows');
    const assertion = expect(withSystemDbAccessContext(fn)).rejects.toBeInstanceOf(DbAccessContextPrologueTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    acquire();
    await vi.advanceTimersByTimeAsync(0);
    expect(tx.execute).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it.each(['partner', 'organization'] as const)('narrows every access axis to %s before caller work', async (scope) => {
    const { tx, issued } = makeTx(null);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));
    const { withResolvedDbAccessContext, getCurrentDbAccessContext } = await loadDb();
    const orgId = '11111111-1111-1111-1111-111111111111';
    const partnerId = '22222222-2222-2222-2222-222222222222';
    const userId = '33333333-3333-3333-3333-333333333333';
    const historyOrgId = '44444444-4444-4444-4444-444444444444';
    const context = {
      scope,
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: scope === 'partner' ? [partnerId] : null,
      currentPartnerId: partnerId,
      userId,
      reportHistoryOrgIds: [historyOrgId],
    };
    await withResolvedDbAccessContext(async () => ({ context, value: 1 }), async (value) => {
      expect(value).toBe(1);
      expect(getCurrentDbAccessContext()).toEqual(context);
      expect(issued).toHaveLength(2);
      expect(issued[0]!.params).toEqual(['system', '', '*', '*', '', '', '']);
      expect(issued[1]!.params).toEqual([
        scope, orgId, orgId, scope === 'partner' ? partnerId : '', userId,
        partnerId, scope === 'partner' ? historyOrgId : '',
      ]);
    });
    expect(transactionImpl).toHaveBeenCalledTimes(1);
  });

  it('establishes archive read-only mode before the batch and clears unrelated grants', async () => {
    const { tx, issued } = makeTx(null);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));
    const { withArchivedOrgReadContext } = await loadDb();
    const orgId = '11111111-1111-1111-1111-111111111111';
    await withArchivedOrgReadContext([orgId], async () => {
      expect(issued).toHaveLength(2);
      expect(issued[0]!.sql).toBe('SET TRANSACTION READ ONLY');
      expect(issued[1]!.params).toEqual(['partner', '', orgId, '', '', '', '']);
    });
  });

  it('bounds the archived-org opener, whose first statement is SET TRANSACTION READ ONLY', async () => {
    // This opener issues an extra statement before the prologue, so its
    // arming/abort sequence is structurally different from the other two.
    const { tx, issued } = makeTx(1);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withArchivedOrgReadContext, DbAccessContextPrologueTimeoutError } = await loadDb();
    const result = withArchivedOrgReadContext(
      ['7f1b0a4e-0c2d-4c8a-9a0e-2f9c1b3d4e5f'],
      async () => 'rows',
    );
    const assertion = expect(result).rejects.toBeInstanceOf(DbAccessContextPrologueTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    expect(issued).toHaveLength(1);
  });

  it('bounds the second, narrowing prologue in withResolvedDbAccessContext', async () => {
    // This one runs a prologue INSIDE an already-open system-scope transaction,
    // so it needs its own bound — the outer one has long since disarmed.
    let call = 0;
    const issued: number[] = [];
    const tx = {
      execute: vi.fn(() => {
        call += 1;
        issued.push(call);
        // The first statement establishes system scope; the second narrows
        // it in the same transaction, and that is where we wedge.
        return call === 2 ? new Promise(() => {}) : Promise.resolve([]);
      }),
    };
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withResolvedDbAccessContext, DbAccessContextPrologueTimeoutError } = await loadDb();
    const fn = vi.fn(async () => 'rows');
    const result = withResolvedDbAccessContext(
      async () => ({
        context: {
          scope: 'organization' as const,
          orgId: '7f1b0a4e-0c2d-4c8a-9a0e-2f9c1b3d4e5f',
          accessibleOrgIds: ['7f1b0a4e-0c2d-4c8a-9a0e-2f9c1b3d4e5f'],
        },
        value: 1,
      }),
      fn,
    );
    const assertion = expect(result).rejects.toBeInstanceOf(DbAccessContextPrologueTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    expect(issued).toHaveLength(2);
    expect(fn).not.toHaveBeenCalled();
  });

  it('is a pass-through when the deadline is disabled', async () => {
    process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS = '0';
    const { tx } = makeTx(null);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withSystemDbAccessContext } = await loadDb();
    await expect(withSystemDbAccessContext(async () => 'rows', 'wiringTest')).resolves.toBe('rows');
    expect(vi.getTimerCount()).toBe(0);
  });
});
