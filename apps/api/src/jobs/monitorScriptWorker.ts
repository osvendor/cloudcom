/**
 * Script Monitor Worker (#5291 W04)
 *
 * DESIGN — this is the DISPATCH half of the `script` monitor kind; the
 * BREACH/VERDICT half is `alertConditions/handlers/scriptMonitor.ts`. Unlike
 * every other monitor kind (evaluated against data the agent already
 * reports, or an agent-delivered watch), a `script` monitor's evidence does
 * not exist until something runs the probe script — this worker is that
 * "something". It never decides breach/no-breach itself; it only keeps
 * `script_executions` freshly populated for the handler to read. The two
 * halves are deliberately decoupled through that table, not a shared
 * in-memory object, so neither has to assume anything about the other's
 * schedule.
 *
 * DEVICE RESOLUTION is DEVICE-first only, via `resolveMonitorsForDevice`.
 * `alertService.getApplicableRules` faces the identical "which devices does
 * this compiled monitor rule apply to" problem for EVALUATION and solves it
 * the same way: enumerate candidate devices, then ask the resolver whether
 * this monitor is the winner for each one. There is no monitor-first
 * ("which devices does monitor X apply to") index anywhere in this
 * codebase; building one here would be a SECOND resolution algorithm that
 * could drift from the resolver's winner-per-monitor / override semantics
 * (config-policy attachment, closest-wins-per-monitor, parent inheritance).
 *
 * ADMISSION PREFILTER: a fresh attachment inventory can prove that a monitor
 * is unattached, or establish the shortest possible cadence across ALL its
 * attachments. Bulk execution history then skips candidates that cannot be
 * due at that cadence. Every remaining candidate still gets the full device
 * resolver and exact effective due check; the prefilter never grants a run.
 *
 * OVERRIDES: a config-policy attachment can override `intervalMinutes` /
 * `timeoutSeconds` per device (scriptKind.overridableKeys) — see
 * `alertService.ts`'s own `applyOverrides(spec, base, effective.overrides)`
 * call on the EVALUATION side. This worker mirrors that on the DISPATCH
 * side: using the monitor's raw, un-overridden `intervalMinutes` here would
 * desync the two — a device overridden to a SHORTER interval would still
 * only get re-probed on the monitor's baseline cadence, so the handler's
 * staleness window (3x the EFFECTIVE interval) would go stale well before
 * this worker ever dispatches again.
 *
 * REGISTRATION: `initializeMonitorScriptWorker` / `shutdownMonitorScriptWorker`
 * below are wired into `services/workerRegistry.ts` (which decides which
 * process role actually starts a worker) and `jobs/workerReadinessManifest.ts`
 * (which CI asserts covers every `attachWorkerObservability` name). Both edits
 * have to land in the SAME change as the `Worker` itself or
 * workerReadinessCoverage.test.ts / workerReadinessManifest.test.ts fail.
 */
import { Queue, Worker } from 'bullmq';
import { and, eq, gt, inArray, or } from 'drizzle-orm';
import * as dbModule from '../db';
import { configPolicyMonitors, devices, monitorDefinitions, organizations, scriptExecutions, scripts } from '../db/schema';
import { dispatchScriptToDevice } from '../services/scriptDispatch';
import { resolveMonitorsForDevice } from '../services/monitors/monitorResolver';
import { applyOverrides } from '../services/monitors/kinds';
import { scriptKind } from '../services/monitors/kinds/script';
import { getBullMQConnection } from '../services/redis';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { assertQueueJobName } from '../services/bullmqValidation';
import { excludeEphemeralDevices, excludeQuickSupportOrgs } from '../services/quickSupportOrg';
import { withQueueMeta, type QueueActorMeta } from './queueSchemas';
import { attachWorkerObservability } from './workerObservability';
import { captureException } from '../services/sentry';
import { canRunBackgroundWork } from '../services/capacityGuard';
import { notHoldingOrgCondition, notParkedDeviceCondition } from '../services/unassignedPool/selectorPredicate';

const { db } = dbModule;
// Same pattern as monitorWorker.ts: a background worker legitimately reads
// under system scope (never the request-path escalation CLAUDE.md forbids).
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

// Mirrors monitorWorker.ts's PARTNER_FANOUT_ORG_LIMIT: one misconfigured
// partner-wide script monitor must not be able to flood a single tick with
// thousands of per-device dispatch attempts.
const PARTNER_FANOUT_ORG_LIMIT = 500;

export interface ScriptMonitorTickResult {
  deferredForCapacity?: true;
  monitorsConsidered: number;
  devicesConsidered: number;
  dispatched: number;
  /** Not due yet, disabled for this device, or dispatchScriptToDevice's own skip (offline/maintenance/decommissioned/etc). */
  skipped: number;
  /** Online candidates skipped using this sweep's complete attachment inventory. */
  skippedUnattached: number;
  /** Online candidates blocked even at the shortest possible effective interval. */
  skippedNotDue: number;
  errors: number;
}

type CandidateDevice = Pick<
  typeof devices.$inferSelect,
  'id' | 'orgId' | 'osType' | 'status' | 'agentId' | 'hostname' | 'siteId' | 'customFields'
>;

type ScriptCondition = ReturnType<(typeof scriptKind)['conditionSchema']['parse']>;
type AttachmentOverrides = typeof configPolicyMonitors.$inferSelect.overrides;

/** A lower bound only: even disabled/unassigned attachments must participate. */
function minimumPossibleInterval(
  authoredCondition: ScriptCondition,
  attachmentOverrides: AttachmentOverrides[],
): number | null {
  let minimum = authoredCondition.intervalMinutes;
  for (const overrides of attachmentOverrides) {
    if (overrides !== null && (
      typeof overrides !== 'object'
      || Array.isArray(overrides)
      || Object.keys(overrides).some((key) => !scriptKind.overridableKeys.some((allowed) => allowed === key))
    )) return null;
    try {
      // Validate the whole merged condition, including timeout. An invalid
      // attachment must reach normal resolution/error reporting, not be hidden
      // behind a cached not-due decision.
      minimum = Math.min(minimum, applyOverrides(scriptKind, authoredCondition, overrides).intervalMinutes);
    } catch {
      return null;
    }
  }
  return minimum;
}

type ProbeHistory = Map<string, { active: boolean; latestCreatedAt: number }>;
const ACTIVE_PROBE_STATUSES = ['pending', 'queued', 'running', 'cancelling'] as const;

async function readBlockingProbeHistory(
  monitorId: string,
  onlineDeviceIds: string[],
  minimumInterval: number,
): Promise<ProbeHistory> {
  const rows = await db.select({
    deviceId: scriptExecutions.deviceId,
    status: scriptExecutions.status,
    createdAt: scriptExecutions.createdAt,
  }).from(scriptExecutions).where(and(
    eq(scriptExecutions.monitorId, monitorId),
    inArray(scriptExecutions.deviceId, onlineDeviceIds),
    or(
      inArray(scriptExecutions.status, [...ACTIVE_PROBE_STATUSES]),
      gt(scriptExecutions.createdAt, new Date(Date.now() - minimumInterval * 60_000)),
    ),
  ));
  const history: ProbeHistory = new Map();
  for (const row of rows) {
    const previous = history.get(row.deviceId);
    history.set(row.deviceId, {
      active: previous?.active === true || ACTIVE_PROBE_STATUSES.some((status) => status === row.status),
      latestCreatedAt: Math.max(previous?.latestCreatedAt ?? -Infinity, row.createdAt.getTime()),
    });
  }
  return history;
}

/**
 * The orgs a `script` monitor row must be evaluated against: itself, for an
 * org-owned row; every org under its partner, for a partner-wide row (Partner
 * Wide First — CLAUDE.md). Mirrors `monitorWorker.ts`'s identical fan-out for
 * partner-wide network monitors, including the same safety cap.
 */
async function resolveCandidateOrgIds(monitor: {
  id: string;
  orgId: string | null;
  partnerId: string | null;
}): Promise<string[]> {
  if (monitor.orgId) return [monitor.orgId];
  if (!monitor.partnerId) {
    // monitor_definitions_one_owner_chk is supposed to make this unreachable.
    // "Should never happen" is exactly the category this wave stopped trusting
    // silently: unlogged, the monitor would drop out of every tick forever.
    console.warn(
      `[monitorScriptWorker] Monitor ${monitor.id} has neither org nor partner owner; skipping`,
    );
    return [];
  }

  // Exclude the hidden per-partner 'quick_support' org: its devices are a
  // stranger's own machine mid support-session, not fleet the partner's
  // library of monitor probes is authored against. Mirrors
  // automationWorker.ts's/featureConfigResolver.ts's identical partner-wide
  // fan-out exclusion.
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.partnerId, monitor.partnerId), excludeQuickSupportOrgs(), notHoldingOrgCondition()));

  if (rows.length > PARTNER_FANOUT_ORG_LIMIT) {
    console.error(
      `[monitorScriptWorker] Partner-wide monitor ${monitor.id} fans out to ${rows.length} orgs (> ${PARTNER_FANOUT_ORG_LIMIT}); skipping`,
    );
    return [];
  }
  return rows.map((r) => r.id);
}

/**
 * A probe is due only when no active execution exists and the cadence has
 * elapsed. Active runs block another probe regardless of age, including an
 * older run behind a newer terminal execution. Throttle terminal runs on
 * `createdAt` (when dispatch was initiated), not `completedAt`. This is a separate question
 * from the scriptMonitor condition handler's own staleness check (which
 * reads `completedAt` and asks "is the newest VERDICT too old"); throttling
 * dispatch and judging staleness are different concerns read off different
 * columns of the same table on purpose.
 */
async function isDeviceDueForProbe(
  monitorId: string,
  deviceId: string,
  intervalMinutes: number,
): Promise<boolean> {
  const [blockingExecution] = await db
    .select({ id: scriptExecutions.id })
    .from(scriptExecutions)
    .where(and(
      eq(scriptExecutions.monitorId, monitorId),
      eq(scriptExecutions.deviceId, deviceId),
      or(
        inArray(scriptExecutions.status, [...ACTIVE_PROBE_STATUSES]),
        gt(scriptExecutions.createdAt, new Date(Date.now() - intervalMinutes * 60_000)),
      ),
    ))
    .limit(1);

  return !blockingExecution;
}

/**
 * One tick: dispatch the `script` monitor's probe to every device it
 * currently applies to and is due on. Exported bare (no BullMQ) so it is
 * fully testable — see the REGISTRATION NOTE above for why this file stops
 * short of wiring a `Worker` around it.
 */
export async function processScriptMonitorTick(): Promise<ScriptMonitorTickResult> {
  // This worker owns its transaction boundaries. An inherited context would
  // make withSystemDbAccessContext reuse one transaction across the sweep.
  return dbModule.runOutsideDbContext(async () => {
    const result: ScriptMonitorTickResult = {
      monitorsConsidered: 0,
      devicesConsidered: 0,
      dispatched: 0,
      skipped: 0,
      skippedUnattached: 0,
      skippedNotDue: 0,
      errors: 0,
    };

    // Nothing becomes complete/not-due when capacity defers this tick.
    if (!canRunBackgroundWork()) return { ...result, deferredForCapacity: true };
    const monitorRows = await runWithSystemDbAccess(() => db
      .select()
      .from(monitorDefinitions)
      .where(and(eq(monitorDefinitions.kind, 'script'), eq(monitorDefinitions.enabled, true))));

    // No assignment/status filtering: inherited or disabled attachments can
    // lower the bound too. This inventory is discarded at the end of the tick,
    // so a newly attached/shortened monitor is observed on the next sweep.
    let attachments: Map<string, AttachmentOverrides[]> | null = null;
    if (monitorRows.length > 0) {
      try {
        const rows = await runWithSystemDbAccess(() => db.select({
          monitorId: configPolicyMonitors.monitorId,
          overrides: configPolicyMonitors.overrides,
        }).from(configPolicyMonitors).where(inArray(configPolicyMonitors.monitorId, monitorRows.map((monitor) => monitor.id))));
        attachments = new Map();
        for (const row of rows) {
          const overrides = attachments.get(row.monitorId) ?? [];
          overrides.push(row.overrides);
          attachments.set(row.monitorId, overrides);
        }
      } catch (err) {
        // A failed inventory is NOT proof of absence. Its transaction has
        // ended; retain normal per-device resolution in fresh transactions.
        attachments = null;
        result.errors++;
        console.error('[monitorScriptWorker] attachment prefilter failed; using full admission checks', err);
        captureException(err);
      }
    }

    for (const monitor of monitorRows) {
      if (!canRunBackgroundWork()) return { ...result, deferredForCapacity: true };
      result.monitorsConsidered++;

      let authoredCondition: ScriptCondition;
      try {
        authoredCondition = scriptKind.conditionSchema.parse(monitor.condition);
      } catch (err) {
        console.error('[monitorScriptWorker] invalid script monitor condition', {
          monitorId: monitor.id,
          error: err,
        });
        result.errors++;
        continue;
      }

      const orgIds = await runWithSystemDbAccess(() => resolveCandidateOrgIds(monitor));
      if (orgIds.length === 0) {
        // Either an ownerless row or a fan-out over the cap — both are logged
        // above, and both are operational problems rather than "nothing to do",
        // so the tick result must not report them as a clean zero.
        result.errors++;
        continue;
      }

      const deviceRows: CandidateDevice[] = await runWithSystemDbAccess(() => db
        .select({
          id: devices.id,
          orgId: devices.orgId,
          osType: devices.osType,
          status: devices.status,
          agentId: devices.agentId,
          hostname: devices.hostname,
          siteId: devices.siteId,
          customFields: devices.customFields,
        })
        .from(devices)
        // Defense in depth alongside the quick_support org exclusion above:
        // an ephemeral (Quick Support session) device must never be a
        // candidate for an unattended monitor probe, same exclusion
        // automationWorker.ts/featureConfigResolver.ts apply.
        .where(and(inArray(devices.orgId, orgIds), excludeEphemeralDevices(), notParkedDeviceCondition())));

      const monitorAttachments = attachments?.get(monitor.id) ?? [];
      const unattached = attachments !== null && monitorAttachments.length === 0;
      const minimumInterval = attachments !== null && !unattached
        ? minimumPossibleInterval(authoredCondition, monitorAttachments)
        : null;
      let history: ProbeHistory | null = null;
      const onlineDeviceIds = deviceRows.filter((device) => device.status === 'online').map((device) => device.id);
      if (minimumInterval !== null && onlineDeviceIds.length > 0) {
        try {
          history = await runWithSystemDbAccess(() => readBlockingProbeHistory(monitor.id, onlineDeviceIds, minimumInterval));
        } catch (err) {
          result.errors++;
          console.error('[monitorScriptWorker] execution prefilter failed; using full admission checks', err);
          captureException(err);
        }
      }

      for (const device of deviceRows) {
        // Prior probes have committed/delivered. Never wait with a transaction held.
        if (!canRunBackgroundWork()) return { ...result, deferredForCapacity: true };
        result.devicesConsidered++;

        // Periodic probes describe current health, so missed offline checks
        // must not accumulate for replay. Skip before expensive resolution;
        // the dispatcher's reject policy rechecks liveness before writing.
        if (device.status !== 'online') {
          result.skipped++;
          continue;
        }

        if (unattached) {
          result.skipped++;
          result.skippedUnattached++;
          continue;
        }
        const prior = history?.get(device.id);
        // Re-evaluate recency now rather than freezing it when the bulk query
        // ran: earlier admissions can take long enough for this device to be
        // due. A completed old active run is reconsidered next tick.
        if (prior && minimumInterval !== null && (
          prior.active || prior.latestCreatedAt > Date.now() - minimumInterval * 60_000
        )) {
          result.skipped++;
          result.skippedNotDue++;
          continue;
        }

        let dispatchResult: Awaited<ReturnType<typeof dispatchScriptToDevice>> | null;
        try {
          // One admission per transaction: policy reads, the due guard, and
          // script_executions + device_commands writes commit together. Child
          // row inserts take device FK locks; they must be released before the
          // next device's policy/maintenance resolution, not at sweep end.
          dispatchResult = await runWithSystemDbAccess(async () => {
            // Winner-per-monitor resolution (device-first, see header). A
            // disabled-for-this-device winner (an explicit override lower in
            // the hierarchy) contributes no dispatch, same as it contributes no
            // alert rule on the evaluation side. A device that vanished between
            // the query above and here (raced a delete) resolves as
            // `device_missing`, not a fabricated "zero monitors" — same
            // no-dispatch outcome for this tick either way (#5677).
            const resolution = await resolveMonitorsForDevice(device.id);
            const match =
              resolution.kind === 'resolved'
                ? resolution.monitors.find((m) => m.monitorId === monitor.id)
                : undefined;
            if (!match || !match.enabled) {
              return null;
            }

            const effectiveCondition = applyOverrides(scriptKind, authoredCondition, match.overrides);

            const due = await isDeviceDueForProbe(monitor.id, device.id, effectiveCondition.intervalMinutes);
            if (!due) {
              return null;
            }

            const [scriptRow] = await db.select().from(scripts).where(eq(scripts.id, effectiveCondition.scriptId)).limit(1);
            if (!scriptRow) {
              throw new Error(`Monitor ${monitor.id} references missing script ${effectiveCondition.scriptId}`);
            }

            // Keep manual scripts' default offline queueing unchanged. Monitors
            // explicitly reject offline targets, including one that went offline
            // since the candidate read. Maintenance/decommissioning gates remain
            // in the shared dispatcher; a refusal is an ordinary skipped probe.
            return dispatchScriptToDevice({
              device,
              offlinePolicy: { kind: 'reject' },
              source: { kind: 'saved', script: scriptRow },
              parameters: effectiveCondition.parameters,
              triggerType: 'monitor',
              monitorId: monitor.id,
              timeoutSeconds: effectiveCondition.timeoutSeconds,
              deferDelivery: true,
            });
          });
        } catch (err) {
          // This device's admission rolled back. Earlier devices have already
          // committed and must not lose their probes because a later one fails.
          result.errors++;
          console.error('[monitorScriptWorker] probe admission failed', {
            monitorId: monitor.id,
            deviceId: device.id,
            error: err,
          });
          captureException(err, undefined, { monitorId: monitor.id, deviceId: device.id });
          continue;
        }

        if (dispatchResult?.ok) {
          result.dispatched++;
          if (dispatchResult.deliver) {
            // #3445: only send after BOTH probe rows committed. A fast agent
            // can now report against visible rows. Deliver before considering
            // the next device, so a later failure cannot strand earlier work.
            try {
              await dbModule.runOutsideDbContext(dispatchResult.deliver);
            } catch (err) {
              // The committed command remains available to heartbeat delivery.
              console.error('[monitorScriptWorker] deferred probe delivery threw; the committed command stays queued', {
                commandId: dispatchResult.commandId,
                deviceId: device.id,
                error: err instanceof Error ? err.message : String(err),
              });
              captureException(err, undefined, { commandId: dispatchResult.commandId, deviceId: device.id });
            }
          }
        } else {
          result.skipped++;
        }
      }
    }

    return result;
  });
}


// ---------------------------------------------------------------------------
// BullMQ wiring
// ---------------------------------------------------------------------------

const MONITOR_SCRIPT_QUEUE = 'monitor-scripts';
/**
 * The tick cadence, NOT the probe cadence. A `script` monitor's own
 * `intervalMinutes` (5-1440) is enforced per device by `isDeviceDueForProbe`;
 * this only decides how often we look. One minute keeps the floor honest
 * without making the sweep hot.
 */
const TICK_EVERY_MS = 60 * 1000;

const SCRIPT_MONITOR_TICK_META: QueueActorMeta = {
  actorType: 'system',
  actorId: null,
  source: 'worker:monitorScript:tick',
};

let monitorScriptQueue: Queue | null = null;

function getMonitorScriptQueue(): Queue {
  if (!monitorScriptQueue) {
    monitorScriptQueue = createInstrumentedQueue(MONITOR_SCRIPT_QUEUE);
  }
  return monitorScriptQueue;
}

async function scheduleScriptMonitorTick(): Promise<void> {
  const queue = getMonitorScriptQueue();

  // Re-registering a repeatable job with a changed `every` leaves the OLD
  // schedule running alongside the new one, so clear ours first.
  for (const job of await queue.getRepeatableJobs()) {
    if (job.name === 'monitor-script-tick') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'monitor-script-tick',
    withQueueMeta({ type: 'monitor-script-tick' as const }, SCRIPT_MONITOR_TICK_META),
    {
      repeat: { every: TICK_EVERY_MS },
      attempts: 1,
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 },
    },
  );

  console.log('[monitorScriptWorker] Scheduled repeatable script-monitor tick (every 60s)');
}

let monitorScriptWorkerInstance: Worker | null = null;

export async function initializeMonitorScriptWorker(): Promise<void> {
  try {
    monitorScriptWorkerInstance = new Worker(
      MONITOR_SCRIPT_QUEUE,
      async (job) => {
        assertQueueJobName(MONITOR_SCRIPT_QUEUE, job, 'monitor-script-tick');
        return processScriptMonitorTick();
      },
      { connection: getBullMQConnection(), concurrency: 1 },
    );
    attachWorkerObservability(monitorScriptWorkerInstance, 'monitorScriptWorker');

    monitorScriptWorkerInstance.on('error', (error) => {
      console.error('[monitorScriptWorker] Worker error:', error);
    });
    monitorScriptWorkerInstance.on('failed', (job, error) => {
      console.error(`[monitorScriptWorker] Job ${job?.id} failed:`, error);
    });

    await scheduleScriptMonitorTick();

    console.log('[monitorScriptWorker] Script monitor worker initialized');
  } catch (error) {
    console.error('[monitorScriptWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownMonitorScriptWorker(): Promise<void> {
  if (monitorScriptWorkerInstance) {
    await monitorScriptWorkerInstance.close();
    monitorScriptWorkerInstance = null;
  }
  if (monitorScriptQueue) {
    await monitorScriptQueue.close();
    monitorScriptQueue = null;
  }
  console.log('[monitorScriptWorker] Script monitor worker shut down');
}
