# CloudCom fork CI

The fork keeps Breeze's existing area classifier and the single `CI Success` result. Website-only changes run web/API checks without building native endpoint agents. Shared inputs, unknown paths, agent-facing API code, and CI changes retain broader validation. Native OS checks are still required when relevant; this is not a blanket test bypass.

## Local Linux runner

Use a dedicated disposable VM, labeled `self-hosted`, `linux`, `cloudcom`, with Docker access. Install Git, GitHub CLI (`gh`), jq, curl, tar, unzip, build-essential, ripgrep, and socat. Actions install the pinned Node, pnpm, and Go versions. Allocate 8 GB minimum / 16 GB recommended RAM, and at least 20 GB free disk (60 GB or larger disk recommended). Avoid running multiple runner services against the same work directory.

The `typecheck`, `test-api` (8 shards), `test-web` (4 shards), and `integration-test` (16 shards) jobs always use `ubuntu-24.04` hosted runners. For this public repository, GitHub documents 16 GB RAM for that label in its [hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). A single CloudCom worker would serialize the 28 test shards, and its assigned 8 GB cannot safely satisfy Type Check's 12 GB Node heap. Type Check also has a 30-minute deadline to bound pathological hangs. This limited routing leaves the remaining trusted-job and external-fork routing unchanged.

`check-cloudcom-runner.sh` reports missing tools, insufficient resources, and incomplete checkouts before the application jobs queue. The classifier uses a full checkout because persistent runners reuse working directories. Temporary scanner binaries live in `RUNNER_TEMP`, not `/usr/local/bin`.

External-fork PRs use GitHub-hosted Linux runners, and repository settings must require approval for **all external contributors**. Workflow routing is defense in depth, not protection from edits to the workflow itself: review external workflow changes before approval. Keep production credentials, application databases, and personal files off this VM. Docker access is effectively root access to the VM. Privileged disk/recovery tests use disposable hosted runners.

A private Hyper-V Default Switch address can change after reboot; this does not affect the runner's outbound GitHub registration. Discover its current address from Hyper-V or DHCP rather than committing an IP to workflows. Public repository fetches can use HTTPS; publishing changes should use an authenticated developer checkout, not a long-lived personal token on the runner.

## Fork references

See [fork image configuration](fork-image-configuration.md). Application builds use the fork namespace. Keep upstream licenses, module/package identities, and agent signing provenance intact until a separate signed fork-agent release process exists. The runner changes do not deploy the platform or modify its production databases.

Before merging an upstream update, run the workflow contract tests and the full CI suite. Preserve `CI Success` as the required branch check rather than requiring OS jobs that legitimately skip for website-only changes.
