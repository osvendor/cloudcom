#!/usr/bin/env bash
# Fixed loopback-only disposable resources; never inherit production DB targets.
set -euo pipefail
project="cloudcom-reviewed-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
export BREEZE_TEST_PG_PORT=55436 BREEZE_TEST_REDIS_PORT=56383
export BREEZE_TEST_PG_CONTAINER="${project}-postgres" BREEZE_TEST_REDIS_CONTAINER="${project}-redis" BREEZE_TEST_NETWORK="${project}-network"
export NODE_ENV=test DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:55436/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:55436/breeze_test
export BREEZE_TEST_DB_URL="$DATABASE_URL" BREEZE_APP_DB_PASSWORD=breeze_test POSTGRES_PASSWORD=breeze_test
export REDIS_URL=redis://localhost:56383
export POLICY_PLAN_TEST_DATABASE_URL="$DATABASE_URL" DEVICE_IDENTITY_TEST_URL="$DATABASE_URL" CLOUDCOM_GUARD_TEST_REDIS_URL="$REDIS_URL"
export JWT_SECRET=test-jwt-secret-must-be-at-least-32-characters-long APP_ENCRYPTION_KEY=test-app-encryption-key-at-least-32-chars-long!! APP_ENCRYPTION_KEY_ID=test-key-1
cleanup() { docker compose --project-name "$project" -f docker-compose.test.yml down -v --remove-orphans; }
trap cleanup EXIT
docker compose --project-name "$project" -f docker-compose.test.yml up -d --wait
pnpm --filter @breeze/api db:migrate
pnpm --filter @breeze/api db:migrate
for migration in packages/ext-cloud-command/migrations/*.sql packages/ext-credentials/migrations/*.sql; do
  for repeat in 1 2; do
    docker compose --project-name "$project" -f docker-compose.test.yml exec -T postgres-test psql -v ON_ERROR_STOP=1 -U breeze_test -d breeze_test < "$migration"
  done
done
pnpm --filter @breeze/api exec vitest run --config vitest.config.cloudcom-reviewed-db.ts
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls-coverage.ts --maxWorkers=1
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls.ts --maxWorkers=1
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts --maxWorkers=1
