#!/usr/bin/env bash
# Run as root on the production host after uploading a signed, immutable
# artifact directory. Reuses the currently configured API image exactly.
set -euo pipefail

release_id="${1:-}"
[[ "$release_id" =~ ^[a-z0-9][a-z0-9-]{3,63}$ ]] || { echo 'invalid release id' >&2; exit 2; }
root='/opt/cloudcom'
compose_extra=()
if [[ -n "${CLOUDCOM_FEATURE_TEST_ROOT:-}" ]]; then
  [[ "$(id -u)" -ne 0 && "$CLOUDCOM_FEATURE_TEST_ROOT" == "$HOME"/* ]] \
    || { echo 'test root requires an unprivileged user and a directory under HOME' >&2; exit 2; }
  root="$CLOUDCOM_FEATURE_TEST_ROOT"
  compose_extra=(--test-root "$root/features")
else
  [[ "$(id -u)" -eq 0 ]] || { echo 'run as root' >&2; exit 2; }
fi
release_dir="$root/features/$release_id"
compose="$root/deployment/compose.json"
trust="$root/deployment/feature-trust"
[[ -d "$release_dir" && ! -L "$release_dir" ]] || { echo 'release directory missing' >&2; exit 2; }
[[ -f "$trust/feature-artifact.mjs" && -f "$trust/ed25519-public.pem" && -f "$trust/feature_compose.py" ]] || { echo 'feature trust files missing' >&2; exit 2; }
[[ ! -L "$compose" ]] || { echo 'Compose path is a symlink' >&2; exit 2; }
if find "$release_dir" -perm /022 -print -quit | grep -q .; then
  echo 'release artifact is writable by group or others' >&2; exit 2
fi

image="$(jq -er '.services.api.image' "$compose")"
worker_image="$(jq -er '.services["cloudcom-exchange-worker"].image' "$compose")"
# The verifier is installed outside the uploaded artifact and is run with no
# network or additional capabilities. It checks the signed exact image digest.
docker run --rm --pull=never --network=none --read-only --cap-drop=ALL \
  --security-opt no-new-privileges --entrypoint node \
  -v "$release_dir:/release:ro" -v "$trust:/trust:ro" "$image" \
  /trust/feature-artifact.mjs verify --root /release \
  --manifest /release/feature-manifest.json \
  --signature /release/feature-manifest.sig \
  --public-key /trust/ed25519-public.pem --expected-image "$image" \
  --expected-worker-image "$worker_image"
schema="$(jq -er '.schemaVersion' "$release_dir/feature-manifest.json")"
[[ "$schema" == 1 || "$schema" == 2 || "$schema" == 3 ]] || { echo 'invalid feature schema' >&2; exit 2; }
if [[ "$schema" == 3 ]]; then
  # Schema changes are irreversible by reverting the application mount. Require
  # an operator-created, hashed database backup before allowing API boot.
  backup_file="${CLOUDCOM_FEATURE_DB_BACKUP:-}"
  backup_sha="${CLOUDCOM_FEATURE_DB_BACKUP_SHA256:-}"
  [[ "$backup_sha" =~ ^[0-9a-f]{64}$ && -f "$backup_file" && ! -L "$backup_file" && -s "$backup_file" ]] \
    || { echo 'schema release requires a regular database backup and its SHA-256' >&2; exit 2; }
  [[ "$(readlink -f -- "$backup_file")" == "$root/deployment/backups/"* ]] \
    || { echo 'database backup must be inside deployment/backups' >&2; exit 2; }
  [[ "$(sha256sum -- "$backup_file" | cut -d ' ' -f1)" == "$backup_sha" ]] \
    || { echo 'database backup hash mismatch' >&2; exit 2; }
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$root/deployment/compose.before-feature-$release_id-$stamp.json"
candidate="$root/deployment/compose.feature-$release_id-$stamp.tmp.json"
worker_extra=()
if [[ "$schema" == 2 || "$schema" == 3 ]]; then worker_extra=(--expected-worker-image "$worker_image"); fi
migration_extra=()
if [[ "$schema" == 3 ]]; then
  mapfile -t migration_names < <(jq -er '.migrations[]' "$release_dir/feature-manifest.json")
  for name in "${migration_names[@]}"; do migration_extra+=(--migration-file "$name"); done
fi
python3 "$trust/feature_compose.py" --compose "$compose" --release-dir "$release_dir" \
  --expected-image "$image" --output "$candidate" "${worker_extra[@]}" "${migration_extra[@]}" "${compose_extra[@]}"
docker compose -f "$candidate" config --quiet
cp -p "$compose" "$backup"

changed=0
accepted=0
finish() {
  if [[ "$changed" -eq 1 && "$accepted" -eq 0 ]]; then
    cp -p "$backup" "$compose"
    if [[ "$schema" == 2 || "$schema" == 3 ]]; then docker compose -f "$compose" up -d --no-deps cloudcom-exchange-worker api >&2 || true
    else docker compose -f "$compose" up -d --no-deps api >&2 || true; fi
    echo "Feature promotion failed; restored $backup" >&2
  fi
  rm -f -- "$candidate"
}
trap finish EXIT
mv -f -- "$candidate" "$compose"
changed=1
if [[ "$schema" == 2 || "$schema" == 3 ]]; then docker compose -f "$compose" up -d --no-deps cloudcom-exchange-worker api
else docker compose -f "$compose" up -d --no-deps api; fi
container="$(docker compose -f "$compose" ps -q api)"
[[ -n "$container" ]] || { echo 'API container missing after promotion' >&2; exit 1; }
for attempt in {1..30}; do
  running="$(docker inspect "$container" --format '{{.State.Running}}')"
  [[ "$running" == true ]] || { echo 'API stopped after promotion' >&2; exit 1; }
  status="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}')"
  if [[ "$status" == healthy ]]; then accepted=1; break; fi
  [[ "$status" != unhealthy ]] || { echo 'API unhealthy after promotion' >&2; exit 1; }
  sleep 4
done
[[ "$accepted" -eq 1 ]] || { echo 'API health check timed out' >&2; exit 1; }
[[ "$(docker inspect "$container" --format '{{.Image}}')" == "$(docker image inspect "$image" --format '{{.Id}}')" ]] \
  || { accepted=0; echo 'API image changed unexpectedly' >&2; exit 1; }
if [[ "$schema" == 2 || "$schema" == 3 ]]; then
  worker_container="$(docker compose -f "$compose" ps -q cloudcom-exchange-worker)"
  [[ -n "$worker_container" ]] || { accepted=0; echo 'Exchange worker missing after promotion' >&2; exit 1; }
  for attempt in {1..30}; do
    status="$(docker inspect "$worker_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}')"
    if [[ "$status" == healthy ]]; then break; fi
    [[ "$status" != unhealthy ]] || { accepted=0; echo 'Exchange worker unhealthy after promotion' >&2; exit 1; }
    sleep 4
  done
  [[ "$status" == healthy ]] || { accepted=0; echo 'Exchange worker health check timed out' >&2; exit 1; }
  [[ "$(docker inspect "$worker_container" --format '{{.Image}}')" == "$(docker image inspect "$worker_image" --format '{{.Id}}')" ]] \
    || { accepted=0; echo 'Exchange worker image changed unexpectedly' >&2; exit 1; }
fi
echo "Promoted $release_id using the unchanged API image; Compose backup: $backup"
