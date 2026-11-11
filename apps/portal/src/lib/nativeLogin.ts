export type NativeLoginRequest = {
  clientId: 'cloudcom-rustdesk-v1'; redirectUri: string; codeChallenge: string;
  codeChallengeMethod: 'S256'; state: string;
};
const fields = ['clientId', 'redirectUri', 'codeChallenge', 'codeChallengeMethod', 'state'];
// Canonical unpadded base64url for exactly 32 bytes, including the unused bits.
const canonical32 = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);

export function parseNativeLoginRequest(query: URLSearchParams): NativeLoginRequest | null {
  query = new URLSearchParams(query);
  // Ignore only the known browser Access marker; actual identity is checked
  // by portal authentication and the one-time PKCE exchange.
  if (query.getAll('cf-access-login').length === 1 && query.get('cf-access-login') === 'success') {
    query.delete('cf-access-login');
  }
  if ([...query.keys()].length !== fields.length || fields.some(key => query.getAll(key).length !== 1)) return null;
  if (query.get('clientId') !== 'cloudcom-rustdesk-v1' || query.get('codeChallengeMethod') !== 'S256') return null;
  const redirectUri = query.get('redirectUri')!;
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/cloudcom\/callback$/.exec(redirectUri);
  if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) return null;
  const codeChallenge = query.get('codeChallenge');
  const state = query.get('state');
  if (!canonical32(codeChallenge) || !canonical32(state)) return null;
  return { clientId: 'cloudcom-rustdesk-v1', redirectUri, codeChallenge, codeChallengeMethod: 'S256', state };
}

/** Validate again at the navigation boundary; never follow an arbitrary API URL. */
export function nativeCallbackUrl(value: unknown, request: NativeLoginRequest): string | null {
  if (typeof value !== 'string' || value.length > 320) return null;
  try {
    const url = new URL(value);
    if (url.hash || `${url.origin}${url.pathname}` !== request.redirectUri
      || url.username || url.password || [...url.searchParams.keys()].length !== 2
      || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('state').length !== 1
      || url.searchParams.get('state') !== request.state || !canonical32(url.searchParams.get('code'))) return null;
    // Raw prefix also rejects URL-normalized aliases of the registered callback.
    return value.startsWith(request.redirectUri + '?') ? value : null;
  } catch { return null; }
}
