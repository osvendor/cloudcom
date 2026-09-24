import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopConnectionParams } from './upstream/lib/protocol';
import { endBrowserSession } from './lifecycle';

import DesktopViewer from './upstream/components/DesktopViewer';
let active = false;
export function isBrowserDesktopActive() { return active; }

export function launchBrowserDesktop(input: Omit<DesktopConnectionParams, 'mode' | 'apiUrl'>): void {
  if (active) throw new Error('Disconnect the active browser desktop before opening another.');
  active = true;
  // The code and viewer token stay in memory, never query strings/storage.
  const params: DesktopConnectionParams = { ...input, mode: 'desktop', apiUrl: window.location.origin };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Shell() {
    const [closing, setClosing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const busy = useRef(false);
    const dialog = useRef<HTMLDivElement>(null);
    const onError = useCallback(() => {}, []); // Viewer renders its actionable error.
    const close = useCallback(async () => {
      if (busy.current) return;
      busy.current = true;
      setClosing(true); setError(null);
      try {
        await endBrowserSession(params.sessionId);
        root.unmount(); container.remove(); active = false;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Disconnect could not be confirmed.');
      } finally { busy.current = false; }
    }, []);
    useEffect(() => {
      const previous = document.activeElement as HTMLElement | null;
      const overflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden'; dialog.current?.focus();
      const trap = (event: KeyboardEvent) => {
        if (event.key !== 'Tab' || !dialog.current) return;
        const items = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]')).filter(el => el.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (!first) { event.preventDefault(); dialog.current.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
      };
      const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
      document.addEventListener('keydown', trap, true);
      window.addEventListener('beforeunload', leave);
      return () => { document.body.style.overflow = overflow; previous?.focus(); document.removeEventListener('keydown', trap, true); window.removeEventListener('beforeunload', leave); };
    }, []);
    return <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Browser remote desktop" className="fixed inset-0 z-[10000] bg-gray-900 text-white">
      <button type="button" onClick={() => void close()} disabled={closing && !error} className="absolute right-3 top-14 z-[100] rounded border bg-gray-800 px-3 py-2">Disconnect and close</button>
      {closing && <div role="status" className="absolute inset-0 z-[90] flex flex-col items-center justify-center gap-4 bg-gray-900">
        <p>{error || 'Confirming remote session disconnect…'}</p>
        {error && <button type="button" onClick={() => void close()} className="rounded border px-4 py-2">Retry disconnect</button>}
      </div>}
      <DesktopViewer params={params} closing={closing} onDisconnect={close} onError={onError} />
    </div>;
  }
  root.render(<Shell />);
}
