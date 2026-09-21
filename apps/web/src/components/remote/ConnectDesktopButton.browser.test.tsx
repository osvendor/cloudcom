import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ConnectDesktopButton from './ConnectDesktopButton';
import { fetchWithAuth } from '@/stores/auth';
import { launchBrowserDesktop, isBrowserDesktopActive } from '../cloudcom/browserDesktop/launch';
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../cloudcom/browserDesktop/launch', () => ({ launchBrowserDesktop: vi.fn(), isBrowserDesktopActive: vi.fn(() => false) }));
beforeEach(() => { vi.mocked(fetchWithAuth).mockReset(); vi.mocked(isBrowserDesktopActive).mockReturnValue(false); });
describe('browser desktop default', () => {
  it('uses the existing authorized session and one-use code without a native protocol launch', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async path => new Response(JSON.stringify(
      String(path).startsWith('/devices/') ? { desktopAccess: null, hasRemoteAccessLauncher: false } :
      String(path).endsWith('desktop-connect-code') ? { code: 'private-test-code' } : { id: 'session' }
    ), { headers: { 'content-type': 'application/json' } }));
    render(<ConnectDesktopButton deviceId="device" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));
    await waitFor(() => expect(launchBrowserDesktop).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session', connectCode: 'private-test-code', deviceId: 'device' })));
    expect(document.body.textContent).not.toContain('private-test-code');
    expect(document.querySelector('a[href^="breeze:"]')).toBeNull();
  });
  it('does not create another session while a browser desktop remains active', async () => {
    vi.mocked(isBrowserDesktopActive).mockReturnValue(true);
    render(<ConnectDesktopButton deviceId="device" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));
    await screen.findByTitle(/Disconnect the active browser desktop/);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
