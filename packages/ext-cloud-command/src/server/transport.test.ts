import { describe, expect, it, vi } from 'vitest';
import { createProvider } from './transport';

const credentials = { origin: 'https://pbx.example.test', clientId: 'client', secret: 'secret' };
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }

describe('3CX guarded transport', () => {
  it('uses the injected transport with bounded requests, HTTPS origin and redirect errors', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ access_token: 'token' }))
      .mockResolvedValueOnce(response({ value: [] }));
    await expect(createProvider(fetch).groups(credentials)).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [_url, init] of fetch.mock.calls) {
      expect(init).toMatchObject({ redirect: 'error', timeoutMs: 15000, maxBytes: 2 * 1024 * 1024 });
    }
    expect(fetch.mock.calls[0][0]).toBe('https://pbx.example.test/connect/token');
  });

  it.each([
    ['network failure', vi.fn().mockRejectedValue(new Error('offline')), 'provider_unreachable'],
    ['redirect response', vi.fn().mockResolvedValue(response({}, 302)), 'provider_request_failed'],
    ['invalid credentials', vi.fn().mockResolvedValue(response({}, 401)), 'provider_access_denied'],
  ])('maps %s without leaking transport errors', async (_label, fetch, code) => {
    await expect(createProvider(fetch).groups(credentials)).rejects.toMatchObject({ code });
  });

  it('paginates groups by fixed same-origin requests and never follows nextLink', async () => {
    const first = Array.from({ length: 100 }, (_, id) => ({ Id: id, Name: `Group ${id}` }));
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ access_token: 'token' }))
      .mockResolvedValueOnce(response({ value: first, '@odata.nextLink': 'https://attacker.example/steal' }))
      .mockResolvedValueOnce(response({ value: [{ Id: 100, Name: 'Final' }] }));
    const groups = await createProvider(fetch).groups(credentials);
    expect(groups).toHaveLength(101);
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain('https://attacker.example/steal');
    expect(fetch.mock.calls[2][0]).toContain('https://pbx.example.test/xapi/v1/Groups?');
    expect(fetch.mock.calls[2][0]).toContain('%24skip=100');
  });

  it('rejects invalid origins and malformed provider pages', async () => {
    await expect(createProvider(vi.fn()).groups({ ...credentials, origin: 'http://private.example.test' })).rejects.toMatchObject({ code: 'invalid_origin' });
    const fetch = vi.fn().mockResolvedValueOnce(response({ access_token: 'token' })).mockResolvedValueOnce(response({ value: [{ Id: 'bad', Name: 'no' }] }));
    await expect(createProvider(fetch).groups(credentials)).rejects.toMatchObject({ code: 'invalid_provider_response' });
  });
});
