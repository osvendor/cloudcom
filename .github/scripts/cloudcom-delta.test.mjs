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
    api: false, web: true, shared: false, native: true, infra: true, unsupported: [], docsOnly: false,
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

test('requires focused API coverage for the monitor response binding fix', () => {
  for (const path of ['apps/api/src/services/monitors/monitorCompiler.ts', 'apps/api/src/services/monitors/monitorCompiler.w04.test.ts']) {
    assert.equal(classify([path]).api, true);
    assert.deepEqual(classify([path]).unsupported, []);
  }
  assert.deepEqual(classify(['apps/api/src/services/monitors/monitorService.ts']).unsupported, ['apps/api/src/services/monitors/monitorService.ts']);
});
