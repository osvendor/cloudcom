## Codex and Other Agents

Everything above is shared with Claude Code (`CLAUDE.md`). This section applies to Codex and other agents that read `AGENTS.md`.

- **Skills.** Where a rule points at `.claude/skills/<name>/SKILL.md`, read that file; it is plain Markdown and applies to you too.
- **Advisor quorum.** When a Claude session runs you with `codex exec` for a second opinion, stay read-only: no edits, commits, or GitHub writes. Report your position and the reasons.
- **Branch names.** Never use a `codex/` (or any agent/vendor) prefix. Use `fix/<issue>-<slug>`, `feat/<issue>-<slug>`, `docs/<slug>`, `chore/<slug>`, `ops/<slug>`, `hotfix/<slug>`; lowercase kebab-case. `pr-<N>` / `pr-<N>-review` only for inspecting an existing PR.
- **PR titles** follow `fix(scope): summary` / `feat(scope): summary` / `docs(scope): summary` / `chore(scope): summary`, with `(#1234)` when tied to an issue.
- **Linking issues.** `Closes #1234` when the PR fully resolves the issue (the default). `Refs #1234` only for a partial fix or a community report the reporter must verify, and then say in the body which half shipped. Repeat the keyword per issue: `Closes #X, closes #Y`.

### CI Integration
- The inherited Breeze workflows have been removed at the user's request; CloudCom CI and a controlled upstream-release updater are implemented; see the CI guide for current coverage and deployment boundaries.
- Follow `docs/cloudcom-ci.md`: validate our changes and affected interfaces against a pinned released upstream baseline.
- Do not restore the upstream full pipeline during merges or claim automated coverage beyond the actual implemented checks.
- Application tests remain available; inherited workflow-file contracts need adaptation for the replacement pipeline.


## CloudCom Fork Maintenance

Read `docs/cloudcom-upstream-maintenance.md` before changing fork behavior or integrating upstream updates. Update its change register in the same PR as each CloudCom customization, including affected files, compatibility boundaries, tests, and migration/recovery implications. Distinguish planned work from implemented and verified work. Never treat a conflict-free merge or previous CI results as proof that a new upstream integration is safe.

## CloudCom Codex Delegation Policy

This policy governs Codex delegation for this project and takes precedence over the older `Codex Delegation` section below wherever they conflict. The primary Codex agent is the coordinator: it owns task scope, decisions, integration, and the final result.

- Delegate narrow, routine UI or documentation work to `gpt-5.6-luna` at low reasoning effort.
- Delegate ordinary, bounded implementation work to `gpt-5.6-terra` at medium reasoning effort.
- Keep architecture, security, client/tenant isolation, migrations, and final critical review with the primary agent.
- Give delegated agents only the context and files needed for their bounded task. Prefer scripts and CI for deterministic, repeatable work.
- Do not change global settings as part of project delegation. Do not claim token or cost savings without measurements.

