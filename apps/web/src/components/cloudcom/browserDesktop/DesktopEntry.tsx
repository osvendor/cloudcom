import { useEffect, useState } from 'react';
import type { DesktopAccessState, RemoteAccessPolicy } from '@breeze/shared';
import { fetchWithAuth, useAuthStore } from '@/stores/auth';
import ConnectDesktopButton from '@/components/remote/ConnectDesktopButton';

type Device = {
  hostname: string;
  displayName?: string | null;
  status?: string;
  isHeadless?: boolean;
  desktopAccess?: DesktopAccessState | null;
  remoteAccessPolicy?: RemoteAccessPolicy | null;
  helperLifecycleMode?: 'always-on' | 'on-demand' | null;
};

/** Normal Breeze authentication and API authorization own this entry point. */
export default function DesktopEntry({ deviceId }: { deviceId: string }) {
  const ready = useAuthStore(state => state.isAuthenticated && !!state.tokens?.accessToken && !state.isLoading);
  const [device, setDevice] = useState<Device | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithAuth(`/devices/${deviceId}`);
        if (!response.ok) throw new Error(response.status === 403 || response.status === 404
          ? 'This device is unavailable or your account does not have access.' : 'Could not load the device. Refresh to retry.');
        const data = await response.json() as Device;
        if (!cancelled) setDevice(data);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load the device.');
      }
    })();
    return () => { cancelled = true; };
  }, [ready, deviceId]);
  return <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
    <h1 className="text-xl font-semibold">Browser remote desktop</h1>
    {error ? <p role="alert">{error}</p> : !device || !ready ? <p role="status">Preparing connection…</p> : <>
      <p className="font-medium">{device.displayName || device.hostname}</p>
      <ConnectDesktopButton key={deviceId} deviceId={deviceId} viewerMode="browser" preferBuiltIn autoStart
        disabled={device.status !== 'online'} disabledTitle="Device is offline"
        isHeadless={device.isHeadless} desktopAccess={device.desktopAccess}
        remoteAccessPolicy={device.remoteAccessPolicy} helperLifecycleMode={device.helperLifecycleMode} />
      <p className="text-sm text-muted-foreground">Your companion panel remains available beside this desktop.</p>
    </>}
  </main>;
}
