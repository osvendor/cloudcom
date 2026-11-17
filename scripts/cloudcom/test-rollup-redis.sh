#!/usr/bin/env bash
set -euo pipefail
# Own only this unique disposable Redis; never attach to an existing service.
container="cloudcom-rollup-regression-${RANDOM}-$$"
created=0
cleanup() { if [ "$created" = 1 ]; then docker rm -f "$container" >/dev/null; fi; }
trap cleanup EXIT
# Binding fails closed if the dedicated localhost test port is already occupied.
docker create --name "$container" --memory 128m --publish 127.0.0.1:56389:6379 redis:8-alpine redis-server --save '' --appendonly no >/dev/null
created=1
docker start "$container" >/dev/null
ready=0
for attempt in $(seq 1 30); do
  if [ "$(docker exec "$container" redis-cli ping 2>/dev/null || true)" = PONG ]; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo 'Isolated Redis failed readiness' >&2; exit 1; }
ROLLUP_TEST_REDIS_PORT=56389 pnpm --filter @breeze/api exec vitest run src/jobs/metricRollupWorkAdmission.redis.test.ts --maxWorkers=1
