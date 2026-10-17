import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchWithAuth } from '@/stores/auth';

type Credential = { id: string; name: string; username?: string; email?: string; hasPassword: boolean; hasOtp: boolean };
type Secret = { id: string; value: string; expiresAt: number; label: string };

// Browser account authentication only: a desktop transport capability is never a vault credential.
export default function SessionCredentials({ sessionId, enabled }: { sessionId?: string; enabled: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { setOpen(false); }, [sessionId, enabled]);
  return <>
    <button ref={trigger} type="button" disabled={!enabled || !sessionId} onClick={() => setOpen(true)}
      className="px-2 py-1 text-xs text-gray-300 hover:text-white disabled:opacity-40">Credentials</button>
    {open && enabled && sessionId && createPortal(<CredentialDialog key={sessionId} sessionId={sessionId} close={() => { setOpen(false); trigger.current?.focus(); }} />, document.body)}
  </>;
}

function CredentialDialog({ sessionId, close }: { sessionId: string; close: () => void }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Credential[]>([]);
  const [notice, setNotice] = useState('Loading credentials…');
  const [secret, setSecret] = useState<Secret | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const base = `/credentials/sessions/${encodeURIComponent(sessionId)}/credentials`;
  useEffect(() => { search.current?.focus(); return () => { revision.current++; }; }, []);
  useEffect(() => {
    const rev = ++revision.current;
    const controller = new AbortController();
    setSecret(null); setRows([]); setBusy(false); setNotice('Loading credentials…');
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetchWithAuth(`${base}?q=${encodeURIComponent(query)}`, { skipOrgIdInjection: true, cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (rev !== revision.current) return;
        setRows(Array.isArray(body.credentials) ? body.credentials : []); setNotice('');
      } catch { if (rev === revision.current && !controller.signal.aborted) setNotice('Credentials are unavailable for this session or your permissions.'); }
    }, 200);
    return () => { revision.current++; controller.abort(); window.clearTimeout(timer); };
  }, [base, query]);
  useEffect(() => {
    if (!secret) return;
    const timer = window.setTimeout(() => setSecret(null), Math.max(0, secret.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [secret]);
  useEffect(() => {
    const hide = () => { if (document.hidden) { revision.current++; setSecret(null); setBusy(false); } };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);
  async function reveal(row: Credential, otp: boolean) {
    const rev = revision.current;
    setSecret(null); setBusy(true); setNotice('');
    try {
      const response = await fetchWithAuth(`${base}/${encodeURIComponent(row.id)}/${otp ? 'otp' : 'reveal'}`, {
        method: 'POST', skipOrgIdInjection: true, cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        ...(otp ? {} : { body: JSON.stringify({ field: 'password' }) }),
      });
      if (!response.ok) throw new Error();
      const body = await response.json();
      const value = otp ? body.code : body.value;
      const expiresAt = otp ? Date.parse(body.expiresAt) : Date.now() + 30_000;
      if (typeof value !== 'string' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error();
      if (rev === revision.current) setSecret({ id: row.id, value, expiresAt: Math.min(expiresAt, Date.now() + 30_000), label: otp ? 'OTP code' : 'Password' });
    } catch { if (rev === revision.current) setNotice('Unable to reveal this credential. Check your permissions or reopen the session.'); }
    finally { if (rev === revision.current) setBusy(false); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('Copied to your clipboard.'); }
    catch { setNotice('Clipboard access was blocked by your browser.'); }
  }
  const button = 'rounded border border-gray-600 px-2 py-1 text-xs hover:bg-gray-700 disabled:opacity-40';
  return <div className="fixed inset-0 z-[10010] flex justify-end bg-black/40" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="Session credentials" data-browser-local-input="true"
      className="h-full w-full max-w-lg overflow-y-auto border-l border-gray-600 bg-gray-900 p-5 text-gray-100 shadow-xl"
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        if (e.key === 'Tab') {
          const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input') ?? []);
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }} onKeyUp={e => e.stopPropagation()}>
      <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Credentials</h2><button className={button} onClick={close}>Close</button></div>
      <p className="my-3 text-sm text-gray-400">Only credentials for this computer’s client are available.</p>
      <label className="block text-sm">Search credentials<input ref={search} value={query} maxLength={200} onChange={e => { revision.current++; setRows([]); setSecret(null); setQuery(e.target.value); }} className="my-2 w-full rounded border border-gray-600 bg-gray-950 p-2" /></label>
      <p role="status" className="text-sm text-gray-300">{notice}</p>
      {!notice && rows.length === 0 && <p className="py-4 text-sm">No matching credentials.</p>}
      <ul className="divide-y divide-gray-700">{rows.map(row => <li key={row.id} className="py-4">
        <h3 className="break-words font-medium">{row.name}</h3>
        {row.username && <div className="my-2 flex items-center justify-between gap-2 text-sm"><span className="break-all">Username: {row.username}</span><button className={button} onClick={() => void copy(row.username!)}>Copy username</button></div>}
        {row.email && <div className="my-2 flex items-center justify-between gap-2 text-sm"><span className="break-all">Email: {row.email}</span><button className={button} onClick={() => void copy(row.email!)}>Copy email</button></div>}
        <div className="mt-3 flex flex-wrap gap-2">
          {row.hasPassword && <button className={button} disabled={busy} onClick={() => void reveal(row, false)}>Reveal password</button>}
          {row.hasOtp && <button className={button} disabled={busy} onClick={() => void reveal(row, true)}>Show OTP</button>}
        </div>
        {secret?.id === row.id && <div className="mt-3 rounded border border-gray-600 p-3" data-sentry-mask="true">
          <div className="break-all font-mono">{secret.label}: {secret.value}</div>
          <div className="mt-2 flex gap-2"><button className={button} onClick={() => { if (secret.expiresAt > Date.now()) void copy(secret.value); else setSecret(null); }}>Copy {secret.label.toLowerCase()}</button><button className={button} onClick={() => setSecret(null)}>Hide</button></div>
        </div>}
      </li>)}</ul>
    </div>
  </div>;
}

