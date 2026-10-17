import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../src/db';
import { auditLogs, deviceCommands } from '../src/db/schema';
import { finalizeScriptExecutionTerminal } from '../src/services/scriptExecutionTerminal';
import { terminalPayloadErasureSet } from '../src/services/sensitiveCommandPayload';

const REASON = 'Obsolete undelivered periodic monitor probe cancelled while device was offline';
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

export type BacklogOptions = { apply: boolean; batchSize: number; max: number; orgId?: string; deviceId?: string };
type Candidate = { commandId: string; executionId: string; deviceId: string; orgId: string; monitorId: string; batchId: string | null };

export function parseBacklogArgs(argv: string[]): BacklogOptions {
  const result: BacklogOptions = { apply: false, batchSize: 25, max: 500 };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i]!;
    if (seen.has(option)) throw new Error('Duplicate option');
    seen.add(option);
    if (option === '--apply') { result.apply = true; continue; }
    if (!['--batch-size', '--max', '--org', '--device'].includes(option)) throw new Error('Unknown option');
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing option value');
    if (option === '--org' || option === '--device') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid scope id');
      result[option === '--org' ? 'orgId' : 'deviceId'] = value;
    } else {
      const maximum = option === '--batch-size' ? 25 : 500;
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw new Error('Invalid count limit');
      result[option === '--batch-size' ? 'batchSize' : 'max'] = Number(value);
    }
  }
  return result;
}

/** The dry run and locked recheck share every safety predicate. No payload is
 * returned except the batch id needed by the shared terminal bookkeeping. */
export function backlogCandidateQuery(options: BacklogOptions, cutoff: Date, args: {
  after?: string; commandId?: string; limit: number; lock?: boolean;
}): SQL {
  return sql`
    SELECT dc.id AS "commandId", se.id AS "executionId", se.device_id AS "deviceId",
      se.org_id AS "orgId", se.monitor_id AS "monitorId", dc.payload->>'batchId' AS "batchId"
    FROM device_commands dc
    JOIN LATERAL (
      SELECT matched.* FROM script_executions matched
      WHERE matched.id = CASE
        WHEN dc.payload->>'executionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (dc.payload->>'executionId')::uuid ELSE NULL END
      ${args.lock ? sql`FOR UPDATE OF matched SKIP LOCKED` : sql``}
      OFFSET 0
    ) se ON dc.device_id = se.device_id
    JOIN devices d ON d.id = se.device_id AND d.org_id = se.org_id
    WHERE se.trigger_type = 'monitor' AND se.monitor_id IS NOT NULL
      AND se.status IN ('pending', 'queued') AND se.started_at IS NULL AND se.completed_at IS NULL
      AND se.automation_run_id IS NULL AND se.cancel_state IS NULL
      AND d.status <> 'online'
      AND dc.type = 'script' AND dc.status = 'pending'
      AND dc.executed_at IS NULL AND dc.completed_at IS NULL AND dc.created_at <= ${cutoff.toISOString()}::timestamptz
      AND (dc.submitted_org_id IS NULL OR dc.submitted_org_id = se.org_id)
      AND NOT EXISTS (
        SELECT 1 FROM device_commands other
        WHERE other.type = 'script' AND other.payload->>'executionId' = se.id::text AND other.id <> dc.id
      )
      ${options.orgId ? sql`AND se.org_id = ${options.orgId}::uuid` : sql``}
      ${options.deviceId ? sql`AND se.device_id = ${options.deviceId}::uuid` : sql``}
      ${args.after ? sql`AND dc.id > ${args.after}::uuid` : sql``}
      ${args.commandId ? sql`AND dc.id = ${args.commandId}::uuid` : sql``}
    ORDER BY dc.id LIMIT ${args.limit}
    ${args.lock ? sql`FOR UPDATE OF dc, d SKIP LOCKED` : sql``}
  `;
}

async function system<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    // Each read page / cancellation owns a fresh, bounded transaction. A busy
    // endpoint or batch is skipped/rolled back rather than blocking login.
    await db.execute(sql`SET LOCAL statement_timeout = '5s'`);
    await db.execute(sql`SET LOCAL lock_timeout = '500ms'`);
    return fn();
  }, 'operator.cancelOfflineMonitorBacklog'));
}

export async function cancelBacklogCandidate(options: BacklogOptions, cutoff: Date, commandId: string, invocationId: string): Promise<boolean> {
  if (!options.apply) throw new Error('Apply flag required for cancellation');
  return system(async () => {
    const [candidate] = await db.execute<Candidate>(backlogCandidateQuery(options, cutoff, { commandId, limit: 1, lock: true }));
    if (!candidate) return false;
    const completedAt = new Date();
    const changed = await db.update(deviceCommands).set({
      status: 'cancelled', completedAt,
      result: { status: 'cancelled', reason: REASON, cancelledBy: 'offline_monitor_backlog_recovery', invocationId },
      ...terminalPayloadErasureSet(),
    }).where(and(eq(deviceCommands.id, candidate.commandId), eq(deviceCommands.type, 'script'),
      eq(deviceCommands.status, 'pending'), isNull(deviceCommands.executedAt), isNull(deviceCommands.completedAt),
      sql`${deviceCommands.payload}->>'executionId' = ${candidate.executionId}`,
    )).returning({ id: deviceCommands.id });
    if (changed.length !== 1) throw new Error('Command changed during cancellation');

    // Locking the pending/queued execution above ensures the shared finalizer
    // cannot accidentally cancel a running execution. Its CAS advances batch
    // counters only once and preserves fix-outcome bookkeeping in this txn.
    const terminal = await finalizeScriptExecutionTerminal({
      executionId: candidate.executionId, batchId: candidate.batchId,
      outcome: 'cancelled', errorMessage: REASON, completedAt, neverDelivered: true, executor: db,
    });
    if (!terminal.terminalised) throw new Error('Execution changed during cancellation');
    await db.insert(auditLogs).values({
      orgId: candidate.orgId, actorType: 'system', actorId: SYSTEM_ACTOR,
      action: 'monitor.offline_backlog.cancelled', resourceType: 'script_execution', resourceId: candidate.executionId,
      initiatedBy: 'manual', result: 'success',
      details: { invocationId, commandId: candidate.commandId, deviceId: candidate.deviceId, monitorId: candidate.monitorId,
        reason: REASON, neverDelivered: true },
    });
    return true;
  });
}

export async function runBacklogRecovery(options: BacklogOptions) {
  const cutoff = new Date();
  const invocationId = randomUUID();
  let after: string | undefined;
  let inspected = 0;
  let cancelled = 0;
  let skipped = 0;
  let batches = 0;
  while (inspected < options.max) {
    const candidates = await system(() => db.execute<Candidate>(backlogCandidateQuery(options, cutoff, {
      after, limit: Math.min(options.batchSize, options.max - inspected),
    })));
    if (!candidates.length) break;
    batches++;
    for (const candidate of candidates) {
      inspected++;
      after = candidate.commandId;
      if (options.apply) {
        if (await cancelBacklogCandidate(options, cutoff, candidate.commandId, invocationId)) cancelled++;
        else skipped++;
      }
    }
    // No transaction is held while yielding to the live application's work.
    if (options.apply && inspected < options.max) await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { mode: options.apply ? 'apply' : 'dry-run', invocationId, cutoff: cutoff.toISOString(),
    inspected, cancelled, skipped, batches, capped: inspected === options.max,
    maximum: options.max, batchSize: options.batchSize };
}
