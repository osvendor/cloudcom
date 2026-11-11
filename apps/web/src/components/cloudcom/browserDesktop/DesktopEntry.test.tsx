import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DesktopEntry from './DesktopEntry';

const mocks = vi.hoisted(() => ({ ready: false, fetch: vi.fn(), connect: vi.fn() }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => mocks.ready,
  fetchWithAuth: mocks.fetch,
}));
vi.mock('@/components/remote/ConnectDesktopButton', () => ({ default: (props: unknown) => {
  mocks.connect(props); return <button>Connect</button>;
} }));
beforeEach(() => { mocks.ready = false; mocks.fetch.mockReset(); mocks.connect.mockClear(); });
describe('desktop navigation entry', () => {
  it('waits for normal Breeze authentication before querying or connecting', () => {
    render(<DesktopEntry deviceId="device" />);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('never connects a forbidden device', async () => {
    mocks.ready = true; mocks.fetch.mockResolvedValue(new Response('{}', { status: 403 }));
    render(<DesktopEntry deviceId="device" />);
    await screen.findByRole('alert');
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('passes authorized live device policy and session selection to the existing connector', async () => {
    mocks.ready = true;
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ hostname: 'HOST', status: 'online', helperLifecycleMode: 'on-demand', remoteAccessPolicy: { webrtcDesktop: false } })));
    render(<DesktopEntry deviceId="device" />);
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'device', autoStart: true, preferBuiltIn: true,
      helperLifecycleMode: 'on-demand', remoteAccessPolicy: { webrtcDesktop: false },
    })));
  });
});
