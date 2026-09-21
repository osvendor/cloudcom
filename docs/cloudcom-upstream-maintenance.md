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
| Inherited workflow removal | Removed all 17 inherited YAML definitions from `.github/workflows/`; disabled all previously active inherited workflows in GitHub. CloudCom replacement checks are planned, not implemented. See [CI transition](cloudcom-ci.md). | Upstream merges must not restore automatic upstream pipelines. Retain our own runner, reusable scripts, application tests and signed upstream artifact provenance. | Verified zero active inherited workflows and zero remaining YAML definitions. No application change or deployment; automated validation is temporarily paused. |
| Change-focused validation | Planned: CloudCom cumulative-delta classification against a pinned upstream release, with tests for affected components and interfaces. Existing classifier source is retained for reference. | An upstream release import alone must not trigger the entire upstream pipeline. Unknown changes need impact assessment; auth/RLS/schema/protocol changes need corresponding regression coverage. | Replacement classifier and required checks remain to be implemented. |
| Application image sources | Implemented in `deploy/.env.example`, `deploy/docker-compose.prod.yml`, `scripts/prod/deploy.sh`, smoke workflows and `scripts/smoke-guided-setup.sh`. See [image configuration](fork-image-configuration.md). | Keep application and agent-binaries sources distinct. Preserve signed inventories, exact repository/digest binding and verification. Root Compose and strict production Compose have different configuration contracts. | Release-image consumer contracts; packaging and binary-source smoke checks; deploy a signed fork release to a disposable installation. |
| Security workflow transition | Inherited CodeQL and secret/security workflows retired with the rest of the pipeline. | Restore appropriate CloudCom security checks before relying on automated release readiness; retain external-contributor approval policy. | Earlier CodeQL success applies to the retired revision, not replacement automation. |
| Generated systemd unit verification | Isolated verification root in `scripts/check-guided-setup-systemd-unit.sh`. | Validate the actual generated unit without loading unrelated host units. Do not suppress errors in the generated unit. | Static renderer checks and actual Linux systemd verification in lint. |
| CloudCom visual branding | On hold at the user's request; keep existing website text, images, colors and branding unchanged. Existing partner/login and portal controls cover only some surfaces. | Do not apply a product rebrand during upstream integration. Preserve client overrides and upstream notices. | Existing branding and client-isolation regressions; no new branding work authorized by this register. |
| Compiled-in service modules | Planned: Microsoft 365, Google and 3CX through existing extension interfaces. | Do not reintroduce runtime third-party extension bundles. Review extension SDK changes and client-specific enablement/menu behavior. UI term is Clients; shared MSP settings belong under General. | Module-specific auth, client isolation, permissions, disabled-module behavior, API/UI and integration tests. |

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

CI contract follow-up: `apps/api/src/config/ciSuccessGatingContract.test.ts` explicitly recognizes the seven endpoint-gated jobs while still requiring their code/app/endpoint gates. `apps/api/src/config/envComposeParity.test.ts` classifies `BREEZE_RELEASE_REPOSITORY` as a host-side deployment input consumed by `scripts/prod/deploy.sh`, not an API container variable. Both targeted suites passed locally (112 tests); The inherited CI pipeline is now retired; replacement checks must assess these contracts for relevance before selecting them.

At the initial 2026-09-21 review, full CI was incomplete and an earlier Type Check had received a runner shutdown signal. The release workflow was still coupled to agent/desktop publishing, and repository Actions secrets were not configured. A verified application release path, signing configuration, fresh-install validation and recovery rehearsal are required before production cutover. Update this section when evidence resolves each item; do not infer readiness from the existence of configuration options.
