import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyBrowserToolbarLayers } from './browser-toolbar-layers-transform.mjs';
test('all four browser toolbar dropdowns cover shell controls and identify local input', () => {
  const source = readFileSync('apps/viewer/src/components/ViewerToolbar.tsx', 'utf8').replaceAll('\r\n', '\n');
  const output = applyBrowserToolbarLayers('components/ViewerToolbar.tsx', source);
  assert.equal(output.match(/data-browser-local-input="true"/g)?.length, 4);
  assert.equal(output.match(/z-\[10020\]/g)?.length, 4);
  assert.equal(output.includes('shadow-xl z-50'), false);
  assert.throws(() => applyBrowserToolbarLayers('components/ViewerToolbar.tsx', source.replace('shadow-xl z-50', 'different')), /attachment points changed/);
  assert.equal(applyBrowserToolbarLayers('other.ts', source), source);
});
