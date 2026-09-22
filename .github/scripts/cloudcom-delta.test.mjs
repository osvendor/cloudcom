import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, readBaseline } from './cloudcom-delta.mjs';

test('browser viewer changes require web validation while unrelated web surfaces fail closed', () => {
  for (const path of ['apps/web/src/components/cloudcom/browserDesktop/browserFetch.ts', 'apps/web/src/components/remote/ConnectDesktopButton.tsx', 'apps/web/src/components/remote/ConnectDesktopButton.browser.test.tsx']) {
    assert.equal(classify([path]).web, true);
    assert.deepEqual(classify([path]).unsupported, []);
  }
});

test('baseline accepts a valid release fixture and rejects an arbitrary repository', () => {
  assert.deepEqual(readBaseline(JSON.stringify({
    repository: 'LanternOps/breeze', tag: 'v9.8.7', commit: 'a'.repeat(40),
  })), {
    repository: 'LanternOps/breeze', tag: 'v9.8.7', commit: 'a'.repeat(40),
  });
  assert.throws(() => readBaseline(JSON.stringify({
    repository: 'untrusted/example', tag: 'v9.8.7', commit: 'a'.repeat(40),
  })), /LanternOps\/breeze/);
});

test('classifies supported web, native, and explicit infrastructure changes', () => {
  assert.deepEqual(classify(['apps/web/src/components/remote/RemoteToolsPage.tsx', 'agent/main.go', 'deploy/docker-compose.prod.yml']), {
    api: false, web: true, shared: false, native: true, infra: true, portalRemote: false, unsupported: [], docsOnly: false,
  });
  assert.deepEqual(classify(['apps/api/src/routes/devices.ts']).unsupported, ['apps/api/src/routes/devices.ts']);
  assert.deepEqual(classify(['packages/shared/src/types.ts']).unsupported, ['packages/shared/src/types.ts']);
  assert.deepEqual(classify(['apps/web/src/pages/index.astro']).unsupported, ['apps/web/src/pages/index.astro']);
  assert.equal(classify(['apps/api/src/config/envComposeParity.test.ts']).infra, true);
});

test('skips a docs-only delta and rejects unsupported product surfaces', () => {
  assert.equal(classify(['docs/cloudcom-ci.md', 'README.md']).docsOnly, true);
  assert.deepEqual(classify(['apps/mobile/src/App.tsx']).unsupported, ['apps/mobile/src/App.tsx']);
  assert.equal(classify(['apps/mobile/src/App.tsx']).docsOnly, false);
});

test('requires API validation for the explicit remote tool module and its mount', () => {
  for (const path of ['apps/api/src/routes/devices/index.ts', 'apps/api/src/routes/devices/cloudcomRemoteAccess.ts', 'apps/api/src/services/cloudcom/remoteAccessOptions.ts']) {
    const result = classify([path]);
    assert.equal(result.api, true);
    assert.deepEqual(result.unsupported, []);
  }
  assert.deepEqual(classify(['apps/api/src/routes/portal/devices.ts']).unsupported, ['apps/api/src/routes/portal/devices.ts']);
});

test('routes the enumerated customer portal remote surface to focused real-DB coverage', () => {
  for (const path of [
    'apps/api/migrations/2026-09-21-portal-remote-access.sql',
    'apps/api/src/routes/portal/remote.ts',
    'apps/api/src/services/portalRemoteSessionStore.ts',
    'apps/api/src/routes/orgPortalUsers.ts',
    'apps/api/src/routes/orgPortalUsers.test.ts',
    'apps/api/src/routes/portal/acceptInvite.test.ts',
    'apps/web/src/components/settings/OrgPortalUsersEditor.tsx',
    'apps/web/src/components/settings/OrgPortalUsersEditor.test.tsx',
    'packages/shared/src/validators/portal.ts',
    'packages/shared/src/validators/portal.test.ts',
    'apps/api/src/__tests__/integration/portalRemoteLogin.integration.test.ts',
    'apps/api/src/__tests__/integration/portalNativeLogin.integration.test.ts',
    'apps/api/src/routes/portal/nativeLogin.ts',
    'apps/api/src/services/portalNativeLogin.ts',
    'apps/portal/src/pages/remote/native.astro',
    'apps/portal/src/components/remote/NativeSignInPage.tsx',
    'apps/portal/src/pages/remote/[sessionId].astro',
    'packages/ext-rustdesk-access/src/server/index.ts',
  ]) {
    const result = classify([path]);
    assert.equal(result.portalRemote, true);
    assert.deepEqual(result.unsupported, []);
  }
  const configuration = classify(['docker-compose.yml']);
  assert.equal(configuration.portalRemote, true);
  assert.equal(configuration.infra, true);
  assert.deepEqual(classify(['apps/api/src/routes/portal/reports.ts']).unsupported, ['apps/api/src/routes/portal/reports.ts']);
});

test('requires focused API coverage for the monitor response binding fix', () => {
  for (const path of ['apps/api/src/services/monitors/monitorCompiler.ts', 'apps/api/src/services/monitors/monitorCompiler.w04.test.ts']) {
    assert.equal(classify([path]).api, true);
    assert.deepEqual(classify([path]).unsupported, []);
  }
  assert.deepEqual(classify(['apps/api/src/services/monitors/monitorService.ts']).unsupported, ['apps/api/src/services/monitors/monitorService.ts']);
});

test('classifies only the reviewed Cloud Command server, bridge, registry, and build surfaces', () => {
  for (const path of [
    'packages/ext-cloud-command/src/server/index.ts',
    'packages/ext-cloud-command/src/web/index.test.ts',
    'packages/ext-cloud-command/migrations/2026-09-21-threecx-connections.sql',
    'apps/api/src/extensions/webRegistry.ts',
    'apps/api/src/__tests__/integration/cloudCommandThreeCx.integration.test.ts',
  ]) {
    const result = classify([path]);
    assert.equal(result.api, true);
    assert.deepEqual(result.unsupported, []);
  }
  for (const path of [
    'apps/web/src/lib/extensions/hostApi.ts',
    'apps/web/src/components/extensions/useExtensionNavigation.ts',
    'apps/web/src/components/layout/Sidebar.tsx',
    'apps/web/src/components/layout/Sidebar.extensions.test.tsx',
    'apps/web/src/lib/extensions/cloudCommandNavigationEvents.ts',
    'apps/web/src/components/extensions/ExtensionElementHost.tsx',
  ]) assert.equal(classify([path]).web, true);
  assert.equal(classify(['packages/extension-web-sdk/src/hostApi.ts']).shared, true);
  assert.deepEqual(classify(['packages/ext-cloud-command/src/unsafe.ts']).unsupported, ['packages/ext-cloud-command/src/unsafe.ts']);
});

// Native Microsoft must remain covered even when its upstream attachment merges cleanly.
test('requires API and web validation for the native Microsoft host bridge', () => {
  const result = classify(['apps/api/src/extensions/cloudCommandMicrosoft.ts', 'apps/api/src/extensions/cloudCommandMicrosoft.test.ts']);
  assert.equal(result.api, true);
  assert.equal(result.web, true);
  assert.deepEqual(result.unsupported, []);
});

test('classifies the bounded Microsoft administration runtime, authorization, and additive migration', () => {
  for (const path of [
    'apps/api/src/extensions/cloudCommandAdminRuntime.ts',
    'apps/api/src/extensions/cloudCommandAdminRuntime.test.ts',
    'apps/api/src/extensions/cloudCommandAdminAuthorization.ts',
    'apps/api/src/extensions/cloudCommandAdminAuthorization.test.ts',
    'packages/ext-cloud-command/src/server/admin-runtime.ts',
    'packages/ext-cloud-command/src/server/admin-services.ts',
    'packages/ext-cloud-command/src/server/admin-store.ts',
    'packages/ext-cloud-command/migrations/2026-09-22-native-admin-connections.sql',
  ]) {
    const result = classify([path]);
    assert.equal(result.api, true);
    assert.equal(result.web, true);
    assert.deepEqual(result.unsupported, []);
  }
});
