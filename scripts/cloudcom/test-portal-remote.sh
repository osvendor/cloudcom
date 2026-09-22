#!/usr/bin/env bash
# Runs the customer portal remote-access proof against a disposable, isolated
# compose stack. Unit tests alone do not exercise the request role or RLS.
set -euo pipefail

project="cloudcom-portal-remote-ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
project="${project//[^a-zA-Z0-9_-]/-}"
export BREEZE_TEST_PG_PORT=127.0.0.1:55434
export BREEZE_TEST_REDIS_PORT=127.0.0.1:56381
export BREEZE_TEST_PG_CONTAINER="${project}-postgres"
export BREEZE_TEST_REDIS_CONTAINER="${project}-redis"
export BREEZE_TEST_NETWORK="${project}-network"
export NODE_ENV=test
export DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:55434/breeze_test"
export DATABASE_URL_APP="postgresql://breeze_app:breeze_test@localhost:55434/breeze_test"
export BREEZE_TEST_DB_URL="$DATABASE_URL"
export BREEZE_APP_DB_PASSWORD=breeze_test
export POSTGRES_PASSWORD=breeze_test
export REDIS_URL="redis://localhost:56381"
export JWT_SECRET=test-jwt-secret-must-be-at-least-32-characters-long
export APP_ENCRYPTION_KEY=test-app-encryption-key-at-least-32-chars-long!!
export APP_ENCRYPTION_KEY_ID=test-key-1

cleanup() {
  docker compose --project-name "$project" -f docker-compose.test.yml down -v --remove-orphans
}
trap cleanup EXIT

docker compose --project-name "$project" -f docker-compose.test.yml up -d --wait
pnpm --filter @breeze/api db:migrate

pnpm --filter @breeze/api exec vitest run \
  src/routes/orgPortalUsers.test.ts src/routes/portal/acceptInvite.test.ts \
  src/services/portalCompanyGateway.test.ts src/services/cfAccessJwt.test.ts \
  src/services/portalNativeLogin.test.ts src/routes/portal/nativeLogin.test.ts \
  src/routes/portal/accessMode.test.ts src/routes/portal/auth.test.ts src/routes/portal/authOrgStatusGate.test.ts \
  src/routes/portal/remote.test.ts src/routes/portal/remoteDesktop.test.ts src/routes/portal/remoteRateLimit.test.ts \
  src/services/portalNativeProof.test.ts src/services/portalRemoteAgent.test.ts src/services/portalRemoteLease.test.ts \
  src/services/portalRemoteSessionAuth.test.ts src/services/portalRemoteSessionStore.test.ts src/routes/agentWs.test.ts \
  src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/routes/devices/moveOrg.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/portalRemoteAccess.integration.test.ts src/__tests__/integration/portalRemoteLogin.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls-coverage.ts
PORTAL_STATE_BACKEND=redis pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/portalNativeLogin.integration.test.ts

pnpm --filter @cloudcom/ext-rustdesk-access typecheck
pnpm --filter @cloudcom/ext-rustdesk-access build:web
pnpm --filter @cloudcom/ext-rustdesk-access test
pnpm --filter @cloudcom/ext-rustdesk-access test:server
pnpm --filter @cloudcom/ext-rustdesk-access test:web

pnpm --filter @breeze/portal exec vitest run \
  src/lib/nativeLogin.test.ts src/components/remote/NativeSignInPage.test.tsx \
  src/components/portal/RemoteViewer.test.tsx src/lib/landing.test.ts src/lib/nextPath.test.ts \
  src/lib/protectedPaths.test.ts src/lib/remoteInput.test.ts src/middleware.test.ts
pnpm --filter @breeze/portal build
pnpm --filter @breeze/shared exec vitest run src/validators/portal.test.ts
pnpm --filter @breeze/web exec vitest run src/components/settings/OrgPortalUsersEditor.test.tsx
