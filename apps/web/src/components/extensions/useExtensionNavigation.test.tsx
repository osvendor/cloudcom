import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  useExtensionNavigation,
  extensionNavLinksFromRegistry,
} from './useExtensionNavigation';
import type { RuntimeWebRegistry, RuntimeWebExtension } from '@/lib/extensions/registry';
import { CLOUD_COMMAND_CONNECTIONS_CHANGED_EVENT } from '@/lib/extensions/cloudCommandNavigationEvents';

const { getExtensionRegistry, createExtensionHostApi, useOrgScope, useAuthStore } = vi.hoisted(() => ({
  getExtensionRegistry: vi.fn(),
  createExtensionHostApi: vi.fn(),
  useOrgScope: vi.fn(),
  useAuthStore: vi.fn(),
}));
vi.mock('@/lib/extensions/registry', () => ({
  getExtensionRegistry: (...a: unknown[]) => getExtensionRegistry(...a),
}));
vi.mock('@/lib/extensions/hostApi', () => ({ createExtensionHostApi: (...a: unknown[]) => createExtensionHostApi(...a) }));
vi.mock('@/hooks/useOrgScope', () => ({ useOrgScope: () => useOrgScope() }));
vi.mock('@/stores/auth', () => ({ useAuthStore: (selector: (state: unknown) => unknown) => useAuthStore(selector) }));

function extension(over: Partial<RuntimeWebExtension> = {}): RuntimeWebExtension {
  return {
    name: 'demo',
    routeNamespace: 'demo',
    version: '1.0.0',
    digest: 'abc123',
    moduleUrl: '/api/v1/extensions/assets/demo/abc123/index.js',
    pages: [],
    navigation: [],
    slots: [],
    ...over,
  };
}

function registry(extensions: RuntimeWebExtension[]): RuntimeWebRegistry {
  return { apiVersion: 'breeze.extensions.web/v1', revision: 'rev-1', extensions };
}

beforeEach(() => {
  getExtensionRegistry.mockReset();
  createExtensionHostApi.mockReset();
  useOrgScope.mockReturnValue({ status: 'resolved', scope: 'all', orgId: null });
  useAuthStore.mockImplementation((selector: (state: unknown) => unknown) => selector({ isAuthenticated: true, user: { id: 'user-a' } }));
});

function cloudCommand(): RuntimeWebExtension {
  return extension({
    name: 'cloudcommand',
    routeNamespace: 'cloud-command',
    pages: [
      { id: 'overview', path: '/overview', element: 'cloudcommand-overview-page' },
      { id: 'threecx', path: '/threecx', element: 'cloudcommand-threecx-page' },
      { id: 'microsoft', path: '/microsoft', element: 'cloudcommand-microsoft-page' },
    ],
    navigation: [
      { id: 'overview', label: 'Cloud Command', path: '/overview', order: 100 },
      { id: 'connect', label: 'Connect', path: '/connect', order: 101 },
    ],
  });
}

describe('extensionNavLinksFromRegistry (pure projection)', () => {
  it('builds a namespaced href from the extension name and nav item path', () => {
    const links = extensionNavLinksFromRegistry(
      registry([
        extension({
          name: 'demo',
          navigation: [{ id: 'main', label: 'Demo Dashboard', path: '/dashboard', order: undefined }],
        }),
      ]),
    );
    expect(links).toEqual([{ name: 'Demo Dashboard', href: '/extensions/demo/dashboard' }]);
  });

  it('orders by order -> extension name -> contribution id', () => {
    const links = extensionNavLinksFromRegistry(
      registry([
        extension({
          name: 'zeta',
          navigation: [
            { id: 'b', label: 'Zeta B', path: '/b', order: 1 },
            { id: 'a', label: 'Zeta A', path: '/a', order: 1 },
          ],
        }),
        extension({
          name: 'alpha',
          navigation: [
            { id: undefined, label: 'Alpha Unordered', path: '/x', order: undefined },
            { id: 'first', label: 'Alpha First', path: '/first', order: 0 },
          ],
        }),
      ]),
    );
    // order 0 first (Alpha First), then order 1 tie-broken by extension name
    // (alpha < zeta is irrelevant here, both order-1 items are on zeta, so
    // tie-broken by contribution id 'a' < 'b'), then undefined-order items last.
    expect(links.map((l) => l.name)).toEqual(['Alpha First', 'Zeta A', 'Zeta B', 'Alpha Unordered']);
  });

  it('drops a disabled extension entirely (registry omits it — enabled-only by construction)', () => {
    const links = extensionNavLinksFromRegistry(registry([]));
    expect(links).toEqual([]);
  });

  it('SECURITY: rejects a nav item whose constructed href would not stay under /extensions/<name>/', () => {
    // absoluteWebPath already forbids '..' server-side, but this hook must
    // not trust that — re-derive and re-validate independently.
    const links = extensionNavLinksFromRegistry(
      registry([
        extension({
          name: 'demo',
          navigation: [{ id: 'evil', label: 'Escape', path: '/../../settings/users', order: undefined }],
        }),
      ]),
    );
    expect(links).toEqual([]);
  });

  it('SECURITY: rejects a well-formed-looking path that would smuggle a different extension namespace', () => {
    const links = extensionNavLinksFromRegistry(
      registry([
        extension({
          name: 'demo',
          navigation: [{ id: 'x', label: 'X', path: '/../other/page', order: undefined }],
        }),
      ]),
    );
    expect(links).toEqual([]);
  });
});

describe('useExtensionNavigation', () => {
  it('returns the enabled navigation links once the registry resolves', async () => {
    getExtensionRegistry.mockResolvedValue(
      registry([
        extension({ name: 'demo', navigation: [{ id: 'main', label: 'Demo', path: '/dashboard', order: undefined }] }),
      ]),
    );

    const { result } = renderHook(() => useExtensionNavigation());
    expect(result.current).toEqual([]);

    await waitFor(() =>
      expect(result.current).toEqual([{ name: 'Demo', href: '/extensions/demo/dashboard' }]),
    );
  });

  it('never throws to the caller: a registry fetch failure resolves to an empty list', async () => {
    getExtensionRegistry.mockRejectedValue(new Error('extension registry request failed with status 401'));

    const { result } = renderHook(() => useExtensionNavigation());

    await waitFor(() => expect(getExtensionRegistry).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it('returns no links when no extension contributes navigation', async () => {
    getExtensionRegistry.mockResolvedValue(registry([extension({ name: 'demo', navigation: [] })]));

    const { result } = renderHook(() => useExtensionNavigation());
    await waitFor(() => expect(getExtensionRegistry).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it('groups only enabled established Cloud Command providers under its declared overview page', async () => {
    useOrgScope.mockReturnValue({ status: 'resolved', scope: 'org', orgId: 'org-a' });
    getExtensionRegistry.mockResolvedValue(registry([cloudCommand()]));
    const request = vi.fn(async (path: string) => Response.json(path === '/threecx/connection'
      ? { connected: true, enabled: true }
      : { available: true, connected: true, enabled: true }));
    createExtensionHostApi.mockReturnValue({ hostApi: { request }, revoke: vi.fn() });

    const { result } = renderHook(() => useExtensionNavigation());
    await waitFor(() => expect(result.current).toEqual([
      { name: 'Cloud Command', href: '/extensions/cloudcommand/overview', children: [
        { name: '3CX', href: '/extensions/cloudcommand/threecx' },
        { name: 'Microsoft 365', href: '/extensions/cloudcommand/microsoft' },
      ], loading: false },
      { name: 'Connect', href: '/extensions/cloudcommand/connect' },
    ]));
  });

  it('shows Google only for an active native connection in the selected organization', async () => {
    useOrgScope.mockReturnValue({ status: 'resolved', scope: 'org', orgId: 'org-a' });
    const ext = cloudCommand();
    getExtensionRegistry.mockResolvedValue(registry([{ ...ext, pages: [
      ...ext.pages, { id: 'google', path: '/google', element: 'cloudcommand-google-page' },
    ] }]));
    const request = vi.fn(async (path: string) => Response.json(path === '/google/connection'
      ? { available: true, connected: true, enabled: true }
      : { available: false, connected: false, enabled: false }));
    createExtensionHostApi.mockReturnValue({ hostApi: { request }, revoke: vi.fn() });
    const { result } = renderHook(() => useExtensionNavigation());
    await waitFor(() => expect(result.current[0]).toMatchObject({ children: [
      { name: 'Google Workspace', href: '/extensions/cloudcommand/google' },
    ], loading: false }));
    expect(request).toHaveBeenCalledWith('/google/connection');
  });

  it('keeps an established provider when the other status request fails', async () => {
    useOrgScope.mockReturnValue({ status: 'resolved', scope: 'org', orgId: 'org-a' });
    getExtensionRegistry.mockResolvedValue(registry([cloudCommand()]));
    const request = vi.fn(async (path: string) => path === '/threecx/connection'
      ? Promise.reject(new Error('denied'))
      : Response.json({ available: true, connected: true, enabled: true }));
    createExtensionHostApi.mockReturnValue({ hostApi: { request }, revoke: vi.fn() });

    const { result } = renderHook(() => useExtensionNavigation());
    await waitFor(() => expect(result.current[0]).toEqual({
      name: 'Cloud Command', href: '/extensions/cloudcommand/overview', children: [
        { name: 'Microsoft 365', href: '/extensions/cloudcommand/microsoft' },
      ], loading: false,
    }));
  });

  it('does not include disabled connections even when their provider is otherwise available', async () => {
    useOrgScope.mockReturnValue({ status: 'resolved', scope: 'org', orgId: 'org-a' });
    getExtensionRegistry.mockResolvedValue(registry([cloudCommand()]));
    const request = vi.fn(async (path: string) => Response.json(path === '/threecx/connection'
      ? { connected: true, enabled: false }
      : { available: true, connected: true, enabled: true }));
    createExtensionHostApi.mockReturnValue({ hostApi: { request }, revoke: vi.fn() });

    const { result } = renderHook(() => useExtensionNavigation());
    await waitFor(() => expect(result.current[0]).toMatchObject({ children: [
      { name: 'Microsoft 365', href: '/extensions/cloudcommand/microsoft' },
    ], loading: false }));
  });

  it('hides old organization children before delayed responses can resolve', async () => {
    let selectedOrg = 'org-a';
    const resolvers: Array<(response: Response) => void> = [];
    useOrgScope.mockImplementation(() => ({ status: 'resolved', scope: 'org', orgId: selectedOrg }));
    getExtensionRegistry.mockResolvedValue(registry([cloudCommand()]));
    createExtensionHostApi.mockImplementation(() => ({
      hostApi: { request: () => new Promise<Response>((resolve) => resolvers.push(resolve)) },
      revoke: vi.fn(),
    }));

    const { result, rerender } = renderHook(() => useExtensionNavigation());
    await waitFor(() => expect(resolvers).toHaveLength(2));
    selectedOrg = 'org-b';
    rerender();
    expect(result.current[0]).toMatchObject({ children: [], loading: true });
    await waitFor(() => expect(resolvers).toHaveLength(4));
    resolvers[0](Response.json({ connected: true, enabled: true }));
    resolvers[1](Response.json({ available: true, connected: true, enabled: true }));
    await Promise.resolve();
    expect(result.current[0]).toMatchObject({ children: [], loading: true });
    resolvers[2](Response.json({ connected: false, enabled: true }));
    resolvers[3](Response.json({ available: true, connected: true, enabled: true }));
    await waitFor(() => expect(result.current[0]).toMatchObject({ children: [
      { name: 'Microsoft 365', href: '/extensions/cloudcommand/microsoft' },
    ], loading: false }));
  });

  it('does not create an authenticated host API without a selected organization or declared Cloud Command pages', async () => {
    getExtensionRegistry.mockResolvedValue(registry([extension({ name: 'cloudcommand', navigation: [{ id: 'overview', label: 'Cloud Command', path: '/overview', order: 1 }] })]));
    renderHook(() => useExtensionNavigation());
    await waitFor(() => expect(getExtensionRegistry).toHaveBeenCalled());
    expect(createExtensionHostApi).not.toHaveBeenCalled();
  });

  it('does not retain pending children or start new reads after logout', async () => {
    let authenticated = true;
    const resolvers: Array<(response: Response) => void> = [];
    useOrgScope.mockReturnValue({ status: 'resolved', scope: 'org', orgId: 'org-a' });
    useAuthStore.mockImplementation((selector: (state: unknown) => unknown) => selector({ isAuthenticated: authenticated, user: authenticated ? { id: 'user-a' } : null }));
    getExtensionRegistry.mockResolvedValue(registry([cloudCommand()]));
    createExtensionHostApi.mockReturnValue({
      hostApi: { request: () => new Promise<Response>((resolve) => resolvers.push(resolve)) },
      revoke: vi.fn(),
    });

    const { result, rerender } = renderHook(() => useExtensionNavigation());
    await waitFor(() => expect(resolvers).toHaveLength(2));
    authenticated = false;
    rerender();
    expect(result.current[0]).toMatchObject({ children: [], loading: true });
    resolvers.forEach((resolve) => resolve(Response.json({ connected: true, enabled: true, available: true })));
    await Promise.resolve();
    expect(result.current[0]).toMatchObject({ children: [] });
    expect(createExtensionHostApi).toHaveBeenCalledTimes(1);
  });

  it('drops a prior account response while the selected organization stays the same', async () => {
    let accountId = 'user-a';
    const resolvers: Array<(response: Response) => void> = [];
    useOrgScope.mockReturnValue({ status: 'resolved', scope: 'org', orgId: 'org-a' });
    useAuthStore.mockImplementation((selector: (state: unknown) => unknown) => selector({ isAuthenticated: true, user: { id: accountId } }));
    getExtensionRegistry.mockResolvedValue(registry([cloudCommand()]));
    createExtensionHostApi.mockImplementation(() => ({
      hostApi: { request: () => new Promise<Response>((resolve) => resolvers.push(resolve)) },
      revoke: vi.fn(),
    }));

    const { result, rerender } = renderHook(() => useExtensionNavigation());
    await waitFor(() => expect(resolvers).toHaveLength(2));
    accountId = 'user-b';
    rerender();
    expect(result.current[0]).toMatchObject({ children: [], loading: true });
    await waitFor(() => expect(resolvers).toHaveLength(4));
    resolvers[0](Response.json({ connected: true, enabled: true }));
    resolvers[1](Response.json({ available: true, connected: true, enabled: true }));
    await Promise.resolve();
    expect(result.current[0]).toMatchObject({ children: [], loading: true });
    resolvers[2](Response.json({ connected: false, enabled: true }));
    resolvers[3](Response.json({ available: false, connected: false, enabled: false }));
    await waitFor(() => expect(result.current[0]).toMatchObject({ children: [], loading: false }));
  });

  it('revalidates connection state after a matching successful host event, focus, and Astro swap', async () => {
    useOrgScope.mockReturnValue({ status: 'resolved', scope: 'org', orgId: 'org-a' });
    getExtensionRegistry.mockResolvedValue(registry([cloudCommand()]));
    createExtensionHostApi.mockReturnValue({ hostApi: { request: async (path: string) => Response.json(path === '/threecx/connection'
      ? { connected: false, enabled: true }
      : { available: false, connected: false, enabled: false }) }, revoke: vi.fn() });
    renderHook(() => useExtensionNavigation());
    await waitFor(() => expect(createExtensionHostApi).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new CustomEvent(CLOUD_COMMAND_CONNECTIONS_CHANGED_EVENT, { detail: { organizationId: 'org-a' } }));
    await waitFor(() => expect(createExtensionHostApi).toHaveBeenCalledTimes(2));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(createExtensionHostApi).toHaveBeenCalledTimes(3));
    document.dispatchEvent(new Event('astro:after-swap'));
    await waitFor(() => expect(createExtensionHostApi).toHaveBeenCalledTimes(4));
  });
});
