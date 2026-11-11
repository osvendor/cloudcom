import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { DbAccessContext } from './index';

// Keep the real Drizzle constructors, query builders and transaction adapter.
// Only the transport is fake: these tests verify the exact SQL/connection and
// callback boundaries sent to postgres.js, not PostgreSQL's RLS implementation.
const transport = vi.hoisted(() => {
  type Event = { kind: string; client: string; sql?: string; params?: unknown[] };
  type Client = {
    options: { parsers: Record<string, unknown>; serializers: Record<string, unknown> };
    unsafe(query: string, params?: unknown[]): Promise<never[]> & { values(): Promise<never[]> };
    begin<T>(callback: (client: Client) => Promise<T>): Promise<T>;
    savepoint<T>(callback: (client: Client) => Promise<T>): Promise<T>;
  };
  const events: Event[] = [];
  let nextTransaction = 0;
  let nextSavepoint = 0;
  function makeClient(id: string): Client {
    return {
      options: { parsers: {}, serializers: {} },
      unsafe(query: string, params: unknown[] = []) {
        events.push({ kind: 'execute', client: id, sql: query, params });
        return Object.assign(Promise.resolve([]), { values: () => Promise.resolve([]) });
      },
      async begin<T>(callback: (client: Client) => Promise<T>): Promise<T> {
        const name = `tx${++nextTransaction}`;
        events.push({ kind: 'begin', client: name });
        try {
          const result = await callback(makeClient(name));
          events.push({ kind: 'commit', client: name });
          return result;
        } catch (error) {
          events.push({ kind: 'rollback', client: name });
          throw error;
        }
      },
      async savepoint<T>(callback: (client: Client) => Promise<T>): Promise<T> {
        const name = `${id}/sp${++nextSavepoint}`;
        events.push({ kind: 'savepoint', client: name });
        try {
          const result = await callback(makeClient(name));
          events.push({ kind: 'release-savepoint', client: name });
          return result;
        } catch (error) {
          events.push({ kind: 'rollback-savepoint', client: name });
          throw error;
        }
      },
    };
  }
  return {
    events,
    pool: makeClient('pool'),
    reset() { events.length = 0; nextTransaction = 0; nextSavepoint = 0; },
  };
});

vi.mock('postgres', () => ({ default: vi.fn(() => transport.pool) }));
vi.mock('../services/sentry', () => ({ captureMessage: vi.fn() }));
vi.mock('./wedgedBackends', async (importOriginal) => ({
  ...await importOriginal<typeof import('./wedgedBackends')>(),
  requestWedgedBackendReclaim: vi.fn(() => null),
}));

const originalEnv = { ...process.env };
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const PARTNER = '33333333-3333-3333-3333-333333333333';
const USER = '44444444-4444-4444-4444-444444444444';
const rows = pgTable('schema_free_context_rows', {
  id: uuid('id').primaryKey(), orgId: uuid('org_id').notNull(), name: text('name').notNull(),
});
const orgContext = (orgId = ORG_A): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId],
  accessiblePartnerIds: null, userId: USER, currentPartnerId: PARTNER,
});
const statements = () => transport.events.filter(event => event.kind === 'execute');

describe('schema-free request database with the real Drizzle adapter', () => {
  beforeEach(() => {
    vi.resetModules();
    transport.reset();
    process.env.DATABASE_URL_APP = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DB_CONTEXT_HELD_WARN_MS = '0';
    process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS = '15000';
  });
  afterEach(() => { process.env = { ...originalEnv }; });

  it('does not allocate relational table builders on the pool, transaction, or savepoint', async () => {
    const database = await import('./index');
    expect(Object.keys(database.db.query)).toEqual([]);
    await database.withDbAccessContext(orgContext(), async () => {
      expect(Object.keys(database.db.query)).toEqual([]);
      await database.withDbTransaction(async () => {
        expect(Object.keys(database.db.query)).toEqual([]);
      });
    });
    expect(transport.events.map(event => event.kind)).toEqual([
      'begin', 'execute', 'savepoint', 'release-savepoint', 'commit',
    ]);
  });

  it('preserves SQL builders and routes them through the context, including FOR UPDATE and returning', async () => {
    const database = await import('./index');
    // The configured reference represents the previous public constructor;
    // compare all ordinary builders, not a hand-written SQL approximation.
    const reference = drizzle(transport.pool as never, { schema: { rows } });
    const queries = (db: Pick<typeof database.db, 'select' | 'update' | 'insert' | 'delete'>) => [
      db.select({ id: rows.id, name: rows.name }).from(rows).where(eq(rows.orgId, ORG_A)).for('update'),
      db.update(rows).set({ name: 'updated' }).where(eq(rows.id, ORG_A)).returning({ id: rows.id }),
      db.insert(rows).values({ id: ORG_A, orgId: ORG_A, name: 'new' }).returning({ id: rows.id }),
      db.delete(rows).where(eq(rows.id, ORG_A)),
    ];
    await database.withDbAccessContext(orgContext(), async () => {
      const actual = queries(database.db);
      expect(actual.map(query => query.toSQL())).toEqual(queries(reference).map(query => query.toSQL()));
      for (const query of actual) await query;
    });
    expect(statements()).toHaveLength(5);
    expect(statements().every(event => event.client === 'tx1')).toBe(true);
    expect(statements().slice(1).map(event => event.sql?.split(' ')[0])).toEqual([
      'select', 'update', 'insert', 'delete',
    ]);
  });

  it('keeps transaction-local grants and metadata across savepoint rollback without escalating nested scope', async () => {
    const database = await import('./index');
    const context = orgContext();
    await database.withDbAccessContext(context, async () => {
      const outer = database.getCurrentDbTransactionIdentity();
      await database.db.execute(sql`select ${'outer-before'}`);
      const failure = new Error('abort only savepoint');
      await expect(database.withDbTransaction(async () => {
        expect(database.getCurrentDbTransactionIdentity()).not.toBe(outer);
        expect(database.getCurrentDbAccessContext()).toBe(context);
        await database.withSystemDbAccessContext(async () => {
          expect(database.getCurrentDbAccessContext()).toBe(context);
          await database.db.execute(sql`select ${'inside-savepoint'}`);
        });
        throw failure;
      })).rejects.toBe(failure);
      expect(database.getCurrentDbTransactionIdentity()).toBe(outer);
      expect(database.getCurrentDbAccessContext()).toBe(context);
      await database.db.execute(sql`select ${'outer-after'}`);
    });
    const guc = statements()[0]!;
    expect(guc.sql?.match(/set_config\(/g)).toHaveLength(7);
    expect(guc.sql?.match(/, true\)/g)).toHaveLength(7);
    expect(guc.params).toEqual(['organization', ORG_A, ORG_A, '', USER, PARTNER, '']);
    expect(statements().map(event => event.client)).toEqual(['tx1', 'tx1', 'tx1/sp1', 'tx1']);
    expect(transport.events.map(event => event.kind)).toEqual([
      'begin', 'execute', 'execute', 'savepoint', 'execute', 'rollback-savepoint', 'execute', 'commit',
    ]);
    expect(database.getCurrentDbAccessContext()).toBeUndefined();
    expect(database.getCurrentDbTransactionIdentity()).toBeUndefined();
  });

  it('rolls back a failed context and initializes a fresh transaction for the next tenant', async () => {
    const database = await import('./index');
    const failure = new Error('abort outer transaction');
    await expect(database.withDbAccessContext(orgContext(), async () => {
      await database.db.execute(sql`select ${'tenant-a'}`);
      throw failure;
    })).rejects.toBe(failure);
    expect(database.getCurrentDbAccessContext()).toBeUndefined();
    expect(database.getCurrentDbTransactionIdentity()).toBeUndefined();
    const contextB = orgContext(ORG_B);
    await database.withDbAccessContext(contextB, async () => {
      expect(database.getCurrentDbAccessContext()).toBe(contextB);
      await database.db.execute(sql`select ${'tenant-b'}`);
    });
    expect(transport.events.filter(event => event.kind !== 'execute')).toEqual([
      { kind: 'begin', client: 'tx1' }, { kind: 'rollback', client: 'tx1' },
      { kind: 'begin', client: 'tx2' }, { kind: 'commit', client: 'tx2' },
    ]);
    expect(statements().map(event => event.client)).toEqual(['tx1', 'tx1', 'tx2', 'tx2']);
    expect(statements()[2]!.params).toEqual(['organization', ORG_B, ORG_B, '', USER, PARTNER, '']);
  });

  it('narrows resolved access on the same transaction before caller SQL', async () => {
    const database = await import('./index');
    const context = orgContext();
    let identity: object | undefined;
    await database.withResolvedDbAccessContext(async () => {
      expect(database.getCurrentDbAccessContext()?.scope).toBe('system');
      identity = database.getCurrentDbTransactionIdentity();
      await database.db.execute(sql`select ${'resolve'}`);
      return { context, value: 'resolved' };
    }, async value => {
      expect(value).toBe('resolved');
      expect(database.getCurrentDbTransactionIdentity()).toBe(identity);
      expect(database.getCurrentDbAccessContext()).toBe(context);
      await database.db.execute(sql`select ${'narrowed'}`);
    });
    expect(statements().every(event => event.client === 'tx1')).toBe(true);
    expect(statements().map(event => event.params)).toEqual([
      ['system', '', '*', '*', '', '', ''], ['resolve'],
      ['organization', ORG_A, ORG_A, '', USER, PARTNER, ''], ['narrowed'],
    ]);
  });

  it('keeps archive reads read-only with only the explicit organization grant', async () => {
    const database = await import('./index');
    await database.withArchivedOrgReadContext([ORG_A], async () => {
      expect(database.getCurrentDbAccessContext()).toMatchObject({
        scope: 'partner', accessibleOrgIds: [ORG_A], accessiblePartnerIds: null, userId: null,
      });
      await database.db.execute(sql`select ${'archived'}`);
    });
    expect(statements()[0]).toMatchObject({ client: 'tx1', sql: 'SET TRANSACTION READ ONLY' });
    expect(statements()[1]!.params).toEqual(['partner', '', ORG_A, '', '', '', '']);
    expect(statements().every(event => event.client === 'tx1')).toBe(true);
  });
});
