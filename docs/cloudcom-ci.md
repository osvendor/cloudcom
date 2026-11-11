# CloudCom CI and upstream updates

CloudCom owns four workflows: cloudcom-ci.yml, cloudcom-upstream.yml, cloudcom-candidate.yml and cloudcom-runner-smoke.yml. The 17 inherited Breeze workflows remain retired. Reusable source tests and scripts remain available, but their existence is not evidence that they run in CloudCom CI.

## Validation

CloudCom CI runs on pull requests to main, pushes to main, and manual dispatch. Pull requests use disposable GitHub-hosted workers. Pushes to main and maintainer-dispatched runs in this repository use the dedicated Linux worker labelled `cloudcom-linux`; this includes updater-dispatched integration branches. Production is not a runner.

The worker runs one job at a time under a dedicated account, separate from the development checkout. Provision Node 22, pnpm 10.34.5, Go matching agent/go.mod, GitHub CLI, Python 3, Docker/Compose, PowerShell with Pester 5.7.1, build-essential, pkg-config and libpcap-dev before starting it. CI installs temporary tools without sudo. Native Go tests use one package worker and candidate builds serialize their matrix. The 4 GB worker starts with a 2 GB Node heap limit and two Go processors; this is a capacity bound, not evidence that every full build fits.

Because this is a public repository, workflow routing alone is not a security boundary: a pull request can edit its own workflow. The service must enforce a root-owned job-start hook outside the checkout that rejects pull_request/pull_request_target and foreign repositories before any job step. Permit only main pushes, main scheduled runs, and maintainer-dispatched same-repository branches; missing/unknown event context fails closed. Do not run the service without that gate. Keep production SSH material and signing secrets off this worker. Native Windows/macOS and privileged signing jobs remain on their matching hosted workers until separately isolated runners exist.

The weekly updater and manual candidate preparation also use `cloudcom-linux`. Their existing default-branch and verified-source checks remain mandatory. A worker outage queues those jobs; it does not trigger a production fallback. Runner provisioning, registration and live job evidence are recorded privately, not in this public repository. Run the manual CloudCom Runner Smoke workflow from the default branch after provisioning or moving the worker; it verifies the runner environment and installed tools without checkout, builds or deployment.

The baseline in .github/cloudcom-baseline.json records the released upstream repository, tag and exact commit. CI verifies the published release, tag resolution and ancestry, then compares the cumulative fork tree against that baseline. This validates retained customizations after an upstream update without replaying the complete upstream development/release pipeline.

The initial fork changes are infrastructure and deployment configuration. Their checks cover environment/Compose parity, signed image consumers, generated systemd units, updater behavior, delta classification, workflow security/syntax and redacted secret detection. Secret detection also runs for documentation changes. CloudCom checks is the aggregate result; it requires the baseline and secret checks to succeed and rejects failed/cancelled applicable jobs.

The optional remote-tool module has an exact API/web path allowlist, focused launcher/authorization/UI lifecycle regressions, and API/web builds. Unmapped web/API changes, schema/authentication changes, portal changes and shared dependencies fail as unsupported until their relevant checks are added. Native agent changes select Linux Go race tests. These component checks are not complete cross-platform, real-DB RLS or deployment acceptance. Add coverage in the same PR that introduces a new customization. Existing workflow-file contract tests describe retired automation and must be adapted before being used as replacement tests.

Security dependency/SAST monitoring and full candidate image/upgrade acceptance are separate readiness work; the current secret/workflow checks do not claim to replace them. CI does not publish or deploy images.

Customer remote access now selects `scripts/cloudcom/test-portal-remote.sh` through
an enumerated path set. That check creates its own PostgreSQL/Redis stack, applies
core migrations, and runs real portal-login, assignment/session isolation and RLS
contracts alongside the focused API and portal tests, extension checks and portal
build. Other portal/schema paths remain unsupported until explicitly covered.
This wiring is separate from real Windows/browser acceptance and does not enable
or prove the unfinished native RustDesk transport.

## Reviewed cumulative feature groups

`.github/cloudcom-reviewed-impacts.json` registers exact additional fork paths with their behavioral tests and commands. `scripts/cloudcom/validate-reviewed-fork.mjs` selects groups from the complete diff against the pinned upstream baseline and runs them serially. This supplements the older focused gates; it does not enable all upstream workflows or claim full upstream CI coverage. A neighboring unregistered product path still fails classification. Adding a path requires a reviewed source/test mapping and a real validation command, not a blanket directory allowlist.

| Group | Required validation |
| --- | --- |
| API runtime | Named alert, capacity, rollout, integration, authentication and Companion service tests; API bundle build |
| Database and security | Database unit tests; disposable PostgreSQL and Redis; core migrations replayed; extension migrations replayed; real Harmony isolation/publication, prepared-query RLS, device identity and atomic rollout tests; RLS coverage and tenant export/erasure |
| Browser Companion | Package Node behavioral tests |
| Credentials and notes | Extension typecheck, server/import tests, browser tests and web bundle |
| Cloud Command | Extension typecheck, server and browser suites and web bundle |
| Web UI | Named changed UI tests and web/portal builds |
| Shared contracts | Google delegation scope tests and consuming extension typechecks |
| Release artifacts | Version, signed-artifact and viewer-updater tests; compose generation tests; promotion script syntax |

The Linux runner requires Docker Compose, Node/pnpm, Python 3, Bash and `zip` (the native updater packaging contract uses a real STORED archive). Missing tools fail the gate; they are not grounds to skip packaging tests.

The database gate owns fixed loopback-only disposable ports and never accepts production database endpoints. It explicitly enables the opt-in real Redis, prepared-policy and device-identity tests; an unset opt-in variable must not be mistaken for a successful proof. Container teardown runs on exit. The runner stops on the first failing command, and skipped or unexecuted groups must be reported as such. Classifier tests alone prove routing, not product behavior.

Windows acceptance is separate: validate the actual signed candidate binaries on the Windows test endpoint, including service startup/update, sign-in and locked desktop capture, Web Remote, and the managed RustDesk direct/relay paths appropriate to the change. Linux tests, bundling, structural contracts and this manifest do not establish Windows desktop or installer acceptance. Production promotion also requires the exact final commit's CI result, restored-database rehearsal, provenance and rollback checks described below.

## Release updates

The upstream workflow checks published stable LanternOps/breeze releases weekly on Monday at 10:23 UTC and can be run manually from the default branch. Schedules become active only after this workflow is on the default branch. GitHub Actions must be permitted to create PRs; default workflow permissions stay read-only and the updater grants only its job the required write permissions.

When a new release is available, it verifies the old pinned tag still matches, imports the new release on a separate integration branch and updates the baseline. It preserves the complete CloudCom workflow directory, excluding upstream additions. It aborts unresolved non-workflow conflicts for manual resolution. It opens a draft PR and explicitly dispatches CloudCom CI because PRs created by GITHUB_TOKEN do not trigger normal PR workflows. Retries do not overwrite an existing branch.

Registered customization files and attachment points in `.github/cloudcom-customizations.json` are checked against the contract loaded before merging. Losing a module or hook aborts the merge even without Git conflicts. CI repeats the structural check and behavior tests; this does not prove semantic compatibility with a new release.

Review release notes, changed dependencies and every retained customization, then verify checks for the exact final commit before merging. No automatic merge, server pull, reset or deployment occurs. Branch protection should require CloudCom checks. Updated release code is not executed inside the privileged updater job.

## Server preparation and deployment boundary

Prepare the fork in a separate directory from the live installation. The existing Lightsail server remains the production and application-testing destination. Before cutover, validate candidate images and configuration, signed inventories and agent provenance, database upgrade compatibility, and backup/recovery. CI success alone is not deployment acceptance.

Branding and version naming remain unchanged. Preserve upstream licenses, package identities and agent signatures. See [upstream maintenance](cloudcom-upstream-maintenance.md) for customization records.

## Candidate image preparation

CloudCom Candidate Images is manual-only on the default branch. Its source_commit input must be an exact commit ancestral to the default branch with a successful push-triggered CloudCom CI run. It must also be the commit that advances the pinned LanternOps baseline; routine CloudCom feature releases do not build images. See [direct-code deployment](cloudcom-direct-code-deployment.md) for the intended no-image path and its current implementation gate. The workflow builds Linux amd64 API, web and portal runtime images, plus a migration-only builder image, from the selected intake commit. Version metadata comes from that commit’s upstream baseline.

The workflow exports gzip image archives, SHA256SUMS and exact Docker image IDs as seven-day Actions artifacts. It does not publish a release, push registry tags or deploy. Verify archive hashes and loaded image IDs before using them. These preparation artifacts do not replace signed production release inventories.

Run the migration builder’s pnpm db:migrate command only against an isolated restored database, without Redis or external networking. Normal API startup initializes additional services; do not use it as a migration-only command. Re-run migrations to verify idempotence and test the unprivileged request role. Candidate app acceptance should use a separate disposable database/network. Preserve private backup/configuration and test records outside the public repository.

For promotion of verified local archives without registry publication, follow [local image promotion](cloudcom-local-release.md). It still requires a signed inventory and exact image bindings.
