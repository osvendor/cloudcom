import type { InheritableRemoteAccessSettings } from '@breeze/shared';
import { checkRemoteAccessLaunchAvailability, resolveRemoteAccessLaunch } from '../remoteAccessLauncher';

type Device = { customFields?: Record<string, unknown> | null };

// Explicit choices must never fall back to a preference or tenant default.
// Reuse upstream template validation/decryption, but supply only the selected
// enabled provider. No provider definition supplied by the caller is accepted.
function select(settings: InheritableRemoteAccessSettings | undefined, providerId: string) {
  const provider = settings?.providers?.find(p => p.id === providerId && p.enabled);
  return provider ? { providers: [provider], defaultProviderId: provider.id } : undefined;
}

export function listRemoteAccessOptions(device: Device, settings: InheritableRemoteAccessSettings | undefined) {
  return (settings?.providers ?? []).filter(p => p.enabled).map(provider => {
    const availability = checkRemoteAccessLaunchAvailability(device, select(settings, provider.id));
    // Do not spread provider: it contains the template, identifier key and secret.
    return {
      id: provider.id,
      name: provider.name,
      available: availability.available,
      skipReason: availability.skipReason,
    };
  });
}

export function launchRemoteAccessOption(device: Device, settings: InheritableRemoteAccessSettings | undefined, providerId: string) {
  return resolveRemoteAccessLaunch(device, select(settings, providerId));
}
