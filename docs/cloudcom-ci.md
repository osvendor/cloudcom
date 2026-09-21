# CloudCom CI and upstream updates

CloudCom owns two workflows: cloudcom-ci.yml and cloudcom-upstream.yml. The 17 inherited Breeze workflows remain retired. Reusable source tests and scripts remain available, but their existence is not evidence that they run in CloudCom CI.

## Validation

CloudCom CI runs on pull requests to main, pushes to main, and manual dispatch. It uses disposable GitHub-hosted workers; the existing CloudCom-owned worker is retained but is not required by these workflows. Production is not a PR runner.

The baseline in .github/cloudcom-baseline.json records the released upstream repository, tag and exact commit. CI verifies the published release, tag resolution and ancestry, then compares the cumulative fork tree against that baseline. This validates retained customizations after an upstream update without replaying the complete upstream development/release pipeline.

The initial fork changes are infrastructure and deployment configuration. Their checks cover environment/Compose parity, signed image consumers, generated systemd units, updater behavior, delta classification, workflow security/syntax and redacted secret detection. Secret detection also runs for documentation changes. CloudCom checks is the aggregate result; it requires the baseline and secret checks to succeed and rejects failed/cancelled applicable jobs.

Web changes select web tests and a build; native agent changes select Linux Go race tests. These are initial component checks, not complete cross-platform or deployment acceptance. API/schema/authentication and shared-dependency changes currently fail as unsupported until their relevant integration, tenant-isolation and compatibility checks are added. Other unmapped components likewise fail rather than silently pass. Add coverage in the same PR that introduces a new customization. Existing workflow-file contract tests describe retired automation and must be adapted before being used as replacement tests.

Security dependency/SAST monitoring and full candidate image/upgrade acceptance are separate readiness work; the current secret/workflow checks do not claim to replace them. CI does not publish or deploy images.

## Release updates

The upstream workflow checks published stable LanternOps/breeze releases weekly on Monday at 10:23 UTC and can be run manually from the default branch. Schedules become active only after this workflow is on the default branch. GitHub Actions must be permitted to create PRs; default workflow permissions stay read-only and the updater grants only its job the required write permissions.

When a new release is available, it verifies the old pinned tag still matches, imports the new release on a separate integration branch and updates the baseline. It preserves the complete CloudCom workflow directory, excluding upstream additions. It aborts unresolved non-workflow conflicts for manual resolution. It opens a draft PR and explicitly dispatches CloudCom CI because PRs created by GITHUB_TOKEN do not trigger normal PR workflows. Retries do not overwrite an existing branch.

Review release notes, changed dependencies and every retained customization, then verify checks for the exact final commit before merging. No automatic merge, server pull, reset or deployment occurs. Branch protection should require CloudCom checks. Updated release code is not executed inside the privileged updater job.

## Server preparation and deployment boundary

Prepare the fork in a separate directory from the live installation. The existing Lightsail server remains the production and application-testing destination. Before cutover, validate candidate images and configuration, signed inventories and agent provenance, database upgrade compatibility, and backup/recovery. CI success alone is not deployment acceptance.

Branding and version naming remain unchanged. Preserve upstream licenses, package identities and agent signatures. See [upstream maintenance](cloudcom-upstream-maintenance.md) for customization records.
