import { useEffect, useState } from 'react';
import { apiLogin, fetchWithAuth, useAuthStore } from '../../stores/auth';
import LoginPage from '../auth/LoginPage';
import { runAction } from '../../lib/runAction';
import { bootstrapThenNavigate } from '../../lib/authNavigation';
import { authenticateRemoteAccount } from './unifiedNativeSignIn';
import { resolveRemoteAccount, staffRemoteSignInUrl, type RemoteAccount } from './remoteAccount';
import { RemoteComputerDirectory, type RemoteComputer } from './RemoteComputerDirectory';

const HOME = '/remote/computers';
const VIEWER_DOWNLOAD = '/downloads/managed-viewer/OS-Consultants-Remote-Access-1.0.7-x64.msi';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultNavigate = (url: string) => window.location.assign(url);

function portalHeaders() {
  const cookie = document.cookie.split(';').map(v => v.trim()).find(v => v.startsWith('breeze_portal_csrf_token='));
  if (!cookie) throw new Error('Your customer session needs to be refreshed. Sign in again.');
  return { 'Content-Type': 'application/json', 'x-breeze-csrf': decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)) };
}

async function customerRequest(path: string, body?: unknown) {
  return fetch(`/api/v1${path}`, { credentials: 'include', redirect: 'error',
    signal: AbortSignal.timeout(20000), ...(body !== undefined ? {
      method: 'POST', headers: portalHeaders(), body: JSON.stringify(body),
    } : {}) });
}

export default function RemoteComputersPage({ navigate = defaultNavigate }: { navigate?: (url: string) => void } = {}) {
  const [account, setAccount] = useState<RemoteAccount | null>(null);
  const [devices, setDevices] = useState<RemoteComputer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setDevices([]);
    void (async () => {
      try {
        const selected = await resolveRemoteAccount();
        if (cancelled) return;
        if (selected.kind === 'staff-sso') { await bootstrapThenNavigate(staffRemoteSignInUrl(HOME), navigate); return; }
        setAccount(selected);
        if (selected.kind === 'sign-in') return;
        const all: RemoteComputer[] = [];
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
          const response: Response = selected.kind === 'staff'
            ? await fetchWithAuth(`/staff-native/browser/devices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
            : await customerRequest('/portal/remote/browser/devices');
          if (!response.ok) throw new Error('Your account cannot load this remote directory. Sign in again or retry.');
          const body: { devices: RemoteComputer[]; nextCursor?: string | null } = await response.json();
          if (!Array.isArray(body.devices)) throw new Error('Invalid computer list.');
          for (const device of body.devices) {
            if (!uuid.test(device.id)) throw new Error('Invalid computer identity.');
            all.push({ ...device, currentUser: device.currentUser ?? null, previousUsers: device.previousUsers ?? [],
              organizationId: selected.kind === 'staff' ? device.organizationId : selected.user.orgId,
              organizationName: selected.kind === 'staff' ? device.organizationName
                : selected.user.organizationName || selected.user.orgName || 'My computers' });
          }
          cursor = selected.kind === 'staff' ? body.nextCursor ?? null : null;
          if (cursor && (!uuid.test(cursor) || cursors.has(cursor))) throw new Error('Invalid directory page.');
          if (cursor) cursors.add(cursor);
          if (cursors.size > 1000) throw new Error('The computer directory is too large to load.');
        } while (cursor && !cancelled);
        if (!cancelled) setDevices(all);
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load remote access.'); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [generation, navigate]);

  async function openBrowser(device: RemoteComputer) {
    if (busy || !device.transports.webrtc.available) return;
    if (account?.kind === 'staff') { navigate(`/remote/desktop/${device.id}`); return; }
    if (account?.kind !== 'customer') return;
    setBusy(device.id); setError(null);
    try {
      const result = await runAction<{ launch?: { url?: string } }>({
        request: () => customerRequest('/portal/remote/sessions', { deviceId: device.id, transport: 'webrtc' }),
        errorFallback: 'The Web Remote connection could not start.',
      });
      const url = result.launch?.url;
      if (!url || !/^\/portal\/remote\/[0-9a-f-]{36}$/i.test(url)
        || !uuid.test(url.slice('/portal/remote/'.length))) throw new Error('Invalid remote session link.');
      navigate(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not connect.'); }
    finally { setBusy(null); }
  }
  async function openDesktop(device: RemoteComputer) {
    if (busy || !device.transports.rustdesk.available) return;
    if (account?.kind === 'customer') {
      setMessage(`Open OS Consultants – Remote Access, sign in with this account, and select ${device.displayName || device.hostname}.`);
      return;
    }
    if (account?.kind !== 'staff') return;
    setBusy(device.id); setError(null);
    try {
      const result = await runAction<{ launchUrl: string }>({
        request: () => fetchWithAuth(`/staff-native/launch/${device.id}`, { method: 'POST' }),
        errorFallback: 'The desktop app could not be opened.',
      });
      if (result.launchUrl !== `cloudcom-remote://staff/connect/${device.id}`) throw new Error('Invalid desktop app link.');
      navigate(result.launchUrl);
      setMessage('Opening the desktop app. Sign in there if prompted.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open the app.'); }
    finally { setBusy(null); }
  }
  async function rename(device: RemoteComputer, displayName: string | null) {
    if (account?.kind !== 'staff') throw new Error('Staff sign-in required.');
    await runAction({ request: () => fetchWithAuth(`/staff-native/browser/devices/${device.id}/name`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName }),
    }), errorFallback: 'Could not save the computer name.' });
    setDevices(current => current.map(d => d.id === device.id ? { ...d, displayName } : d));
  }
  return <main className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-8" data-testid="remote-computers-page">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
      <div><h1 className="text-2xl font-semibold">Remote Access</h1>
        <p className="text-sm text-muted-foreground">{account?.kind === 'staff'
          ? `${useAuthStore.getState().user?.email ?? 'Staff account'} · Staff access`
          : account?.kind === 'customer' ? `${account.user.email} · My computers` : 'Your computers, in the browser or desktop app.'}</p></div>
      <nav className="flex flex-wrap items-center justify-end gap-3 text-sm">
        {account?.kind === 'staff' && <a className="underline" href="/">Breeze</a>}
        {account?.kind === 'customer' && <a className="underline" href="/portal/profile">Account</a>}
        {(account?.kind === 'staff' || account?.kind === 'customer') && <a
          className="rounded border px-3 py-1.5 hover:bg-muted"
          href={VIEWER_DOWNLOAD}
          download="OS-Consultants-Remote-Access-1.0.7-x64.msi"
          title="Windows 64-bit · version 1.0.7"
        >Download viewer for Windows</a>}
        <button className="rounded border px-3 py-1.5" disabled={loading} onClick={() => setGeneration(g => g + 1)}>Refresh</button>
      </nav>
    </header>
    {loading && <p role="status">Loading your computers…</p>}
    {error && <p role="alert" className="rounded border border-destructive/50 p-3 text-destructive">{error}</p>}
    {message && <p role="status" className="rounded border p-3 text-sm">{message}</p>}
    {!loading && account?.kind === 'sign-in' && <div className="mx-auto max-w-md">
      <LoginPage next={HOME} skipAutomaticStaffSso authenticate={(email, password) => authenticateRemoteAccount(email, password, apiLogin,
        async (customerEmail, customerPassword) => {
          const response = await fetch('/api/v1/portal/auth/login', { method: 'POST', credentials: 'include', redirect: 'error',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: customerEmail, password: customerPassword, unifiedNative: true }) });
          if (!response.ok) return false;
          const data = await response.json();
          if (data.user?.accessMode !== 'remote_only') return false;
          navigate(HOME); return true;
        })} />
      <button className="mt-4 block w-full text-center underline" onClick={() => {
        void bootstrapThenNavigate(staffRemoteSignInUrl(HOME), navigate)
          .catch(cause => setError(cause instanceof Error ? cause.message : 'Could not prepare sign-in.'));
      }}>Sign in with your company account</button>
    </div>}
    {!loading && !error && (account?.kind === 'staff' || account?.kind === 'customer') &&
      <RemoteComputerDirectory devices={devices} busyDeviceId={busy} onBrowser={d => void openBrowser(d)}
        onDesktop={d => void openDesktop(d)} onRename={account.kind === 'staff' ? rename : undefined} />}
  </main>;
}
