/** Keep viewer capability tokens on the same authenticated website origin. */
export async function browserFetch(input: RequestInfo | URL, options: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
  if (url.origin !== window.location.origin || url.username || url.password ||
      !/^\/api\/v1\/(?:desktop-ws\/|vnc-viewer\/|vnc-exchange\/|tunnels(?:\/|$)|remote\/sessions(?:\/|$))/.test(url.pathname)) {
    throw new Error('Remote viewer request was blocked: invalid destination.');
  }
  const response = await window.fetch(input, { ...options, credentials: 'same-origin', redirect: 'error' });
  if (response.headers.get('content-type')?.includes('text/html')) {
    throw new Error('Your website access session needs renewal. Reload Breeze and reconnect.');
  }
  return response;
}
