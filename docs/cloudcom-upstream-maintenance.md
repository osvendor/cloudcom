# CloudCom upstream maintenance

This guide records how the CloudCom fork differs from LanternOps/Breeze and how to integrate upstream changes. Maintain it with the code; it is not a guarantee that future merges will be conflict-free or regression-free.

## Baseline and ownership

- Fork: `osvendor/cloudcom`; upstream: `LanternOps/breeze`.
- Initial fork PR: https://github.com/osvendor/cloudcom/pull/1.
- Base reviewed for that PR: `dc724dbed1782e4336cffa07a3e0314c60087a67`.
- CI repair revision reviewed on 2026-09-21: `695985321e95e8be66b81babe706f204c431c9de`. Full CI was still pending at review time. This is not a production release or a last-known-good deployment marker.
- Keep exact upstream and fork commit IDs in each integration PR. Record deployed image digests and database migration state separately in private operational records.
- Never put server addresses, secrets, signing keys, or internal domain mappings in this public guide.

## Change register

| Area | Current state and files | Upstream merge considerations | Validation |
| --- | --- | --- | --- |
| Runner and workflow routing | Implemented in `.github/workflows/`, `.github/scripts/check-cloudcom-runner.sh`, and `.github/actionlint.yaml`. See [CI guide](cloudcom-ci.md). | Preserve hosted routing for external PRs and privileged/native jobs, full checkout, contributor approval, and required CI Success semantics. One local runner serializes jobs; queued does not necessarily mean stalled. | Actionlint; runner-routing and workflow contract tests; fresh full CI on integration head. |
| Area/native check selection | Implemented in `.github/scripts/classify-pr-paths.sh` and `.github/workflows/ci.yml`. | Shared, unknown, CI and agent-facing changes must retain broad checks. Legitimate skips must not hide failed or missing checks. | Classifier, area-gating, build-reuse and mobile-native contracts; representative path fixtures; CI Success. |
| Application image sources | Implemented in `deploy/.env.example`, `deploy/docker-compose.prod.yml`, `scripts/prod/deploy.sh`, smoke workflows and `scripts/smoke-guided-setup.sh`. See [image configuration](fork-image-configuration.md). | Keep application and agent-binaries sources distinct. Preserve signed inventories, exact repository/digest binding and verification. Root Compose and strict production Compose have different configuration contracts. | Release-image consumer contracts; packaging and binary-source smoke checks; deploy a signed fork release to a disposable installation. |
| CodeQL runtime | Explicit pinned Node setup in `.github/workflows/codeql.yml`. | Self-hosted runners cannot assume hosted Node availability. Retain both TypeScript and Go security analysis. | Successful CodeQL extraction and analysis for both languages. |
| Generated systemd unit verification | Isolated verification root in `scripts/check-guided-setup-systemd-unit.sh`. | Validate the actual generated unit without loading unrelated host units. Do not suppress errors in the generated unit. | Static renderer checks and actual Linux systemd verification in lint. |
| CloudCom visual branding | Planned; not implemented as a global brand change. Existing partner/login and portal controls cover only some surfaces. | Prefer centralized display defaults with client overrides. Hardcoded web titles/fallbacks and auth email strings need explicit coverage. Preserve theme and upstream notices. | Login, setup/error pages, sidebar, browser titles/favicon, portal domain resolution, system emails; safe logo handling and client isolation. |
| Compiled-in service modules | Planned: Microsoft 365, Google and 3CX through existing extension interfaces. | Do not reintroduce runtime third-party extension bundles. Review extension SDK changes and client-specific enablement/menu behavior. UI term is Clients; shared MSP settings belong under General. | Module-specific auth, client isolation, permissions, disabled-module behavior, API/UI and integration tests. |

## Compatibility boundaries

CloudCom is the intended displayed product name. Do not use a repository-wide Breeze-to-CloudCom replacement. Preserve these identifiers unless a separate compatibility migration is designed and tested:

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
5. Run relevant local contracts and fresh required CI/security checks against the final integration head. Earlier green checks do not validate a later commit. Investigate runner failures separately from application failures; never remove required checks simply to merge.
6. Build the exact candidate images. Verify signed inventories and digest bindings. Exercise a disposable fresh installation and, when supporting existing data, an upgrade from the last deployed schema. Check login/MFA, cross-client denial, module permissions, agent enrollment/heartbeat, portal, background jobs and changed branding surfaces.
7. Record results and unresolved blockers in the integration PR. Prepare a recovery plan that accounts for database changes: rolling back images alone may be insufficient after migrations. Verify the relevant backup/restore path before deployment.
8. Deploy only through the approved release process. Verify running component versions/digests, health and user flows. Update the change register and private deployment record with the outcome.

## Required record for each customization

Include the purpose, status (planned/implemented/verified/deployed), affected paths, upstream baseline, compatibility assumptions, tests and their results, configuration/migration requirements, and recovery implications. Link the implementing PR. If an upstream update makes the customization unnecessary, record its removal rather than carrying it forever.

## Open readiness items

At the initial 2026-09-21 review, full CI was incomplete and an earlier Type Check had received a runner shutdown signal. The release workflow was still coupled to agent/desktop publishing, and repository Actions secrets were not configured. A verified application release path, signing configuration, fresh-install validation and recovery rehearsal are required before production cutover. Update this section when evidence resolves each item; do not infer readiness from the existence of configuration options.
