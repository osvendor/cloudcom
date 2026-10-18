# CloudCom capacity safeguards

These server controls pace native-agent updates and defer selected routine work
when host pressure threatens interactive use. They require no endpoint or
browser-extension release. They do not measure AWS burst credits or guarantee
zero burst usage, and cannot stop updates already running on devices.

## Configuration

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
