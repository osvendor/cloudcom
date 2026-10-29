import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ account: vi.fn(), staffFetch: vi.fn(), fetch: vi.fn(), navigate: vi.fn() }));
vi.mock('./remoteAccount', () => ({ resolveRemoteAccount: m.account,
  staffRemoteSignInUrl: (next: string) => `/api/v1/auth/cf-access-login?next=${encodeURIComponent(next)}` }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: m.staffFetch, apiLogin: vi.fn(),
  useAuthStore: { getState: () => ({ user: { email: 'staff@example.test' } }) } }));
vi.mock('../auth/LoginPage', () => ({ default: () => <p>Sign in</p> }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
import RemoteComputersPage from './RemoteComputersPage';

const id = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const device = { id, hostname: 'WORKSTATION', displayName: null, status: 'online',
  organizationId: 'org', organizationName: 'Example', currentUser: 'Ada', previousUsers: ['Lin'], canRename: true,
  transports: { webrtc: { available: true }, rustdesk: { available: true } } };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', m.fetch);
  m.account.mockResolvedValue({ kind: 'staff' });
  m.staffFetch.mockResolvedValue(Response.json({ devices: [device], nextCursor: null }));
  document.cookie = 'breeze_portal_csrf_token=test-csrf; path=/';
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.cookie = 'breeze_portal_csrf_token=; max-age=0; path=/'; });

describe('shared remote browser directory', () => {
  it('loads all staff pages and launches WebRTC on the staff route', async () => {
    m.staffFetch.mockResolvedValueOnce(Response.json({ devices: [device], nextCursor: secondId }))
      .mockResolvedValueOnce(Response.json({ devices: [{ ...device, id: secondId, hostname: 'SECOND' }], nextCursor: null }));
    render(<RemoteComputersPage navigate={m.navigate} />);
    await screen.findByText('SECOND');
    const download = screen.getByRole('link', { name: 'Download viewer for Windows' });
    expect(download).toHaveAttribute('href', '/downloads/managed-viewer/OS-Consultants-Remote-Access-1.0.7-x64.msi');
    expect(download).toHaveAttribute('download', 'OS-Consultants-Remote-Access-1.0.7-x64.msi');
    expect(m.staffFetch).toHaveBeenNthCalledWith(2, `/staff-native/browser/devices?cursor=${secondId}`);
    fireEvent.click(screen.getAllByRole('button', { name: 'Web Remote' })[1]!);
    expect(m.navigate).toHaveBeenCalledWith(`/remote/desktop/${id}`);
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it('does not show partial staff data or fall back to customer access after denial', async () => {
    m.staffFetch.mockResolvedValueOnce(Response.json({ devices: [device], nextCursor: secondId }))
      .mockResolvedValueOnce(Response.json({ error: 'Denied' }, { status: 403 }));
    render(<RemoteComputersPage navigate={m.navigate} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot load');
    expect(screen.queryByText('WORKSTATION')).toBeNull();
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it('prepares the browser binding before company sign-in', async () => {
    m.account.mockResolvedValue({ kind: 'staff-sso' });
    m.fetch.mockResolvedValue(Response.json({ success: true }));
    render(<RemoteComputersPage navigate={m.navigate} />);
    await waitFor(() => expect(m.navigate).toHaveBeenCalledWith('/api/v1/auth/cf-access-login?next=%2Fremote%2Fcomputers'));
    expect(m.fetch).toHaveBeenCalledWith('/api/v1/auth/browser-binding/bootstrap', expect.objectContaining({ method: 'POST' }));
    expect(m.staffFetch).not.toHaveBeenCalled();
  });

  it('launches the customer session only with customer CSRF and its verified session URL', async () => {
    m.account.mockResolvedValue({ kind: 'customer', user: { email: 'customer@example.test', orgId: 'org', orgName: 'Example' } });
    m.fetch.mockResolvedValueOnce(Response.json({ devices: [device] }))
      .mockResolvedValueOnce(Response.json({ launch: { url: `/portal/remote/${secondId}` } }));
    render(<RemoteComputersPage navigate={m.navigate} />);
    const download = await screen.findByRole('link', { name: 'Download viewer for Windows' });
    expect(download).toHaveAttribute('href', '/downloads/managed-viewer/OS-Consultants-Remote-Access-1.0.7-x64.msi');
    expect(download).toHaveAttribute('download', 'OS-Consultants-Remote-Access-1.0.7-x64.msi');
    fireEvent.click(screen.getByRole('button', { name: 'Web Remote' }));
    await waitFor(() => expect(m.navigate).toHaveBeenCalledWith(`/portal/remote/${secondId}`));
    expect(m.fetch).toHaveBeenLastCalledWith('/api/v1/portal/remote/sessions', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-breeze-csrf': 'test-csrf' },
      body: JSON.stringify({ deviceId: id, transport: 'webrtc' }),
    }));
    expect(m.staffFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Rename WORKSTATION' })).toBeNull();
  });

  it.each(['https://outside.example.test', '/portal/remote/not-a-uuid'])('rejects an unexpected customer launch URL %s', async url => {
    m.account.mockResolvedValue({ kind: 'customer', user: { email: 'customer@example.test', orgId: 'org' } });
    m.fetch.mockResolvedValueOnce(Response.json({ devices: [device] }))
      .mockResolvedValueOnce(Response.json({ launch: { url } }));
    render(<RemoteComputersPage navigate={m.navigate} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Web Remote' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid remote session link');
    expect(m.navigate).not.toHaveBeenCalled();
  });

  it('does not send a customer start request without CSRF', async () => {
    document.cookie = 'breeze_portal_csrf_token=; max-age=0; path=/';
    m.account.mockResolvedValue({ kind: 'customer', user: { email: 'customer@example.test', orgId: 'org' } });
    m.fetch.mockResolvedValueOnce(Response.json({ devices: [device] }));
    render(<RemoteComputersPage navigate={m.navigate} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Web Remote' }));
    await screen.findByRole('alert');
    expect(m.fetch).toHaveBeenCalledOnce();
    expect(m.navigate).not.toHaveBeenCalled();
  });

  it('opens only the exact authorized managed desktop scheme', async () => {
    render(<RemoteComputersPage navigate={m.navigate} />);
    await screen.findByText('WORKSTATION');
    m.staffFetch.mockResolvedValueOnce(Response.json({ launchUrl: `cloudcom-remote://staff/connect/${id}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Desktop app' }));
    await waitFor(() => expect(m.navigate).toHaveBeenCalledWith(`cloudcom-remote://staff/connect/${id}`));
    expect(m.staffFetch).toHaveBeenLastCalledWith(`/staff-native/launch/${id}`, { method: 'POST' });
  });
});
