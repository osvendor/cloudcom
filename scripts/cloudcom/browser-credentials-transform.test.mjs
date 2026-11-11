import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyCredentialToolbar } from './browser-credentials-transform.mjs';
test('toolbar integration survives regeneration through checked source anchors', () => {
  const desktop = readFileSync('apps/viewer/src/components/DesktopViewer.tsx', 'utf8').replaceAll('\r\n', '\n');
  const toolbar = readFileSync('apps/viewer/src/components/ViewerToolbar.tsx', 'utf8').replaceAll('\r\n', '\n');
  assert.match(applyCredentialToolbar('components/DesktopViewer.tsx', desktop), /credentialSessionId=\{params.mode === 'desktop' \? params.sessionId : undefined\}/);
  assert.match(applyCredentialToolbar('components/ViewerToolbar.tsx', toolbar), /<SessionCredentials sessionId=\{credentialSessionId\}/);
  assert.throws(() => applyCredentialToolbar('components/ViewerToolbar.tsx', 'changed upstream'), /attachment point changed/);
});
