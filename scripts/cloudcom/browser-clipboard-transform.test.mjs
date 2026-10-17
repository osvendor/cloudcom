import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyBrowserClipboard } from './browser-clipboard-transform.mjs';

const source = readFileSync(new URL('../../apps/viewer/src/components/DesktopViewer.tsx', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

test('clipboard paste modifier supports the actual macos identifier and darwin alias', () => {
  const result = applyBrowserClipboard(source);
  const expression = result.match(/modifiers: \[(remoteOs === 'darwin'[^\]]+)\]/)?.[1];
  assert.ok(expression, 'Browser paste modifier must be explicitly derived from the remote OS');
  const modifier = new Function('remoteOs', `return ${expression};`);
  assert.equal(modifier('macos'), 'meta');
  assert.equal(modifier('darwin'), 'meta');
  assert.equal(modifier('windows'), 'ctrl');
  assert.equal(modifier('linux'), 'ctrl');
});

test('paste gesture interception remains scoped to WebRTC and is installed before preventDefault', () => {
  const result = applyBrowserClipboard(source);
  const start = result.indexOf('  const handleKeyDown =');
  const end = result.indexOf('    e.preventDefault();', start);
  const interception = result.slice(start, end);
  assert.match(interception, /transport === 'webrtc'/);
  assert.match(interception, /if \(e.code === 'KeyV'\) return;/);
  assert.match(result, /event.clipboardData.getData\('text\/plain'\)/);
});

test('upstream attachment drift stops generation instead of silently dropping clipboard support', () => {
  assert.throws(() => applyBrowserClipboard(source.replace('      onClipboardChannel: (channel) => {', '      changedChannel: (channel) => {')), /attachment point changed/);
});

test('browser remap derives from local and remote platforms while preserving a manual override', () => {
  const result = applyBrowserClipboard(source);
  assert.match(result, /const \[remapCmdCtrl, setRemapCmdCtrl\] = useState\(false\)/);
  assert.match(result, /if \(!browserRemapOverrideRef.current\) setRemapCmdCtrl\(defaultModifierRemap\(navigator.platform, remoteOs\)\)/);
  assert.match(result, /browserRemapOverrideRef.current = true;/);
});

test('native Copy is scoped to the active remote surface and uses the same deduplicated request', () => {
  const result = applyBrowserClipboard(source);
  const interaction = result.slice(result.indexOf('  const interactionProps = {'), result.indexOf('\n  return (', result.indexOf('  const interactionProps = {')));
  assert.match(interaction, /onCopy: \(event: React.ClipboardEvent\)/);
  assert.match(interaction, /transport !== 'webrtc' \|\| status !== 'connected' \|\| closing/);
  assert.match(interaction, /browserClipboardRef.current\?\.requestCopy\(\(\) =>/);
  assert.match(interaction, /type: 'key_press', key: 'c'/);
  const keyboard = result.slice(result.indexOf('  const handleKeyDown'), result.indexOf('  const handleKeyUp'));
  assert.match(keyboard, /browserClipboardRef.current\?\.requestCopy\(\(\) =>/);
});

test('upstream clipboard sync is replaced by browser adapters without native clipboard imports', () => {
  const result = applyBrowserClipboard(source);
  assert.match(result, /const clipboardIO = \{/);
  assert.match(result, /navigator\.clipboard\.write\(\[new ClipboardItem/);
  assert.match(result, /text = await navigator\.clipboard\.readText\(\);/);
  assert.doesNotMatch(result, /@tauri-apps\/plugin-clipboard-manager/);
  assert.doesNotMatch(result, /ClipboardSync/);
  assert.doesNotMatch(result, /\b(?:clipboardSyncRef|clipboardState|setClipboardState)\b/);
});
