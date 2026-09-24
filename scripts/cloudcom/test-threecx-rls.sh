#!/usr/bin/env bash
# Runs the Cloud Command 3CX integration proof against a disposable, isolated
# compose stack. It never accepts caller-supplied database endpoints.
set -euo pipefail

project="cloudcom-threecx-ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
project="${project//[^a-zA-Z0-9_-]/-}"
export BREEZE_TEST_PG_PORT=127.0.0.1:55433
export BREEZE_TEST_REDIS_PORT=127.0.0.1:56380
export BREEZE_TEST_PG_CONTAINER="${project}-postgres"
export BREEZE_TEST_REDIS_CONTAINER="${project}-redis"
export BREEZE_TEST_NETWORK="${project}-network"
export NODE_ENV=test
export DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:55433/breeze_test"
export DATABASE_URL_APP="postgresql://breeze_app:breeze_test@localhost:55433/breeze_test"
export BREEZE_TEST_DB_URL="$DATABASE_URL"
export BREEZE_APP_DB_PASSWORD=breeze_test
export POSTGRES_PASSWORD=breeze_test
export REDIS_URL="redis://localhost:56380"
export JWT_SECRET=test-jwt-secret-must-be-at-least-32-characters-long
export APP_ENCRYPTION_KEY=test-app-encryption-key-at-least-32-chars-long!!
export APP_ENCRYPTION_KEY_ID=test-key-1

cleanup() {
  docker compose --project-name "$project" -f docker-compose.test.yml down -v --remove-orphans
}
trap cleanup EXIT

docker compose --project-name "$project" -f docker-compose.test.yml up -d --wait
pnpm --filter @breeze/api db:migrate
for migration in packages/ext-cloud-command/migrations/*.sql; do
  for _ in 1 2; do
    docker compose --project-name "$project" -f docker-compose.test.yml exec -T postgres-test \
      psql -v ON_ERROR_STOP=1 -U breeze_test -d breeze_test < "$migration"
  done
done
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/cloudCommandThreeCx.integration.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/cloudCommandGoogleOAuth.integration.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls-coverage.ts
