// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RemoteViewer from './RemoteViewer';
import { portalApi } from '@/lib/api';

vi.mock('@/lib/api', () => ({ portalApi: {
  getRemoteSession: vi.fn(), submitRemoteOffer: vi.fn(), endRemoteSession: vi.fn(),
} }));
class Peer {
  static latest: Peer;
  connectionState = 'connected';
  iceGatheringState = 'complete';
  localDescription = { sdp: 'offer' };
  ontrack: unknown;
  onconnectionstatechange: (() => void) | null = null;
  input = { readyState: 'open', bufferedAmount: 0, send: vi.fn() };
  close = vi.fn(() => { this.connectionState = 'closed'; });
  addTransceiver = vi.fn();
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer' }));
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => undefined);
  createDataChannel = vi.fn(() => this.input);
  constructor() { Peer.latest = this; }
}
const live = { data: { session: { id: 'session', status: 'active', terminationPhase: 'none', webrtcAnswer: 'answer' }, iceServers: [] } };
async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }

describe('customer remote viewer lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    vi.stubGlobal('RTCPeerConnection', Peer);
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2);
    vi.mocked(portalApi.getRemoteSession).mockResolvedValue(live as never);
    vi.mocked(portalApi.submitRemoteOffer).mockResolvedValue({ data: { success: true } } as never);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('closes the peer when a heartbeat loses authorization', async () => {
    render(<RemoteViewer sessionId="session" />); await flush();
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
    vi.mocked(portalApi.getRemoteSession).mockResolvedValue({ error: 'Access revoked', statusCode: 403 });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(Peer.latest.close).toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Access revoked');
  });

  it('releases held keys on blur and closes locally even when end fails', async () => {
    render(<RemoteViewer sessionId="session" />); await flush();
    fireEvent.keyDown(screen.getByTestId('remote-video'), { code: 'KeyA', key: 'a' });
    fireEvent.blur(window);
    expect(Peer.latest.input.send).toHaveBeenCalledWith(JSON.stringify({ type: 'key_up', key: 'a' }));
    vi.mocked(portalApi.endRemoteSession).mockResolvedValue({ error: 'Unavailable', statusCode: 503 });
    fireEvent.click(screen.getByTestId('remote-end')); await flush();
    expect(Peer.latest.close).toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Unavailable');
    expect(screen.getByTestId('remote-end')).not.toBeDisabled();
  });

  it('reports completion only after endpoint termination confirmation', async () => {
    render(<RemoteViewer sessionId="session" />); await flush();
    vi.mocked(portalApi.endRemoteSession).mockResolvedValue({ data: { success: true, terminationPhase: 'pending' } } as never);
    vi.mocked(portalApi.getRemoteSession).mockResolvedValue({ data: { session: { status: 'disconnected', terminationPhase: 'confirmed' } } } as never);
    fireEvent.click(screen.getByTestId('remote-end')); await flush();
    expect(screen.getByRole('status')).toHaveTextContent('Ending session');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole('status')).toHaveTextContent('Session ended');
    expect(screen.getByTestId('remote-end')).toBeDisabled();
  });
});
