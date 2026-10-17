/** Cmd/Control remapping is needed only when the local and remote OS families differ. */
export function defaultModifierRemap(localPlatform: string, remoteOs: string | null): boolean {
  if (!remoteOs) return false;
  const localMac = /mac|iphone|ipad|ipod/i.test(localPlatform);
  const remoteMac = remoteOs.toLowerCase() === 'macos' || remoteOs.toLowerCase() === 'darwin';
  return localMac !== remoteMac;
}
