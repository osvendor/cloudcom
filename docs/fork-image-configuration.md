# Fork application images

Application image namespaces are configurable without changing upstream agent package identities, release keys, or download provenance.

- CI builds and `scripts/smoke-guided-setup.sh` must use the same `GUIDED_SMOKE_IMAGE_PREFIX`, for example `ghcr.io/example/cloudcom`.
- `GUIDED_SMOKE_BINARIES_IMAGE_REF` remains independent. The default consumes upstream agent binaries; changing application image names does not imply that a fork publishes signed agents.
- For strict production deployment, set `BREEZE_IMAGE_PREFIX` (application images) and `BREEZE_RELEASE_REPOSITORY` (GitHub owner/repository containing the signed release inventory) in the deployment environment file.
- `BREEZE_BINARIES_IMAGE_PREFIX` independently selects the binaries image repository prefix and defaults to `ghcr.io/lanternops/breeze`.

All settings default to the upstream namespace for compatibility. A fork must publish its application images and a release inventory signed with its own configured trusted key before selecting fork release settings. The inventory must bind the exact application and binaries repositories and digests. `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`, digest pinning, and signature verification remain required; namespace configuration does not bypass them.

The root Compose setup already uses explicit `BREEZE_*_IMAGE_REF` values resolved from the signed inventory. The strict `deploy/docker-compose.prod.yml` setup uses the prefixes above plus `BREEZE_*_IMAGE_DIGEST` values. Keep these deployment modes consistent with their respective configuration templates.
