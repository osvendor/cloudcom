# CloudCom direct-code development and release boundary

CloudCom uses one persistent source checkout for ordinary development. Edit and run focused tests there without creating a branch, candidate image, or public version for every iteration. Git records an exact source checkpoint when integrating a LanternOps release or publishing a distributable release.

## When images are allowed

Build new CloudCom runtime images only for the commit that advances `.github/cloudcom-baseline.json` to a published LanternOps release. `cloudcom-candidate.yml` enforces this with `require-upstream-intake.mjs`, in addition to its exact-main-commit and successful-CI requirements. A routine CloudCom feature commit must not use the candidate-image workflow. Windows agent/MSI and RustDesk client packages are separate deliverables, not Docker images.

An upstream intake still requires a database/configuration backup, published-tag provenance, review of migrations and CloudCom attachments, tests, signed release inventory, and a health-checked deployment. No upstream image is substituted for a CloudCom image: PAM, remote access, and Extensions must be present in the combined source. Keep the running image and a tested rollback image per component; remove older unused candidates only after checking container references and recovery artifacts. Never prune application data volumes to reclaim image space.

## Ordinary CloudCom releases without new images

The desired path is a frozen source revision built on the existing test runner into versioned application artifacts, with a signed manifest containing each archive hash, source commit, upstream-runtime image digests, and expected database migration set. The production host verifies that manifest before unpacking into a new release directory. A read-only Compose override mounts the API, web, portal, and extension runtime artifacts over the compatible intake images; the affected containers are recreated with the **same** image digests. Keep the prior artifact directory and override for rollback. Do not edit files inside a running container or replace a live release directory in place.

Dependency and runtime compatibility are a hard gate: a feature release may use this path only when its runtime dependencies and image contract still match the intake images. Otherwise defer that feature to the next LanternOps intake, or obtain an explicit change to this rule. Before any schema migration, take and verify a database backup; an application rollback alone does not reverse migrations. Native agent releases retain their own MSI, version, manifest, and acceptance process.

**Current implementation status:** the image-build restriction is enforced. The signed artifact bundler, read-only mount override, atomic promotion/rollback, and end-to-end acceptance are not yet implemented. Until they pass on a disposable stack, do not present ordinary CloudCom source changes as production-ready via a no-image path. The v0.116.0 LanternOps intake may use the existing verified image deployment process because it is an upstream intake.
