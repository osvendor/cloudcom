import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { mockDb, dispatchMock, resolveMonitorsMock, txState, neSpy, eqSpy, activeWorkMock, responseHistoryMock, latestProbeMock, decisionMock } = vi.hoisted(() => ({
  mockDb: { select: vi.fn(), selectDistinctOn: vi.fn() },
  decisionMock: vi.fn(() => [] as unknown[]),
  latestProbeMock: vi.fn(() => [] as unknown[]),
  responseHistoryMock: vi.fn(() => [] as unknown[]),
  activeWorkMock: vi.fn((_predicate?: unknown) => [] as unknown[]),
  dispatchMock: vi.fn(),
  resolveMonitorsMock: vi.fn(),
  // Model context reuse and transaction commit/rollback, including probe writes
  // that must remain atomic and survive a failure on a subsequent device.
  txState: {
    depth: 0,
    nextId: 0,
    id: null as number | null,
    staged: [] as string[],
    committed: [] as string[],
    failCommit: false,
    events: [] as Array<{ id: number; event: 'begin' | 'commit' | 'rollback' }>,
  },
  neSpy: vi.fn(),
  eqSpy: vi.fn(),
}));

const { canRunBackgroundWorkMock, snapshotMock } = vi.hoisted(() => ({ canRunBackgroundWorkMock: vi.fn(() => true), snapshotMock: vi.fn() }));
vi.mock('../services/capacityGuard', () => ({ readCapacityGuard: () => snapshotMock.mock.calls.length || snapshotMock.getMockImplementation() ? snapshotMock() : ({ enabled: !canRunBackgroundWorkMock(), state: 'paused', observedAt: null }) }));

// Plain-string mocked schema columns below cannot round-trip through a real
// drizzle SQL compiler (no Column/Table shape for PgDialect to read), so the
// only way to prove a predicate like `ne(organizations.type, 'quick_support')`
// is actually emitted is to spy on the drizzle-orm helper call itself rather
// than inspect the resulting SQL tree.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    ne: ((...args: Parameters<typeof actual.ne>) => {
      neSpy(...args);
      return actual.ne(...args);
    }) as typeof actual.ne,
    eq: ((...args: Parameters<typeof actual.eq>) => {
      eqSpy(...args);
      return actual.eq(...args);
    }) as typeof actual.eq,
  };
});

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: async (fn: () => unknown) => {
    if (txState.depth > 0) return fn();
    const id = ++txState.nextId;
    txState.id = id;
    txState.staged = [];
    txState.depth += 1;
    txState.events.push({ id, event: 'begin' });
    try {
      const result = await fn();
      if (txState.failCommit) {
        txState.failCommit = false;
        throw new Error('commit failed');
      }
      txState.committed.push(...txState.staged);
      txState.events.push({ id, event: 'commit' });
      return result;
    } catch (error) {
      txState.events.push({ id, event: 'rollback' });
      throw error;
    } finally {
      txState.depth -= 1;
      txState.id = null;
      txState.staged = [];
    }
  },
  runOutsideDbContext: async (fn: () => unknown) => {
    const saved = txState.depth;
    const savedId = txState.id;
    const savedStaged = txState.staged;
    txState.depth = 0;
    txState.id = null;
    txState.staged = [];
    try {
      return await fn();
    } finally {
      txState.depth = saved;
      txState.id = savedId;
      txState.staged = savedStaged;
    }
  },
}));

vi.mock('../db/schema', async () => {
  const { pgTable, uuid, timestamp, text } = await import('drizzle-orm/pg-core');
  return {
  monitorDeviceState: { monitorId: 'state.monitorId', deviceId: 'state.deviceId',
    lastEvaluatedAt: 'state.lastEvaluatedAt', responsesPaused: 'state.responsesPaused', currentEpisodeId: 'state.currentEpisodeId' },
  monitorEpisodes: { id: 'episodes.id', responseOutcome: 'episodes.responseOutcome', responseDispatch: 'episodes.responseDispatch', responseRunId: 'episodes.responseRunId' },
  automationRuns: { id: 'runs.id', status: 'runs.status' },
  monitorDefinitions: {
    id: 'monitorDefinitions.id',
    kind: 'monitorDefinitions.kind',
    enabled: 'monitorDefinitions.enabled',
    orgId: 'monitorDefinitions.orgId',
    partnerId: 'monitorDefinitions.partnerId',
    condition: 'monitorDefinitions.condition',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
    type: 'organizations.type',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    osType: 'devices.osType',
    status: 'devices.status',
    agentId: 'devices.agentId',
    hostname: 'devices.hostname',
    siteId: 'devices.siteId',
    customFields: 'devices.customFields',
    isEphemeral: 'devices.isEphemeral',
  },
  configPolicyMonitors: pgTable('config_policy_monitors', {
    monitorId: uuid('monitor_id'),
    overrides: text('overrides'),
  }),
  // Real column metadata lets the guard test inspect the SQL sent to Postgres.
  scriptExecutions: pgTable('script_executions', {
    id: uuid('id'),
    monitorId: uuid('monitor_id'),
    deviceId: uuid('device_id'),
    scriptId: uuid('script_id'),
    exitCode: text('exit_code'),
    stdout: text('stdout'),
    completedAt: timestamp('completed_at'),
    status: text('status'),
    createdAt: timestamp('created_at'),
  }),
  scripts: {
    id: 'scripts.id',
  },
  };
});

vi.mock('../services/scriptDispatch', () => ({
  dispatchScriptToDevice: dispatchMock,
}));

vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

vi.mock('../services/monitors/monitorResolver', () => ({
  resolveMonitorsForDevice: resolveMonitorsMock,
}));

import { configPolicyMonitors, monitorDefinitions, organizations, devices, scriptExecutions, scripts, monitorDeviceState } from '../db/schema';
import { readCapacityGuardConfig } from '../services/capacityGuardPolicy';
import type { CapacityGuardSnapshot } from '../services/capacityGuard';
import { applicablePendingMonitorResponseDevices, canRunScriptMonitorProbe, pendingMonitorResponseDevices, processScriptMonitorTick } from './monitorScriptWorker';

const MONITOR_ID = 'monitor-1';
const DEVICE_ID = 'device-1';
const ORG_ID = 'org-1';
const SCRIPT_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-13T12:00:00.000Z');

type TableRef = typeof configPolicyMonitors | typeof monitorDefinitions | typeof organizations | typeof devices | typeof scriptExecutions | typeof scripts;
type QueryResponse = unknown[] | (() => unknown[]);

/**
 * Routes `db.select({...}).from(table)...` chains by the TABLE passed to
 * `.from()`, resolving to whatever rows the test registered for that table.
 * Supports both `await ...where(...)` (no orderBy/limit) and
 * `...where().orderBy().limit()` shapes, matching what monitorScriptWorker
 * actually calls per table.
 */
function setupDb(responses: Map<TableRef, QueryResponse>) {
  const queries: Array<{ table: TableRef; where: unknown; transactionId: number | null }> = [];
  mockDb.selectDistinctOn.mockImplementation(() => {
    const builder = { from: () => builder, where: () => builder,
      orderBy: () => Promise.resolve(latestProbeMock()) };
    return builder;
  });
  mockDb.select.mockImplementation((fields) => {
    let response: QueryResponse = [];
    let tableRef: TableRef;
    const readRows = () => {
      const rows = typeof response === 'function' ? response() : response;
      if (tableRef !== scriptExecutions || !fields?.active) return rows;
      return rows.map((row: any) => ({ ...row, active: row.active ?? ['pending', 'queued', 'running', 'cancelling'].includes(row.status) }));
    };
    const builder = {
      from(table: TableRef) {
        tableRef = table;
        if (table === (monitorDeviceState as any)) { response = decisionMock; return builder; }
        // Existing admission fixtures represent attached monitors. Tests for
        // absence/overrides provide the complete inventory explicitly.
        response = responses.get(table) ?? (table === configPolicyMonitors
          ? [{ monitorId: MONITOR_ID, overrides: null }]
          : []);
        return builder;
      },
      where(predicate: unknown) {
        if (tableRef === scriptExecutions && Object.keys(fields ?? {}).join() === 'deviceId') {
          return { groupBy: () => ({ limit: () => Promise.resolve(activeWorkMock(predicate)) }) };
        }
        if (tableRef === scriptExecutions && Object.keys(fields ?? {}).join() === 'deviceId,scriptId,createdAt') {
          return { groupBy: () => Promise.resolve(responseHistoryMock()) };
        }
        queries.push({ table: tableRef, where: predicate, transactionId: txState.id });
        return builder;
      },
      leftJoin() { return builder; },
      groupBy() { return builder; },
      orderBy() {
        return builder;
      },
      limit() {
        return Promise.resolve().then(readRows);
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve().then(readRows).then(resolve, reject);
      },
    };
    return builder;
  });
  return queries;
}

function makeMonitorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MONITOR_ID,
    orgId: ORG_ID,
    partnerId: null,
    enabled: true,
    condition: {
      scriptId: SCRIPT_ID,
      intervalMinutes: 60,
      timeoutSeconds: 300,
      breachOnNonZeroExit: true,
    },
    ...overrides,
  };
}

function makeDeviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DEVICE_ID,
    orgId: ORG_ID,
    osType: 'windows',
    status: 'online',
    agentId: 'agent-1',
    hostname: 'device-1.example',
    siteId: 'site-1',
    customFields: {},
    ...overrides,
  };
}

function makeScriptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SCRIPT_ID,
    orgId: null,
    version: 1,
    language: 'powershell',
    timeoutSeconds: 300,
    content: 'Write-Output "ok"',
    runAs: 'system',
    ...overrides,
  };
}

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function deferredProbe(deviceId: string, deliver: () => Promise<void>) {
  return {
    ok: true,
    commandId: `command:${deviceId}`,
    executionId: `execution:${deviceId}`,
    delivered: false,
    deliveryOutcome: 'deferred',
    executedAt: null,
    deliverBy: null,
    ignoredParameters: [],
    runAs: 'system',
    targetSessionId: null,
    deliver,
  };
}

describe('processScriptMonitorTick', () => {
  beforeEach(() => {
    canRunBackgroundWorkMock.mockReset().mockReturnValue(true);
    snapshotMock.mockReset();
    activeWorkMock.mockReset().mockReturnValue([]);
    latestProbeMock.mockReset().mockReturnValue([]);
    responseHistoryMock.mockReset().mockReturnValue([]);
    decisionMock.mockReset().mockReturnValue([]);
    vi.stubEnv('MONITOR_SCRIPT_MAX_DISPATCH_PER_TICK', '10');
    vi.stubEnv('MONITOR_SCRIPT_MAX_ACTIVE_WORK', '10');
    mockDb.select.mockReset();
    dispatchMock.mockReset();
    resolveMonitorsMock.mockReset();
    Object.assign(txState, {
      depth: 0, nextId: 0, id: null, staged: [], committed: [], failCommit: false, events: [],
    });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    dispatchMock.mockResolvedValue({
      ok: true,
      commandId: 'cmd-1',
      executionId: 'exec-1',
      delivered: true,
      deliverBy: null,
      deliveryOutcome: 'sent',
      executedAt: null,
      ignoredParameters: [],
      runAs: 'system',
      targetSessionId: null,
    });

    resolveMonitorsMock.mockResolvedValue({
      kind: 'resolved',
      monitors: [
        {
          monitorId: MONITOR_ID,
          enabled: true,
          overrides: null,
          sourcePolicyId: 'policy-1',
          sourceLevel: 'organization',
          inheritedFromParent: false,
        },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('makes one bounded admission during heavy-lane recovery, prioritizing never then oldest evidence', async () => {
    vi.unstubAllEnvs(); // Production defaults are one dispatch and two active jobs.
    snapshotMock.mockReturnValue(microSnapshot());
    const responses = new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, ['recent', 'oldest', 'new'].map(id => makeDeviceRow({ id }))],
      [scriptExecutions, [
        { deviceId: 'recent', status: 'completed', createdAt: minutesAgo(90) },
        { deviceId: 'oldest', status: 'completed', createdAt: minutesAgo(300) },
      ]],
      [scripts, [makeScriptRow()]],
    ]);
    let history = true;
    responses.set(scriptExecutions, () => history ? (history = false, [
      { deviceId: 'recent', status: 'completed', createdAt: minutesAgo(90) },
      { deviceId: 'oldest', status: 'completed', createdAt: minutesAgo(300) },
    ]) : []);
    setupDb(responses);
    expect(await processScriptMonitorTick()).toMatchObject({ dispatched: 1 });
    expect(dispatchMock.mock.calls[0]![0].device.id).toBe('new');
    dispatchMock.mockClear();
    history = true;
    responses.set(devices, ['recent', 'oldest'].map(id => makeDeviceRow({ id })));
    expect(await processScriptMonitorTick()).toMatchObject({ dispatched: 1 });
    expect(dispatchMock.mock.calls[0]![0].device.id).toBe('oldest');
  });

  it('rechecks active work when a response execution appears between admission snapshots', async () => {
    vi.unstubAllEnvs();
    setupDb(new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow()]], [scripts, [makeScriptRow()]],
    ]));
    activeWorkMock.mockReturnValueOnce([]).mockReturnValueOnce([
      { deviceId: 'just-started-one' }, { deviceId: 'just-started-two' },
    ]);
    expect(await processScriptMonitorTick()).toMatchObject({ dispatched: 0, deferredForActiveWork: true });
    expect(dispatchMock).not.toHaveBeenCalled();
  });
  it('counts active automation response scripts even without monitor_id and refuses another probe', async () => {
    vi.unstubAllEnvs();
    const repairId = '22222222-2222-4222-8222-222222222222';
    setupDb(new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow({ responses: [{ type: 'run_script', scriptId: repairId }] })]],
    ]));
    activeWorkMock.mockReturnValue([{ deviceId: 'device1' }, { deviceId: 'device2' }]);
    expect(await processScriptMonitorTick()).toMatchObject({ dispatched: 0, deferredForActiveWork: true });
    expect(resolveMonitorsMock).not.toHaveBeenCalled();
    // Predicate includes response script IDs independently of monitor IDs.
    expect(mockDb.select).toHaveBeenCalledTimes(2);
    const query = new PgDialect().sqlToQuery(activeWorkMock.mock.calls[0]![0] as any);
    expect(query.sql).toContain('"script_id" in');
    expect(query.params).toContain(repairId);
    expect(query.params).toContain(SCRIPT_ID);
    expect(query.params).toContain('running');
  });

  it('defers a pressured tick before opening a database context or marking any probe due', async () => {
    canRunBackgroundWorkMock.mockReturnValue(false);
    const result = await processScriptMonitorTick();
    expect(result).toEqual({
      monitorsConsidered: 0, devicesConsidered: 0, dispatched: 0, skipped: 0,
      skippedUnattached: 0, skippedNotDue: 0, errors: 0, deferredForCapacity: true,
    });
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(resolveMonitorsMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(txState.events).toEqual([]);
    expect(txState.depth).toBe(0);
  });

  it('stops between devices after committed delivery and resumes the still-due device next tick', async () => {
    const responses = new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow({ id: 'first' }), makeDeviceRow({ id: 'second' })]],
      [scriptExecutions, []],
      [scripts, [makeScriptRow()]],
    ]);
    setupDb(responses);
    const delivered: string[] = [];
    canRunBackgroundWorkMock.mockImplementation(() => {
      expect(txState.depth).toBe(0);
      return delivered.length === 0;
    });
    dispatchMock.mockImplementation(async ({ device }) => {
      txState.staged.push(`execution:${device.id}`, `command:${device.id}`);
      return deferredProbe(device.id, async () => {
        expect(txState.depth).toBe(0);
        expect(txState.committed).toContain(`command:${device.id}`);
        delivered.push(device.id);
      });
    });
    expect(await processScriptMonitorTick()).toMatchObject({
      devicesConsidered: 2, dispatched: 1, skipped: 0, skippedNotDue: 0, errors: 0, deferredForCapacity: true,
    });
    expect(delivered).toEqual(['first']);
    expect(txState.committed).toEqual(['execution:first', 'command:first']);
    expect(resolveMonitorsMock).toHaveBeenCalledTimes(1);

    // The first probe now exists; only the second remains due after recovery.
    let historyReads = 0;
    responses.set(scriptExecutions, () => ++historyReads === 1
      ? [{ deviceId: 'first', id: 'execution:first', status: 'pending', createdAt: NOW }]
      : []);
    canRunBackgroundWorkMock.mockReturnValue(true);
    const resumed = await processScriptMonitorTick();
    expect(resumed).toMatchObject({ dispatched: 1, skipped: 1, skippedNotDue: 1, errors: 0 });
    expect(resumed.deferredForCapacity).toBeUndefined();
    expect(delivered).toEqual(['first', 'second']);
    expect(txState.depth).toBe(0);
  });

  it('(a) does not redispatch when the newest execution is younger than the interval', async () => {
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow()]],
        [devices, [makeDeviceRow()]],
        [scriptExecutions, [{ createdAt: minutesAgo(10) }]], // 10 min old, interval is 60
        [scripts, [makeScriptRow()]],
      ]),
    );

    const result = await processScriptMonitorTick();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ monitorsConsidered: 1, devicesConsidered: 1, dispatched: 0, skipped: 1 });
  });

  it('(b) allows old terminal history while guarding any active execution and the current cadence', async () => {
    const queries = setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow()]],
        [devices, [makeDeviceRow()]],
        // The EXISTS-style lookup excludes terminal runs older than the
        // interval, so Postgres returns no blocking rows for that history.
        [scriptExecutions, []],
        [scripts, [makeScriptRow()]],
      ]),
    );

    const result = await processScriptMonitorTick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ monitorsConsidered: 1, devicesConsidered: 1, dispatched: 1, skipped: 0 });

    const predicate = queries.filter((query) => query.table === scriptExecutions).at(-1)!.where;
    const compiled = new PgDialect().sqlToQuery(predicate as Parameters<PgDialect['sqlToQuery']>[0]);
    expect(compiled.sql).toBe('("script_executions"."monitor_id" = $1 and "script_executions"."device_id" = $2 and ("script_executions"."status" in ($3, $4, $5, $6) or "script_executions"."created_at" > $7))');
    expect(compiled.params).toEqual([
      MONITOR_ID, DEVICE_ID, 'pending', 'queued', 'running', 'cancelling', minutesAgo(60).toISOString(),
    ]);
  });

  it.each(['pending', 'queued', 'running', 'cancelling'])('does not replace an old %s execution with another probe', async (status) => {
    setupDb(new Map<TableRef, unknown[]>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow()]],
      // The guard is an existence lookup, so an old active row is returned
      // even when newer completed/failed runs are present in the history.
      [scriptExecutions, [{ id: 'active-run', status, createdAt: minutesAgo(1440) }]],
      [scripts, [makeScriptRow()]],
    ]));

    const result = await processScriptMonitorTick();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dispatched: 0, skipped: 1, errors: 0 });
  });

  it.each(['offline', 'degraded', 'maintenance', 'decommissioned'])('skips a %s candidate before resolving policies or checking history', async (status) => {
    const queries = setupDb(new Map<TableRef, unknown[]>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow({ status })]],
      [scriptExecutions, []],
      [scripts, [makeScriptRow()]],
    ]));

    const result = await processScriptMonitorTick();

    expect(resolveMonitorsMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(queries.some((query) => query.table === scriptExecutions)).toBe(false);
    expect(result).toMatchObject({ devicesConsidered: 1, dispatched: 0, skipped: 1, errors: 0 });
  });

  it('requests a fresh offline rejection and treats a liveness race as a skipped probe', async () => {
    setupDb(new Map<TableRef, unknown[]>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, []],
      [scripts, [makeScriptRow()]],
    ]));
    dispatchMock.mockResolvedValue({ ok: false, code: 'device_offline', error: 'Device is offline' });

    const result = await processScriptMonitorTick();

    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      device: expect.objectContaining({ status: 'online' }),
      offlinePolicy: { kind: 'reject' },
    }));
    expect(result).toMatchObject({ dispatched: 0, skipped: 1, errors: 0 });
  });

  it('(c) does not dispatch when the resolver says this monitor is disabled for the device', async () => {
    resolveMonitorsMock.mockResolvedValue({
      kind: 'resolved',
      monitors: [
        {
          monitorId: MONITOR_ID,
          enabled: false,
          overrides: null,
          sourcePolicyId: 'policy-1',
          sourceLevel: 'device',
          inheritedFromParent: false,
        },
      ],
    });
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow()]],
        [devices, [makeDeviceRow()]],
        // No execution history needed â€” disabled short-circuits before the throttle check.
        [scriptExecutions, []],
        [scripts, [makeScriptRow()]],
      ]),
    );

    const result = await processScriptMonitorTick();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ monitorsConsidered: 1, devicesConsidered: 1, dispatched: 0, skipped: 1 });
  });

  it('(c2) does not dispatch when the device raced a delete â€” resolver returns device_missing, not a fabricated "zero monitors" (#5677)', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'device_missing' });
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow()]],
        [devices, [makeDeviceRow()]],
        [scriptExecutions, []],
        [scripts, [makeScriptRow()]],
      ]),
    );

    const result = await processScriptMonitorTick();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ monitorsConsidered: 1, devicesConsidered: 1, dispatched: 0, skipped: 1 });
  });

  it('(d) dispatches with triggerType "monitor" and the monitor definition id', async () => {
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow()]],
        [devices, [makeDeviceRow()]],
        [scriptExecutions, []], // no prior run at all -> due
        [scripts, [makeScriptRow()]],
      ]),
    );

    await processScriptMonitorTick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0]![0];
    expect(call.triggerType).toBe('monitor');
    expect(call.monitorId).toBe(MONITOR_ID);
    expect(call.device.id).toBe(DEVICE_ID);
    expect(call.timeoutSeconds).toBe(300);
    expect(call.offlinePolicy).toEqual({ kind: 'reject' });
  });

  it('keeps effective scheduling overrides and rejects invalid overrides before dispatch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const queries = setupDb(new Map<TableRef, unknown[]>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, []],
      [scripts, [makeScriptRow()]],
    ]));
    const resolution = await resolveMonitorsMock();
    resolveMonitorsMock.mockResolvedValue({
      ...resolution,
      monitors: [{ ...resolution.monitors[0], overrides: { intervalMinutes: 10, timeoutSeconds: 90 } }],
    });

    expect((await processScriptMonitorTick()).dispatched).toBe(1);
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: 90 }));
    const guard = queries.filter((query) => query.table === scriptExecutions).at(-1)!.where;
    expect(new PgDialect().sqlToQuery(guard as Parameters<PgDialect['sqlToQuery']>[0]).params)
      .toContain(minutesAgo(10).toISOString());

    dispatchMock.mockClear();
    resolveMonitorsMock.mockResolvedValue({
      ...resolution,
      monitors: [{ ...resolution.monitors[0], overrides: { timeoutSeconds: -1 } }],
    });
    expect(await processScriptMonitorTick()).toMatchObject({ dispatched: 0, errors: 1 });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it.each(['maintenance_suppressed', 'maintenance_check_failed'])('preserves the dispatcher refusal %s', async (code) => {
    setupDb(new Map<TableRef, unknown[]>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, []],
      [scripts, [makeScriptRow()]],
    ]));
    dispatchMock.mockResolvedValue({ ok: false, code, error: 'Maintenance gate refused the probe' });

    expect(await processScriptMonitorTick()).toMatchObject({ dispatched: 0, skipped: 1, errors: 0 });
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ deferDelivery: true }));
    expect(dispatchMock.mock.calls[0]![0].bypassMaintenanceWindow).toBeUndefined();
    expect(txState.committed).toEqual([]);
  });

  // #3445: the probe's script_executions + device_commands rows are written
  // together in the device admission transaction. Sending inside
  // that transaction lets a fast agent answer before the rows are visible to
  // the result path, which then drops the result and strands the execution
  // until the stale reaper times it out.
  it('writes the probe rows inside one admission transaction and sends only after it commits (#3445)', async () => {
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow()]],
        [devices, [makeDeviceRow()]],
        [scriptExecutions, []],
        [scripts, [makeScriptRow()]],
      ]),
    );
    const events: Array<{ event: string; depth: number }> = [];
    const base = {
      ok: true,
      commandId: 'cmd-1',
      executionId: 'exec-1',
      deliverBy: null,
      ignoredParameters: [],
      runAs: 'system',
      targetSessionId: null,
    };
    dispatchMock.mockImplementation(async (input: { deferDelivery?: boolean }) => {
      events.push({ event: 'rows_created', depth: txState.depth });
      const send = () => {
        events.push({ event: 'sent', depth: txState.depth });
        return { ...base, delivered: true, deliveryOutcome: 'sent', executedAt: NOW };
      };
      if (input.deferDelivery) {
        return { ...base, delivered: false, deliveryOutcome: 'deferred', executedAt: null, deliver: async () => send() };
      }
      return send();
    });

    const result = await processScriptMonitorTick();

    expect(result.dispatched).toBe(1);
    expect(events).toEqual([
      { event: 'rows_created', depth: 1 },
      { event: 'sent', depth: 0 },
    ]);
  });

  it('releases prior-device locks before the next policy read and rolls back only a failed admission', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setupDb(new Map<TableRef, unknown[]>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, ['first', 'fails', 'last'].map((id) => makeDeviceRow({ id }))],
      [scriptExecutions, []],
      [scripts, [makeScriptRow()]],
    ]));
    const policyTransactions: number[] = [];
    const delivered: string[] = [];
    const resolution = await resolveMonitorsMock();
    resolveMonitorsMock.mockClear();
    resolveMonitorsMock.mockImplementation(async (id: string) => {
      expect(txState.depth).toBe(1);
      expect(txState.staged).toEqual([]);
      if (id !== 'first') {
        // These FK-holding writes already committed; they cannot remain open
        // while this device resolves policy and maintenance on its connection.
        expect(txState.committed).toEqual(['execution:first', 'command:first']);
        expect(delivered).toEqual(['first']);
        expect(txState.events).toContainEqual({ id: policyTransactions[0], event: 'commit' });
      }
      policyTransactions.push(txState.id!);
      return resolution;
    });
    dispatchMock.mockImplementation(async ({ device, deferDelivery }) => {
      expect(deferDelivery).toBe(true);
      expect(txState.depth).toBe(1);
      txState.staged.push(`execution:${device.id}`);
      if (device.id === 'fails') throw new Error('command insert failed');
      txState.staged.push(`command:${device.id}`);
      return deferredProbe(device.id, async () => {
        expect(txState.depth).toBe(0);
        expect(txState.committed).toContain(`execution:${device.id}`);
        expect(txState.committed).toContain(`command:${device.id}`);
        delivered.push(device.id);
      });
    });

    const result = await processScriptMonitorTick();

    expect(result).toEqual({ monitorsConsidered: 1, devicesConsidered: 3, dispatched: 2, skipped: 0, skippedUnattached: 0, skippedNotDue: 0, errors: 1 });
    expect(new Set(policyTransactions).size).toBe(3);
    expect(txState.events).toContainEqual({ id: policyTransactions[1], event: 'rollback' });
    expect(txState.committed).toEqual(['execution:first', 'command:first', 'execution:last', 'command:last']);
    expect(delivered).toEqual(['first', 'last']);
    expect(txState.depth).toBe(0);
  });

  it('does not count or deliver a probe whose transaction failed to commit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setupDb(new Map<TableRef, unknown[]>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, []],
      [scripts, [makeScriptRow()]],
    ]));
    const deliver = vi.fn();
    dispatchMock.mockImplementation(async () => {
      txState.staged.push('execution:failed-commit', 'command:failed-commit');
      txState.failCommit = true;
      return deferredProbe(DEVICE_ID, deliver);
    });

    const result = await processScriptMonitorTick();

    expect(result).toMatchObject({ dispatched: 0, skipped: 0, errors: 1 });
    expect(txState.committed).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('uses a fresh transaction rather than inheriting an outer sweep context', async () => {
    setupDb(new Map<TableRef, unknown[]>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, []],
      [scripts, [makeScriptRow()]],
    ]));
    txState.depth = 1;
    txState.id = 999;
    txState.staged = ['unrelated outer write'];
    dispatchMock.mockImplementation(async () => {
      expect(txState.id).not.toBe(999);
      expect(txState.depth).toBe(1);
      txState.staged.push('execution:own', 'command:own');
      return deferredProbe(DEVICE_ID, async () => {
        expect(txState.depth).toBe(0);
        expect(txState.committed).toEqual(['execution:own', 'command:own']);
      });
    });

    expect((await processScriptMonitorTick()).dispatched).toBe(1);
    expect(txState.depth).toBe(1);
    expect(txState.id).toBe(999);
    expect(txState.staged).toEqual(['unrelated outer write']);
  });

  it('does not redispatch a committed admission when a later tick retries', async () => {
    const responses = new Map<TableRef, unknown[]>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, []],
      [scripts, [makeScriptRow()]],
    ]);
    setupDb(responses);
    dispatchMock.mockImplementation(async () => {
      txState.staged.push('execution:once', 'command:once');
      return deferredProbe(DEVICE_ID, async () => {
        expect(txState.committed).toEqual(['execution:once', 'command:once']);
        responses.set(scriptExecutions, [{ id: 'execution:once', status: 'pending', createdAt: NOW }]);
      });
    });

    expect((await processScriptMonitorTick()).dispatched).toBe(1);
    expect(await processScriptMonitorTick()).toMatchObject({ dispatched: 0, skipped: 1, errors: 0 });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it('a throwing deferred delivery does not fail the tick â€” the committed command waits for the heartbeat (#3445)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow()]],
        [devices, [makeDeviceRow()]],
        [scriptExecutions, []],
        [scripts, [makeScriptRow()]],
      ]),
    );
    dispatchMock.mockResolvedValue({
      ok: true,
      commandId: 'cmd-1',
      executionId: 'exec-1',
      deliverBy: null,
      ignoredParameters: [],
      runAs: 'system',
      targetSessionId: null,
      delivered: false,
      deliveryOutcome: 'deferred',
      executedAt: null,
      deliver: async () => { throw new Error('socket closed'); },
    });

    const result = await processScriptMonitorTick();

    expect(result.dispatched).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('never dispatches when no monitor rows are due for consideration', async () => {
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, []],
        [devices, []],
        [scriptExecutions, []],
        [scripts, []],
      ]),
    );

    const result = await processScriptMonitorTick();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ monitorsConsidered: 0, devicesConsidered: 0, dispatched: 0, skipped: 0, skippedUnattached: 0, skippedNotDue: 0, errors: 0 });
  });

  it('excludes the hidden quick_support org from a partner-wide script monitor fan-out', async () => {
    neSpy.mockClear();
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow({ orgId: null, partnerId: 'partner-1' })]],
        [organizations, [{ id: ORG_ID }]],
        [devices, [makeDeviceRow()]],
        [scriptExecutions, []],
        [scripts, [makeScriptRow()]],
      ]),
    );

    await processScriptMonitorTick();

    expect(neSpy).toHaveBeenCalledWith(organizations.type, 'quick_support');
  });

  it('excludes ephemeral (Quick Support) devices from the candidate device query', async () => {
    eqSpy.mockClear();
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow()]],
        [devices, [makeDeviceRow()]],
        [scriptExecutions, []],
        [scripts, [makeScriptRow()]],
      ]),
    );

    await processScriptMonitorTick();

    expect(eqSpy).toHaveBeenCalledWith(devices.isEphemeral, false);
  });

  it('skips an unattached monitor without per-device policy/history reads and sees a new attachment next tick', async () => {
    const responses = new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow()]],
      [configPolicyMonitors, []],
      [devices, [makeDeviceRow(), makeDeviceRow({ id: 'offline', status: 'offline' })]],
      [scriptExecutions, []],
      [scripts, [makeScriptRow()]],
    ]);
    const queries = setupDb(responses);

    expect(await processScriptMonitorTick()).toMatchObject({
      devicesConsidered: 2, skipped: 2, skippedUnattached: 1, skippedNotDue: 0, errors: 0,
    });
    expect(resolveMonitorsMock).not.toHaveBeenCalled();
    expect(queries.filter((query) => query.table === scriptExecutions)).toHaveLength(0);

    responses.set(configPolicyMonitors, [{ monitorId: MONITOR_ID, overrides: null }]);
    expect(await processScriptMonitorTick()).toMatchObject({ dispatched: 1, skippedUnattached: 0 });
    expect(resolveMonitorsMock).toHaveBeenCalledTimes(1);
    expect(queries.filter((query) => query.table === configPolicyMonitors)).toHaveLength(2);
  });

  it('preserves authored condition and owner/fan-out errors even when no attachment exists', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setupDb(new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [
        makeMonitorRow({ id: 'invalid', condition: { scriptId: SCRIPT_ID, intervalMinutes: 1 } }),
        makeMonitorRow({ id: 'ownerless', orgId: null, partnerId: null }),
        makeMonitorRow({ id: 'too-wide', orgId: null, partnerId: 'partner-1' }),
      ]],
      [configPolicyMonitors, []],
      [organizations, Array.from({ length: 501 }, (_, i) => ({ id: `org-${i}` }))],
    ]));

    expect(await processScriptMonitorTick()).toMatchObject({
      monitorsConsidered: 3, errors: 3, skippedUnattached: 0, dispatched: 0,
    });
    expect(resolveMonitorsMock).not.toHaveBeenCalled();
  });

  it('uses one history query for an idle fleet instead of resolving every device', async () => {
    const fleet = Array.from({ length: 46 }, (_, i) => makeDeviceRow({ id: `fleet-${i}` }));
    const queries = setupDb(new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, fleet],
      [scriptExecutions, fleet.map((device) => ({
        deviceId: device.id, status: 'completed', createdAt: minutesAgo(10),
      }))],
    ]));

    expect(await processScriptMonitorTick()).toMatchObject({
      devicesConsidered: 46, skipped: 46, skippedNotDue: 46, dispatched: 0, errors: 0,
    });
    expect(resolveMonitorsMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(queries.filter((query) => query.table === configPolicyMonitors)).toHaveLength(1);
    const historyQueries = queries.filter((query) => query.table === scriptExecutions);
    expect(historyQueries).toHaveLength(1);
    const compiled = new PgDialect().sqlToQuery(historyQueries[0]!.where as Parameters<PgDialect['sqlToQuery']>[0]);
    expect(compiled.sql).toContain('"monitor_id" = $1');
    expect(compiled.sql).toContain('"device_id" in (');
    expect(compiled.params).toEqual([
      MONITOR_ID, ...fleet.map((device) => device.id),
    ]);
  });

  it.each(['pending', 'queued', 'running', 'cancelling'])('prefilters an old %s run even behind newer terminal history', async (status) => {
    setupDb(new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, [
        { deviceId: DEVICE_ID, status, createdAt: minutesAgo(1440) },
        { deviceId: DEVICE_ID, status: 'completed', createdAt: minutesAgo(120) },
      ]],
    ]));

    expect(await processScriptMonitorTick()).toMatchObject({ skippedNotDue: 1, dispatched: 0 });
    expect(resolveMonitorsMock).not.toHaveBeenCalled();
  });

  it('includes shorter disabled/unassigned attachment overrides without changing final winner resolution', async () => {
    let historyReads = 0;
    const queries = setupDb(new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow()]],
      [configPolicyMonitors, [
        { monitorId: MONITOR_ID, overrides: null },
        { monitorId: MONITOR_ID, overrides: { intervalMinutes: 5 }, enabled: false, assigned: false },
      ]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, () => ++historyReads === 1
        ? [{ deviceId: DEVICE_ID, status: 'completed', createdAt: minutesAgo(10) }]
        : []],
      [scripts, [makeScriptRow()]],
    ]));
    const resolution = await resolveMonitorsMock();
    resolveMonitorsMock.mockClear();
    resolveMonitorsMock.mockResolvedValue({
      ...resolution,
      monitors: [{ ...resolution.monitors[0], overrides: { intervalMinutes: 5 }, inheritedFromParent: true }],
    });

    expect(await processScriptMonitorTick()).toMatchObject({ dispatched: 1, skippedNotDue: 0 });
    expect(resolveMonitorsMock).toHaveBeenCalledTimes(1);
    const inventory = queries.find((query) => query.table === configPolicyMonitors)!;
    expect(new PgDialect().sqlToQuery(inventory.where as Parameters<PgDialect['sqlToQuery']>[0]).sql)
      .toBe('"config_policy_monitors"."monitor_id" in ($1)');
    for (const query of queries.filter((query) => query.table === scriptExecutions).slice(1)) {
      expect(new PgDialect().sqlToQuery(query.where as Parameters<PgDialect['sqlToQuery']>[0]).params)
        .toContain(minutesAgo(5).toISOString());
    }
  });

  it('retains the authored lower bound and exact due check when an attachment makes the interval longer', async () => {
    const authored = makeMonitorRow();
    authored.condition.intervalMinutes = 5;
    const queries = setupDb(new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [authored]],
      [configPolicyMonitors, [{ monitorId: MONITOR_ID, overrides: { intervalMinutes: 60 } }]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, [{ deviceId: DEVICE_ID, status: 'completed', createdAt: minutesAgo(10) }]],
    ]));
    const resolution = await resolveMonitorsMock();
    resolveMonitorsMock.mockClear();
    resolveMonitorsMock.mockResolvedValue({
      ...resolution, monitors: [{ ...resolution.monitors[0], overrides: { intervalMinutes: 60 } }],
    });

    expect(await processScriptMonitorTick()).toMatchObject({ dispatched: 0, skipped: 1, skippedNotDue: 0 });
    expect(resolveMonitorsMock).toHaveBeenCalledTimes(1);
    const queriesWithCutoffs = queries.filter((query) => query.table === scriptExecutions)
      .map((query) => new PgDialect().sqlToQuery(query.where as Parameters<PgDialect['sqlToQuery']>[0]).params);
    expect(queriesWithCutoffs[0]).not.toContain(minutesAgo(5).toISOString());
    expect(queriesWithCutoffs[1]).toContain(minutesAgo(60).toISOString());
  });

  it.each([
    ['unknown key', { futureSetting: true }],
    ['invalid interval', { intervalMinutes: 1 }],
    ['fractional interval', { intervalMinutes: 5.5 }],
    ['invalid timeout', { timeoutSeconds: -1 }],
    ['array', []],
    ['string', 'invalid'],
    ['boolean', false],
  ])('disables the prefilter for any %s override, even on a nonwinning attachment', async (_name, overrides) => {
    const queries = setupDb(new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow()]],
      [configPolicyMonitors, [
        { monitorId: MONITOR_ID, overrides: null },
        { monitorId: MONITOR_ID, overrides, enabled: false },
      ]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, [{ deviceId: DEVICE_ID, status: 'completed', createdAt: minutesAgo(1) }]],
    ]));

    expect(await processScriptMonitorTick()).toMatchObject({ skipped: 1, skippedNotDue: 0, errors: 0 });
    expect(resolveMonitorsMock).toHaveBeenCalledTimes(1);
    expect(queries.filter((query) => query.table === scriptExecutions)).toHaveLength(1);
  });

  it('does not hide an invalid winning override behind recent execution history', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const badOverride = { timeoutSeconds: -1 };
    setupDb(new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow()]],
      [configPolicyMonitors, [{ monitorId: MONITOR_ID, overrides: badOverride }]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, [{ deviceId: DEVICE_ID, status: 'completed', createdAt: minutesAgo(1) }]],
    ]));
    const resolution = await resolveMonitorsMock();
    resolveMonitorsMock.mockClear();
    resolveMonitorsMock.mockResolvedValue({
      ...resolution, monitors: [{ ...resolution.monitors[0], overrides: badOverride }],
    });

    expect(await processScriptMonitorTick()).toMatchObject({ errors: 1, skippedNotDue: 0, dispatched: 0 });
    expect(resolveMonitorsMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('sees a newly shortened interval on the next sweep without retaining a not-due decision', async () => {
    let historyReads = 0;
    const responses = new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow()]],
      [configPolicyMonitors, [{ monitorId: MONITOR_ID, overrides: null }]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, () => ++historyReads <= 2
        ? [{ deviceId: DEVICE_ID, status: 'completed', createdAt: minutesAgo(10) }]
        : []],
      [scripts, [makeScriptRow()]],
    ]);
    setupDb(responses);
    expect(await processScriptMonitorTick()).toMatchObject({ skippedNotDue: 1, dispatched: 0 });
    expect(resolveMonitorsMock).not.toHaveBeenCalled();

    responses.set(configPolicyMonitors, [{ monitorId: MONITOR_ID, overrides: { intervalMinutes: 5 } }]);
    const resolution = await resolveMonitorsMock();
    resolveMonitorsMock.mockClear();
    resolveMonitorsMock.mockResolvedValue({
      ...resolution, monitors: [{ ...resolution.monitors[0], overrides: { intervalMinutes: 5 } }],
    });
    expect(await processScriptMonitorTick()).toMatchObject({ skippedNotDue: 0, dispatched: 1 });
    expect(resolveMonitorsMock).toHaveBeenCalledTimes(1);
  });

  it('reconsiders a not-yet-due candidate on the next bounded sweep', async () => {
    let historyReads = 0;
    setupDb(new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow({ id: 'first' }), makeDeviceRow({ id: 'almost-due' })]],
      [scriptExecutions, () => ++historyReads === 1
        ? [{ deviceId: 'almost-due', status: 'completed', createdAt: minutesAgo(59.5) }]
        : []],
      [scripts, [makeScriptRow()]],
    ]));
    dispatchMock.mockImplementation(async ({ device }) => {
      if (device.id === 'first') vi.setSystemTime(new Date(NOW.getTime() + 60_000));
      return { ok: true };
    });

    expect(await processScriptMonitorTick()).toMatchObject({ dispatched: 1, skippedNotDue: 1 });
    expect(resolveMonitorsMock).toHaveBeenCalledTimes(1);
    expect(historyReads).toBe(2); // One aggregate and one exact admission guard.
  });

  it('keeps monitor/device history separate across organizations in the same sweep', async () => {
    let candidateReads = 0;
    let historyReads = 0;
    const queries = setupDb(new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow(), makeMonitorRow({ id: 'monitor-2', orgId: 'org-2' })]],
      [configPolicyMonitors, [
        { monitorId: MONITOR_ID, overrides: null },
        { monitorId: 'monitor-2', overrides: null },
      ]],
      [devices, () => ++candidateReads === 1
        ? [makeDeviceRow()]
        : [makeDeviceRow({ id: 'device-2', orgId: 'org-2' })]],
      [scriptExecutions, () => ++historyReads === 1
        ? [{ deviceId: DEVICE_ID, status: 'pending', createdAt: NOW }]
        : []],
      [scripts, [makeScriptRow()]],
    ]));
    resolveMonitorsMock.mockResolvedValue({
      kind: 'resolved', monitors: [{ monitorId: 'monitor-2', enabled: true, overrides: null }],
    });

    expect(await processScriptMonitorTick()).toMatchObject({
      monitorsConsidered: 2, dispatched: 1, skippedNotDue: 1, errors: 0,
    });
    expect(resolveMonitorsMock).toHaveBeenCalledExactlyOnceWith('device-2');
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      monitorId: 'monitor-2', device: expect.objectContaining({ id: 'device-2', orgId: 'org-2' }),
    }));
    const predicates = queries.filter((query) => query.table === scriptExecutions)
      .map((query) => new PgDialect().sqlToQuery(query.where as Parameters<PgDialect['sqlToQuery']>[0]).params);
    expect(predicates[0]!.slice(0, 2)).toEqual([MONITOR_ID, DEVICE_ID]);
    expect(predicates[1]!.slice(0, 2)).toEqual(['monitor-2', 'device-2']);
  });

  it('still rejects a duplicate execution created after the bulk history read', async () => {
    let historyReads = 0;
    setupDb(new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, () => ++historyReads === 1
        ? []
        : [{ id: 'racing-run', deviceId: DEVICE_ID, status: 'pending', createdAt: NOW }]],
      [scripts, [makeScriptRow()]],
    ]));

    expect(await processScriptMonitorTick()).toMatchObject({ dispatched: 0, skipped: 1, skippedNotDue: 0 });
    expect(resolveMonitorsMock).toHaveBeenCalledExactlyOnceWith(DEVICE_ID);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(historyReads).toBe(2);
  });

  it.each(['attachments', 'history'])('reports a failed %s prefilter and performs full checks in a fresh transaction', async (failedRead) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let reads = 0;
    let failedTransaction: number | null = null;
    const responses = new Map<TableRef, QueryResponse>([
      [monitorDefinitions, [makeMonitorRow()]],
      [devices, [makeDeviceRow()]],
      [scriptExecutions, []],
      [scripts, [makeScriptRow()]],
    ]);
    responses.set(failedRead === 'attachments' ? configPolicyMonitors : scriptExecutions, () => {
      if (++reads === 1) {
        failedTransaction = txState.id;
        throw new Error('read failed');
      }
      return [];
    });
    setupDb(responses);
    const resolution = await resolveMonitorsMock();
    resolveMonitorsMock.mockClear();
    resolveMonitorsMock.mockImplementation(async () => {
      expect(txState.id).not.toBe(failedTransaction);
      expect(txState.events).toContainEqual({ id: failedTransaction, event: 'rollback' });
      return resolution;
    });

    expect(await processScriptMonitorTick()).toMatchObject({
      dispatched: 1, errors: 1, skippedNotDue: 0, skippedUnattached: 0,
    });
    expect(resolveMonitorsMock).toHaveBeenCalledTimes(1);
  });
});

function microSnapshot(overrides: Partial<CapacityGuardSnapshot> = {}): CapacityGuardSnapshot {
  return {
    enabled: true, state: 'paused', canRunBackgroundWork: false,
    observedAt: NOW.toISOString(), sampleAgeMs: 1000, healthyForMs: 0,
    reasons: ['recovering'], thresholds: readCapacityGuardConfig(),
    metrics: { cpuBusyPercent: 30, cpuStealPercent: 3, cpuIowaitPercent: 0,
      memoryUsedPercent: 50, eventLoopLagMs: 10, dependenciesReady: true },
    agentUpdates: {} as CapacityGuardSnapshot['agentUpdates'], ...overrides,
  };
}

describe('bounded script monitor admission', () => {
  it('allows current healthy observations while the heavy-work recovery latch is paused', () => {
    expect(canRunScriptMonitorProbe(microSnapshot())).toBe(true);
  });
  it.each([
    { state: 'stopped' }, { observedAt: null }, { sampleAgeMs: 21000 }, { sampleAgeMs: -1 },
    { metrics: { ...microSnapshot().metrics, cpuBusyPercent: 80 } },
    { metrics: { ...microSnapshot().metrics, cpuStealPercent: 6 } },
    { metrics: { ...microSnapshot().metrics, cpuStealPercent: null } },
    { metrics: { ...microSnapshot().metrics, memoryUsedPercent: null } },
    { metrics: { ...microSnapshot().metrics, eventLoopLagMs: 300 } },
    { metrics: { ...microSnapshot().metrics, dependenciesReady: false } },
  ] as Partial<CapacityGuardSnapshot>[])('rejects unhealthy or stale observations: %j', (overrides) => {
    expect(canRunScriptMonitorProbe(microSnapshot(overrides))).toBe(false);
  });
});

describe('durable pending response reservations', () => {
  const repair = '22222222-2222-4222-8222-222222222222';
  const monitor = makeMonitorRow({ responses: [{ type: 'run_script', scriptId: repair }] });
  const probe = { monitorId: MONITOR_ID, deviceId: DEVICE_ID, status: 'completed',
    exitCode: 0, stdout: '::breeze:monitor:: {"state":"breach"}', createdAt: minutesAgo(10) };
  const decision = { monitorId: MONITOR_ID, deviceId: DEVICE_ID, lastEvaluatedAt: minutesAgo(5),
    responsesPaused: false, episodeId: 'episode', responseOutcome: 'queued', responseDispatch: {}, responseRunStatus: 'running' };
  it('does not let a detached historical breach reserve capacity forever', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [] });
    expect((await applicablePendingMonitorResponseDevices([monitor], [probe], [])).size).toBe(0);
    expect(resolveMonitorsMock).toHaveBeenCalledWith(DEVICE_ID);
  });
  it('releases a reservation when the current inherited winner is disabled', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [{ monitorId: MONITOR_ID, enabled: false }] });
    expect((await applicablePendingMonitorResponseDevices([monitor], [probe], [], [decision])).size).toBe(0);
  });
  it('keeps an applicable queued response reserved across policy resolution', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [{ monitorId: MONITOR_ID, enabled: true }] });
    expect([...(await applicablePendingMonitorResponseDevices([monitor], [probe], [], [decision]))]).toEqual([DEVICE_ID]);
  });
  it('fails closed when reservation applicability cannot be read', async () => {
    resolveMonitorsMock.mockRejectedValue(new Error('policy read unavailable'));
    await expect(applicablePendingMonitorResponseDevices([monitor], [probe], [], [decision])).rejects.toThrow('policy read unavailable');
  });
  it('retains a ten-minute breach when its response is durably queued, without an execution yet', () => {
    expect(pendingMonitorResponseDevices([monitor], [probe], [], [decision]).size).toBe(1);
  });
  it.each([
    { responsesPaused: true }, { episodeId: null }, { responseOutcome: 'skipped_paused' },
    { responseOutcome: 'skipped_no_response' }, { responseOutcome: 'failed' },
    { responseOutcome: 'completed' }, { responseRunStatus: 'completed' },
  ])('releases an evaluated non-actionable response: %j', overrides => {
    expect(pendingMonitorResponseDevices([monitor], [probe], [], [{ ...decision, ...overrides }]).size).toBe(0);
  });
  it('reserves an evaluated legacy episode before createAlert publishes its response', () => {
    expect(pendingMonitorResponseDevices([monitor], [probe], [], [{ ...decision,
      responseOutcome: null, responseDispatch: null, responseRunStatus: null }]).size).toBe(1);
  });
  it('retains a newly persisted outbox before it acquires a queued outcome', () => {
    expect(pendingMonitorResponseDevices([monitor], [probe], [], [{ ...decision,
      responseOutcome: null, responseRunStatus: null }]).size).toBe(1);
  });
  it('retains a breach older than ten minutes while no response has been dispatched', () => {
    expect([...pendingMonitorResponseDevices([monitor], [probe], [])]).toEqual([DEVICE_ID]);
  });
  it('releases after a newer response execution exists; older repairs do not release', () => {
    expect(pendingMonitorResponseDevices([monitor], [probe], [
      { deviceId: DEVICE_ID, scriptId: repair, createdAt: minutesAgo(5) },
    ]).size).toBe(0);
    expect(pendingMonitorResponseDevices([monitor], [probe], [
      { deviceId: DEVICE_ID, scriptId: repair, createdAt: minutesAgo(20) },
    ]).size).toBe(1);
  });
  it('uses the final marker, respecting explicit OK even with a nonzero exit', () => {
    expect(pendingMonitorResponseDevices([monitor], [{ ...probe, exitCode: 1,
      stdout: probe.stdout + '\n::breeze:monitor:: {"state":"ok"}' }], []).size).toBe(0);
  });
  it('respects breachOnNonZeroExit and never reserves an unsuccessful probe without a verdict', () => {
    expect(pendingMonitorResponseDevices([{ ...monitor,
      condition: { ...monitor.condition, breachOnNonZeroExit: false } }],
      [{ ...probe, stdout: '', exitCode: 1 }], []).size).toBe(0);
    expect(pendingMonitorResponseDevices([monitor], [{ ...probe, status: 'failed' }], []).size).toBe(0);
  });
  it('only reserves the newest probe supplied by DISTINCT ON, not an older breach', () => {
    expect(pendingMonitorResponseDevices([monitor], [{ ...probe,
      stdout: '::breeze:monitor:: {"state":"ok"}', createdAt: minutesAgo(1) }], []).size).toBe(0);
  });
});
