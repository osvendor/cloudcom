#!/usr/bin/env bash
# Check the persistent Linux runner before scheduling the application suite.
set -euo pipefail
failed=0
for tool in git gh docker jq curl tar unzip bash; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "::error::Runner prerequisite missing: $tool"
    failed=1
  fi
done
if command -v docker >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  echo '::error::Runner cannot reach Docker. Check daemon state and runner group membership.'
  failed=1
fi
memory_kib=$(awk '/MemTotal:/ {print $2}' /proc/meminfo)
if (( memory_kib < 7 * 1024 * 1024 )); then
  echo '::error::Runner needs at least 8 GB assigned RAM; 16 GB is recommended for the full suite.'
  failed=1
fi
available_kib=$(df -Pk "${GITHUB_WORKSPACE:-.}" | awk 'NR == 2 {print $4}')
if (( available_kib < 20 * 1024 * 1024 )); then
  echo '::error::Runner needs at least 20 GB free for dependencies and Docker builds.'
  failed=1
fi
for path in apps/api apps/web agent .node-version scripts/security/scan-confidential.sh; do
  if [[ ! -e "$path" ]]; then
    echo "::error::Incomplete checkout: $path is missing. Restore a full working tree."
    failed=1
  fi
done
exit "$failed"
