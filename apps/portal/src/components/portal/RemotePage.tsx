import { useEffect, useState } from 'react';
import { portalApi, type RemoteDevice } from '@/lib/api';
import { PageHeader } from './ui';
import { withBase } from '@/lib/basePath';

type LoadState = 'loading' | 'ready' | 'error';

function isSafeLaunchUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    const prefix = withBase('/remote/');
    return parsed.origin === window.location.origin && !parsed.search && !parsed.hash
      && parsed.pathname.startsWith(prefix)
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.pathname.slice(prefix.length));
  } catch {
    return false;
  }
}

export function RemotePage() {
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

  const load = async () => {
    setState('loading');
    const response = await portalApi.getRemoteDevices();
    if (!response.data) {
      setMessage(response.error ?? 'We couldn’t load your computers. Please try again.');
      setState('error');
      return;
    }
    setDevices(response.data.devices);
    setMessage(null);
    setState('ready');
  };

  useEffect(() => { void load(); }, []);

  const connect = async (device: RemoteDevice) => {
    if (connecting) return;
    setConnecting(device.id);
    const response = await portalApi.createRemoteSession(device.id, 'webrtc');
    setConnecting(null);
    if (response.data?.launch?.url && isSafeLaunchUrl(response.data.launch.url)) {
      window.location.assign(response.data.launch.url);
      return;
    }
    setMessage(response.error ?? 'A secure connection link was not provided. Please try again.');
  };

  return <div data-testid="remote-page">
    <PageHeader title="Remote access" lede="Connect to a computer your IT team has approved." />
    {state === 'loading' && <p role="status" className="text-sm text-muted-foreground">Loading your computers…</p>}
    {state === 'error' && <div role="alert" className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <p>{message}</p><button type="button" onClick={() => void load()} className="font-semibold underline">Try again</button>
    </div>}
    {state === 'ready' && devices.length === 0 && <p data-testid="remote-empty" className="rounded-md border border-border p-6 text-sm text-muted-foreground">No computers are available yet. Contact your IT team if you expected to see one.</p>}
    {state === 'ready' && devices.length > 0 && <div className="space-y-4">
      {devices.map((device) => <article key={device.id} data-testid={`remote-device-${device.id}`} className="rounded-md border border-border p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="font-display text-lg font-semibold">{device.displayName || device.hostname}</h2><p className="text-sm text-muted-foreground">{device.hostname}</p></div>
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{device.status}</span>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <button data-testid={`remote-connect-webrtc-${device.id}`} type="button" disabled={!device.transports.webrtc.available || connecting !== null} onClick={() => void connect(device)} title={device.transports.webrtc.available ? undefined : device.transports.webrtc.reason} className="rounded-md border border-border px-4 py-2 text-sm font-semibold transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50">
            {connecting === device.id ? 'Connecting…' : 'Open in browser'}
          </button>
        </div>
        {device.transports.rustdesk.available && <p className="mt-3 text-sm text-muted-foreground">For RustDesk, open the managed app, sign in with your Breeze account, and choose this computer.</p>}
        {message && <p role="alert" className="mt-4 text-sm text-destructive">{message}</p>}
      </article>)}
    </div>}
  </div>;
}

export default RemotePage;
