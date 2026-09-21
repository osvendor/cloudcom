# CloudCom CI transition

At the user's request, all 17 inherited Breeze workflow definitions were removed. The 12 active workflows were disabled through GitHub; the other five were already disabled. Cancellation was requested for the remaining inherited CI run. Historical workflow records may remain visible in Actions.

CloudCom automation is temporarily paused. There is no replacement required CI gate yet, and this change does not establish release or deployment readiness. The existing CloudCom-owned Linux runner remains registered for future workflows. No LanternOps-owned runner was registered in the fork. The production server is unchanged.

## Replacement design

Use published Breeze releases as pinned baselines. The initial v0.115.0 tag resolves to commit 42427328a4efa002b018de0c87fd11c8d35f3719; the fork base dc724dbed1782e4336cffa07a3e0314c60087a67 adds only documentation.

Build CloudCom workflows around our cumulative customizations and the interfaces and dependencies they affect. Select relevant lint, type checks, unit and integration regressions, builds, and candidate application acceptance. New upstream releases do not automatically trigger the entire upstream development/release pipeline. Broaden checks when our changes affect authentication, tenant isolation, schemas, shared dependencies or agent protocols. Unknown paths need explicit impact assessment.

Restore secret detection and appropriate security checks in the replacement pipeline. Newly disclosed vulnerabilities need scheduled monitoring independently of code changes. Continue requiring approval for all external contributors. Never run untrusted PR code on the production server.

The existing Lightsail installation remains the production and application-testing destination. Deployment and acceptance must protect its running database and services. Unchanged upstream agents retain their upstream signatures and provenance.

## Retained source and upstream updates

Application tests, reusable action implementations and scripts remain in source for selective reuse. Some inherited workflow contract tests directly read the removed YAML files; those contracts describe the retired pipeline and must be adapted or retired when the replacement checks are implemented. A broad legacy test command is not expected to pass unchanged during this transition. Do not treat those missing-file failures as application regressions or silently skip application tests.

The inherited definitions remain recoverable from Git history at 6169b89cf148dbf5e4d90df11a769bca6e7ad7e5. Pre-removal uncommitted repairs were also saved locally. Future upstream merges may reintroduce workflow files: review that directory explicitly and preserve the CloudCom-owned automation policy. Do not re-enable inherited workflows as a side effect of an upstream update.

Branding, version naming and production deployment are unchanged. See [upstream maintenance](cloudcom-upstream-maintenance.md) for the customization register.
