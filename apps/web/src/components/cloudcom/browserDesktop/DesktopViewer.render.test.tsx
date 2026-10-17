import { renderToString } from 'react-dom/server';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DesktopViewer from './upstream/components/DesktopViewer';
import { connectWebRTC } from './upstream/lib/transports/webrtc';
import { capabilitiesFor } from './upstream/lib/transports/types';

vi.mock('./upstream/lib/api', () => ({
  exchangeDesktopConnectCode: vi.fn().mockResolvedValue({ accessToken: 'test-token', hostname: 'Test endpoint', osType: 'windows' }),
  exchangeVncConnectCode: vi.fn(),
}));
vi.mock('./upstream/lib/webrtc', async importOriginal => ({
  ...await importOriginal<object>(), isWebRTCSupported: () => true,
}));
vi.mock('./upstream/lib/transports/webrtc', () => ({ connectWebRTC: vi.fn() }));

describe('generated browser desktop initial render', () => {
  it('renders the real viewer before any transport or clipboard effects run', () => {
    const markup = renderToString(<DesktopViewer
      params={{ mode: 'desktop', apiUrl: 'https://breeze.example.com', sessionId: 'test-session', connectCode: 'private-connect-code', deviceId: 'test-device' }}
      closing={false}
      onDisconnect={() => {}}
      onError={() => {}}
    />);
    expect(markup).toContain('Connecting');
    expect(markup).not.toContain('private-connect-code');
  });

  it('starts, renders a connected WebRTC session, and cleans up the real viewer', async () => {
    const channel = () => Object.assign(new EventTarget(), { readyState: 'open', send: vi.fn(), bufferedAmount: 0 });
    const close = vi.fn();
    vi.mocked(connectWebRTC).mockImplementation(async (_auth, deps) => ({
      kind: 'webrtc', capabilities: capabilitiesFor('webrtc'), videoElement: deps.videoElement,
      pc: { getStats: vi.fn().mockResolvedValue(new Map()) } as unknown as RTCPeerConnection,
      controlChannel: channel() as unknown as RTCDataChannel,
      inputChannel: channel() as unknown as RTCDataChannel,
      openReliableInput: () => null, close,
    }));
    const onError = vi.fn();
    const view = render(<DesktopViewer
      params={{ mode: 'desktop', apiUrl: 'https://breeze.example.com', sessionId: 'transport-session', connectCode: 'transport-code', deviceId: 'test-device' }}
      closing={false} onDisconnect={() => {}} onError={onError}
    />);
    await waitFor(() => expect(connectWebRTC).toHaveBeenCalledOnce());
    await act(async () => { vi.mocked(connectWebRTC).mock.calls[0]![1].onConnected(); });
    expect(await screen.findByRole('button', { name: 'Copy remote text' })).toBeVisible();
    expect(onError).not.toHaveBeenCalled();
    view.unmount();
    expect(close).toHaveBeenCalled();
  });
});
