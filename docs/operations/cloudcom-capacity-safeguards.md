# CloudCom capacity safeguards

## Alert and metric worker budgets

`ALERT_WORKER_CONCURRENCY` bounds local alert consumers (default 2, 1–10).
An existing Redis global limit is preserved. Alert evaluation continues under
pressure; scheduled tenant/device duplicates coalesce with one successor retained
for an active evaluation. A fresh per-evaluation hierarchy reduces repeated reads
without cross-request caching or weaker tenant predicates.
Monitor attachment and inheritance reads share one LEFT JOIN. Empty replace
links still suppress inherited monitors, and disabled attachments remain visible;
RLS applies to both tables. This removes an extra query per resolution without
caching policy decisions across requests.
Condition evaluation fetches the latest raw metric only when a real metric
threshold lacks a value from its evaluator. Existing healthy monitor states use
one conditional UPDATE rather than an insert attempt and lock/read first. This
stays inside the transaction/savepoint; open episodes retain the recovery path,
and freshness timestamps, recurrence counters and response-pause flags remain.

`METRIC_ROLLUP_WORKER_CONCURRENCY` sets local and Redis global aggregation limits
(default 1, accepted 1–2); replicas must agree. Historical rollup jobs move to
delayed when the capacity guard denies optional work. Their original ranges and
day catch-up plans remain intact. No attempt is consumed and no success is
recorded. Unchanged aggregate rows are not rewritten; `updated_at` changes only
with the contents. Late-data overlap and normal rollup schedules remain.

Check once-per-minute `[AlertWorker] Workload` and `[MetricRollupsWorker] Workload`
summaries alongside queue counts and server pressure. They contain elapsed time
and maximum queue age, not CPU usage. Sustained metric deferral can grow historical
backlog; a quiet server alone does not prove recovery. Acceptance requires alert
progress, bounded age and eventual metric completion as capacity becomes available.
Never permanently pause security alerts to obtain a good CPU reading.

For rollback, preserve the prior artifact/configuration and record the metric
queue's global concurrency. Restore that Redis setting (or remove it if absent
before deployment) explicitly; an artifact rollback cannot revert Redis metadata.

These server controls pace native-agent updates and defer selected routine work
when host pressure threatens interactive use. They require no endpoint or
browser-extension release. They do not measure AWS burst credits or guarantee
zero burst usage, and cannot stop updates already running on devices.

## Bounded script monitor checks

Script probes use fresh current pressure observations, rather than the heavy
job recovery latch. A server with brief recurring load spikes can therefore
make small amounts of progress without requiring a full quiet recovery window.
Missing, stale, stopped, incomplete, dependency-failed, or pressured observations
still defer checks. Heavy collectors retain their existing recovery behavior.

The scheduler ticks every five seconds and admits at most one probe per tick by
default (`MONITOR_SCRIPT_MAX_DISPATCH_PER_TICK`). It defers when two devices have active or reserved probe/repair work
(`MONITOR_SCRIPT_MAX_ACTIVE_WORK`).
Repair scripts are counted by configured response and recurrence script IDs,
including automation executions without a monitor ID. Completed breach probes
retain a durable reservation across evaluation and delayed automation dispatch.
Reservations release after a response execution appears (active executions still
count), or a definitive paused, skipped, terminal, or non-actionable decision.
Suppressed alerts record skipped_no_response with a compare-and-set that cannot
overwrite linked, claimed, queued or admitted work. Active work is re-read after
history to close the response-creation race. A broken response pipeline can hold
its slots; investigate rather than expiring reservations into an installation burst.
Pending reservations also recheck current inherited monitor applicability so
detached or disabled historical monitors cannot stop unrelated deployments.
Actual running scripts continue to count even after policy removal.
The queue also sets global concurrency one across worker processes.

Eligible devices with no probe history come first, followed by oldest history.
The exact inherited policy, cadence, offline, and maintenance checks still run
before dispatch. Offline devices are reconsidered after reconnecting; missed
checks do not accumulate for replay. Saved execution history preserves priority
across restarts. A missing or incomplete verdict remains unknown, never OK.

Monitor tick duration, queue errors, active repairs, installation failures,
registration counts, and interactive health during catch-up. Existing unknown
RustDesk installations still require reviewed adoption; this scheduler change
does not authorize replacing them or disabling admission controls.

## Configuration

### Exchange worker isolation

Microsoft 365 snapshots now refresh only after an explicit directory Refresh
request. The minute scheduler looks only for `refresh_requested_at` newer than
the last attempt (or a requested first attempt); it does not collect every
enabled tenant merely because five minutes elapsed. Existing cached directory
and usage remain readable. This prevents mailbox-by-mailbox statistics and
Exchange session creation while the integration is unused. Failed requests are
not silently retried forever; another explicit Refresh requests another attempt.

The Exchange broker runs outside the API capacity guard. Its deployment must
retain `cpus: 0.25`, `cpu_shares: 128`, and `stop_grace_period: 60s`. On a two-core
host, 0.25 CPU is a ceiling of one eighth of total CPU capacity. The budget is
shared by the broker and every PowerShell descendant; it is not a per-process
allowance. Preserve it during upgrades and Compose regeneration.

The broker admits one command at a time and returns `worker_busy` immediately
for excess work instead of accumulating waiting commands. At most three tenant
sessions remain cached. A periodic sweep retires dead sessions and sessions
idle for 60 seconds without needing another request from that tenant. A full
pool refuses a new tenant until an idle slot is available, preserving recent
tenants' in-memory inventory continuations. Idle expiry still invalidates those
continuations; start a fresh read if a continuation has expired.

Commands have a hard 45-second response deadline even when stdout remains
readable. A timed-out write reports `unknown_write_outcome`; never replay it
automatically. Idle cleanup skips an active command. Process-group termination
removes descendants, and graceful shutdown refuses new work and waits for the
bounded active command before closing sessions. The 60-second container grace
must exceed that command budget.

Verify the effective cgroup CPU limit, worker health, session count, idle cleanup,
API readiness, and CPU/agent-timeout trends after deploying. A healthy readiness
response alone does not prove the absence of connection churn. These controls
bound Exchange's contribution; they do not diagnose or repair every agent
transport timeout or measure AWS burst credits.

### Alert evaluation burst containment

The production `alert-evaluation` BullMQ queue uses a Redis-persisted global
concurrency limit of one. This spreads each minute's device evaluations instead
of starting ten database-heavy evaluations together. Alerts continue to execute;
do not pause or purge the queue to implement this budget. The global limit
survives API/worker replacement while Redis metadata is retained. Restore the
same limit after replacing Redis or restoring an older Redis snapshot. Record
the previous value before changing it, and monitor waiting depth and oldest
waiting age to ensure evaluations clear between sweeps. This is distinct from
the Exchange container's CPU budget and does not cap interactive remote work.

### API capacity guard configuration

Enable `CLOUDCOM_CAPACITY_GUARD_ENABLED=true` and
`CLOUDCOM_UPDATE_GUARD_ENABLED=true` in the API and separate Breeze workers.
Generic defaults leave both controls disabled. Invalid tuning refuses startup.

Capacity tuning variables use the `CLOUDCOM_CAPACITY_GUARD_` prefix:

| Suffix pair | Pause / resume default |
| --- | --- |
| CPU_PAUSE_PERCENT / CPU_RESUME_PERCENT | 70 / 50 |
| STEAL_PAUSE_PERCENT / STEAL_RESUME_PERCENT | 5 / 2 |
| EVENT_LOOP_PAUSE_MS / EVENT_LOOP_RESUME_MS | 250 / 100 |
| MEMORY_PAUSE_PERCENT / MEMORY_RESUME_PERCENT | 90 / 85 |

Tune CPU thresholds below sustained host capacity. Measurements use Linux host
busy/steal deltas and MemAvailable, not container quotas or load averages.
Samples run every five seconds. Unknown, failed or older-than-20-second
observations withhold work. Startup/recovery require 60 continuous healthy
seconds below every resume threshold. DB, Redis and required-worker readiness
must also pass. API and worker processes each measure their own host.

## Fleet admission

Agent updates use `canRunAgentUpdateWork()`, independently of the heavy-job
recovery latch. A complete 60-second window must have time-weighted CPU, steal
and event-loop readings below the configured resume thresholds. Latest readings
must also be below pause thresholds; window peak memory stays below its resume
threshold. CPU/steal/memory/lag observations and dependency readiness are required.
Intervals use monotonic time; lag coverage includes delayed ticks and probe time.
Stale/missing observations, clock discontinuities and lifecycle changes discard
history. Severe CPU (at least 85%), steal (20%), event-loop lag (1 second), or
memory at its pause threshold requires a fresh window. The severe CPU/steal/lag
boundaries are never lower than their configured pause thresholds. Admission
uses cached samples and performs no extra host or dependency probes per request.
Brief non-severe spikes remain in the average and block starts while current,
without resetting a full minute of otherwise valid evidence. Existing Redis
concurrency, per-site, settling and start-rate controls still apply.

- Two devices at once, one per verified organization/site by default.
- Two new device starts per rolling two-minute window, shared across replicas.
  Redis server time and one atomic script enforce the bounds.
- Commands without trusted site context occupy an exclusive fleet slot; site
  identity is never inferred from a command payload.
- Agent/helper/watchdog offers share a device reservation. Repeated offers of
  the same bundle consume no extra starts. Different target versions cannot
  replace an active bundle.
- Actual reported component versions determine completion. Completed bundles
  retain their slot for at least 60 seconds and until the start window expires.
- Missing completion holds a slot for ten minutes. That device remains in
  cooldown until 30 minutes after its original admission; other devices proceed.
- Redis outage or a 250ms deadline defers updates. An unresolved raw Redis call
  retains single-flight ownership. Unused late reservations expire safely.

`CLOUDCOM_UPDATE_MAX_CONCURRENT` and `CLOUDCOM_UPDATE_STARTS_PER_WINDOW` accept
1–10 (default 2). `CLOUDCOM_UPDATE_WINDOW_SECONDS` accepts 60–3600 (default 120).
Other bounds are fixed. Keys use `cloudcom:{agent-rollout}:v1:`, expiry and
hashed site identities. No schema migration is required. Do not flush the
namespace during active updates or reset capacity by restarting the server.

Covered paths: heartbeat offers, watchdog recovery offers, queued update_agent
and update_watchdog delivery, development push and automatic Windows edition
migration. Ordinary commands, authentication and check-ins remain ungated.
Signed emergency rollback and independent local repair are exempt. Arbitrary
manually written installer scripts are not parsed or intercepted.

Main heartbeat offers are filtered after policy resolution: explicitly disabled
Breeze Assist is omitted before admission because its agent manager will not
install it. A failed/missing hierarchy or missing policy is not treated as off.
Native user-helper repairs are a distinct component and are unaffected. Existing
reservations are not edited or cleared when this filter is deployed; any prior
unconfirmed Assist target expires under the original bounded lease.

## Routine jobs and health probes

Script monitors check before DB discovery and between monitors/devices.
Committed probes remain committed; skipped devices remain due. Scheduled
Harmony refresh checks before starting; deferral neither advances freshness
nor reports provider success. Other jobs, in-progress work, security response
and backups are not globally paused. New optional worker integrations should
call `canRunBackgroundWork()` before work and at safe batch boundaries.

Readiness preserves one underlying DB and Redis probe per evaluator after
response timeouts. Subsequent checks share it instead of accumulating queued
queries. Each raw attempt reports failure once. Actual settlement permits a new
probe, and diagnostic-hook exceptions cannot break readiness. Existing worker,
tenant-isolation and shutdown requirements are unchanged.

Operations health shows guard state, CPU, reasons, thresholds and rollout limits.
State-change logs are bounded and contain no device credentials. A paused state
is intentional protection; investigate the reason before raising limits. There
is no automatic AWS plan change, fleet reboot or rollback.

## Release and verification

### Database container memory

Host `MemAvailable` and API readiness do not establish database container
headroom. Check the database cgroup's `memory.current`, `memory.max` and deltas
in `memory.events` (`oom` / `oom_kill`), plus PostgreSQL recovery logs. A killed
backend can trigger internal database recovery without changing Docker's
restart count. Preserve the operator-approved database memory/swap limits in
the private deployment Compose configuration during releases and rollback;
do not substitute generic development defaults or a stale configuration backup.

Interpret the footprint with `memory.stat` and `memory.pressure`: the `file`
category includes cache and shared memory, and a `max` event can precede
successful reclaim rather than an OOM. Do not label cache growth alone a leak
or add shared-memory usage to the `file` category again. Counter semantics are
defined in the [Linux cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html).

Budget database memory against the host's other services. Include backend
connections, shared buffers, concurrent operations using `work_mem`, maintenance,
and container overhead. Increasing `shared_buffers` or pool concurrency along
with a container limit is a separate tuning decision, not an automatic follow-up.
The October 21 allocation correction leaves those database/pool settings alone.

A supported live Docker limit increase must also be saved in Compose. Validate
the rendered configuration without printing secrets and verify container identity,
runtime limits and sustained database/API readiness after applying it. Compare
OOM counters and recovery events across the prior failure interval and normal
connection recycling. Do not automatically lower a live limit beneath current
use; reassess available host memory and a maintenance plan before reverting.

### Application releases

Build/test outside production, package a frozen source manifest and signed API
artifact, verify hashes and current deployment baseline, and require sustained
readiness before activation. Preserve unrelated mounts and native promotion.
Restore the previous compose/API bundle on failed deployment. Redis leases
expire naturally; no database migration or fleet-wide endpoint restart is needed.
Use disposable QA services for overload tests rather than production stress.

Regression coverage includes 500 simultaneous simulated update requests against
real Redis, per-site/exclusive limits, rate windows, settling/cooldown, pressure,
timeouts, heartbeat/command compatibility, monitor/provider deferral, readiness
recovery and health-page authorization.

## Database-pool pressure containment (2026-10-26)

The KEV/EPSS worker previously updated each CVE in one long transaction. Keep
`exploitFeeds.ts`'s bounded writes (500 EPSS rows per transaction), unchanged-score
predicate, and capacity checks between HTTP/write batches. All batches use the
existing system DB context and release it before yielding. Capacity deferral must
not record a false feed failure/success. `vulnerabilityWorkAdmission.ts` moves
source/maintenance jobs to delayed without consuming an attempt when capacity is
unavailable; preserve BullMQ lock-token handling and propagation of real errors.

`agentRequestConcurrency.ts` bounds agent-ID HTTP handlers before auth/DB work.
`CLOUDCOM_AGENT_REQUEST_CONCURRENCY` defaults to zero (disabled); deployment opts
in to eight concurrent requests, with a bounded FIFO wait queue and abort cleanup.
Human authentication, downloads and the separately budgeted WS setup route do not
enter this queue. Existing authentication and RLS remain mandatory after admission.
Do not increase the pool merely to work around overload. Preserve middleware order
immediately after agent admission and before auth/body/database middleware.

Validation in OS-TEST: 36 focused feed/admission/concurrency tests and 50 existing
admission-core tests passed; candidate API syntax checked. Broader route tests
could not load due to missing native argon2 in the isolated test environment.
No migration or endpoint/extension release is required. Deployment receipts and
post-deployment acceptance are recorded separately in the control-plane evidence.

Deployment accepted 2026-10-26: authenticated staff dashboard and Operations
health verified; three readiness probes passed, no pool acquire timeouts in the
three-minute observation window, and idle DB connections available. Both queues
resumed and capacity deferrals observed. Host CPU steal remains about 68%, so
background work remains deferred and this does not establish full host recovery.
Watchdog restored and temporary Inspector closed. Keep a rollback artifact and
allow at least five minutes for API cold startup under host scheduling pressure.
## Core policy and network-monitor admission (2026-10-27)

New policy evaluations and network probes use the existing shared capacity guard
before opening database contexts. Already received network-check results continue
processing under pressure. Explicit jobs retain their BullMQ lock token and move
to delayed without consuming failure attempts. Periodic scan ticks coalesce under
pressure rather than accumulating delayed repeat jobs; no evaluation timestamps or
successful checks are recorded for skipped work.

Monitor worker concurrency defaults to two (MONITOR_WORKER_CONCURRENCY, 1–10);
policy evaluation concurrency is one. Due-policy reads commit before Redis enqueue.
Existing commit-before-remediation/event publication and tenant contexts remain.
Fixed-label workload summaries are emitted at most once per minute and contain
completion/failure/deferral counts and elapsed time, not secrets or device IDs.
Elapsed time includes I/O and must not be presented as CPU or database time.

This is admission control, not incremental per-device compliance evaluation. The
existing compliance transaction still needs separate bounded-batch design that
preserves commit-before-event ordering. No identity-service changes are included.
The owner authorized local validation for this server-side change. 134 focused tests and exact-candidate factory smoke checks passed. Source is not a production deployment record; see the control-plane receipt for activation.

Activation verified October 27: API healthy, readiness passed three times,
received-result admission preserved, periodic policy/monitor scans reported
capacity deferral with no catch-up backlog. No observed pool timeouts; database
connections available. Host scheduling pressure remained high in the immediate
sample, so this is not evidence of full CPU recovery. Identity services, endpoint
versions, and infrastructure sizing were unchanged.

## UniFi configuration recovery lane (2026-10-27)

In enforce mode, only GET /api/v1/agents/:id/unifi-collectors has a separate
process-local budget: one start per second and one request in flight. This read
must reach normal authentication, tenant-bound assignment lookup and negative
cache to truthfully tell unassigned agents to enter their long idle interval.
Do not fabricate empty configuration, bypass agent authentication, or exempt
telemetry uploads. The cap applies even when healthy; many assigned collectors
may require a separately measured budget adjustment. Observe/off are unchanged.
Budget refusals retain 503/Retry-After and fixed HTTP metric/log labels.

Agent collector failures use bounded exponential jitter and respect Retry-After
on 429/503. Wake signals cannot bypass the failure cooldown; last known idle
state is preserved. Sustained fetch warnings are limited to once per five
minutes. This agent behavior requires a separately promoted agent binary; the
server recovery lane also benefits existing agents without a fleet update.

The dedicated slot is marked only in server-side Hono context after admission.
That marked exact GET bypasses the general agent HTTP FIFO, reserving one extra
request instead of waiting behind all eight ordinary slots. Client headers cannot
set the marker. The dedicated limiter stays held until downstream completes and
clears its marker/releases in finally. Authentication, global rate limits and the
DB pool remain downstream; total bounded agent HTTP work is ordinary limit + 1.
