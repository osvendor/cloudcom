// Browser-only adaptation: native clipboard APIs require different gesture handling.
export function applyBrowserClipboard(content) {
  function replace(before, after) {
    if (!content.includes(before)) throw new Error('Browser clipboard attachment point changed');
    content = content.replace(before, after);
  }
  content = "import { BrowserClipboard } from '../../clipboard';\nimport { defaultModifierRemap } from '../../keyboard';\n" + content;
  replace('  const [remapCmdCtrl, setRemapCmdCtrl] = useState(true);', `  const [remapCmdCtrl, setRemapCmdCtrl] = useState(false);
  const browserRemapOverrideRef = useRef(false);
  useEffect(() => {
    if (!browserRemapOverrideRef.current) setRemapCmdCtrl(defaultModifierRemap(navigator.platform, remoteOs));
  }, [remoteOs]);`);
  replace('        onRemapCmdCtrlChange={setRemapCmdCtrl}', `        onRemapCmdCtrlChange={(value) => {
          browserRemapOverrideRef.current = true;
          setRemapCmdCtrl(value);
        }}`);
  replace("  const [pasteNotice, setPasteNotice] = useState<string | null>(null);", `  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const browserClipboardRef = useRef<BrowserClipboard | null>(null);
  if (!browserClipboardRef.current) browserClipboardRef.current = new BrowserClipboard(setPasteNotice);
  useEffect(() => () => browserClipboardRef.current?.clear(), []);
  useEffect(() => { if (closing || status !== 'connected') browserClipboardRef.current?.clear(); }, [closing, status]);`);
  const start = content.indexOf('      onClipboardChannel: (channel) => {');
  const end = content.indexOf('      onCursorChannelOpen:', start);
  if (start < 0 || end < 0) throw new Error('Browser clipboard channel attachment point changed');
  content = content.slice(0, start) + `      onClipboardChannel: (channel) => {
        clipboardDCRef.current = channel;
        browserClipboardRef.current?.attach(channel);
      },
` + content.slice(end);
  replace('  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {\n    e.preventDefault();', `  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
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
    e.preventDefault();`);
  replace('}, [sendInputFn, handlePasteAsKeystrokes, remapCmdCtrl]);', '}, [sendInputFn, handlePasteAsKeystrokes, remapCmdCtrl, transport, remoteOs]);');
  replace('    onKeyDown: handleKeyDown,', `    onPaste: (event: React.ClipboardEvent) => {
      if (transport !== 'webrtc') return;
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      void browserClipboardRef.current?.paste(text, () => {
        sendInputFn({ type: 'key_press', key: 'v', modifiers: [remoteOs === 'darwin' || remoteOs === 'macos' ? 'meta' : 'ctrl'] });
      });
    },
    // Browser shells may deliver native Copy without dispatching a KeyC event.
    // Keep this on the remote surface, never the local credential panel/forms.
    onCopy: (event: React.ClipboardEvent) => {
      if (transport !== 'webrtc' || status !== 'connected' || closing) return;
      event.preventDefault();
      browserClipboardRef.current?.requestCopy(() => {
        sendInputFn({ type: 'key_press', key: 'c', modifiers: [remoteOs === 'darwin' || remoteOs === 'macos' ? 'meta' : 'ctrl'] });
      });
    },
    onKeyDown: handleKeyDown,`);
  replace('      <div className="flex-1 overflow-hidden flex items-center justify-center bg-black relative">', `      {transport === 'webrtc' && status === 'connected' && !closing && (
        <div className="flex items-center gap-3 bg-gray-900 px-3 py-1 text-xs text-gray-300">
          <span>Ctrl+C / Ctrl+V: copy and paste text in the remote desktop</span>
          <button type="button" className="rounded border border-gray-600 px-2 py-1 hover:bg-gray-800" onClick={() => void browserClipboardRef.current?.copy()}>Copy remote text</button>
        </div>
      )}
      <div className="flex-1 overflow-hidden flex items-center justify-center bg-black relative">`);
  return content;
}
