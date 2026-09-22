/** Authorization boundary, not navigation filtering. Unknown modes fail closed. */
export function portalAccessModeAllows(mode: unknown, method: string, path: string): boolean {
  // Hono supplies a decoded, normalized pathname; accept only exact API roots.
  const relative = path.replace(/^\/api\/v1\/portal(?=\/|$)/, '').replace(/^\/portal(?=\/|$)/, '');
  // Teardown must remain available even for a corrupt/unknown entitlement.
  if (relative === '/auth/logout') return method === 'POST';
  if (mode === 'standard') return true;
  if (mode !== 'remote_only') return false;
  if (relative === '/branding') return method === 'GET';
  if (relative === '/profile') return ['GET', 'PATCH'].includes(method);
  if (relative === '/profile/password') return method === 'POST';
  return relative === '/remote' || relative.startsWith('/remote/');
}
