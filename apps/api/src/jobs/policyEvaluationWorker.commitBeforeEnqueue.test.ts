import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7347 — policy-evaluation remediation must not enqueue `execute-run` before
 * the transaction that created the automation_runs row has committed.
 *
 * `evaluate-policy` and `scan-config-policy-compliance` each evaluate inside
 * one system transaction, and a non-compliant device's remediation run row is
 * INSERTed there. The execute-run worker loads the run on its own connection,
 * so an enqueue made inside that transaction lets it find no run and throw
 * `Automation run not found`; a rollback leaves a job for a run that never
 * existed. Same class as #7187 (automation trigger handlers).
 *
 * Proven here through the real BullMQ processor: evaluation runs with the
 * transaction open and `deferEnqueue` set, the returned `afterCommit` runs with
 * no transaction open, and a transaction that fails to commit enqueues nothing.
 */

const txState = vi.hoisted(() => ({ depth: 0, open: 0, failNextCommit: false }));
const capacity = vi.hoisted(() => ({ available: true }));
vi.mock('../services/capacityGuard', () => ({ canRunBackgroundWork: () => capacity.available }));

const { selectMock, evaluatePolicyMock, scanConfigMock, afterCommitMock, captured, events } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  evaluatePolicyMock: vi.fn(),
  scanConfigMock: vi.fn(),
  afterCommitMock: vi.fn(),
  captured: { options: {} as { concurrency?: number }, processor: null as null | ((job: unknown, token?: string) => Promise<unknown>) },
  events: [] as Array<{ event: string; depth: number; open: number }>,
}));

vi.mock('bullmq', () => ({
  DelayedError: class DelayedError extends Error {},
  Queue: class {
    addBulk = vi.fn(async () => { events.push({ event: 'bulk_enqueue', depth: txState.depth, open: txState.open }); });
    close = vi.fn();
  },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>, options: { concurrency?: number }) {
      captured.processor = processor;
      captured.options = options;
    }
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const opensTransaction = txState.depth === 0;
    txState.depth += 1;
    if (opensTransaction) txState.open += 1;
    try {
      const result = await fn();
      if (opensTransaction && txState.failNextCommit) {
        txState.failNextCommit = false;
        throw new Error('commit failed');
      }
      return result;
    } finally {
      txState.depth -= 1;
      if (opensTransaction) txState.open -= 1;
    }
  }),
}));

vi.mock('../db/schema', () => ({ automationPolicies: { id: 'id', enabled: 'enabled' } }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/policyEvaluationService', () => ({
  evaluatePolicy: evaluatePolicyMock,
  scanAndEvaluateConfigPolicyCompliance: scanConfigMock,
}));

import { DelayedError } from 'bullmq';
import { createPolicyEvaluationWorker } from './policyEvaluationWorker';

const POLICY = { id: 'policy-1', enabled: true };

function mockPolicyRow(rows: unknown[]) {
  selectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  capacity.available = true;
  selectMock.mockReset();
  txState.depth = 0;
  txState.open = 0;
  txState.failNextCommit = false;
  events.length = 0;
  afterCommitMock.mockImplementation(async () => {
    events.push({ event: 'enqueue', depth: txState.depth, open: txState.open });
  });
  evaluatePolicyMock.mockImplementation(async () => {
    events.push({ event: 'run_created', depth: txState.depth, open: txState.open });
    return {
      message: 'Policy evaluation completed',
      policyId: POLICY.id,
      devicesEvaluated: 1,
      results: [],
      summary: { compliant: 0, non_compliant: 1 },
      evaluatedAt: '2026-09-28T00:00:00.000Z',
      afterCommit: afterCommitMock,
    };
  });
  scanConfigMock.mockImplementation(async () => {
    events.push({ event: 'run_created', depth: txState.depth, open: txState.open });
    return { rulesScanned: 1, devicesEvaluated: 1, results: [], afterCommit: afterCommitMock };
  });
  createPolicyEvaluationWorker();
});

const EVALUATE_JOB = { data: { type: 'evaluate-policy', policyId: POLICY.id } };
const CONFIG_SCAN_JOB = { data: { type: 'scan-config-policy-compliance' } };

describe('policy evaluation enqueues remediation runs only after they commit (#7347)', () => {
  it('evaluate-policy: evaluates deferred inside the transaction, enqueues after it commits', async () => {
    mockPolicyRow([POLICY]);

    const result = await captured.processor!(EVALUATE_JOB);

    expect(result).toEqual({ policyId: POLICY.id, devicesEvaluated: 1, compliant: 0, nonCompliant: 1 });
    expect(evaluatePolicyMock).toHaveBeenCalledWith(POLICY, expect.objectContaining({ deferEnqueue: true }));
    const created = events.find((e) => e.event === 'run_created');
    const enqueued = events.find((e) => e.event === 'enqueue');
    expect(created).toMatchObject({ open: 1 });
    expect(enqueued).toMatchObject({ depth: 0, open: 0 });
    expect(events.indexOf(enqueued!)).toBeGreaterThan(events.indexOf(created!));
  });

  it('scan-config-policy-compliance: evaluates deferred inside the transaction, enqueues after it commits', async () => {
    const result = await captured.processor!(CONFIG_SCAN_JOB);

    expect(result).toEqual({ rulesScanned: 1, devicesEvaluated: 1 });
    expect(scanConfigMock).toHaveBeenCalledWith(expect.objectContaining({ deferEnqueue: true }));
    const created = events.find((e) => e.event === 'run_created');
    const enqueued = events.find((e) => e.event === 'enqueue');
    expect(created).toMatchObject({ open: 1 });
    expect(enqueued).toMatchObject({ depth: 0, open: 0 });
  });

  it.each([
    ['evaluate-policy', EVALUATE_JOB],
    ['scan-config-policy-compliance', CONFIG_SCAN_JOB],
  ])('%s: a transaction that rolls back enqueues nothing', async (name, queueJob) => {
    if (name === 'evaluate-policy') mockPolicyRow([POLICY]);
    txState.failNextCommit = true;

    await expect(captured.processor!(queueJob)).rejects.toThrow('commit failed');

    expect(afterCommitMock).not.toHaveBeenCalled();
  });

  it('config scan: a missing-table error is still swallowed as before', async () => {
    scanConfigMock.mockRejectedValueOnce(Object.assign(new Error('relation missing'), { cause: { code: '42P01' } }));

    await expect(captured.processor!(CONFIG_SCAN_JOB)).resolves.toEqual({ rulesScanned: 0, devicesEvaluated: 0 });
    expect(afterCommitMock).not.toHaveBeenCalled();
  });
});

describe('policy evaluation capacity admission', () => {
  it.each(['scan-due-policies', 'evaluate-policy', 'scan-config-policy-compliance', 'reconcile-compliance-alerts'])(
    'retains explicit %s work with its lock token before database access', async (type) => {
      capacity.available = false;
      const moveToDelayed = vi.fn().mockResolvedValue(undefined);
      const before = Date.now();
      await expect(captured.processor!({ data: { type, policyId: POLICY.id }, moveToDelayed }, 'lock-token'))
        .rejects.toBeInstanceOf(DelayedError);
      expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'lock-token');
      expect(moveToDelayed.mock.calls[0]![0]).toBeGreaterThanOrEqual(before + 60_000);
      expect(selectMock).not.toHaveBeenCalled();
      expect(scanConfigMock).not.toHaveBeenCalled();
      expect(evaluatePolicyMock).not.toHaveBeenCalled();
      expect(txState.open).toBe(0);
    },
  );

  it('skips only the missed recurring scan tick, without retaining a catch-up backlog', async () => {
    capacity.available = false;
    const moveToDelayed = vi.fn();
    await expect(captured.processor!({ ...CONFIG_SCAN_JOB, opts: { repeat: { every: 60_000 } }, moveToDelayed }, 'lock'))
      .resolves.toEqual({ deferredForCapacity: true });
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(scanConfigMock).not.toHaveBeenCalled();
    capacity.available = true;
    await expect(captured.processor!(CONFIG_SCAN_JOB)).resolves.toEqual({ rulesScanned: 1, devicesEvaluated: 1 });
  });

  it('propagates a failed delay instead of claiming the work was safely deferred', async () => {
    capacity.available = false;
    const error = Error('Redis unavailable');
    await expect(captured.processor!({ ...EVALUATE_JOB, moveToDelayed: vi.fn().mockRejectedValue(error) }, 'lock'))
      .rejects.toBe(error);
    expect(evaluatePolicyMock).not.toHaveBeenCalled();
  });

  it('allows already-admitted work to commit and enqueue after capacity drops', async () => {
    mockPolicyRow([POLICY]);
    evaluatePolicyMock.mockImplementationOnce(async () => {
      capacity.available = false;
      return { devicesEvaluated: 1, summary: { compliant: 0, non_compliant: 1 }, afterCommit: afterCommitMock };
    });
    await expect(captured.processor!(EVALUATE_JOB)).resolves.toMatchObject({ devicesEvaluated: 1 });
    expect(afterCommitMock).toHaveBeenCalledOnce();
    expect(events.find(e => e.event === 'enqueue')).toMatchObject({ open: 0 });
  });

  it('releases the policy scan transaction before enqueuing to Redis', async () => {
    selectMock.mockReturnValueOnce({ from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(async () => {
        expect(txState.open).toBe(1);
        return [{ ...POLICY, lastEvaluatedAt: null }];
      }),
    }) });
    await expect(captured.processor!({ data: { type: 'scan-due-policies' } })).resolves.toEqual({ queued: 1 });
    expect(events.find(e => e.event === 'bulk_enqueue')).toMatchObject({ open: 0, depth: 0 });
  });
});
it('limits simultaneous policy evaluations to one', () => {
  expect(captured.options.concurrency).toBe(1);
});

it('aggregates workload counters without device identities or per-job logging', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const date = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
  try {
    capacity.available = false;
    await captured.processor!({ ...CONFIG_SCAN_JOB, opts: { repeat: { every: 60_000 } } });
    const record = info.mock.calls.find(call => call[0] === '[PolicyEvaluationWorker] Workload');
    expect(record).toBeDefined();
    expect(record![1]).toMatchObject({ jobs: {
      'scan-config-policy-compliance': { deferred: expect.any(Number), elapsedMs: expect.any(Number) },
    } });
    expect(JSON.stringify(record)).not.toContain(POLICY.id);
    info.mockClear();
    await captured.processor!({ ...CONFIG_SCAN_JOB, opts: { repeat: { every: 60_000 } } });
    expect(info).not.toHaveBeenCalled();
  } finally { info.mockRestore(); date.mockRestore(); }
});
it('retains a scoped reconcile even if repeat metadata is present', async () => {
  capacity.available = false;
  const moveToDelayed = vi.fn().mockResolvedValue(undefined);
  await expect(captured.processor!({
    data: { type: 'reconcile-compliance-alerts', orgId: 'org-1' },
    opts: { repeat: { every: 60_000 } }, moveToDelayed,
  }, 'lock')).rejects.toBeInstanceOf(DelayedError);
  expect(moveToDelayed).toHaveBeenCalledOnce();
});

it('does not start explicit work or claim a safe deferral without a lock token', async () => {
  capacity.available = false;
  const moveToDelayed = vi.fn();
  await expect(captured.processor!({ ...EVALUATE_JOB, moveToDelayed })).rejects.toThrow('worker lock token');
  expect(moveToDelayed).not.toHaveBeenCalled();
  expect(selectMock).not.toHaveBeenCalled();
});