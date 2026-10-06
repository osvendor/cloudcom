export const STAFF_NATIVE_CLIENT_ID = 'cloudcom-rustdesk-v1';

export type StaffNativeAuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  state: string;
};

export type StaffNativeAuthorizationResponse = { redirectUri: string };

const CANONICAL_32 = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_CALLBACK = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/cloudcom\/callback$/;
const ONE_TIME_CODE = /^[A-Za-z0-9_-]{43}$/;

export function readStaffNativeAuthorizationRequest(search: string): StaffNativeAuthorizationRequest | null {
  const params = new URLSearchParams(search);
  // Cloudflare Access appends this after browser authentication. It is only
  // transport metadata, never proof of a Breeze identity or authorization.
  if (params.getAll('cf-access-login').length === 1 && params.get('cf-access-login') === 'success') {
    params.delete('cf-access-login');
  }
  const keys = ['clientId', 'redirectUri', 'codeChallenge', 'codeChallengeMethod', 'state'] as const;
  if (keys.some((key) => params.getAll(key).length !== 1) || [...params.keys()].some((key) => !keys.includes(key as typeof keys[number]))) return null;
  const request = {
    clientId: params.get('clientId') ?? '',
    redirectUri: params.get('redirectUri') ?? '',
    codeChallenge: params.get('codeChallenge') ?? '',
    codeChallengeMethod: params.get('codeChallengeMethod') ?? '',
    state: params.get('state') ?? '',
  };
  const port = LOOPBACK_CALLBACK.exec(request.redirectUri)?.[1];
  if (request.clientId !== STAFF_NATIVE_CLIENT_ID || request.codeChallengeMethod !== 'S256'
    || !CANONICAL_32.test(request.codeChallenge) || !CANONICAL_32.test(request.state)
    || !port || Number(port) < 1024 || Number(port) > 65535) return null;
  return request as StaffNativeAuthorizationRequest;
}

/** Accept only the exact registered callback plus its one-time code and original state. */
export function validateStaffNativeAuthorizationResponse(
  response: StaffNativeAuthorizationResponse,
  request: StaffNativeAuthorizationRequest,
): string | null {
  if (!response || typeof response.redirectUri !== 'string') return null;
  const redirect = response.redirectUri;
  const question = redirect.indexOf('?');
  if (question < 0 || redirect.slice(0, question) !== request.redirectUri) return null;
  const params = new URLSearchParams(redirect.slice(question + 1));
  if ([...params.keys()].some((key) => key !== 'code' && key !== 'state')
    || params.getAll('code').length !== 1 || params.getAll('state').length !== 1) return null;
  const code = params.get('code') ?? '';
  if (!ONE_TIME_CODE.test(code) || params.get('state') !== request.state) return null;
  return redirect;
}
