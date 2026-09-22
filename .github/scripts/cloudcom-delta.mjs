import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const baselinePath = new URL('../cloudcom-baseline.json', import.meta.url);
const docsPath = /^(?:docs\/|apps\/docs\/|scripts\/docs-review\/|README(?:\.[^/]+)?$|AGENTS\.md$|[^/]+\.mdx?$)/u;
const supported = [
  ['native', /^agent\//u],
];
const remoteAccessWebPaths = new Set([
  'apps/web/src/components/remote/RemoteToolsPage.tsx',
  'apps/web/src/components/cloudcom/RemoteAccessAlternatives.tsx',
  'apps/web/src/components/cloudcom/RemoteAccessAlternatives.test.tsx',
]);
// Only this reviewed API surface has change-focused coverage below. Unknown
// API, schema and portal changes continue to fail closed.
const remoteAccessApiPaths = new Set([
  'apps/api/src/services/monitors/monitorCompiler.ts',
  'apps/api/src/services/monitors/monitorCompiler.w04.test.ts',
  'apps/api/src/routes/devices/index.ts',
  'apps/api/src/routes/devices/cloudcomRemoteAccess.ts',
  'apps/api/src/routes/devices/cloudcomRemoteAccess.test.ts',
  'apps/api/src/services/cloudcom/remoteAccessOptions.ts',
  'apps/api/src/services/cloudcom/remoteAccessOptions.test.ts',
]);
// Customer portal remote access has its own bounded CI path. These entries are
// deliberately enumerated because the validation uses a disposable Postgres /
// Redis stack, real portal-login and authorization tests, plus the RLS coverage
// contract; unknown portal or schema work must still fail closed.
const portalRemoteApiPaths = new Set([
  'apps/api/src/routes/orgPortalUsers.ts', 'apps/api/src/routes/orgPortalUsers.test.ts',
  'apps/api/src/routes/portal/acceptInvite.test.ts',
  'apps/api/src/services/portalCompanyGateway.ts', 'apps/api/src/services/portalCompanyGateway.test.ts',
  'apps/api/src/services/cfAccessJwt.ts', 'apps/api/src/services/cfAccessJwt.test.ts',
  'apps/api/src/services/portalNativeLogin.ts', 'apps/api/src/services/portalNativeLogin.test.ts',
  'apps/api/src/routes/portal/nativeLogin.ts', 'apps/api/src/routes/portal/nativeLogin.test.ts',
  'apps/api/src/__tests__/integration/portalNativeLogin.integration.test.ts',
  '.env.example', 'docker-compose.yml',
  'apps/api/migrations/2026-09-21-portal-remote-access.sql',
  'apps/api/migrations/2026-09-21-portal-remote-session-prompt.sql',
  'apps/api/migrations/2026-09-22-portal-remote-assignment-identity.sql',
  'apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts',
  'apps/api/src/__tests__/integration/portalRemoteAccess.integration.test.ts',
  'apps/api/src/__tests__/integration/portalRemoteLogin.integration.test.ts',
  'apps/api/src/db/schema/index.ts', 'apps/api/src/db/schema/portal.ts', 'apps/api/src/db/schema/portalRemote.ts',
  'apps/api/src/extensions/builtinExtensions.test.ts', 'apps/api/src/extensions/builtinRegistry.test.ts', 'apps/api/src/extensions/builtinRegistry.ts',
  'apps/api/src/middleware/selfManagedDbContextRoutes.test.ts', 'apps/api/src/middleware/selfManagedDbContextRoutes.ts',
  'apps/api/src/routes/agentWs.test.ts', 'apps/api/src/routes/agentWs.ts',
  'apps/api/src/routes/devices/cascadeDelete.test.ts', 'apps/api/src/routes/devices/core.ts',
  'apps/api/src/routes/devices/moveOrg.coverage.test.ts', 'apps/api/src/routes/devices/moveOrg.test.ts', 'apps/api/src/routes/devices/moveOrg.ts',
  'apps/api/src/routes/portal/accessMode.test.ts', 'apps/api/src/routes/portal/accessMode.ts',
  'apps/api/src/routes/portal/auth.test.ts', 'apps/api/src/routes/portal/auth.ts', 'apps/api/src/routes/portal/authOrgStatusGate.test.ts',
  'apps/api/src/routes/portal/helpers.ts', 'apps/api/src/routes/portal/index.ts', 'apps/api/src/routes/portal/profile.ts',
  'apps/api/src/routes/portal/remote.test.ts', 'apps/api/src/routes/portal/remote.ts',
  'apps/api/src/routes/portal/remoteDesktop.test.ts', 'apps/api/src/routes/portal/remoteDesktop.ts',
  'apps/api/src/routes/portal/remoteRateLimit.test.ts', 'apps/api/src/routes/portal/remoteRateLimit.ts', 'apps/api/src/routes/portal/schemas.ts',
  'apps/api/src/services/orgMergeRegistry.ts', 'apps/api/src/services/portalNativeProof.test.ts', 'apps/api/src/services/portalNativeProof.ts',
  'apps/api/src/services/portalRemoteAgent.test.ts', 'apps/api/src/services/portalRemoteAgent.ts', 'apps/api/src/services/portalRemoteAuthority.ts',
  'apps/api/src/services/portalRemoteFeature.ts', 'apps/api/src/services/portalRemoteLease.test.ts', 'apps/api/src/services/portalRemoteLease.ts',
  'apps/api/src/services/portalRemoteSessionAuth.test.ts', 'apps/api/src/services/portalRemoteSessionAuth.ts',
  'apps/api/src/services/portalRemoteSessionStore.test.ts', 'apps/api/src/services/portalRemoteSessionStore.ts',
  'apps/api/src/services/remoteAccessLauncher.test.ts', 'apps/api/src/services/tenantCascade.ts', 'apps/api/src/services/tenantExportPolicyRegistry.ts',
]);
const portalRemoteWebPaths = new Set([
  'apps/web/src/components/settings/OrgPortalUsersEditor.tsx', 'apps/web/src/components/settings/OrgPortalUsersEditor.test.tsx',
  'apps/portal/src/pages/remote/native.astro', 'apps/portal/src/lib/nativeLogin.ts', 'apps/portal/src/lib/nativeLogin.test.ts',
  'apps/portal/src/components/remote/NativeSignInPage.tsx', 'apps/portal/src/components/remote/NativeSignInPage.test.tsx',
  'apps/portal/src/components/remote/NativeSignInConsent.tsx',
  'apps/portal/src/components/portal/LoginForm.tsx', 'apps/portal/src/components/portal/RemotePage.tsx',
  'apps/portal/src/components/portal/RemoteViewer.test.tsx', 'apps/portal/src/components/portal/RemoteViewer.tsx',
  'apps/portal/src/layouts/PortalLayout.astro', 'apps/portal/src/lib/api.ts', 'apps/portal/src/lib/auth.ts',
  'apps/portal/src/lib/landing.test.ts', 'apps/portal/src/lib/landing.ts', 'apps/portal/src/lib/nextPath.test.ts',
  'apps/portal/src/lib/nextPath.ts', 'apps/portal/src/lib/protectedPaths.ts', 'apps/portal/src/lib/remoteInput.test.ts',
  'apps/portal/src/lib/remoteInput.ts', 'apps/portal/src/middleware.test.ts', 'apps/portal/src/middleware.ts',
  'apps/portal/src/pages/index.astro', 'apps/portal/src/pages/remote/[sessionId].astro', 'apps/portal/src/pages/remote/index.astro',
]);
const rustdeskExtensionPaths = /^(?:packages\/ext-rustdesk-access\/(?:manifest\.json|package\.json|tsconfig\.json|tsup\.web\.config\.ts|vitest\.web\.config\.ts|migrations\/README\.md|src\/(?:authorization(?:\.test)?\.mjs|server\/index(?:\.test)?\.ts|web\/index(?:\.test)?\.ts))|packages\/ext-rustdesk-access\/README\.md)$/u;
const cloudCommandApiPaths = new Set([
  'apps/api/src/routes/extensionsWeb.test.ts',
  'apps/api/src/routes/extensionsWeb.ts',
  'apps/api/src/extensions/builtinExtensions.test.ts',
  'apps/api/src/extensions/builtinExtensions.ts',
  'apps/api/src/extensions/builtinRegistry.test.ts',
  'apps/api/src/extensions/builtinRegistry.ts',
  'apps/api/src/extensions/cloudCommandMicrosoft.ts',
  'apps/api/src/extensions/cloudCommandMicrosoft.test.ts',
  'apps/api/src/extensions/cloudCommandAdminRuntime.ts',
  'apps/api/src/extensions/cloudCommandAdminRuntime.test.ts',
  'apps/api/src/extensions/cloudCommandAdminAuthorization.ts',
  'apps/api/src/extensions/cloudCommandAdminAuthorization.test.ts',
  'apps/api/src/extensions/webRegistry.test.ts',
  'apps/api/src/extensions/webRegistry.ts',
  'apps/api/src/extensions/webAssets.test.ts',
  'apps/api/src/extensions/webAssets.ts',
  'apps/api/src/extensions/stageExtension.test.ts',
  'apps/api/src/extensions/stageExtension.ts',
  'apps/api/src/extensions/gateway.test.ts',
  'apps/api/src/extensions/gateway.ts',
  'apps/api/src/services/urlSafety.test.ts',
  'apps/api/src/services/urlSafety.tripwire.test.ts',
  'apps/api/src/services/urlSafety.ts',
  'apps/api/src/__tests__/integration/cloudCommandThreeCx.integration.test.ts',
  'apps/api/package.json',
  'apps/api/tsup.config.ts',
  'apps/api/Dockerfile',
  'docker/Dockerfile.api',
  'pnpm-lock.yaml',
]);
const cloudCommandWebPaths = new Set([
  'apps/web/src/components/extensions/ExtensionElementHost.tsx',
  'apps/web/src/components/extensions/ExtensionPageHost.test.tsx',
  'apps/web/src/components/extensions/ExtensionSlotHost.test.tsx',
  'apps/web/src/components/extensions/useExtensionNavigation.test.tsx',
  'apps/web/src/components/extensions/useExtensionNavigation.ts',
  'apps/web/src/components/layout/Sidebar.tsx',
  'apps/web/src/components/layout/Sidebar.extensions.test.tsx',
  'apps/web/src/lib/extensions/cloudCommandNavigationEvents.ts',
  'apps/web/src/lib/extensions/hostApi.test.ts',
  'apps/web/src/lib/extensions/hostApi.ts',
  'apps/web/src/lib/extensions/registry.test.ts',
  'apps/web/src/lib/extensions/registry.ts',
]);
const cloudCommandSharedPaths = new Set([
  'packages/extension-web-sdk/src/hostApi.ts',
  'packages/extension-web-sdk/src/index.ts',
]);
const infraPaths = new Set([
  'AGENTS.md', '.github/actionlint.yaml', '.github/actions/load-smoke-images/action.yml',
  '.github/scripts/check-cloudcom-runner.sh', '.github/scripts/ci-area-gating.test.mjs',
  '.github/scripts/ci-build-reuse.test.mjs', '.github/scripts/classify-pr-paths.sh',
  '.github/scripts/classify-pr-paths.test.mjs', '.github/scripts/mobile-native-ci.test.mjs',
  '.github/scripts/prepare-ci-apt-sources.test.mjs', 'deploy/.env.example',
  'deploy/docker-compose.prod.yml', 'scripts/check-guided-setup-systemd-unit.sh',
  'scripts/check-guided-setup-signed-image-floor.sh', 'scripts/prod/deploy.sh',
  'scripts/release/release-image-consumers.test.mjs', 'scripts/smoke-guided-setup.sh',
]);

export function readBaseline(text = readFileSync(baselinePath, 'utf8')) {
  const baseline = JSON.parse(text);
  if (baseline.repository !== 'LanternOps/breeze') throw new Error('baseline.repository must be LanternOps/breeze');
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][\w.-]+)?$/u.test(baseline.tag ?? '')) throw new Error('baseline.tag must be a release tag');
  if (!/^[0-9a-f]{40}$/u.test(baseline.commit ?? '')) throw new Error('baseline.commit must be a 40-character SHA');
  return baseline;
}

export function classify(paths) {
  const result = { api: false, web: false, shared: false, native: false, infra: false, portalRemote: false, unsupported: [] };
  for (const path of paths.filter(Boolean)) {
    if (path === 'packages/shared/src/validators/portal.ts' || path === 'packages/shared/src/validators/portal.test.ts') {
      result.shared = true;
      result.api = true;
      result.web = true;
      result.portalRemote = true;
      continue;
    }
    if (path === 'deploy/remote-identity/README.md') continue;
    if (['deploy/remote-identity/compose.yml', 'deploy/remote-identity/.env.example', 'deploy/remote-identity/.gitignore',
      'deploy/remote-identity/custom-templates/.gitkeep', 'deploy/remote-identity/secrets/.gitkeep',
      'deploy/remote-identity/company-login.yaml'].includes(path)) {
      result.infra = true;
      continue;
    }
    if (docsPath.test(path) || path === 'packages/ext-cloud-command/README.md' || path === 'packages/ext-rustdesk-access/README.md') continue;
    if (portalRemoteApiPaths.has(path)) {
      result.api = true;
      result.portalRemote = true;
      if (path === '.env.example' || path === 'docker-compose.yml') result.infra = true;
      continue;
    }
    if (portalRemoteWebPaths.has(path)) {
      result.web = true;
      result.portalRemote = true;
      continue;
    }
    if (rustdeskExtensionPaths.test(path)) {
      result.api = true;
      result.web = true;
      result.portalRemote = true;
      continue;
    }
    if (remoteAccessApiPaths.has(path)) {
      result.api = true;
      continue;
    }
    if (cloudCommandApiPaths.has(path) || /^packages\/ext-cloud-command\/(?:manifest\.json|package\.json|tsconfig\.json|tsup\.web\.config\.ts|vitest\.web\.config\.ts|migrations\/(?:2026-09-21-threecx-connections|2026-09-22-microsoft-connections|2026-09-22-native-admin-connections)\.sql|src\/(?:server|threecx|web)\/.+)$/u.test(path)) {
      result.api = true;
      result.web = true;
      continue;
    }
    if (cloudCommandWebPaths.has(path)) {
      result.web = true;
      continue;
    }
    if (cloudCommandSharedPaths.has(path)) {
      result.shared = true;
      continue;
    }
    if (remoteAccessWebPaths.has(path) || path.startsWith('apps/web/src/components/cloudcom/browserDesktop/') ||
        /^apps\/web\/src\/components\/remote\/ConnectDesktopButton(?:\.[\w]+)*\.tsx$/.test(path)) {
      result.web = true;
      continue;
    }
    if (path === 'apps/api/src/config/envComposeParity.test.ts') {
      result.infra = true;
      continue;
    }
    if (infraPaths.has(path) || path.startsWith('.github/workflows/') || path.startsWith('.github/cloudcom-') || path.startsWith('.github/scripts/cloudcom-') || path.startsWith('scripts/cloudcom/')) {
      result.infra = true;
      continue;
    }
    const category = supported.find(([, pattern]) => pattern.test(path))?.[0];
    if (category) result[category] = true;
    else result.unsupported.push(path);
  }
  return { ...result, docsOnly: paths.length > 0 && Object.values(result).every((value) => value === false || Array.isArray(value) && value.length === 0) };
}

function changedPaths(baseline) {
  execFileSync('git', ['cat-file', '-e', `${baseline.commit}^{commit}`], { stdio: 'inherit' });
  execFileSync('git', ['merge-base', '--is-ancestor', baseline.commit, 'HEAD'], { stdio: 'inherit' });
  return execFileSync('git', ['diff', '--name-only', baseline.commit, 'HEAD'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
}

function output(result) {
  for (const [name, value] of Object.entries(result)) {
    const rendered = Array.isArray(value) ? value.join(',') : String(value);
    process.stdout.write(`${name}=${rendered}\n`);
  }
}

function verifyRemoteTag(baseline) {
  const remote = `https://github.com/${baseline.repository}.git`;
  const [releaseTag, draft, prerelease] = execFileSync('gh', ['api', `repos/${baseline.repository}/releases/tags/${baseline.tag}`, '--jq', '[.tag_name, .draft, .prerelease] | @tsv'], { encoding: 'utf8' }).trim().split('\t');
  if (releaseTag !== baseline.tag || draft !== 'false' || prerelease !== 'false') throw new Error(`baseline ${baseline.repository}@${baseline.tag} is not a published stable release`);
  const refs = execFileSync('git', ['ls-remote', '--tags', remote, `refs/tags/${baseline.tag}`, `refs/tags/${baseline.tag}^{}`], { encoding: 'utf8' });
  const tagCommit = refs.split('\n').map((line) => line.split('\t')).find(([, ref]) => ref === `refs/tags/${baseline.tag}^{}`)?.[0]
    ?? refs.split('\n').map((line) => line.split('\t')).find(([, ref]) => ref === `refs/tags/${baseline.tag}`)?.[0];
  if (tagCommit !== baseline.commit) {
    throw new Error(`baseline ${baseline.repository}@${baseline.tag} resolved to ${tagCommit || 'nothing'}, expected ${baseline.commit}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseline = readBaseline();
  if (process.argv.includes('--verify-remote')) verifyRemoteTag(baseline);
  const classification = classify(changedPaths(baseline));
  if (classification.unsupported.length > 0) {
    console.error(`Unsupported cumulative-delta paths:\n${classification.unsupported.map((path) => `  - ${JSON.stringify(path)}`).join('\n')}`);
  }
  const result = {
    baseline_commit: baseline.commit,
    api: classification.api,
    web: classification.web,
    shared: classification.shared,
    native: classification.native,
    infra: classification.infra,
    portalRemote: classification.portalRemote,
    docsOnly: classification.docsOnly,
    unsupported: classification.unsupported.length > 0,
  };
  const lines = Object.entries(result).map(([name, value]) => `${name}=${String(value)}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  } else output(result);
}
