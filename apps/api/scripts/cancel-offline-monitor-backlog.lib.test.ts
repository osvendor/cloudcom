import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), update: vi.fn(), insert: vi.fn(), finalise: vi.fn(), system: vi.fn(), outside: vi.fn(),
}));
vi.mock('../src/db', () => ({
  db: { execute: mocks.execute, update: mocks.update, insert: mocks.insert },
  runOutsideDbContext: mocks.outside, withSystemDbAccessContext: mocks.system,
}));
vi.mock('../src/db/schema', async () => {
  const { pgTable, uuid, varchar, timestamp, jsonb } = await import('drizzle-orm/pg-core');
  return { auditLogs: 'audit_logs', deviceCommands: pgTable('device_commands', {
    id: uuid('id'), type: varchar('type'), status: varchar('status'), payload: jsonb('payload'),
    executedAt: timestamp('executed_at'), completedAt: timestamp('completed_at'),
  }) };
});
vi.mock('../src/services/scriptExecutionTerminal', () => ({ finalizeScriptExecutionTerminal: mocks.finalise }));
vi.mock('../src/services/sensitiveCommandPayload', () => ({ terminalPayloadErasureSet: () => ({}) }));

import { backlogCandidateQuery, cancelBacklogCandidate, parseBacklogArgs, runBacklogRecovery } from './cancel-offline-monitor-backlog.lib';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const COMMAND = '33333333-3333-4333-8333-333333333333';
const candidate = { commandId: COMMAND, executionId: '44444444-4444-4444-8444-444444444444',
  deviceId: DEVICE, orgId: ORG, monitorId: '55555555-5555-4555-8555-555555555555', batchId: null };
const dialect = new PgDialect();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.system.mockImplementation((fn: () => Promise<unknown>) => fn());
  mocks.outside.mockImplementation((fn: () => Promise<unknown>) => fn());
  mocks.execute.mockImplementation(async (query) => dialect.sqlToQuery(query).sql.includes('SELECT dc.id') ? [candidate] : []);
  mocks.update.mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{ id: COMMAND }]),
  }) }) });
  mocks.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  mocks.finalise.mockResolvedValue({ terminalised: true });
});

describe('offline monitor backlog operator safety', () => {
  it('defaults to dry run with hard work limits and accepts explicit UUID scopes', () => {
    expect(parseBacklogArgs([])).toEqual({ apply: false, batchSize: 25, max: 500 });
    expect(parseBacklogArgs(['--apply', '--batch-size', '1', '--max', '2', '--org', ORG, '--device', DEVICE]))
      .toEqual({ apply: true, batchSize: 1, max: 2, orgId: ORG, deviceId: DEVICE });
  });

  it.each([
    ['--batch-size', '26'], ['--max', '501'], ['--max', '0'], ['--max', '-1'], ['--max', '1.5'],
    ['--max'], ['--apply', '--apply'], ['--org', 'any'], ['--device', "'; DROP TABLE devices"], ['--force'],
  ])('rejects invalid option sequence %j', (...args) => {
    expect(() => parseBacklogArgs(args)).toThrow();
  });

  it('uses exact execution linkage and refuses delivered, started, ambiguous or nonmonitor records', () => {
    const options = parseBacklogArgs(['--org', ORG, '--device', DEVICE]);
    const query = dialect.sqlToQuery(backlogCandidateQuery(options, new Date(), { commandId: COMMAND, limit: 1, lock: true }));
    expect(query.sql).toContain("se.trigger_type = 'monitor' AND se.monitor_id IS NOT NULL");
    expect(query.sql).toContain("se.status IN ('pending', 'queued')");
    expect(query.sql).toContain('se.started_at IS NULL');
    expect(query.sql).toContain('se.automation_run_id IS NULL AND se.cancel_state IS NULL');
    expect(query.sql).toContain("d.status <> 'online'");
    expect(query.sql).toContain("dc.type = 'script' AND dc.status = 'pending'");
    expect(query.sql).toContain('dc.executed_at IS NULL AND dc.completed_at IS NULL');
    expect(query.sql).toContain('matched.id = CASE');
    expect(query.sql).toContain("THEN (dc.payload->>'executionId')::uuid ELSE NULL END");
    expect(query.sql).toContain("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    expect(query.sql).toContain("other.payload->>'executionId' = se.id::text AND other.id <> dc.id");
    expect(query.sql).toContain('FOR UPDATE OF matched SKIP LOCKED');
    expect(query.sql).toContain('FOR UPDATE OF dc, d SKIP LOCKED');
    expect(query.params).toEqual(expect.arrayContaining([ORG, DEVICE, COMMAND]));
    expect(query.sql).not.toContain(ORG);
  });

  it('dry run remains mutation-free and bounded', async () => {
    const report = await runBacklogRecovery(parseBacklogArgs(['--max', '1']));
    expect(report).toMatchObject({ mode: 'dry-run', inspected: 1, cancelled: 0, capped: true });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.finalise).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('encodes the cutoff as a driver-safe timestamp rather than a raw Date parameter', () => {
    const cutoff = new Date('2026-10-14T22:00:00.000Z');
    const query = dialect.sqlToQuery(backlogCandidateQuery(parseBacklogArgs([]), cutoff, { limit: 25 }));
    expect(query.params).toContain(cutoff.toISOString());
    expect(query.params.some(value => value instanceof Date)).toBe(false);
    expect(query.sql).toContain('::timestamptz');
  });

  it('refuses to invoke cancellation without explicit apply', async () => {
    await expect(cancelBacklogCandidate(parseBacklogArgs([]), new Date(), COMMAND, 'invocation')).rejects.toThrow('Apply flag');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('skips a changed or locked candidate without altering the execution', async () => {
    mocks.execute.mockResolvedValue([]);
    expect(await cancelBacklogCandidate(parseBacklogArgs(['--apply']), new Date(), COMMAND, 'invocation')).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.finalise).not.toHaveBeenCalled();
  });

  it('terminalizes once with never-delivered bookkeeping and records audit inside the same system context', async () => {
    const report = await runBacklogRecovery(parseBacklogArgs(['--apply', '--max', '1']));
    expect(report).toMatchObject({ inspected: 1, cancelled: 1, skipped: 0 });
    expect(mocks.finalise).toHaveBeenCalledWith(expect.objectContaining({
      executionId: candidate.executionId, outcome: 'cancelled', neverDelivered: true, batchId: null,
    }));
    expect(mocks.insert).toHaveBeenCalledWith('audit_logs');
    expect(mocks.system).toHaveBeenCalledTimes(2); // discovery, then one atomic cancellation
    expect(mocks.outside).toHaveBeenCalledTimes(2);
  });

  it('fails the transaction if the command CAS loses, without finalizing or auditing', async () => {
    mocks.update.mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [] }) }) });
    await expect(cancelBacklogCandidate(parseBacklogArgs(['--apply']), new Date(), COMMAND, 'invocation')).rejects.toThrow('Command changed');
    expect(mocks.finalise).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('fails the transaction if the execution does not transition, preventing a partial command cancellation', async () => {
    mocks.finalise.mockResolvedValue({ terminalised: false });
    await expect(cancelBacklogCandidate(parseBacklogArgs(['--apply']), new Date(), COMMAND, 'invocation')).rejects.toThrow('Execution changed');
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
