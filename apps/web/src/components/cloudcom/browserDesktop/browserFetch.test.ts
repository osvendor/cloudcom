import { describe, it, expect, vi, afterEach } from 'vitest';
import { browserFetch } from './browserFetch';
import { renewRevocationLeaseOnce } from './upstream/lib/revocationLease';
afterEach(() => vi.unstubAllGlobals());
describe('browser viewer network boundary', () => {
  it('never treats an Access HTML login response as a renewed revocation lease', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(renewRevocationLeaseOnce({ apiUrl: window.location.origin, sessionId: 'session', accessToken: 'test-capability' })).resolves.toEqual({ kind: 'unavailable' });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/viewer/lease/renew'), expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }));
  });
  it('retains the viewer bearer and sends the same-origin Access cookie without following redirects', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    await browserFetch('/api/v1/desktop-ws/session/viewer/offer', { method: 'POST', headers: { Authorization: 'Bearer test-capability' }, credentials: 'include', redirect: 'follow' });
    expect(fetch).toHaveBeenCalledWith('/api/v1/desktop-ws/session/viewer/offer', expect.objectContaining({ credentials: 'same-origin', redirect: 'error', headers: { Authorization: 'Bearer test-capability' } }));
  });
  it.each(['https://other.example/api/v1/desktop-ws/x', '/api/v1/users', '/api/v1/desktop-ws/../users'])('rejects token disclosure or unrelated destination %s', async path => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(browserFetch(path)).rejects.toThrow('invalid destination');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports an HTML login response as an access-session problem', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } })));
    await expect(browserFetch('/api/v1/desktop-ws/connect/exchange')).rejects.toThrow('access session needs renewal');
  });
});
