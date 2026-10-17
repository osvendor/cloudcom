// Browser-only adaptation: native clipboard APIs require different gesture handling.
export function applyBrowserClipboard(content) {
  function replace(before, after) {
    if (!content.includes(before)) throw new Error('Browser clipboard attachment point changed');
    content = content.replace(before, after);
  }
  const modernClipboard = content.includes("import { ClipboardSync, type ClipboardSyncState } from '../lib/clipboardSync';");
  content = "import { BrowserClipboard } from '../../clipboard';\nimport { defaultModifierRemap } from '../../keyboard';\n" + content;
  if (modernClipboard) {
    content = content.replace("import { ClipboardSync, type ClipboardSyncState } from '../lib/clipboardSync';\n", '')
      .replace("import { createTauriClipboardIO } from '../lib/clipboardIO';\n", '')
      .replace("const clipboardIO = createTauriClipboardIO();\n", '');
    content = content.replace("import { defaultModifierRemap } from '../../keyboard';\n", "import { defaultModifierRemap } from '../../keyboard';\nconst clipboardIO = {\n  readText: async () => { try { return await navigator.clipboard.readText(); } catch { return null; } },\n  writeText: (text: string) => navigator.clipboard.writeText(text),\n  writeImage: async (bytes: Uint8Array, format: 'png' | 'jpeg') => {\n    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard.write) throw new Error('Browser image clipboard is unavailable');\n    const blob = new Blob([new Uint8Array(bytes).buffer], { type: `image/${format}` });\n    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);\n  },\n};\n");
    content = content.replace("const { readText } = await import('@tauri-apps/plugin-clipboard-manager');\n      text = await readText();", "text = await navigator.clipboard.readText();");
  }
  if (modernClipboard) {
    replace('  // One controller per WebRTC clipboard channel (lib/clipboardSync.ts).\n  const clipboardSyncRef = useRef<ClipboardSync | null>(null);\n  const [clipboardState, setClipboardState] = useState<ClipboardSyncState | null>(null);', '');
    const cleanup = /clipboardSyncRef\.current\?\.close\(\);\n\s*clipboardSyncRef\.current = null;/g;
    if ([...content.matchAll(cleanup)].length !== 2) throw new Error('Browser clipboard cleanup attachment point changed');
    content = content.replace(cleanup, 'browserClipboardRef.current?.clear();');
    replace('    setClipboardState(null);\n', '');
    replace("transport === 'vnc' ? vncSessionRef.current?.clipboard ?? null : clipboardSyncRef.current", "transport === 'vnc' ? vncSessionRef.current?.clipboard ?? null : null");
    const chipStart = content.indexOf('  const clipboardChipInput: ClipboardChipInput =');
    const chipEnd = content.indexOf('\n\n', chipStart);
    if (chipStart < 0 || chipEnd < 0) throw new Error('Browser clipboard chip attachment point changed');
    content = content.slice(0, chipStart) + `  // WebRTC clipboard actions live in the browser's gesture-aware text bar.
  const clipboardChipInput: ClipboardChipInput = transport === 'vnc' && vncClipboardState
    ? { kind: 'vnc', ...vncClipboardState }
    : { kind: 'hidden' };` + content.slice(chipEnd);
    replace(`      const sync = clipboardSyncRef.current;
      if (!sync) {
        dispatchPaste();
        return;
      }
      void sync.pasteTransaction(dispatchPaste).then((outcome) => {
        if (outcome.result === 'failed') setPasteNotice(clipboardFailureMessage(outcome.reason, 'paste'));
      });`, `      if (transport === 'webrtc') {
        void navigator.clipboard.readText().then(text => {
          if (!viewOnlyRef.current) return browserClipboardRef.current?.paste(text, dispatchPaste);
        }).catch(() => setPasteNotice('Clipboard access was blocked. Use Ctrl+V or Paste Text.'));
      } else {
        dispatchPaste();
      }`);
    replace('  const [remapOverride, setRemapOverride] = useState<boolean | null>(null);\n  const remapCmdCtrl = remapOverride ?? defaultRemapCmdCtrl(VIEWER_OS, remoteOs);', `  const [remapCmdCtrl, setRemapCmdCtrl] = useState(false);
  const browserRemapOverrideRef = useRef(false);
  useEffect(() => {
    if (!browserRemapOverrideRef.current) setRemapCmdCtrl(defaultModifierRemap(navigator.platform, remoteOs));
  }, [remoteOs]);`);
    const start = content.indexOf('        onClipboardChannel: (channel) => {');
    const end = content.indexOf('        onCursorChannelOpen:', start);
    if (start < 0 || end < 0) throw new Error('Browser clipboard channel attachment point changed');
    content = content.slice(0, start) + `        onClipboardChannel: (channel) => {
          browserClipboardRef.current?.attach(channel);
        },
` + content.slice(end);
  } else {
  replace('  const [remapCmdCtrl, setRemapCmdCtrl] = useState(true);', `  const [remapCmdCtrl, setRemapCmdCtrl] = useState(false);
  const browserRemapOverrideRef = useRef(false);
  useEffect(() => {
    if (!browserRemapOverrideRef.current) setRemapCmdCtrl(defaultModifierRemap(navigator.platform, remoteOs));
  }, [remoteOs]);`);
  replace('        onRemapCmdCtrlChange={setRemapCmdCtrl}', `        onRemapCmdCtrlChange={(value) => {
          browserRemapOverrideRef.current = true;
          setRemapCmdCtrl(value);
        }}`);
  const start = content.indexOf('      onClipboardChannel: (channel) => {');
  const end = content.indexOf('      onCursorChannelOpen:', start);
  if (start < 0 || end < 0) throw new Error('Browser clipboard channel attachment point changed');
  content = content.slice(0, start) + `      onClipboardChannel: (channel) => {
        clipboardDCRef.current = channel;
        browserClipboardRef.current?.attach(channel);
      },
` + content.slice(end);
  }
  // The upstream native clipboard ref may precede status and pasteNotice.
  // Browser construction reads both immediately, so attach after their state.
  replace("  const [pasteNotice, setPasteNotice] = useState<string | null>(null);", `  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const browserClipboardRef = useRef<BrowserClipboard | null>(null);
  if (!browserClipboardRef.current) browserClipboardRef.current = new BrowserClipboard(setPasteNotice);
  useEffect(() => () => browserClipboardRef.current?.clear(), []);
  useEffect(() => { if (closing || status !== 'connected') browserClipboardRef.current?.clear(); }, [closing, status]);`);
  const keyHook = modernClipboard
    ? '    if (!viewOnlyRef.current && composition.keyDown(ne) === \'capture\') return;\n    e.preventDefault();'
    : '  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {\n    e.preventDefault();';
  const keyReplacement = modernClipboard
    ? `    if (!viewOnlyRef.current && composition.keyDown(ne) === 'capture') return;
    // Leave native paste enabled: ClipboardEvent supplies text without a read permission prompt.
    if (!viewOnlyRef.current && transport === 'webrtc' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      if (e.code === 'KeyV') return;
      if (e.code === 'KeyC') {
        e.preventDefault();
        browserClipboardRef.current?.requestCopy(() => {
          sendInputFn({ type: 'key_press', key: 'c', modifiers: [remoteOs === 'darwin' || remoteOs === 'macos' ? 'meta' : 'ctrl'] });
          forgetModifiersReleasedByKeyPress([remoteOs === 'darwin' || remoteOs === 'macos' ? 'meta' : 'ctrl']);
        });
        return;
      }
    }
    e.preventDefault();`
    : `  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Leave native paste enabled: ClipboardEvent supplies text without a read permission prompt.
    if (transport === 'webrtc' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      if (e.code === 'KeyV') return;
      if (e.code === 'KeyC') {
        e.preventDefault();
        browserClipboardRef.current?.requestCopy(() => {
          sendInputFn({ type: 'key_press', key: 'c', modifiers: [remoteOs === 'darwin' || remoteOs === 'macos' ? 'meta' : 'ctrl'] });
        });
        return;
      }
    }
    e.preventDefault();`;
  replace(keyHook, keyReplacement);
  if (modernClipboard) {
    replace('}, [sendInputFn, handlePasteAsKeystrokes, releaseAllKeys, forgetModifiersReleasedByKeyPress, remapCmdCtrl, keyNameMode, remoteOs, reliableInput]);',
      '}, [sendInputFn, handlePasteAsKeystrokes, releaseAllKeys, forgetModifiersReleasedByKeyPress, remapCmdCtrl, keyNameMode, remoteOs, reliableInput, transport]);');
  } else {
    replace('}, [sendInputFn, handlePasteAsKeystrokes, remapCmdCtrl]);', '}, [sendInputFn, handlePasteAsKeystrokes, remapCmdCtrl, transport, remoteOs]);');
  }
  if (modernClipboard) {
    replace(`        onRemapCmdCtrlChange={(v) => {
          // Held keys were sent under the old mapping; their key_up names
          // would no longer match.
          releaseAllKeys();
          setRemapOverride(v);
          rememberDevicePrefs({ remapCmdCtrl: v });
        }}`,
      `        onRemapCmdCtrlChange={(value) => {
          releaseAllKeys();
          browserRemapOverrideRef.current = true;
          setRemapCmdCtrl(value);
          rememberDevicePrefs({ remapCmdCtrl: value });
        }}`);
    replace('        setRemapOverride(prefs.remapCmdCtrl);', `        browserRemapOverrideRef.current = true;
        setRemapCmdCtrl(prefs.remapCmdCtrl);`);
  }
  replace('  const interactionProps = {', `  const browserClipboardEvents = {
    onPaste: (event: React.ClipboardEvent) => {
      if (transport !== 'webrtc' || status !== 'connected' || closing${modernClipboard ? ' || viewOnlyRef.current' : ''}) return;
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      void browserClipboardRef.current?.paste(text, () => {
        sendInputFn({ type: 'key_press', key: 'v', modifiers: [remoteOs === 'darwin' || remoteOs === 'macos' ? 'meta' : 'ctrl'] });
        ${modernClipboard ? "forgetModifiersReleasedByKeyPress([remoteOs === 'darwin' || remoteOs === 'macos' ? 'meta' : 'ctrl']);" : ''}
      });
    },
    // Browser shells may deliver native Copy without dispatching a KeyC event.
    // Keep this on the remote surface, never the local credential panel/forms.
    onCopy: (event: React.ClipboardEvent) => {
      if (transport !== 'webrtc' || status !== 'connected' || closing${modernClipboard ? ' || viewOnlyRef.current' : ''}) return;
      event.preventDefault();
      browserClipboardRef.current?.requestCopy(() => {
        sendInputFn({ type: 'key_press', key: 'c', modifiers: [remoteOs === 'darwin' || remoteOs === 'macos' ? 'meta' : 'ctrl'] });
        ${modernClipboard ? "forgetModifiersReleasedByKeyPress([remoteOs === 'darwin' || remoteOs === 'macos' ? 'meta' : 'ctrl']);" : ''}
      });
    },
  };
  const interactionProps = {`);
  if (modernClipboard) {
    // Clipboard events bubble from both the video and the focused IME input.
    // Keep this ancestor limited to remote input, outside local toolbar/forms.
    replace('        <div className={`absolute inset-0 ${scrollerClassName(viewScaling)}',
      '        <div {...browserClipboardEvents} className={`absolute inset-0 ${scrollerClassName(viewScaling)}');
  }
  replace('      <div className="flex-1 overflow-hidden flex items-center justify-center bg-black relative">', `      {transport === 'webrtc' && status === 'connected' && !closing && (
        <div className="flex items-center gap-3 bg-gray-900 px-3 py-1 text-xs text-gray-300">
          <span>Ctrl+C / Ctrl+V: copy and paste text in the remote desktop</span>
          <button type="button" className="rounded border border-gray-600 px-2 py-1 hover:bg-gray-800" onClick={() => void browserClipboardRef.current?.copy()}>Copy remote text</button>
        </div>
      )}
      <div ${modernClipboard ? '' : '{...browserClipboardEvents} '}className="flex-1 overflow-hidden flex items-center justify-center bg-black relative">`);
  if (/\b(?:clipboardSyncRef|clipboardState|setClipboardState)\b/.test(content)) {
    throw new Error('Browser clipboard adaptation left a native controller reference');
  }
  if (modernClipboard && /\b(?:clipboardDCRef|setRemapOverride|remapOverride)\b/.test(content)) {
    throw new Error('Browser clipboard adaptation left a replaced native binding');
  }
  return content;
}
