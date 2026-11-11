# CloudCom upstream maintenance

## Upstream v0.128.0 intake (2026-11-10)

Candidate fork version is 0.128.5, based on exact upstream commit
`a92212fcff9da71046d3e0feb3fbb3c6b31fd920`. This entry records integration,
not production activation. Native promotion remains separate; the server
baseline retains the existing 0.125.5 binary source until native acceptance.

Upstream short alert transactions replace the old outer evaluation transaction.
Keep the fork concurrency budget, tenant-scoped successor deduplication, bounded
telemetry and conditional metric reads. Hierarchy preparation has its own short
system context; each rule and detach path owns its context. Upstream capture now
uses a DIB section on a dedicated locked desktop-following thread, superseding
our separate GetDIBits fallback files. PAM local consent protocol and managed
RustDesk reconciliation remain fork requirements. Native Windows acceptance is
still required before promotion.

The device launcher composes upstream explicit-provider selection with enrolled
RustDesk identity and managed staff admission. Customer remote-only capabilities
and native session restrictions compose with upstream portal browser-access and
session-method policy; contact invitations retain their remote-only mode.
Mailbox explicit eligibility floors remain authoritative, while legacy null
floors retain original creation time so outages cannot silently skip mail.

There are 108 new upstream SQL migrations and no changed existing SQL migration
files. Rehearse against a restored database and repeat for idempotence. The
portal status/auth-method backfill requires principal checks. UniFi changes its
unique conflict key: code-only rollback is unsafe after migration; restore the
quiesced database together with previous code/configuration. API and workers
must cut over together because webhook retry state moves to PostgreSQL.

CloudCom workflows remain authoritative; upstream workflows are not re-enabled.
The dependency lock was regenerated to reconcile Hono peer versions, followed
by focused auth, remote-access, alert and mailbox checks. Production deployment,
restore proof and signed inventory evidence are tracked outside this source file.


## Alert evaluation and metric aggregation cost (2026-10-27)

Scheduled alert evaluation loads one fresh `DeviceHierarchy` inside its existing
system database context and explicitly passes it through maintenance and rule/
monitor resolution. Optional resolver arguments retain compatibility for other
callers. Preserve the device mismatch guard, owner predicates, parked-organization
semantics, and missing-org behavior. No hierarchy or query result is cached across
evaluations. Existing episode/subject evidence and commit-before-outbox delivery
boundaries remain unchanged.

Scheduled device and network-check jobs use tenant-scoped BullMQ deduplication
with `keepLastIfActive`: repeated pending work coalesces, but an active job retains
one successor for new evidence. Do not replace this with a TTL or permanent job ID
that can suppress fresh evaluations. Local alert concurrency defaults to two
(1–10); an existing Redis global budget remains authoritative. Alert evaluation
does not wait indefinitely for the optional-work capacity guard.

Metric rollups default to one consumer across replicas. Capacity deferral retains
the exact historical range/day plan without consuming attempts; scans continue
recording ranges. Do not use per-org deduplication to discard historical windows.
Unchanged aggregate upserts use null-safe comparison of all eight mutable fields,
avoiding redundant writes, WAL and vacuum work. `updated_at` now denotes an actual
aggregate change. Preserve overlap for late samples and daily catch-up semantics.

Affected files: `alertWorker`, `alertWorkTelemetry`, `alertService`,
`featureConfigResolver`, `metricRollups` worker/service and
`metricRollupWorkAdmission`, their tests, and environment defaults. No schema,
agent or browser-extension migration. Workload summaries are bounded and report
wall-clock time/queue age, not CPU time. Persistent Redis metric global concurrency
must be included in rollback; rolling back the artifact alone does not undo it.
Source tests and isolated PostgreSQL/Redis fixtures are recorded in the task's
evidence. Deployment activation and measured acceptance are recorded separately.

This guide records how the CloudCom fork differs from LanternOps/Breeze and how to integrate upstream changes. Maintain it with the code; it is not a guarantee that future merges will be conflict-free or regression-free.

## Database-pool pressure containment (2026-10-26)

`DB_PREPARED_POLICY_READS=true` opts the request pool into bounded prepared
statements for parameterized policy SELECTs. Drizzle's postgres-js adapter uses
`unsafe()`, whose default disables preparation. The decorator covers transaction,
savepoint and reserved clients; it does not cache result rows, alter RLS, force
generic plans, or prepare writes/context setup. Preserve its SQL-shape/parameter
bounds and explicit driver options. The isolated PostgreSQL integration test
checks alternating tenant contexts, savepoints, plan reuse and fresh updates.

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

## Bounded script monitor progress (2026-10-23)

Preserve `monitorScriptWorker`'s separate fresh-current-pressure admission for
small probes: the heavy recovery latch previously starved first checks, so
managed-host installation never began. The five-second tick has a default one
probe admission, active/reserved device cap two (including response/recurrence
scripts without monitor IDs), and distributed queue concurrency one. Keep
never-probed/oldest-first persisted history ordering, exact inherited policy
admission, offline rejection, maintenance gates, and capacity rechecks. See the
capacity guide for durable response reservations, suppressed-alert compare-and-set,
the final active-work recount, and rollout checks.

## Script monitor evidence availability (2026-10-23)

Script monitors return `dataAvailable: false` when no probe exists, evidence is
stale, the probe is still running, or execution failed without a verdict. These
states must remain unknown rather than silently clear an episode or report OK.
Preserve the focused handler and episode-service tests during upstream intake.
Routine probe sweeps still defer under the capacity guard; this correction does
not bypass that guard or dispatch a fleet-wide installation.

## Capacity and fleet-update safeguards (2026-10-16)

Microsoft directory snapshot candidates now require a pending explicit refresh;
remove neither that predicate nor its idle/requested-sweep regression coverage
in `cloudCommandM365SnapshotWorker.test.ts`. Enabled connections and stale cache
age alone must not trigger Exchange mailbox/statistics collection. Cached reads
and explicitly requested refreshes retain their existing tenant/lease checks.
Production also retains a Redis-persisted global concurrency of one for the
`alert-evaluation` queue; preserve/restore that operational budget when replacing
Redis. See the capacity guide for monitoring and recovery boundaries.

The October 23 Exchange correction bounds `scripts/cloudcom/exchange-worker.py`
to one active command and three retained tenant sessions, autonomously reaps
60-second idle sessions, enforces hard response deadlines, and terminates
process groups on retirement. SIGTERM drains the bounded active command.
Preserve the Exchange overlay's quarter-core CPU budget, reduced CPU share and
60-second stop grace during upstream intakes. The feature Compose regression
test checks these budgets survive artifact mount updates. No dependency, schema,
API, browser-extension or endpoint release is required for this worker change.
Rollback the worker file with its verified predecessor while retaining the CPU
containment; do not restore unrelated older Compose/database limits. Focused
broker tests cover busy rejection, cursor-safe pool saturation, idle cleanup,
active-command protection, timeout behavior and shutdown. See the operational
capacity guide for the inventory-continuation and unknown-write-outcome limits.

The October 21 operational correction adjusts the private PostgreSQL container
memory budget without changing the application, PostgreSQL tuning or pool size.
Preserve the approved database memory/swap limits when generating deployment
configuration or restoring historical Compose backups. Host memory and a zero
container restart count do not rule out database cgroup OOM recovery. Verification
must include cgroup counter deltas and PostgreSQL recovery history; see the
database memory guidance in [capacity safeguards](operations/cloudcom-capacity-safeguards.md).

The October 18 correction gives rate-limited agent updates a separate sustained
capacity window (`agentUpdateCapacity.ts`, integrated by `capacityGuard.ts`).
The heavy-job recovery latch remains unchanged. Preserve monotonic elapsed-time
coverage, complete current observations, time-weighted CPU/steal/lag averages,
current-pressure stops, and full window resets after severe pressure or missing
evidence. Operations health distinguishes waiting updates from paused heavy jobs.
No schema or native-agent change is required; roll back the API image and tuning
together without deleting Redis leases. Regression tests include recurring short
spikes, sustained/severe pressure, clock/probe failures, and 500 concurrent Redis
requests with limits reduced to one.

Main heartbeat admission follows policy resolution so an explicitly disabled
Breeze Assist app does not reserve an unfulfillable helper update slot. Only a
loaded hierarchy plus a resolved `enabled:false` policy withdraws that offer;
unknown/retained policy keeps its prior behavior. This is separate from native
user-helper updates. Watchdog-only admission and Redis lease expiry are unchanged.

Preserve `capacityGuard.ts` / `capacityGuardPolicy.ts`, atomic Redis admission in
`agentRolloutAdmission.ts` / `agentRolloutAdmissionLua.ts`, and their startup and
shutdown hooks in both API and worker entrypoints. Heartbeat offer admission
runs after its organization transaction; watchdog main-agent recovery and
watchdog self-update keep their distinct reported component identities.
Command delivery, development push and automatic edition migration share the
same admission lane. Deferred commands stay pending without a false execution
timeout; their normal delivery expiry remains bounded.

Heavy collectors such as scheduled Harmony refresh defer at safe boundaries.
Small script monitor probes use the separate bounded current-pressure lane above.
Readiness retains raw dependency single-flight ownership after response deadlines
so monitoring cannot accumulate work in an exhausted pool. Operations health
reports protection state and limits. Feature flags default off outside configured
CloudCom deployments; tenant authorization, emergency rollback and independent
local recovery are unchanged. No schema, agent or store release is required.
See [capacity safeguards](operations/cloudcom-capacity-safeguards.md) for scope,
tuning, rollback and regression requirements. Keep these contracts when upstream
changes update offers, command delivery, readiness or worker scheduling.

## Baseline and ownership

- Fork: `osvendor/cloudcom`; upstream: `LanternOps/breeze`.
- Initial fork PR: https://github.com/osvendor/cloudcom/pull/1.
- Base reviewed for that PR: `dc724dbed1782e4336cffa07a3e0314c60087a67`.
- CI repair revision reviewed on 2026-09-21: `695985321e95e8be66b81babe706f204c431c9de`. Full CI was still pending at review time. This is not a production release or a last-known-good deployment marker.
- Keep exact upstream and fork commit IDs in each integration PR. Record deployed image digests and database migration state separately in private operational records.
- Never put server addresses, secrets, signing keys, or internal domain mappings in this public guide.

## Change register

### Portal managed viewer download (2026-10-19)

`RemoteComputersPage.tsx` offers authenticated staff and customer accounts the
same managed Windows x64 viewer installer; `RemoteComputerDirectory.tsx` labels
its browser action **Web Remote**. The versioned MSI link is independent of the
selected computer and is the viewer installer, not the unattended host package.
Normal managed sign-in and device authorization still apply after installation.

Deployment must provide the verified release MSI through a persistent read-only
mount at `apps/web/dist/client/downloads/managed-viewer`. Preserve this mount
when rebuilding or replacing web artifacts; the binary stays outside Git. Bump
the UI URL and download filename together with the published installer version.
The directory's staff/customer tests cover the link and renamed action. Verify
the served installer SHA-256 against the accepted viewer release before rollout.
No API, database, native payload, or endpoint update is required. Revert the web
artifact and its download mount together if rolling back this feature.

### Shared browser/native remote directory (2026-10-19)

The customer portal's `/portal/remote` landing redirects to the standalone web
directory `/remote/computers`. Both browser and native sign-in use
`remoteAccount.ts`: verified staff authority takes precedence; a verified
Cloudflare staff assertion selects normal staff SSO with browser-binding
bootstrap. A portal cookie or matching email never grants staff authority.
Transient/denied staff checks must not downgrade to a cached customer account.
The read-only `remoteIdentity` query on the existing CF login route discloses
only the account kind after assertion verification, without issuing a session.

`staffRemoteDirectory.ts` supplies both native and browser staff lists, applying
fresh partner/org/site permissions before pagination and retaining the existing
RLS context. Rename uses the same permission-checked service and audit trail.
Customers use the existing shared native/browser assignment list; device/user
metadata is additive and rename stays disabled. Each connection still performs
the original live authorization. Transport readiness may differ. Existing
customer session URLs, CSRF checks and company-gateway requirements remain.

The browser directory mirrors search, organization collapse, aliases and user
history. Staff desktop launch validates the managed app URL; customer desktop
launch gives existing-app instructions (no new customer deep-link protocol).
No schema, endpoint agent, native MSI, or store change is required. Roll back the
API/web/portal artifacts together. Implemented and focused tests passing;
deployment acceptance is recorded separately in private release evidence.

Regression surface: staff/customer directory parity, revoked org/site access,
account selection and binding preparation, pagination, safe launch URLs, CSRF,
existing consent protocol 1/2, portal redirect and customer session guards.

### Managed RustDesk viewer directory (2026-10-19)

The separate Flutter viewer now searches hostnames, custom names, organizations,
and current/previous users, with organization sections keyed by ID. It saves
only the existing Breeze `displayName`; OS hostnames are unaffected. Preserve
the `deviceIdentity.ts` projection's heartbeat freshness and device+org-scoped
session history. The staff-native device directory includes identity metadata
and a rename capability hint; actual rename authorization is freshly checked
by `staffNativeDirectory.ts` for devices.write, partner ownership, active tenant
and permitted organization, under the existing native-bearer/RLS/IP boundaries.
The alias endpoint uses a strict schema and records an audit event. Native
connection admission, credential scope and customer permissions are unchanged.

No schema migration or endpoint-agent change is required. API fields are
additive; old viewers continue to work. Updating technician viewer installations
requires the native MSI. Tests cover permissions/revocation, tenant denial,
payload validation, metadata, audit, search/collapse/rename and existing login,
admission and presence paths. The mistaken earlier Breeze/Companion UI edits
were removed; do not reintroduce them during upstream reconciliation.

Regression surface: API `routes/staffNative.ts` extends only the managed staff
directory and adds the alias route; the separate viewer's `account_page.dart`
embeds the directory and coordinates rename, and `native_login.dart` adds its
authorized request. Existing native connection engine/runner bytes are preserved
in viewer 1.0.6. Keep all older uncommitted RustDesk fixes when integrating.

### LanternOps v0.123.0 intake (2026-10-17)

The intake pins upstream `v0.123.0` at `d721f0963d02a9ee8151fc31514666d596826d8d`
and targets fork version `0.123.5` with paired verified native binaries `0.121.6`.
Preserve the complete CloudCom workflow directory. Upstream heartbeat transaction
scope and organization-scoped hierarchy/policy sets replace the superseded
CloudCom `devicePolicyReadSnapshot`; remove that unused snapshot implementation.
CloudCom update-capacity admission remains post-commit and shared by heartbeat,
watchdog, command-delivery and edition-migration paths. The browser viewer was
regenerated with the browser clipboard and credentials adapters. Preserve existing
auth, tenant, native, PAM, credentials and Harmony policies. The API image must
package the `ext-credentials` source manifest and web distribution. No Edge Store
publication or automatic native fleet promotion is part of this intake.

Fresh-bootstrap planning orders the already-shipped CloudCom monitor lookup-index
migration after upstream's monitor-coverage column prerequisite. Their filenames,
SQL bytes and existing ledger entries stay unchanged. Regression tests cover the
explicit dependency, missing prerequisite, repeat planning and unchanged caller
input. Restored-data upgrade applied 129 pending migrations, then a repeat was a
no-op; fresh bootstrap also passed. Real PostgreSQL resolver/mailbox checks passed
153 tests and the RLS catalog contract passed 105. The broader focused API, portal,
extension and browser suites and all three application builds passed before image
acceptance. Native PAM race tests retain both CloudCom failure evidence and the
upstream restart/token-verification marker; the current fleet binary is unchanged.

Live browser acceptance caught a clipboard adapter initialization-order regression:
the upstream clipboard ref precedes the browser status and paste-notice state.
The browser transform now attaches its controller after that state is declared.
A real viewer render test reproduces the original temporal-dead-zone failure.
The adaptation also replaces every native clipboard-controller reference in
transport startup, cleanup and keyboard handling; generation fails if any remain.
Transport tests exercise the real viewer with mocked network channels, including
clipboard-channel arrival, connected rendering and unmount cleanup. Clipboard
events bubble through the remote media scroller so both video and IME focus work;
clipboard ACK precedes paste input, and synthesized chords clear released modifier
bookkeeping. Restore remembered remapping and release held keys before changing it.
All 47 browser desktop tests and the 47-module sync contract pass. The CI binding
guard also checks TypeScript diagnostics in the imported browser viewer graph;
Astro transpilation alone does not reject missing identifiers. Preserve these
checks across viewer refreshes and gate gestures by connected, writable state.

Local MSI serving now requires a signed artifact manifest. Stage a manifest for
the verified current MSI using the established CloudCom release trust key and
register that public key while retaining existing verifier keys. Keep the native
component update manifests and target versions unchanged. The actual merged MSI
fetch path passed against the current artifact. Database and image rollback must
remain paired: keep a protected quiesced backup and previous configuration. Final
image IDs, cutover acceptance and production state belong in private release
evidence, not this public maintenance register.

### Independent local native release version (2026-10-16)

`apps/api/src/services/binarySync.ts` resolves the expected local binary volume
version through `getBinariesVersion`, matching the download routes' explicit
`BINARY_VERSION` override. A native-only release can therefore register its
signed component manifests without changing the API/web version or falling
back to GitHub because the server image is older. The registration safety net
uses the same override precedence so it cannot re-promote an older API release.
Preserve that precedence, the server-only paired-image guard, hosted-edition
refusal and manifest signing.
Focused tests cover four-component signed registration with an older server
version and rejection of a stale hosted volume that matches only that server.
No migration or agent protocol change is required. Recovery restores the prior
binary volume and override together; it does not automatically downgrade agents.

### Windows GDI bitmap readback recovery (2026-10-16)

`agent/internal/remote/desktop/capture_gdi.go`, `capture_gdi_dib.go` and
`capture_windows_nocgo.go` retain DXGI and the existing GDI readback path.
Only a typed GetDIBits failure, after successful bitmap reselection, enables a
persistent DIB-section fallback for that capturer. The existing bounded retry
recreates the native bitmap; BitBlt and GdiFlush complete before its pixels are
copied into owned Go memory. Resolution/thread changes and Close release the
native allocation with its bitmap. Preserve the error gate, flush-before-copy,
CAPTUREBLT retry and handle lifetime when integrating upstream capture changes.
Desktop/session selection, permissions, consent and transport are unchanged.

The recovery addresses a live Windows secure-desktop case where GetDIBits
returned zero without an error code across fresh handles, both DPI modes,
bottom-up headers and named display contexts, while a native DIB section read
succeeded. Portable race tests cover the marker, failed reselection exclusion,
sequencing, buffer bounds and failed-frame handling. Release-mode desktop tests
pass with ten pre-existing adaptive-bitrate/audio failures excluded after
reproducing them on the preceding source. Live browser capture and reconnection
passed on the affected Windows Server 2019 secure desktop; Windows 11 canary
capture also passed. Full Windows desktop CGO/race compilation remains unsupported.
No migration is required. Retain the preceding verified binaries for recovery;
the MSI downgrade guard must not be bypassed by blindly installing an older MSI.
Private release evidence records the native canary scope and exact artifacts.

### Periodic monitor backlog and lookup cost (2026-10-14)

`monitorScriptWorker.ts` schedules recurring probes only for online devices,
rejects an offline race at dispatch, and treats pending/queued/running/cancelling
executions as blockers. Preserve these guards and their tests when merging;
intentional manual offline script queues retain their existing behavior.
The additive `2026-10-14-223000-cloudcom-monitor-lookup-indexes.sql` migration
and Drizzle declarations index command execution IDs and monitor/device/status
lookups. No agent or public API contract change is required.

The dry-run-first `scripts/cancel-offline-monitor-backlog.ts` operator tool
cancels only unstarted periodic-monitor executions with a unique undelivered
pending command on an offline device. It rechecks under row locks, uses bounded
transactions, records an audit event, and preserves execution history. It does
not cancel manual scripts, ambiguous matches, or sent/running commands.
Before applying, back up command/execution tables and deploy the scheduler guard.
API rollback uses the prior application bundle; additive indexes can remain.
Do not restore backed-up pending work wholesale into an active queue.
Validation: 180 worker/dispatch/stale-reaper tests plus 31 recovery/terminalizer
tests passed; API and standalone recovery bundles built successfully.

The DB context prologue sets all seven transaction-local tenant settings in one
parameterized query. Preserve every setting, the before/after deadline checks,
and the recognizable query prefix used by the wedged-backend reclaimer.
Worker initialization is bounded to four concurrent initializers by default
(`WORKER_STARTUP_CONCURRENCY`, capped at eight), with failure isolation and the
same required-consumer readiness gate. These changes reduce startup contention;
they do not relax readiness or increase request deadlines.

The request pool uses Drizzle's supported schema-free constructor. All production
queries use table imports and SQL builders; there are no relational `db.query`
consumers. Registering the full schema allocated 579 unused relational builders
on every transaction/savepoint. Preserve schema-free construction unless a future
upstream change deliberately adopts that API. Real-Drizzle/fake-transport checks
cover SQL equivalence, GUCs, savepoints and context boundaries: 120 DB tests and
26 RLS contract tests passed (five existing skips). These are not substitutes for
real PostgreSQL RLS integration tests. The local constructor benchmark is not a
claim of equivalent whole-application speedup.

Heartbeat policy resolution shares only device, organization and group reads
within its existing policy transaction. `devicePolicyReadSnapshot.ts` binds that
short-lived cache to the device, transaction and access-context identities; it
does not cache resolved policy decisions or reuse reads across heartbeats.
Explicit executors, new/narrowed contexts and savepoints bypass an outer cache.
The patch-source flag uses the policy-only resolver to avoid unused timezone
queries. Regression checks cover identical resolver results, reduced query counts,
context separation, callback lifetime and failed-read retry.

Within that same system-scoped snapshot only, five resolvers can skip their
effective-policy join when the base feature-link table contains no such type.
The effective view contains only own/parent base links. One grouped inventory
read is shared; every cached absence requires a same-transaction `SELECT 1` so
an earlier caught SQL failure still prevents later default/off updates. Keep
device/org visibility checks and existing Redis-cache ordering. Explicit
executors, other scopes, devices, transactions and callbacks cannot use this
shortcut. Monitoring uses `monitors` links and is deliberately unchanged.
Validation: 506 tests across 13 focused suites and the six-entry API build passed.
No cross-heartbeat decision cache or access-policy change is introduced.

The additive `2026-10-14-233000-cloudcom-policy-planner-statistics.sql` migration
initializes statistics on the small configuration tables and lowers their
autoanalyze threshold. Previously these tables could remain below the default
50-change threshold indefinitely, producing inflated estimates for RLS-heavy
queries. Preserve automatic statistics maintenance after schema/data migrations;
this migration changes no application rows or access policies.

The monitor sweep owns its DB context and commits each device admission before
delivery and before the next device's policy reads. This releases device foreign
key locks promptly while keeping execution/command creation atomic. A failed
admission rolls back only that device; a failed delivery leaves its committed
command available to heartbeat delivery. Preserve the post-commit boundary and
worker concurrency of one. The updated worker, dispatcher, maintenance, resolver
and evaluator regression suites passed 155 tests; the full API bundle built.

Before full policy resolution, the 60-second sweep reads a fresh complete monitor
attachment inventory. A monitor with no attachments cannot win for any device.
For attached monitors, the shortest valid authored/attachment interval bounds a
bulk active/recent execution check. Unknown or invalid overrides disable that
optimization; failed metadata reads are reported and fall back to full admission
in fresh transactions. Recency is checked again per candidate as time advances.
Every remaining candidate retains the exact resolver, effective due check and
dispatcher guards. No decision survives the sweep. Added skipped-unattached and
not-due counters make the saved work observable. Focused worker/dispatch/resolver
checks and the six-entry API build passed; existing worker-readiness inventory
drift remains outside this change. No schema or endpoint changes are needed.

`cfAccessRedirectLogin.ts` logs only fixed binding-error classes/reasons, issuance
phase, elapsed time and presence booleans. It never logs exception text, bindings,
capabilities, identities or tokens, and does not weaken authentication or alter
public error responses. The diagnostic distinguishes binding failures without
assuming that every login failure is a timeout.

Operations health samples Linux CPU steal-counter deltas in its existing
single-flight collection. The first observation is unknown; later observations
flag host scheduling pressure at 5% and 20%. This is hypervisor steal, not Docker
quota use or proof of one hosting cause. Auth diagnostics and CPU/health checks
passed 67 tests. Live deployment and sustained recovery must be recorded
separately; passing local tests does not establish hosting capacity.

The web auth overlay distinguishes retryable recovery failures from definitive
authentication failures. Slow refresh and Cloudflare cookie handoffs retain
navigation ownership past the overlay safety timer; an explicit retry reuses
the existing cookie rather than starting another login issuance. The detailed
Cloudflare bootstrap fences every asynchronous stage on session generation so
logout or account changes cannot be undone by late responses. The login page
shows bootstrap progress and a bounded preparation timeout. Preserve token,
origin, revocation and throttling checks; this is recovery behavior, not relaxed
authentication. Validation: 67 focused web tests plus three existing 409 race
tests passed. Deployment and authenticated browser acceptance are recorded
separately in the private incident evidence.

Callback failures expose an explicit single-sign-on retry instead of an automatic
loop. AuthOverlay claims one fixed login redirect target before rerendering, so a
generic redirect cannot overwrite the CF error context. Cancelled handoffs defer
to a newer live session or expiry owner; incomplete recovery remains actionable.
A stalled/rejected navigation shows an ordinary full-page sign-in link. Preserve
the existing transient/throttle ownership and all session-generation fences.
Validation: 82 focused web tests and the dependency-locked production build passed.

### Harmony Endpoint integration (2026-10-15)

Cloud Command's `harmony-contract.ts` and `harmony-provider.ts` implement bounded,
read-only group discovery and complete, exact-ID-scoped endpoint inventory.
Fixed regional origins, guarded fetch, redirect refusal, deadlines, capped jobs
and pagination, strict provider schemas and allowlisted DTOs are required.
Unknown protection state remains unknown. Failed or incomplete snapshots are
rejected rather than published as empty inventory. Client group scopes accept only
custom `GROUP` entries, never virtual/offline categories. Shared-tenant publishing
must partition the complete snapshot against all approved organization mappings:
cross-client claims withhold the endpoint from every client, and missing scopes
produce empty projections without an account-wide fallback. Explicit endpoint
mappings support an initial single-device trial without treating generic groups
as client boundaries. Client projections strip other groups and setup diagnostics.
The host service `cloudCommandHarmony.ts` owns platform-admin setup with effective
account MFA-policy enforcement (policy satisfaction is not proof of a second factor), the
partner-owned encrypted connection and complete shared-tenant partitioning.
Setup accepts a system principal or a platform administrator with full partner
organization access; partial partner access is insufficient. Owner operations
explicitly read all connection mappings, including inactive clients, after this
gate. Normal readers retain their organization-scoped database context.
Organization readers only receive their published cache. The core migration
`2026-10-15-harmony-integrations.sql` must precede the extension migration
`2026-10-15-harmony.sql`; all four tables use forced RLS and composite ownership
constraints. Versioned three-minute leases fence stale publications. Provider I/O
runs outside short database transactions. `harmonySyncWorker` executes through the
host BullMQ worker registry; the extension contribution registry alone does not
execute jobs. A five-minute repeat checks one connection at a time, refreshing no
more frequently than every fifteen minutes. The host consumer participates in
readiness, has concurrency one and bounded job retention, and stops provider work
when Cloud Command is disabled. Configuration
and mapping changes invalidate all affected client caches atomically.

Cloud Command adds connection setup, exact group/endpoint mapping, inventory and
explicit same-client device links. Native antivirus views add separately labelled
cloud evidence without overwriting agent observations, inventing real-time
protection, or treating cumulative infection counts as active threats. Threat
Hunting transport remains pending: authentication and portal telemetry do not
establish the external GraphQL URL, authentication or tenant-binding contract.

Validation: 115 provider/route tests, 369 host/route-context tests (including manifest
registration), fifteen extension UI tests, focused native security tests,
TypeScript and production builds. Real PostgreSQL checks cover forced RLS,
cross-client/partner forgeries, publication, link preservation, stale leases,
provider failure, disabling and native antivirus attachment for single/multiple
device results (36 passed; unrelated integration cases skipped). Native attachment
must use parameterized UUID predicates: direct JavaScript-array interpolation into
`ANY(...::uuid[])` is a SQL record, not a PostgreSQL array. UI mutations reload
inventory so saved links and invalidated caches are immediately reflected.
Both new migrations were reapplied successfully. Full registry tests remain
blocked by the existing missing local `re2-wasm` package. Fresh-database bootstrap
also exposed a pre-existing monitor-index migration ordering dependency; that was
deferred in disposable QA, not edited or claimed fixed here.

Deployment uses a signed artifact manifest, verified database backup and existing
runtime images. Rollback keeps additive migrations and tenancy declarations while
restoring the previous API/web/bundle and hiding Harmony navigation/jobs. Runtime
deployment and trial acceptance evidence belong in the operator release record.

AI continuation (2026-10-15): `aiToolsHarmony.ts` registers the read-only
`get_harmony_evidence` tool across the registry, SDK, input schema, permission
map and security-response capability catalog. It reads one explicitly linked
Breeze device from the existing client cache; organization, site, exact-device
and helper ceilings still apply. It never reads partner secrets or broadens the
configuration API's human-owner gate. Collection time, freshness, source
references and unknown values are preserved. Clean anti-malware inventory is not
an absence-of-threats verdict. Hunting telemetry and provider response actions
remain explicitly unavailable, rather than represented by successful empty data.
Existing incident/ticket/evidence/action tools retain their permission and
approval paths; this read tool executes no actions and grants no new AI policy.

`harmony-hunting-contract.ts` is a prepared, OFFLINE-only schema adapter for the
published GraphQL contract. No runtime route, credentialed transport, ingestion
job or action executor calls it yet. It builds a single exact-EPGUID query with
an endpoint-only data source, 24-hour window and at most 200 records, then rejects
cross-endpoint/out-of-window rows, duplicates and partial GraphQL errors. It
allowlists evidence fields, omits raw command arguments/file/script bodies and
registry contents, and labels truncated coverage. An independently verified
EPGUID mapping and supported URL/auth/tenant contract are prerequisites to wiring
it live. Do not infer that inventory computerId and EPGUID are interchangeable.
Focused checks: 120 AI/SDK/catalog/metadata tests, 15 offline hunting contract
tests, extension TypeScript and API six-entry bundle passed. These are not live
Threat Hunting or autonomous-response acceptance tests.

### Managed RustDesk partner default (2026-10-13)

Fleet enforcement uses native partner-owned scripts, script monitors and a
Windows-filtered partner configuration-policy assignment. Preserve sourced
script parameter `org.id` binding, partner monitor inheritance and Quick Support /
holding-device exclusions when merging upstream. The pinned custom host installer,
native admission, protected staging and unknown-payload refusal remain unchanged.
The operator provisioning record is private under `internal/managed-host-default.ts`;
this configuration requires no API patch, migration or additional scheduled job.

Native target authentication must carry the active tenant's server-derived
partner ID into `withDbAccessContext.currentPartnerId` while retaining organization
scope. Without it, inherited remote-access settings are RLS-invisible during host
admission/renewal even though policy resolution finds the partner policy; admission
then fails closed with HTTP 503. Preserve this in `portalNativeTarget.ts` and
`routes/nativeTarget.ts`, together with the target-context regression tests.

### IDrive 360 integration (2026-10-13)

Cloud Command owns the IDrive contract, fixed-origin public HTTPS provider,
client routes, web page and two additive tables in
`packages/ext-cloud-command/{src/server/idrive*,src/web/idrive*,migrations/2026-10-13-idrive360.sql}`.
Preserve its manifest page, navigation, tenant erasure/merge/export declarations,
and Connect/overview entries across upstream updates. Keys and operation payloads
are encrypted with organization-bound AAD and excluded from organization exports.
Mapping changes require platform-administrator setup authority.

An IDrive MSP company can contain multiple customer groups: the company alone
is not a client boundary. Group-bound connections return only their group's
devices and exclusively owned plans. Shared plans and cross-client targets are
excluded; conflict responses expose counts rather than other clients' identities.
Company-wide connections require platform-admin authority on reads as well.

Supported operations cover inventory, plan creation/editing, group management,
subcompany creation, device tags/metadata, notifications and configured installer
links. Provider-supported dry runs precede plan/group writes; other changes use
local previews. Execution consumes an actor/org/version-bound, expiring preview
before dispatch. No automatic write retries. An uncertain outcome must be checked
in IDrive before a technician submits a new operation. Restore and backup-file
browsing remain outside the published MSP API. Company installers are not
group-specific; subsequent client-group assignment is required.

The host changes are deliberately narrow: a lazy caller-scoped DB runner in
`apps/api/src/extensions/builtinRegistry.ts` and exact IDrive route exemptions in
`middleware/selfManagedDbContextRoutes.ts`. These keep operation claims durable
before outbound calls and avoid holding request transactions across network work.
Do not remove one without the other. The SDK and existing provider signatures
remain compatible through an optional injected runner.

Validation: focused provider/authorization/client-boundary and web tests,
extension typecheck, web/API builds, existing host registration tests, the two
org-table RLS catalog coverage assertions, and a rollback-only real-PostgreSQL
cross-client read/write rehearsal. Live acceptance covers scoped inventory,
client switching and a non-executed preview. Existing customer backup settings
were not mutated for acceptance. Complex plan changes currently use an advanced
JSON editor; tag and notification changes have ordinary forms. Backup timestamps
without timezone remain provider-local; stale detection uses a conservative
14-hour offset allowance and does not certify recovery health.

The normal extension migration ledger applies the additive migration. If code is
rolled back after it runs, retain the new tables' tenancy declarations until a
separately reviewed schema rollback; an old manifest cannot classify them.
Deployment hashes, mappings, and rollback artifacts belong in private records.

### Operations health extension (2026-10-13)

Cloud Command adds `/extensions/cloudcommand/health`, a read-only platform-operator
view. The package owns its route, web component and manifest entry; the built-in
registry supplies a narrow lazy host collector (`extensions/operationsHealth.ts`).
Preserve that bridge across upstream merges. Interactive system-scope platform
administrators (including platform admins retaining a partner login membership)
require organization-read permission. Site-limited, organization, ordinary partner,
API-key and customer sessions cannot consume global aggregates. Active account
status and the live platform-admin flag are rechecked before cached observations.
Use the existing `BREEZE_PLATFORM_ADMINS` bootstrap for deployment owners; this
feature adds no separate privilege list and changes no login scope resolution.

The collector coalesces requests for 30 seconds and executes bounded aggregate
queries using explicit system DB contexts and transaction-local statement limits.
No new tables, dependencies, credentials, device commands or migrations. Results
contain counts/status only, never device/customer identifiers or command payloads.
The UI pauses polling when hidden, handles timeout/stale/error states and labels
unmeasured coverage explicitly. Enrollment toward 500 is rollout progress, not a
claim of tested capacity. Host-visible load/RAM are distinguished from API process
memory; the filesystem check covers the API mount only. Relay bandwidth, external
SSO/integrations, backup recovery, release compliance and full queue depth remain
unmeasured. Deployment and capacity evidence belong in the private operational
record. Focused tests cover global authorization, revocation, partial failures,
thresholds, cached collection and browser polling/error behavior.

### OS Companion public privacy page (2026-10-08)

The staff-only OS Companion Edge listing has a standalone privacy policy at
`apps/web/public/edge-store/privacy.html`. Keep this path publicly reachable
through the web edge so store reviewers can read it without an authenticated
session. The page documents the extension's active-tab metadata checks,
client-scoped credentials, device tools, notes, work tickets and session
storage without making legal retention or security guarantees. This is a
static documentation asset; it does not change authentication, API routes,
authorization, or data handling.

The public path must remain separate from authenticated application routes and
must not expose private infrastructure details. Deployment and public-edge
access verification belong in the operational record; this register records
the source asset only. No new automated tests are required for this static
HTML change.

### Quick Support desktop readiness (2026-10-06)

Support-session list/detail responses now expose `desktopReady` separately from
`deviceOnline`. Readiness requires the first heartbeat to report revocation-lease
version 1 and satisfy the shared desktop-fence capability gate; opening an agent
socket alone no longer enables the technician Connect button. The page displays
the existing initializing/claimed state while waiting. Stored session state and
remote-session authorization are unchanged; no migration is required.

Affected files: `apps/api/src/routes/remote/supportSessions.ts` and its tests,
`apps/web/src/components/remote/QuickSupportPage.tsx` and its tests. Preserve this
additive API/UI contract across upstream merges and deploy API before or with web.
Regression cases cover online-before-heartbeat, partial capability reports, and
polling into readiness. Focused Linux-container validation passed 25 API and
19 UI tests; API and web production builds passed. Production deployment and
desktop connection acceptance are recorded separately in the private ledger.

### Windows agent 0.121.5 release

The Windows self-host agent, backup, watchdog and user-helper binaries now target
the same 0.121.5 fork version as the server. Release metadata therefore emits an
empty baked binary pairing for a full release. Keep the deployed agent manifest
signatures and SHA-256 checks bound to the exact Windows artifacts; preserve
other platform/component promotion slots. Build and test the four-executable MSI
in the Windows test environment before promotion, including enrollment retention
and service recovery without a reboot. Runtime rollout evidence belongs in the
private operational ledger, not this source-level release declaration.

Windows validation uses race checks for version policy, watchdog, installer and
update trust. Heartbeat/native/PAM tests use the shipped CGO-disabled build mode:
the Windows desktop implementation does not currently compile with CGO enabled.
The complete cross-platform installer/updater suites have additional Windows
failures; targeted acceptance is not a claim that those full suites pass.

### Staff native access (2026-09-30)

`staffNativeAuthority`, `staffNativeLogin`, `staffNativeAdmission` and
`staffNativeAvailability` provide separate staff authorization and v2 proof-bound
admission. Preserve their route mount, native-target server-record dispatch,
`staff_native_sessions` migration with forced org RLS/composite target foreign key,
and default-off `CLOUDCOM_STAFF_NATIVE_ENABLED` switch. Only interactive partner
staff can seed an opaque native session; live permissions, owning partner,
organization scope, account/MFA policy and parent-session revocation are checked
again at admission/renewal. Customer identities remain assignment-only.

The browser authorization page uses S256 PKCE and exact loopback callbacks. The
selected RustDesk provider path hands a UUID-only `cloudcom-remote` URI to the
verified viewer launcher. Preserve its MSI protocol registration and strict URI
translation without replacing the endpoint's RustDesk handler. Flutter exposes
separate staff/customer sign-ins, bounded directory pagination, organization
labels and requested-device highlighting; the hint never grants access itself.

Validation: focused API/customer regressions115, web42 and Flutter6 passed;
API/web/client builds passed. Transactional PostgreSQL checks proved same-org
access, denied cross-org reads/updates and target FK mismatches, and forced RLS.
Full API TypeScript checking remains unverified due memory limits. Runtime
acceptance and private deployment evidence remain in the operational ledger;
passing source tests alone are not a claim of accepted desktop connectivity.

### LanternOps v0.117.0 intake

The intake pins upstream `880eaba02361001ecd6a5dc6863deab51d578e53` and retains
the CloudCom 0.116.5 agent fixes for the intended 0.117.5 build. Heartbeat startup
starts both native target reconciliation and upstream hardware collection.
Google DWD scopes now share upstream's central declaration, including Cloud
Command usage/audit reads and the new inbound Gmail connector. Existing OAuth
connections remain separate from DWD.

Cloud Command declares organization merge policies for all nine owned tables.
Connections, pending consent and tenant-specific directory state remain with
the source organization until its erasure; they are never repointed to a new
organization. Reconnect providers explicitly on the surviving organization.
This protects organization-bound credentials, browser consent and cached tenant
data. The merged registry test checks this boundary.

Upstream removes six legacy labour-pricing columns. A pre-upgrade database
backup and migration verification are required; reverting application code alone
cannot recover the previous database schema. Source integration and passing
focused tests do not establish production deployment or endpoint update status.

Managed viewer routing correction (2026-09-24): `scripts/cloudcom/rustdesk/launch-managed.ps1`
and its dependency-free regression test pin private routing per viewer process and
validate bundle fingerprints. See [launch and release acceptance](cloudcom-managed-viewer-launch.md).
No API, agent, database, or provider authorization path changes. Preserve the launcher,
test and guide during upstream updates. Local profile hashes are not release signing.
Nine focused launcher checks passed; the existing managed test bundle connected to
the private relay, consumed its Breeze admission ticket, and displayed the desktop
with user confirmation. Full installer distribution and the complete upgrade/revocation
acceptance matrix remain separate from this routing fix.

| Area | Current state and files | Upstream merge considerations | Validation |
| --- | --- | --- | --- |
| Agent WebSocket recovery | Candidate in `agent/internal/websocket/client.go` and adjacent regression tests: back off after short-lived upgraded connections, reject sockets established after Stop, and retain safe handshake HTTP status. The native job in `cloudcom-ci.yml` installs libpcap development headers required by discovery. [Diagnostics and canary procedure](cloudcom-agent-connectivity.md). Not deployed or signed as a fleet release. | Preserve bearer/TLS authentication, indefinite retries, cancellation and stable-session reset. Reassess against upstream reconnect changes; do not silently alter device offline semantics. | Targeted Linux race tests and final-head CloudCom native CI required; actual results recorded in PR. Historical outage attribution and canary acceptance remain separate. No DB migration; rollback restores previous verified agent binary. |
| PAM reconciliation cleanup recovery | `agent/internal/heartbeat/handlers_actuate.go`, `apps/api/src/jobs/pamActuationWorker.ts`, and `apps/api/src/services/commandDispatch.ts` allow an enrolled device's `pam_cleanup_v2` to run while an unresolved prior actuation temporarily reports protocol capability 0. Apply and UAC interception remain gated on verified reconciliation. | Preserve the cleanup recovery path across agent, worker, and command dispatch together. Keep device and organization identity checks, ledger generation checks, and independent cleanup evidence; never extend the capability-0 exception to apply. No schema change. | Focused Go and API regressions cover cleanup during reconciliation, foreign-organization rejection, and continued apply blocking. End-to-end Windows acceptance is recorded separately. |
| Legacy PAM local-decision gate during native rollout | `apps/api/src/routes/agents/elevationRequests.ts` accepts a comma-separated `PAM_LEGACY_LOCAL_GATE_DEVICE_IDS` override for exact device IDs whose installed agents do not yet send protocol 1. Only auto-approved requests are held for the existing local decision endpoint; no new authority or schema is introduced. Default is empty. | Preserve exact device matching and the auto-approved-only boundary. Remove the override after the selected agents are upgraded and verified; do not make it a tenant-wide setting. The value belongs in private deployment configuration, never source. | Route tests cover configured legacy-device delay, different-device isolation, and the normal protocol-1 path. Production must verify the live PAM gate before and after API promotion. |
| Windows-only self-host agent release candidate | `releaseSource`, `binarySync`, component downloads, heartbeat and `installerBuilder` add an opt-in, separately verified Windows GitHub source. It registers four Windows components without global promotion, selects one configured canary device, and has separate post-acceptance switches for the custom MSI and all-Windows promotion. No database migration. Status: implementation candidate; no live promotion. | Keep the primary repository and Linux/macOS paths unchanged. Preserve exact release repository/tag and Ed25519 manifest verification, normalized deployment signing, checksum/redirect matching, and the device-scoped canary gate. Do not enable the MSI or all-Windows switches before endpoint acceptance. Roll back by clearing the optional Windows source variables; existing promoted rows remain. | Focused API release-source, sync, download, installer and configuration tests on the Linux runner; API build and OS-TEST auto-update/fresh-install/PAM acceptance still required. |
| Microsoft directory presentation | `packages/ext-cloud-command/src/web/microsoft.ts` and directory UI helpers/tests replace duplicate connected setup/provider controls with search, resource tabs, column visibility, expandable account rows and a themed side drawer. | Preserve returned-field boundaries, context/request fencing, manager checks, explicit group confirmation, single-dispatch mutations and verified readback. No new API, credential or migration. Unsupported Microsoft actions remain absent; recover with prior matched application images. | Focused extension UI, typecheck/build and visual acceptance required on the final revision; operational evidence is recorded separately. |
| Native v2 admission backend | Default-off customer/target handlers, `portalNativeAdmission`, `portalNativeTarget`, scoped credentials and two forced-RLS tables. V2 proof binds the encrypted TCP exporter; existing WebRTC service remains separate. | Preserve current main-agent enrollment, exact native/company/target/session identity, atomic ticket consumption, live grant/epoch/presence checks and monotonic leases. No technician handoff or native UI availability yet. New migration requires real DB checks and explicit deployment; target generation rotation must not revive old admissions. | Focused local unit/route tests and real-SQL test coverage added; actual paired native acceptance and migration execution remain outstanding. See native admission protocol. |
| Signed company claim preparation | `portalCompanyGateway` has an explicit `custom-claims` configuration with enabled organization allowlist; legacy subject mappings remain the default. `cfAccessJwt` retains signature-verified `custom` as unknown for consumer validation. | Require application token type, nonempty subject, exact claim schema and organization match; never infer organization from email. No migration. Keep disabled until the live JWT inner claim shape and exclusive company IdP policy are verified. Missing or trimmed claims deny access; no fallback wrapper or subject mode fallback. | Added allowlist, malformed/truncated claims, cross-org, disabled mapping and cryptographic tampering tests; seven focused suites passed (118 tests) locally. Documentation confirms the outer `custom` claim only, so the staged flat inner shape is not a live compatibility claim. |
| Customer identity default | Shared company gateway login in isolated Docker Authentik; individual remote-only passwords remain in Breeze. Default-off company check implemented in `portalCompanyGateway`, portal login/remote routes and native exchange. Deployment template in `deploy/remote-identity`; extension account administration and customer cutover remain unfinished. | Preserve browser-assisted native sign-in without a Cloudflare One/WARP prerequisite, two-step authentication, immutable Cloudflare issuer/subject-to-org mapping, independent identity storage, existing administrator policies and live remote grants. No migration; no enabled production authentication switch. Runtime environment configuration is an interim adapter, not extension management. | Seven focused suites: 87 passed; API build passed. Isolated vendor-container startup and HTTP readiness passed. Company-only login blueprint passed Authentik 2026.8.3 dry-run and application; two stages and an empty non-admin company group verified. Existing admin flow remains unchanged; live OIDC, company administration, native edge passage and cutover acceptance remain required. |
| Remote-only customer invitations | Optional restriction in shared invite validator, `orgPortalUsers` and `OrgPortalUsersEditor`; accounts are restricted before invitation delivery and remain restricted on acceptance/re-invitation. Device assignments remain in Extensions → Remote Access. Implemented and tested locally; not yet deployed. | Preserve omission behavior for existing callers, never promote an existing restricted account, and retain MFA/org authorization and ordinary token/email lifecycle. No migration. Roll back UI/API together; persisted restrictions remain valid with prior portal access enforcement. | Isolated Linux QA: 63 API invitation/acceptance/access-mode tests, 48 shared validator tests and 10 admin UI tests passed. Public invitation acceptance is still required. |
| Native browser sign-in preparation | Default-off `CLOUDCOM_NATIVE_LOGIN_ENABLED`; portal `/remote/native` consent binds the verified Cloudflare company organization and JWT expiry into a one-use, 60-second S256 PKCE code. Exchange needs no Cloudflare token; the native bearer expires no later than the company JWT and is scoped to assigned-device listing and native-session actions. The RustDesk target handshake, enrollment and password-free desktop path remain unwired. | Preserve exact loopback callback, browser CSRF, atomic Redis consumption and parent-session comparison, live account epoch/access-mode checks, company-org/expiry binding, native route confinement, and Microsoft extension paths. Browser sessions still require a fresh Cloudflare assertion. | 70 focused API unit/route tests passed locally on the current dirty tree. Full API typecheck exhausted the host Node heap; DB/Redis integration, paired RustDesk builds, target enrollment, and endpoint acceptance were not run. Keep both native flags off until complete client/target tests and a coordinated release. |
| Remote portal CI coverage | Enumerated `portalRemote` classification selects `scripts/cloudcom/test-portal-remote.sh`: isolated database/Redis, migration, login/access/RLS contracts, focused API/portal and extension checks. | Preserve denial for unrelated portal/schema paths and disposable stack isolation. CI is not native transport or deployment acceptance. | Classifier tests and shell syntax passed locally; full hosted database job results must be checked on the final revision. |
| Cloud Command Microsoft 365 administration candidate | Implemented unified Connect onboarding plus bounded directory administration in `packages/ext-cloud-command` and the authenticated API host runtime. One organization-scoped connection supports inventory and only supported user fields/group membership actions; CIPP is a source reference, not a generic action surface. [Configuration and boundaries](cloudcom-microsoft-administration.md). | Preserve `native-microsoft.ts`, administration runtime/authorization, actor-bound consent state, certificate-version binding, forced RLS, fixed Microsoft endpoints, executor budgets/audit, callback origin fencing and stale-response guards. Do not broaden this into arbitrary Graph/CIPP operations. | Focused server, runtime/authorization, onboarding, executor/provider and web tests are required on the final head. Disposable migration/RLS and Microsoft test-tenant acceptance remain separate. No live completion or full CIPP parity is claimed. |
| Cloud Command Google Directory candidate | The extension adds Users, Groups and Archived users reads. The existing per-organization DWD key supports bounded account actions and Gmail settings; the new separate OAuth connection supports bounded Directory and Reports reads after one Connect consent. The host issues fixed, customer-scoped calls and keeps per-user Gmail and writes unavailable in OAuth mode. | Preserve exactly one credential mode per organization through the shared organization-row transaction lock and opposite-table check in both connect paths. Keep encrypted keys and refresh tokens in separate tables; never treat an OAuth refresh token as a DWD key. Preserve actor/org/site checks, fixed resource/page-token allowlist, safe projection, stale-response guards, and fail-closed write/audit path. | Isolated Linux PostgreSQL RLS/mode-race integration, focused host/extension/UI tests, extension typecheck, lint, and PR CI required. Live OS CONSULTANTS Google consent and provider acceptance remain pending; no production deployment or full Google parity is claimed. |
| Native admission proof preparation | `services/portalNativeProof.ts` and matching feature-gated native proof/lease modules are preparatory and not connected to runtime admission. [Protocol](cloudcom-native-admission-protocol.md). No new route, migration or enabled transport. | Preserve exact binary proof layout, canonical encoding and target/account binding. PKCE, target enrollment, atomic ticket consumption and actual channel revocation remain required before release. | Four API proof tests passed in isolated QA. Seven standalone native lease/encoding tests compiled and passed on Windows with Rust 1.75. This is not a complete native build or connection acceptance. |
| Customer remote access | Gated implementation in `packages/ext-rustdesk-access`, portal `/remote`, API portal remote routes/services, and `portal_remote_*` schema/migrations. Explicit per-customer grants; remote-only portal entitlement; browser session ownership, assignment generations, endpoint leases and termination fences. `CLOUDCOM_REMOTE_ACCESS_ENABLED` defaults false. WebRTC availability rechecks live authority and both endpoint protocols; native remains unavailable. Separate from Cloud Command/3CX. | Preserve portal identities independently from technician identities, forced RLS, composite tenant foreign keys, live authorization on renewal, scoped extension host API, and agent lease/fence protocol requirements. Native RustDesk target enforcement and app sign-in remain unfinished; never enable stock password authentication as a substitute. Grants/history intentionally block org transfer; permanent deletion clears sessions before grants. Preserve existing dependency overrides and database-driver patch. | Linux: ten real DB/Redis isolation tests, one real portal-login test, 103 RLS checks, lifecycle suites (228 unit/43 integration), and preserved-lock 771 portal tests passed; extension server/UI tests passed 6/7. Actual Chromium portal sign-in, assigned listing, browser launch, decoded video, keyboard/mouse, 75-second lease survival, grant revocation and browser-close confirmation passed against an enrolled Linux agent. The disconnect fix and list gating passed 36 focused tests and API/portal builds. See `cloudcom-rustdesk-account-access.md` for codec/Windows/TURN limitations. Packaged browser images at a88a6267766e are deployed; corrected form login and actual Windows 1920×1080 video, 75-second lease survival, other-customer denial and confirmed End session passed at the production origin. Temporary canary data was removed and prior settings restored. Native build, public-ingress, TURN fallback and future upstream-upgrade acceptance remain outstanding. Preserve login/invite access-mode projections, remote-only client landing, and the narrowly scoped portal SSR proxy trust configuration; public Cloudflare Access policy is a separate boundary. |
| Self-hosted native RustDesk launch | Provider configuration uses `rustdesk://{id}/r@<id-server>:21116?key=<encoded-public-key>`; documented in `cloudcom-rustdesk.md`, regression in `services/remoteAccessLauncher.test.ts`. No runtime source change. | Preserve literal server/key and identifier encoding. Do not revert self-hosted deployments to bare-ID templates. Installed-service defaults can differ from portable clients. | Focused launcher suite: 41 tests passed. Installed Windows client reached encrypted relay/password prompt; authentication and password-free launch must be recorded separately. No migration/image deployment; rollback template only. |
| Connected Cloud Command sidebar | Candidate: `components/extensions/useExtensionNavigation.ts`, `components/layout/Sidebar.tsx`, and `lib/extensions/hostApi.ts`. Cloud Command expands into enabled, established 3CX and Microsoft 365 connections for the current organization; Connect remains a sibling setup link. | Keep namespaced, registry-declared provider links, authenticated organization-bound status requests, immediate clearing on scope changes, stale-response cancellation, and fail-closed provider visibility. Refresh after connection setup changes and preserve core/rail/mobile navigation. No schema or credential changes; recover with the previous matched web image. | Linux focused sidebar, navigation-hook and host-API regression suite: 111 tests passed. Covers expand/collapse, active children, collapsed sidebar, org/account/logout fencing, provider failures, and setup/focus/navigation refresh. Deployment and live acceptance recorded separately. |
| Cloud Command Connect and 3CX extension | Deployed at `a648b64c6` (PR #22), including the profile-key fix: `packages/ext-cloud-command`, compiled-in registration, API packaging and revocable web host API bridge. Extensions → Connect centralizes provider setup with 3CX selected by default; the operational 3CX page is a directory surface, while managers use Connect for setup. The Connect shell embeds the existing configuration-only 3CX element, preserving encrypted per-org connections and stale-response guards. Enabled directory and combined views automatically load their first extensions page after the connection read; configuration-only and disabled views do not. Extension details are a full-page view with General, Call Forwarding, IP Phone, BLF, Voicemail, Schedule, 3CX Talk, and View & Options tabs. The server uses a positive redacted projection and safe narrow updates for identity/voicemail fields and supported forwarding ring controls. The fix uses validated unique raw `Name` values as browser keys for expanded profiles, keeps `CustomName` display-only, strips the key upstream, preserves the full profile object, and allows nullable phone/exception IDs. [Operations and boundaries](cloudcom-threecx.md). | Preserve manifest identity and `/connect` page, the configuration/directory display-mode boundary, forward migrations, encrypted-column AAD, RLS/export/cascade declarations, authenticated host bridge propagation to the nested setup element, and organization/generation fences around automatic reads. Preserve the positive projection and the one-extension, one-operation update boundary; preserve profile data while stripping only the browser key before provider writes. Do not describe the revision preflight as ETag or atomic stale-write protection because 3CX does not document conditional PATCH. Native provider links must remain ordinary same-origin anchors because extension navigation is namespace-restricted. | Linux typecheck, 158 server tests, 59 web tests and web build passed for PR #22. Exact-main CI and signed image verification passed. Live directory auto-load, detail tabs, identity and forwarding saves passed on the owner-designated test extension; original values were restored and independently verified. Provider proof on a user-authorized dedicated test extension verified and restored identity/voicemail PATCH plus forwarding update through `Users/Pbx.MultiUserUpdate`; no real infrastructure or user identifiers are recorded. |
| RustDesk quiet unattended profile | Implemented for the single-canary profile in `scripts/cloudcom/rustdesk/common.ps1`, `repair.ps1`, `repair.Tests.ps1`; default quiet-state detection and repair at source `cdfd9e4c2`. | Keep native monitor/script contracts and validate stock RustDesk shortcut targets and tray CLI on upgrades. No Breeze MSI or RustDesk fork; does not suppress active-session UI. Do not claim perfect update compatibility. | Eighteen Linux Pester checks passed; CloudCom CI run `35670867442` passed. Live Windows canary passed quiet cleanup, automatic missing-install repair, controlled relay-drift repair, credential preservation, postboot service/credential recovery, GIT RustDesk reconnect to the Windows lock screen with the original password, and the postboot quiet scheduled probe. First-ever credential provisioning, fleet rollout, multiuser/browser access, and user assignment remain untested/separate. Roll back policy/script versions, preserve DPAPI credentials. |
| Browser desktop | Deployed in PR #5; controlled Windows video/input/disconnect/fresh-connection acceptance passed. `components/cloudcom/browserDesktop`, `ConnectDesktopButton`, generator `scripts/cloudcom/sync-browser-viewer.mjs`. [Restoration contract](cloudcom-browser-desktop.md). | Keep current upstream viewer security/lifecycle fixes; generated-source check fails on drift. Review regeneration rather than restoring the archived Cloud Command bridge. | Same-origin capability boundary, launch and confirmed close tests, native regressions, upstream lease/API/input tests, web build; live endpoint acceptance required. Web-image rollback, no migration. |
| Optional remote-tool selection | Candidate: isolated API `routes/devices/cloudcomRemoteAccess.ts`, service `services/cloudcom/remoteAccessOptions.ts`, web `components/cloudcom/RemoteAccessAlternatives.tsx`; two mounts in device router and Remote Tools page. [RustDesk integration status](cloudcom-rustdesk.md). Browser client and portal assignments are not implemented. | Reuse existing provider/auth/secret contracts; preserve WebRTC/default behavior. The pre-merge customization contract rejects missing module files/attachment points, including conflict-free removals. Never infer full compatibility from that structural check. | Explicit selection, no fallback, safe summaries, org/site/gate denials, URL validation, audit redaction and UI lifecycle tests; update rollback synthetic test. No schema migration. Restore previous verified images to roll back. Live connection acceptance remains required. |
| Inherited workflow removal | Removed all 17 inherited YAML definitions from `.github/workflows/`; disabled all previously active inherited workflows in GitHub. CloudCom replacement checks are implemented in cloudcom-ci.yml; released upstream imports are implemented in cloudcom-upstream.yml. See [CI transition](cloudcom-ci.md). | Upstream merges must not restore automatic upstream pipelines. Retain our own runner, reusable scripts, application tests and signed upstream artifact provenance. | All inherited workflows disabled; two CloudCom workflows replace them. Validate the actual final-head CI before activation/deployment. |
| Change-focused validation | Implemented in `.github/scripts/cloudcom-delta.mjs`, its tests and `cloudcom-ci.yml`; exact released baseline in `.github/cloudcom-baseline.json`. | Compare the cumulative fork delta against the new release. Unknown/API/schema/shared impacts fail pending explicit coverage; never silently skip them. Preserve agent-facing and tenant-isolation compatibility. | Classifier/provenance, selected deployment contracts, workflow security, redacted secrets and fail-closed aggregate; see CI guide for current scope and limits. |
| Local image promotion and clean install | Documented in [local image promotion](cloudcom-local-release.md). Uses independently verified fork image archives, a signed images-only inventory and independent upstream agent trust. | Do not substitute mutable tags or conflate the local image key with agent trust. Preserve Cloudflare tunnel/Access settings during a fresh-data cutover. | Archive/config/OCI/layer identity checks, existing signature verifier, empty-database initialization, RLS and HTTP startup checks; operational evidence remains private. |
| Candidate images | Implemented manual `cloudcom-candidate.yml`: exact CI-validated source commit, API/web/portal runtime images plus migration builder, checksummed archives and image IDs. | Preserve pinned source/baseline metadata; candidate artifacts never bypass signed production release checks. Separate migration-only validation from normal API startup. | Actionlint and workflow security; actual build, restored-database upgrade/idempotence/RLS and app acceptance results recorded privately. |
| Controlled upstream imports | Implemented in `scripts/cloudcom/update-upstream.mjs`, its synthetic Git tests and `cloudcom-upstream.yml`. | Verify existing tag provenance; preserve complete CloudCom workflow tree, abort other conflicts, create draft PR and explicitly dispatch final-head CI. No auto-merge or deploy. | Merge/conflict/dirty checkout/rollback, tag provenance and exact-head dispatch tests. Scheduled/manual activation requires default branch and Actions PR permission. |
| Application image sources | Implemented in `deploy/.env.example`, `deploy/docker-compose.prod.yml`, `scripts/prod/deploy.sh`, smoke workflows and `scripts/smoke-guided-setup.sh`. See [image configuration](fork-image-configuration.md). | Keep application and agent-binaries sources distinct. Preserve signed inventories, exact repository/digest binding and verification. Root Compose and strict production Compose have different configuration contracts. | Release-image consumer contracts; packaging and binary-source smoke checks; deploy a signed fork release to a disposable installation. |
| Security workflow transition | CloudCom CI restores redacted secret scanning and workflow security/syntax checks on hosted workers. | External-contributor approval is retained. Dependency/SAST monitoring and release acceptance remain separate readiness items. | Actual workflow scanner, pinned actionlint and secret detection; no claim of full upstream security-pipeline equivalence. |
| Generated systemd unit verification | Isolated verification root in `scripts/check-guided-setup-systemd-unit.sh`. | Validate the actual generated unit without loading unrelated host units. Do not suppress errors in the generated unit. | Static renderer checks and actual Linux systemd verification in lint. |
| CloudCom visual branding | On hold at the user's request; keep existing website text, images, colors and branding unchanged. Existing partner/login and portal controls cover only some surfaces. | Do not apply a product rebrand during upstream integration. Preserve client overrides and upstream notices. | Existing branding and client-isolation regressions; no new branding work authorized by this register. |
| Compiled-in service modules | Planned: Microsoft 365, Google and 3CX through existing extension interfaces. | Do not reintroduce runtime third-party extension bundles. Review extension SDK changes and client-specific enablement/menu behavior. UI term is Clients; shared MSP settings belong under General. | Module-specific auth, client isolation, permissions, disabled-module behavior, API/UI and integration tests. |

## Concurrent remote desktop requirement

Multiple authorized users must be able to share a desktop without evicting each other. This is required but not implemented. The API and agent currently enforce one desktop session. See the [concurrency acceptance contract](cloudcom-browser-desktop.md#required-concurrent-access-not-implemented); preserve this requirement when merging upstream session/capture changes. Do not remove only the server restriction ahead of compatible agent support.

## Compatibility boundaries

CloudCom identifies the fork; displayed branding and versioning remain unchanged at the user's request. A proposed dual upstream/CloudCom version scheme is not adopted. Do not use a repository-wide Breeze-to-CloudCom replacement. Preserve these identifiers unless a separate compatibility migration is designed and tested:

- `@breeze/*` package names/imports, API contracts and existing database identifiers.
- Agent executable/artifact names, Windows services/Event Log sources, Linux service units, and macOS launchd/package identifiers.
- Viewer protocol schemes such as `breeze://`, agent authentication/signature headers and update protocols.
- Existing `BREEZE_*` configuration names, signed manifest formats, trust roots and digest verification.
- License files, attribution and upstream provenance.

Branding audit entry points: `apps/web/src/components/layout/BrandHeader.tsx`, `apps/web/src/components/auth/AuthPanelBranding.tsx`, `apps/web/src/layouts/`, `apps/web/src/components/settings/PartnerBrandingTab.tsx`, `apps/api/src/routes/partnerLoginBranding.ts`, `apps/api/src/routes/portal/branding.ts`, `apps/portal/src/layouts/`, and `apps/api/src/services/email.ts` / `emailLayout.ts`. Existing per-client branding must continue to resolve only in the appropriate client context.

## Upstream integration procedure

1. Preserve a clean baseline and user files. Fetch upstream into an isolated integration branch/worktree; record its exact commit/tag and our starting commit. Do not pull directly into the running server or resolve conflicts by blindly preferring one side.
2. Review upstream release notes and the actual diff, especially migrations, authentication/RLS, extension interfaces, manifests, agent compatibility, configuration and deployment workflows.
3. Compare every affected change-register entry with upstream. Prefer upstream fixes when they solve the same problem; deliberately adapt or remove fork patches and explain that decision in the PR.
4. Resolve conflicts and review semantic compatibility even where Git reports no conflict. Never edit a shipped migration: use a forward migration with the repository's RLS and idempotency rules.
5. Validate the cumulative CloudCom delta against the pinned released upstream baseline using relevant component/interface tests and fresh CloudCom CI/security checks against the final integration head. Do not replay the entire upstream development pipeline solely because a new upstream release was imported. Earlier green checks do not validate a later commit. Investigate runner failures separately from application failures; never remove required checks simply to merge.
6. Build the exact candidate images. Verify signed inventories and digest bindings. Exercise a disposable fresh installation and, when supporting existing data, an upgrade from the last deployed schema. Check login/MFA, cross-client denial, module permissions, agent enrollment/heartbeat, portal, background jobs and changed branding surfaces.
7. Record results and unresolved blockers in the integration PR. Prepare a recovery plan that accounts for database changes: rolling back images alone may be insufficient after migrations. Verify the relevant backup/restore path before deployment.
8. Deploy only through the approved release process. Verify running component versions/digests, health and user flows. Update the change register and private deployment record with the outcome.

## Required record for each customization

Include the purpose, status (planned/implemented/verified/deployed), affected paths, upstream baseline, compatibility assumptions, tests and their results, configuration/migration requirements, and recovery implications. Link the implementing PR. If an upstream update makes the customization unnecessary, record its removal rather than carrying it forever.

## Open readiness items

The inherited CI Success/routing contracts reference retired workflow files and are not replacement gates. `apps/api/src/config/envComposeParity.test.ts` classifies `BREEZE_RELEASE_REPOSITORY` as a host-side deployment input consumed by `scripts/prod/deploy.sh`, not an API container variable. The environment parity check is selected by the new pipeline; The inherited CI pipeline is now retired; replacement checks must assess these contracts for relevance before selecting them.

At the initial 2026-09-21 review, full CI was incomplete and an earlier Type Check had received a runner shutdown signal. The release workflow was still coupled to agent/desktop publishing, and repository Actions secrets were not configured. A verified application release path, signing configuration, fresh-install validation and recovery rehearsal are required before production cutover. Update this section when evidence resolves each item; do not infer readiness from the existence of configuration options.

## Microsoft menu licensing boundary (2026-09-22)

Planned extension expansion excludes premium-only features under [the menu scope](cloudcom-microsoft-menu-scope.md). Current four-resource navigation needs no removal. Preserve this boundary during upstream/CIPP imports; verify menus, nested actions and direct routes when implementing new features. Documentation-only change, no migration or deployment required; baseline 7e898d625c713d8521c561c2f28f3de8786fd7da, PR #16.

## Google Gmail audit trace candidate (2026-09-23)

`packages/ext-cloud-command/src/server/{native-google,google}.ts`, `src/web/google.ts`, and `apps/api/src/extensions/{cloudCommandGoogle,cloudCommandGoogleTrace}.ts` add a fixed, read-only Gmail audit trace to the existing organization-bound Google DWD connection. The route requires organization-manager permission and MFA, derives the Google customer ID from the connected administrator, rechecks the connection before the provider call, and requests at most 100 records per page over a fixed 1/7/30-day window. It returns only bounded message fields; cross-customer or malformed events are omitted and labeled partial. The compact page filters loaded results and labels further pages. Audit events are not proof of final mail delivery. No new credential store, database table, migration, or arbitrary Admin Reports query is introduced. Preserve the fixed query, customer check, safe projection, paired page token/window and partial-state semantics during upstream merges. Focused host/extension tests and Linux GIT build pass; live delegation scope, provider shape, pagination, and page visual acceptance are still required before claiming parity or deployment.

## Microsoft message trace candidate (2026-09-23)

`packages/ext-cloud-command/src/server/{exchange-contract,exchange-services,exchange-socket-client,admin-services}.ts`, `src/web/microsoft.ts`, and `scripts/cloudcom/{exchange-worker.py,exchange-persistent.ps1}` add fixed read-only Exchange message trace search and detail operations. They bind the existing organization, tenant, connection generation and actor before worker calls, constrain searches to 90 days and each range to 10 days, cap a page at 1,000 rows, and expose continuation and partial results explicitly. The compact table limits loaded rows and exports only the loaded subset to formula-guarded CSV. Preserve the fixed query, cursor, projection, and audit-without-message-content behavior during upstream imports. This remains a worker candidate with no new schema or public port; the current production app does not contain these routes. Linux GIT focused tests/build and PowerShell syntax validation pass. Live Exchange app-only RBAC, Microsoft continuation behavior, worker image/provenance, provider response, and visual acceptance remain required before deployment claims.

## Microsoft Connect and bounded administration candidate

Live acceptance follow-up (baseline `fbf40dfca2f73c2deba07cf2db475141f75ffc28`): the extension Graph provider accepts explicit null role assignability returned for ordinary static groups, while still rejecting true, omitted or malformed values and unsupported group types. User save reconciliation performs at most four read-only checks for eventual consistency; the mutation is never retried and navigation cancels verification. Preserve these semantics in `admin-graph-provider.ts` and `web/microsoft.ts` with their regression tests. No schema or credential changes; recovery is the previous matched application images. Live verification is recorded separately after deployment.

The current candidate is implemented in the extension and authenticated API host, including persistent organization-scoped consent/connection records and the additive RLS migration. Extensions → Connect is the single setup path; its callback state is origin-fenced in the same browser session. Managers have the limited user/group controls documented in [Microsoft administration](cloudcom-microsoft-administration.md); readers retain inventory-only access. It is not an Exchange, Teams, SharePoint, search/export, bulk, or generic CIPP administration release.

Preserve host-only certificate configuration, fixed OAuth/Graph endpoint checks, credential-version binding, actor-bound consent rows, forced RLS, explicit mutation confirmation, no-retry behavior and readback reconciliation. Recovery requires source/image rollback plus an explicit forward migration if persistence needs to change; do not edit the native administration migration. Automated tests do not substitute for disposable migration/RLS or Microsoft test-tenant acceptance, and no live completion claim is made here.


## Microsoft user security actions (2026-09-22)

Candidate on top of production baseline `5b9de87e9631f24fee16d2a1ecfc92582283aa54`: the Microsoft user drawer adds explicitly confirmed password reset and sign-in session revocation through the existing organization connection. Reset uses a cryptographically random one-time password and requires change at next sign-in; neither password nor response body is written to audit. Optional Graph app roles are checked per operation and do not block the single Connect onboarding flow. Session revocation is single-dispatch and reports the documented propagation delay. No database or configuration changes. Recovery is previous matched application images. Automated tests and live disposable-tenant acceptance are required before claiming deployment; this entry is a candidate until those pass.

Follow-up candidate on production baseline `acd26a1806c7fe564888ef79be5eb0c4ae1ebab8`: `packages/ext-cloud-command/src/server/admin-services.ts` classifies password reset and session revocation as mutations for organization-manager authorization, alongside profile and group writes. The prior executor still verified tenant, connection generation, audit intent and optional Graph roles, but the host authorization boundary had treated those two actions as reads. The focused regression denies a reader before credential access. Preserve this distinction when adding Microsoft operations or importing upstream extension changes. No migration or configuration change; recovery uses previous matched application images. Linux GIT server tests passed (171); final candidate validation and live acceptance remain pending.

The same candidate adds a fixed Global Administrator role read/set operation in `packages/ext-cloud-command/src/server/admin-graph-provider.ts` and `admin-execution.ts`. Only the built-in role is selectable; it requires `RoleManagement.ReadWrite.Directory` for writes, a separate confirmation, manager authorization, tenant and connection fencing, intent/outcome audit, complete assignment inventory, sole-administrator protection, and readback. This is a high-privilege capability that remains a candidate until disposable-tenant proof and production release validation pass. It does not add an arbitrary directory role editor or change the single Connect flow; the existing enterprise application may need the optional role permission and renewed tenant consent.

The Exchange worker foundation is a separate candidate under `packages/ext-cloud-command/src/server/exchange-*`, `scripts/cloudcom/exchange-*` and [the worker contract](cloudcom-microsoft-exchange-worker.md). It currently supports only bounded mailbox inventory through a private Unix socket and fixed PowerShell cmdlets. The API bridge and Connect descriptor lifecycle are attached in source, but the worker is not deployed or configured on the Lightsail host. A configured worker is reported as pending until a live capability probe succeeds. The CloudCom customization registry and CI retain the worker files, broker test, and shared directory Graph projection against upstream imports. The directory uses Graph-assigned SKU names and explicitly unavailable Exchange values until its collector is connected. No production configuration has been made for this candidate. Previous application images remain the recovery path for any future image-only rollout; a future worker deployment also needs its own service rollback and descriptor revocation plan.

A separate `admin-auth-methods.ts` candidate adds tenant-fenced, typed Graph authentication-method inventory and explicit phone/Authenticator method removal. `admin-execution.ts` retains connection/actor fences and audit intent/outcome, and `admin-services.ts` restricts both inventory and removal to organization managers because method details are sensitive. This does not imply parity with legacy per-user MFA state, recovery-email setup, phone enrollment or re-registration; those remain missing until separately implemented and verified. The existing enterprise app may require optional `UserAuthenticationMethod.Read.All` or `UserAuthenticationMethod.ReadWrite.All` consent. No migration or live deletion was performed.

The directory Exclude preference candidate adds `cloudcommand_microsoft_directory_preferences` through a forward-only extension migration. Its rows are scoped to organization, technician and Microsoft user, with forced RLS, host-derived actor identity, manager/MFA-gated writes and audit. The manifest registers organization cascade/export metadata; the UI hides excluded users by default and offers an Exclude view to restore them. The integration test checks both organization and same-organization technician isolation on disposable PostgreSQL. This migration cannot be removed by a later upstream merge.

The OneDrive usage candidate extends the fixed Microsoft Graph read-action allowlist and executor with the tenant's usage report. It accepts only the documented report redirect host, parses a bounded CSV into scalar per-user used storage, joins by UPN in the existing organization connection, and leaves the directory value unavailable when report permission or data is absent. It does not block the user list. The executor files and focused tests are included in CloudCom's CI classifier and upstream customization contract. `Reports.Read.All` app consent and live tenant response remain unverified; no report access is claimed yet.

Direct-code Microsoft directory follow-up (2026-09-25): the live Cloud Command extension mounts `createAdministrationServices` in preference to the separate Graph-read bridge. The administration enterprise app is therefore the directory's authority. Its user list now selects `userType` and `assignedLicenses`, resolves assigned SKU IDs against the same tenant's subscribed SKUs, and returns only a scalar license summary. A bounded OneDrive usage report uses the same app only when its token has `Reports.Read.All`; missing consent or report failures leave usage unknown without blocking users. The fixed Exchange worker mailbox inventory supplies `UserMailbox`/`SharedMailbox` and mailbox/archive usage; the web view separates shared mailboxes and labels incomplete statistics. Preserve these paths together during LanternOps intake. The source and focused tests are complete locally; the ordinary no-image production artifact path is not implemented, and live report permission, inventory response, and visual acceptance remain release checks.

The Microsoft Create user candidate performs only the base Graph identity creation step after selecting a verified tenant domain. It generates a one-time password on the server, requires change at first sign-in, fences the tenant connection and actor, audits the operation, and marks responses `no-store`. Optional Cloud Command steps (license, MFA, aliases, and groups) remain visibly pending. It has not been run against a live tenant, so no full create workflow is claimed.

The Google Workspace candidate reads paged Users, Groups, archived users and direct group members through Breeze's existing organization-bound domain-wide-delegation connection. The native host bridge checks organization access, extension authorization and site scope before decrypting the stored credential; the extension exposes only a small fixed response projection. Its sidebar entry requires an active connection. It does not import a legacy OAuth refresh token. Account block/restore and first/last-name edits are bounded candidates with pre-write audit and readback; group roles are shown read-only. A manager/MFA-only Gmail settings view reads automatic-forwarding and vacation status through user impersonation without returning the vacation message body or changing settings. The retained Cloud Command Google source explicitly did not include Gmail settings, so this is a native Breeze addition, not source parity. A bounded daily storage report now reads Google Admin Reports through the same DWD connection and shows missing metrics as unavailable; the report needs an added usage-read scope and an existing connection is not proof that the scope was granted. A bounded Security activity view now reads login, admin, Drive and token events through the same DWD connection, requiring the additional audit-read scope, manager permission and MFA. It fixes a 1/7/30-day window across pages, limits each page to 100 events, verifies the Google customer ID on every item and omits provider parameters. Missing scope is explicit; partial records and paging are labeled, and an empty result is not presented as proof of no incidents. Gmail message trace and investigations remain absent. None of these Google paths has live tenant acceptance yet. The 3CX dashboard candidate counts extensions through the existing department-scoped read service, caps pagination, and labels PBX-wide status separately. The 3CX Call Log candidate provides a fixed, bounded first-page report only for an explicitly full-PBX connection and records a scoped read audit; department connections fail before credential access because the old query has no verified department predicate. Server-driven report continuation remains unverified and is labeled incomplete rather than inventing `$skip` pagination. Preserve its route, transport, manifest, navigation, projection, audit and fail-closed gate across upstream merges. These candidate routes and their host/UI/CI attachments remain part of the CloudCom customization contract, not a replacement for live provider verification.

## Google OAuth Connect candidate (2026-09-23)

The new `cloudcommand_google_oauth_connections` and `cloudcommand_google_oauth_attempts` tables belong to the Cloud Command extension migration and have forced organization RLS. The refresh token and short-lived PKCE verifier use the active application encryption key with organization-bound authenticated data. The manifest declares organization cascade and export behavior while excluding ciphertext, browser hashes and consent state. Keep the separate DWD table and its per-user impersonation path intact. Both connection writers must take a transaction lock on the same organization row, check the other credential table, then write before committing; an earlier check outside that lock can allow two modes to bind simultaneously. The callback also requires the initiating browser cookie, single-use state, verified Google domain, and verified customer ID. Do not remove these checks during an upstream merge.

Deployment is default-off with `GOOGLE_WORKSPACE_ENABLED`. Configure one Google OAuth web client for the exact HTTPS `/api/v1/google/oauth/callback` URL, then set `CLOUDCOMMAND_GOOGLE_OAUTH_CLIENT_ID`, `CLOUDCOMMAND_GOOGLE_OAUTH_CLIENT_SECRET`, and `CLOUDCOMMAND_GOOGLE_OAUTH_REDIRECT_URI` in the API runtime. `APP_ENCRYPTION_KEY` and an active `APP_ENCRYPTION_KEY_ID` are also required: this mode refuses to save legacy non-AAD ciphertext. The Google Workspace administrator must authorize the requested Directory and Reports scopes in Extensions → Connect. A revoked grant or rotated client secret requires reconnecting; do not copy an old Cloud Command grant into the new table or expose it through an API/export. Disconnecting OAuth removes only that organization's OAuth row. For rollback, restore prior matched API/web images and disable Google Workspace; retain the additive tables for a forward recovery and leave DWD rows untouched. Deleting OAuth rows intentionally requires fresh consent later.

The OAuth mode currently provides bounded read-only users, groups, members, storage usage, security activity and Gmail audit trace where consented. Gmail per-user settings and account mutations remain DWD-only. Provider acceptance against the OS CONSULTANTS Workspace, pagination with real data, and representative controlled writes in DWD mode are separate live gates; the passing mock and PostgreSQL tests do not establish them.

## UniFi cross-organization sync repair (2026-09-22)

Implemented in [PR #27](https://github.com/osvendor/cloudcom/pull/27) and verified on the Linux test runner (34 unit tests, 8 PostgreSQL integration tests, 11 classifier tests, and a focused lock-helper TypeScript check): the UniFi worker acquires the complete organization export lock set before applying a sync in its existing database transaction. The set includes current mappings and existing integration device owners, so unordered mappings, remapping, and stale cleanup cannot acquire a lower organization lock after a higher one. This repairs repeat-sync rollbacks that previously surfaced as nested SQL errors while retaining the database lock hierarchy and RLS.

Affected paths: `apps/api/src/jobs/unifiWorker.ts`, `apps/api/src/services/unifi/unifiSyncLocks.ts`, their focused tests and the targeted CloudCom CI classifier/job. Upstream baseline remains v0.115.0. No migration, credentials, site mappings, approval state, or network configuration changes. Recovery uses the prior verified application images. Validation includes a real PostgreSQL negative control and successful multi-organization sync, plus existing UniFi reconciliation tests. Newly imported assets still require approval in Network Discovery before joining the network-device inventory. Deployment evidence is recorded privately after release verification.

## UniFi upstream preservation contract (2026-09-22)

Implemented in [PR #28](https://github.com/osvendor/cloudcom/pull/28). The `unifi-sync-lock-order` entry in `.github/cloudcom-customizations.json` requires the lock helper, worker, unit and PostgreSQL regression tests, and their worker/classifier/CI attachments. The updater checks the pre-merge registry and aborts even a conflict-free import that removes these attachments. Intentional upstream replacements require manual integration and contract review; substring checks do not prove semantic compatibility, so the existing unit and PostgreSQL CI gates remain required.

Verified on the Linux runner: 23 tests passed and the full customization contract passed. Commands: `node --test scripts/cloudcom/customization-contract.test.mjs scripts/cloudcom/update-upstream.test.mjs .github/scripts/cloudcom-delta.test.mjs` and `node scripts/cloudcom/customization-contract.mjs` on the Linux runner. The updater regression cases remove the real registered helper, worker call and classifier attachment independently and verify rollback to a clean original checkout. This protection changes the repository updater only; no application deployment, migration or configuration change is required. Upstream baseline remains v0.115.0.

## Client credential extension (2026-10-07)

Keep `packages/ext-credentials` separate during upstream intake. The additive
`credentials_records` migration enables and forces org RLS immediately; the
manifest owns erasure and metadata-only export and refuses automatic org merge.
Preserve its built-in default-off flag, Docker assets, API package dependency,
row-bound encryption registry entry, granular permission catalog/seed entries,
and strict `createAuditLog` injection (SDK queued audit is not sufficient before
secret disclosure). Keep the operational importer entry in the API bundle.

The vault supports imported passwords and TOTP. Remote-toolbar integration uses
the separate SessionCredentials adapter and checked viewer transforms; preserve
the client binding derived from the owned remote session. Clipboard integration
also uses checked transforms instead of manual edits to regenerated viewer code.
Editing is not provided. Tests and security/import limits are documented in
`packages/ext-credentials/README.md`.

Version 0.2.0 adds the sibling Documentation extension page and the additive
`credentials_documents` migration. Preserve the row-bound encryption registry,
metadata-only export and erasure/merge contracts, plus the operator importer
bundle entry. Workbook originals and previews share the credential permission
boundary. Native organization Documents and core navigation remain unchanged.
After migration, recovery must keep a schema-aware manifest even if the extension
is disabled. API built-in lifecycle tests validate the manifest/table naming and
tenancy declarations; run these alongside extension and importer tests at intake.

## Staff Edge companion (2026-10-08)

Extension version 0.3.0 adds the browser-companion page and fixed browser routes;
`packages/browser-companion` is the standalone, dependency-free MV3 pilot. Keep
these at the extension boundary during upstream intake. There are no schema,
core authentication, Cloudflare, agent or remote transport changes.

Preserve interactive partner-session checks, account verification policy, explicit
client binding and RLS, granular credential disclosure permissions and durable
fill audit. The dedicated Breeze bridge uses the existing session without giving
bearer tokens to the addon. Website matching is exact HTTPS origin; fill requires
a stable document, unique supported field and same-origin form action. The worker
accepts requests only from its own popup, never stores secrets and never submits
forms. Device icons open existing Remote Tools surfaces under existing policies.
Run addon Node tests plus extension server/web tests, typecheck and builds.
The pilot requires a manually enabled connection tab and is not a Store release.

### Browser-session companion candidate (not deployed)

The 0.2 development source adds optional side-panel/window workspaces and a
PKCE handoff to an opaque, browser-session-only token. Core attachment points are
`services/browserCompanionSession.ts`, `services/browserCompanionPolicy.ts`,
`routes/browserCompanion.ts`, one early transport mount in `index.ts`, and an
authorization callback injected through the credentials builtin registration.
The transport is disabled unless `CLOUDCOM_BROWSER_COMPANION_IDS` registers the
installation ID. Keep its narrow CORS separate from normal browser CORS. Each
request revalidates the original staff identity, client/device binding, IP policy,
and existing core authorization via bounded in-process dispatch. Never expose
the internal dispatch JWT to the addon. No database migration is introduced.

Addon session/workspace tests and API session/policy/transport tests are present.
Development validation: 54 focused API tests and six addon tests passed. This is
not browser acceptance: terminal integration, complete tool UI review, native
auto-connect tests, Cloudflare transport configuration, and end-to-end OS-TEST
acceptance remain release gates. Do not distribute the development package as a
finished update. The previously deployed tab-dependent pilot remains unchanged.

### Companion stable sections and client notes (2026-10-08)

Browser companion 0.5.1 adds persistent Work, Logins, Devices and Notes sections.
Device workspaces survive section switches but are discarded on client change or
lock. The selected device remains visible when filtering the selector. Notes use
the existing client-scoped document routes and canonical document section parser
(the browser document-sections.js is generated from ext-credentials import code).
All-client login metadata and explicit password/OTP copy reuse existing audited
vault routes. Website fill remains exact-origin scoped, uses a focused eligible
field when available, and never submits forms. Secrets are not persisted by the
extension; explicit Copy puts the requested value on the user's clipboard.

Affected boundaries: packages/browser-companion and the exact client route
allowlist in apps/api/src/services/browserCompanionPolicy.ts. No schema, upstream
viewer, Cloudflare rule, tenant permission or credential encryption changes.
Validation: browser tests cover client switches, preserved tool iframe, stale notes,
masked workbook secrets, focused field insertion and cross-origin form rejection;
transport tests reject mismatched clients, workspace vault calls and imports.
Recovery: restore the previous API bind and companion package. Do not remove vault
data or rewrite imported documents as part of reverting the UI.

### Compact one-click companion Scripts (2026-10-08)

Companion 0.5.2 replaces the spooler script form with one compact row: name, last
execution time, outcome, Run. Run performs the existing required preview internally
and executes only after successful validation, linking to the automatically ensured
Work ticket. Detailed deleted/failed counts and spooler state remain in existing
server-side ticket comments. No new endpoint or server deployment is required.
Ambiguous submissions retain their idempotency key and offer Check; reopening
tracks an existing execution without auto-executing a previous preview. Disposing
the panel prevents continuation from a preview. Last run means last execution,
not passive folder inspection. Relevant tests cover one-click sequence, failed
preflight, network ambiguity and reopen/disposal. Revert the companion package to
restore the old form; no database change.

### OS Companion selected-device IP scan (development, 2026-10-13)

The companion adds IP Scan beside Processes and Services, using the selected
endpoint's active IPv4 inventory and reported subnet mask. The API accepts an
inventory network ID, rechecks device/org/site access and active membership,
and never accepts a browser-supplied scan target. Missing masks and networks
larger than /24 are shown as unsupported rather than guessed or truncated.
Scans use existing network_discovery agent commands, reject offline dispatch,
and poll command results scoped to actor, device, submitted organization and
command type. No schema or agent changes are required.

Files: packages/browser-companion/workspace-network.js and its workspace,
policy and build wiring; apps/api/src/routes/systemTools/networkScan.ts,
browserCompanionPolicy.ts and companionWorkModel.ts. The work timeline records
scan start; command completion remains available through the command system.
The table shows IP, MAC, manufacturer and TCP 443 reachability (not a verified
HTTPS handshake). Discovery currently probes TCP 80/443/445 and available ARP;
nonresponding hosts may not be discovered and MAC/vendor may be unavailable.

Focused API tests cover masks, server-derived targets, access denial, inactive
network IDs, dispatch scoping and polling. UI tests cover inventory loading,
explicit scan start and stale results. This remains development-only: no store
submission, production deployment, or live endpoint acceptance is recorded.

### IP Scan default /24 override (2026-10-13)

Owner requested every scan default to /24. Network choices and dispatch now
calculate the /24 containing the selected device's active IPv4 address,
regardless of missing or different reported masks. This explicitly supersedes
the preceding mask-required/larger-network-disabled behavior. Private-address,
selected-device, organization, site and command-result checks remain. Nine
focused route tests pass, including missing, empty, /16 and /25 masks.

### IP Scan MAC vendor enrichment (2026-10-13)

The scan-results route now falls back to the existing local MAC vendor lookup
when the agent supplies no manufacturer. Explicit device manufacturer wins;
missing/unrecognized MACs remain unknown. manufacturerSource distinguishes
device identity from mac_oui (network-adapter vendor). No outbound lookup,
SNMP credentials, schema change or endpoint update is required. Focused scan
and MAC-lookup suites pass 24 tests. Store publication remains unchanged.

### IP Scan opportunistic public SNMP (2026-10-13)

Owner requested default read-only public SNMP, with nonresponders ignored.
Companion scan commands now include the snmp method and explicit public
community, using the existing agent's SNMPv2c discovery path with one-second
scan timeout. No device configuration or credentials are modified. Discovery
merges successful SNMP identity responses and retains ordinary port/ARP results
when SNMP is unavailable. MAC vendor fallback remains. The extension table
uses returned manufacturer; additional SNMP detail views are not implemented.
24 focused route/vendor tests passed. API-only deployment; no store release.

### IP Scan table and hostname (2026-10-13)

Companion network table now includes sortable/filterable hostname, read-only
TCP443 checkbox, and five resizable columns with keyboard and pointer handles.
A dedicated scroll wrapper and colgroup avoid generic service-table widths.
API enables agent reverse DNS and returns hostname with SNMP sysName fallback.
Existing org/site/actor scope is unchanged. 25 API/vendor tests and six UI tests
pass. API deployed at companion-ipscan-hostname-20261013; unpacked development
folder rebuilt with the registered public key. No store submission/version bump.

### IP Scan three-column layout (2026-10-13)

The table uses IP as a fixed first column and two configurable columns,
defaulting to Hostname and Manufacturer. Choices include Hostname, Manufacturer,
HTTPS and MAC address. Preferences contain only column field names in local
extension storage; scan results and client data are not persisted. Resizing,
filtering and sorting remain available. This is a development-extension UI
change only and requires no API deployment or store version change.

IP Scan compact header adjustment: 28px toolbar, 26px borderless field selectors, arrow-only sort buttons with accessible labels, tighter rows; existing eight UI tests pass. Development package rebuilt, store unchanged.

### Managed native direct transport qualification (2026-10-23)

Preserve the Oct13 server fleet UDP mode (`CLOUDCOM_UDP_TARGETS=*`) and absence
of forced-relay override. A requested managed UDP probe must not be suppressed
solely by the older TCP NAT classification. The native host69 mediator/helper
change is based on approved68 source1cf9f803; do not replace it with a different
working tree's unrelated native changes. Explicit relay/proxy policy, native
admission, peer/key binding, bounded punch slots/deadlines and relay consent stay.

Host69 is qualified by VM security/policy/wire tests, exact MSI extraction,
68-to69 upgrade/68 rollback/69 reupgrade and real secure direct/frame acceptance
inside OS-TEST. SERURE-DC and SERURE-APP have been upgraded with identities
preserved; their WAN direct desktop acceptance is still unresolved. Both now
perform UDP punching but receive no probe replies. The same OS-TEST runner
connects directly to BBD-DC, so do not call host installation health proof of
WAN traversal or repeatedly restart/reinstall endpoints to mask this symptom.
A bounded viewer port-discovery candidate remains VM-only and is not a release.

Keep immutable68/69 MSI download paths and old stable68 bytes while queued68
scripts still require that checksum. Saved default Probe/Repair version2 accepts
both reviewed payload pairs and requires effective TCP plus UDP firewall rules.
A separate, reviewed69 default-installer promotion is prepared but not applied.
The strict MSI upgrade tool preserves native identity, routing/enrollment and
installer ownership; a busy or timed-out installer cannot trigger a concurrent
rollback. Unknown or stock RustDesk payloads remain manual review.

### Core workload admission (2026-10-27, candidate)

Preserve policyEvaluationWorker capacity admission before transactions, single
worker concurrency, due-policy read/Redis separation, and existing afterCommit
ordering. Preserve monitorWorkAdmission: bounded concurrency, pressure admission
for new checks, received-result bypass, retained explicit jobs and coalesced repeat
ticks. Bounded aggregate workload logs must never change job outcomes. See
operations/cloudcom-capacity-safeguards.md. Local validation was authorized: 134 focused tests plus exact-candidate smoke checks passed. Deployment activation is recorded separately.

### UniFi disconnected-agent retry loop (2026-10-27)
Preserve agentAdmission's bounded configuration GET lane and downstream auth/RLS;
UniFi telemetry stays bulk. Preserve collector error backoff/Retry-After and
warning suppression without suppressing genuine assignment responses. Tests:
agentAdmission.test.ts, unifiTelemetry.test.ts, agent/internal/unifi package.
Server middleware17tests and existingroute23tests passed. Existing unrelated
routeclassification suite has5failures from3unclassifiednative/PAM routes; those
routes remain unchanged. Agent binary promotion is separate from API activation.

## Managed viewer UDP defaults — 2026-10-29
Viewer 1.0.7 adds ManagedViewerDefaults.cs to the launcher build. After payload
verification and before launch/URI handoff, the interactive user's missing
options.enable-udp-punch defaults to Y. Explicit values (including N), relay
preferences, other sections and session data remain unchanged. Writes use a
same-directory atomic replacement with backup; --verify is side-effect free.
Run ManagedViewerDefaults.test.cs with the helper using the .NET Framework C#
compiler. Tests cover empty/existing/deleted profiles, idempotence, scoped keys,
explicit opt-out, relay preservation, and backup. Do not move this to an elevated
MSI action: SYSTEM's profile does not configure the interactive viewer.
RemoteComputersPage and its expectations now reference viewer 1.0.7. No endpoint
agent, native transport/auth engine or database migration. Existing viewer users
must install the new MSI; this change is not a background fleet update.
Release evidence and package validation are recorded in the control-plane
viewer-1.0.7 directory. Portal component tests were attempted but blocked by this
host's Vitest setup-module resolution; no claim that those tests passed.


## Dedicated Linux Actions worker (2026-10-29)

The CloudCom workflows route trusted Linux jobs to `cloudcom-linux`, retain disposable pull-request workers, remove self-hosted package-install sudo, and bound native/candidate parallelism. Preserve the source/publication gates and the runner-routing regression in `scripts/cloudcom/runner-routing.test.mjs` during upstream imports. The externally provisioned job-start event gate is required because PR-controlled YAML can select runner labels; workflow routing alone does not isolate a public repository. Native platform signing remains separate. See [CI operations](cloudcom-ci.md) for prerequisites and trust boundaries. Rollback is the prior workflow revision; no application, endpoint or database change is involved.

## Breeze v0.125 intake (2026-10-29, validation in progress)

This intake combines upstream v0.125.0 with the current CloudCom fork as server
version 0.125.5. Native binary version remains 0.123.5 and automatic promotion
remains disabled pending separate platform qualification. Existing technician
viewer distribution and OS Companion publication are independent deliverables.

Preservation review covers Cloud Command, credentials and inline notes, IDrive,
Harmony, shared portal/native remote access, managed RustDesk authorization,
organization isolation, and CPU/database/background-work safeguards. The UniFi
collector combines upstream Retry-After and telemetry deferral with local failure
backoff and throttled logs; its preservation contract checks both deadlines and
wake enforcement. PAM cleanup guards move into the upstream extracted services.
CloudCom workflow ownership is retained instead of restoring retired upstream
release workflows.

The upstream database changes include destructive legacy AI/schema cleanup.
Rollback requires a verified database restore as well as prior images and runtime
configuration. A source checkpoint and a restore rehearsal precede live changes.
This entry does not certify deployment or completion; exact validation and
promotion receipts are recorded by the control plane.

## v0.128 remote-tool menu integration

The upstream #10922 Connect Desktop split menu supersedes the separate
`RemoteAccessAlternatives` button on `RemoteToolsPage`. Device-provided tools
and the default now flow through `remoteAccessProviders` and
`remoteAccessDefaultProviderId`; explicit choices are re-authorized by the
launch API. The existing CloudCom alternatives API/component remain available
for other consumers and are still protected by the customization inventory.

CloudCom behavior retained: browser desktop is the built-in default;
`preferBuiltIn` and `autoStart` are preserved; RustDesk picks (including menu
picks) require the same managed staff launch admission and exact device-bound
`cloudcom-remote://staff/connect/…` URI. A denied or unavailable managed
admission does not fall back to a password-bearing RustDesk launch or WebRTC.
When `preferBuiltIn` is set, the primary label reflects the browser viewer and
the otherwise-default provider remains available in the menu.

Validation on GIT: the 11 ConnectDesktopButton/RemoteToolsPage test files
covered 103 tests. Ten files passed initially; the split suite required its
legacy native-viewer assertion to select `viewerMode="native"` explicitly.
Its focused rerun passed all 23 tests. Added regressions cover explicit managed
menu success, 403/503 refusal, and the `preferBuiltIn` menu/label combination.

### v0.128 browser-viewer reconciliation

The browser clipboard transform preserves the upstream `handleReleaseStuckKeys` callback dependency. Regenerate browser modules with `node scripts/cloudcom/sync-browser-viewer.mjs` after intake; the sync and binding gates must pass. This intake refreshes reconnect/ICE trickle, session-end diagnostics, focus-ring and input-release dependencies while retaining browser clipboard, credential insertion and close/revocation behavior. The generated browser directory already routes to the dedicated sync/binding and behavioral UI gates; this does not allow unrelated source paths.
