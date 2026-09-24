import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { isAllowedLauncherScheme } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';

type RemoteAccessOption = { id: string; name: string; available: boolean; skipReason: string | null };
type RemoteAccessOptionsResponse = { providers: RemoteAccessOption[] };
type LaunchResponse = { launchUrl: string; providerId: string; scheme: string };
type Props = { deviceId: string };

function unavailableMessage(reason: string | null): string {
  if (reason === 'missing_device_identifier') return 'This device is missing the identifier required by this remote tool.';
  if (reason === 'provider_disabled') return 'This remote tool is disabled.';
  if (reason === 'empty_url_template') return 'This remote tool is not fully configured.';
  return 'This remote tool is unavailable for this device.';
}

function launchCustomScheme(url: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => anchor.remove(), 100);
}

/** Explicit provider selection; it never reads or changes the default preference. */
export default function RemoteAccessAlternatives({ deviceId }: Props) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<RemoteAccessOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [launchingProviderId, setLaunchingProviderId] = useState<string | null>(null);
  const optionsGenerationRef = useRef(0);
  const deviceGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const launchInFlightRef = useRef(false);
  const launchTokenRef = useRef(0);
  const activeLaunchTokenRef = useRef<number | null>(null);
  const menuId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    optionsGenerationRef.current += 1;
    deviceGenerationRef.current += 1;
    setOpen(false); setOptions(null); setLoadError(null); setLoading(false); setLaunchingProviderId(null);
    launchInFlightRef.current = false;
    activeLaunchTokenRef.current = null;
  }, [deviceId]);

  const loadOptions = useCallback(async () => {
    const generation = ++optionsGenerationRef.current;
    setLoading(true); setLoadError(null); setOptions(null);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/remote-access-options`);
      if (!response.ok) throw new Error('options failed');
      const body = await response.json() as RemoteAccessOptionsResponse;
      if (!mountedRef.current || generation !== optionsGenerationRef.current) return;
      setOptions(Array.isArray(body.providers) ? body.providers : []);
    } catch {
      if (mountedRef.current && generation === optionsGenerationRef.current) setLoadError('Unable to load other remote tools. Try again.');
    } finally {
      if (mountedRef.current && generation === optionsGenerationRef.current) setLoading(false);
    }
  }, [deviceId]);

  const closeChooser = useCallback(() => {
    optionsGenerationRef.current += 1;
    setOpen(false);
  }, []);

  const toggleChooser = useCallback(() => {
    if (open) { closeChooser(); return; }
    setOpen(true);
    void loadOptions();
  }, [closeChooser, loadOptions, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeChooser();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeChooser, open]);

  const launch = useCallback(async (providerId: string) => {
    // State updates are asynchronous, so the ref is the authoritative lock
    // for two rapid clicks before React has rendered the disabled state.
    if (launchInFlightRef.current) return;
    launchInFlightRef.current = true;
    const deviceGeneration = deviceGenerationRef.current;
    const launchToken = ++launchTokenRef.current;
    activeLaunchTokenRef.current = launchToken;
    // This explicit click is the only time a browser tab may be pre-opened.
    // Do not pass `noopener`: browsers intentionally return null in that mode,
    // which leaves an uncloseable blank tab for custom-protocol launches.
    let popup = window.open('', '_blank');
    if (popup) {
      try {
        popup.opener = null;
        if (popup.opener !== null) throw new Error('popup opener could not be cleared');
        const meta = popup.document.createElement('meta');
        meta.name = 'referrer';
        meta.content = 'no-referrer';
        popup.document.head.appendChild(meta);
      } catch {
        // Never navigate a tab whose opener/referrer protections could not be
        // installed. The custom-protocol anchor remains safe without it.
        popup.close();
        popup = null;
      }
    }
    setLaunchingProviderId(providerId);
    try {
      const result = await runAction<LaunchResponse>({
        request: () => fetchWithAuth(`/devices/${deviceId}/remote-access-options/${encodeURIComponent(providerId)}/launch`, { method: 'POST' }),
        errorFallback: 'Unable to launch this remote tool.',
        parseSuccess: (data) => data as LaunchResponse,
      });
      if (!mountedRef.current || deviceGeneration !== deviceGenerationRef.current) { popup?.close(); return; }
      // The launch address never enters state, telemetry, or an error message.
      if (result.providerId !== providerId || !result.launchUrl || !isAllowedLauncherScheme(result.launchUrl)) {
        popup?.close();
        showToast({ type: 'error', message: 'The remote tool returned an unsafe launch address.' });
        return;
      }
      if (/^https?:\/\//i.test(result.launchUrl)) {
        if (!popup) {
          showToast({ type: 'error', message: 'Your browser blocked the remote-tool window. Allow popups and try again.' });
          return;
        }
        popup.location.href = result.launchUrl;
      } else {
        popup?.close();
        launchCustomScheme(result.launchUrl);
      }
    } catch (error) {
      popup?.close();
      if (!(error instanceof ActionError)) showToast({ type: 'error', message: 'Unable to launch this remote tool.' });
    } finally {
      if (activeLaunchTokenRef.current === launchToken) {
        launchInFlightRef.current = false;
        activeLaunchTokenRef.current = null;
      }
      if (mountedRef.current && deviceGeneration === deviceGenerationRef.current) setLaunchingProviderId(null);
    }
  }, [deviceId]);

  return (
    <div className="relative">
      <button type="button" onClick={toggleChooser} className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" aria-expanded={open} aria-controls={menuId} data-testid="other-remote-tools-button">Other remote tools</button>
      {open && <div id={menuId} className="absolute right-0 z-20 mt-2 w-80 rounded-lg border bg-popover p-3 shadow-lg" data-testid="remote-access-alternatives">
        <div className="mb-2 flex items-center justify-between"><p className="text-sm font-medium">Other remote tools</p><button type="button" onClick={closeChooser} className="rounded px-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close other remote tools">×</button></div>
        {loading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading tools…</p>}
        {loadError && <div className="space-y-2 text-sm text-destructive"><p>{loadError}</p><button type="button" onClick={() => void loadOptions()} className="rounded-md border px-2 py-1 text-sm hover:bg-muted">Try again</button></div>}
        {!loading && !loadError && options?.length === 0 && <p className="text-sm text-muted-foreground">No other remote tools are configured for this device.</p>}
        {!loading && !loadError && options && options.length > 0 && <ul className="space-y-1">{options.map((provider) => {
          const launching = launchingProviderId === provider.id;
          return <li key={provider.id}><button type="button" disabled={!provider.available || launchingProviderId !== null} onClick={() => void launch(provider.id)} className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50" title={provider.available ? undefined : unavailableMessage(provider.skipReason)} data-testid={`remote-access-option-${provider.id}`}>
            <span><span className="block font-medium">{provider.name}</span>{!provider.available && <span className="block text-xs text-muted-foreground">{unavailableMessage(provider.skipReason)}</span>}</span>
            {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
          </button></li>;
        })}</ul>}
      </div>}
    </div>
  );
}
