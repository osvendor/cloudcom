import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExtensionHostApi, ExtensionHostApiError } from './hostApi';

const { fetchWithAuth, getExtensionRegistry } = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), getExtensionRegistry: vi.fn() }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth }));

vi.mock('./registry', () => ({ getExtensionRegistry }));

const registry = (routeNamespace = 'cloud-command') => ({
  extensions: [{ name: 'cloud-command', routeNamespace }],
});

beforeEach(() => {
  fetchWithAuth.mockReset();
  getExtensionRegistry.mockReset();
  getExtensionRegistry.mockResolvedValue(registry());
  fetchWithAuth.mockResolvedValue(new Response('{}'));
});

describe('createExtensionHostApi', () => {
  it('uses the authenticated registry namespace and forces the mounted organization', async () => {
    const { hostApi } = createExtensionHostApi({ extensionName: 'cloud-command', organizationId: 'org-a' });

    await hostApi.request('/threecx/connection?orgId=org-a&filter=active', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });

    expect(getExtensionRegistry).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth).toHaveBeenCalledWith(
      '/api/v1/cloud-command/threecx/connection?filter=active&orgId=org-a',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
    const init = fetchWithAuth.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBeNull();
  });

  it.each([
    '/api/v1/users',
    'https://attacker.example/path',
    '//attacker.example/path',
    '/threecx/../users',
    '/threecx/%2e%2e/users',
    '/threecx%2f..%2fusers',
    '/threecx\\connection',
  ])('rejects paths that can escape the namespace: %s', async (path) => {
    const { hostApi } = createExtensionHostApi({ extensionName: 'cloud-command', organizationId: 'org-a' });
    await expect(hostApi.request(path)).rejects.toBeInstanceOf(ExtensionHostApiError);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects tenant switching and caller supplied authentication', async () => {
    const { hostApi } = createExtensionHostApi({ extensionName: 'cloud-command', organizationId: 'org-a' });
    await expect(hostApi.request('/threecx/connection?orgId=org-b')).rejects.toBeInstanceOf(ExtensionHostApiError);
    await expect(hostApi.request('/threecx/connection', { headers: { Authorization: 'Bearer stolen' } })).rejects.toBeInstanceOf(ExtensionHostApiError);
    await expect(hostApi.request('/threecx/connection', { credentials: 'include' })).rejects.toBeInstanceOf(ExtensionHostApiError);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('aborts and permanently revokes outstanding work', async () => {
    let seenSignal: AbortSignal | undefined;
    fetchWithAuth.mockImplementation((_url: string, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const { hostApi, revoke } = createExtensionHostApi({ extensionName: 'cloud-command', organizationId: 'org-a' });
    const pending = hostApi.request('/threecx/connection');
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    revoke();
    expect(seenSignal?.aborted).toBe(true);
    await expect(hostApi.request('/threecx/connection')).rejects.toMatchObject({ name: 'AbortError' });
    // The in-flight promise is intentionally unresolved in this mock; it was
    // handed an aborted signal, which is what real fetch observes.
    void pending;
  });
});
