import { useCallback, useEffect, useRef, useState } from 'react';
import { portalApi } from '@/lib/api';
import { withBase } from '@/lib/basePath';
import { remoteKey, remotePoint, remoteSessionIsLive, remoteWheel } from '@/lib/remoteInput';

const OPTIONS = { redirectOnUnauthorized: false, timeoutMs: 8000 };
const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

export default function RemoteViewer({ sessionId }: { sessionId: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const peer = useRef<RTCPeerConnection | null>(null);
  const input = useRef<RTCDataChannel | null>(null);
  const closed = useRef(false), mounted = useRef(false);
  const pressed = useRef(new Set<string>()), buttons = useRef(new Set<string>());
  const lastPoint = useRef({ x: 0, y: 0 });
  const pointerFrame = useRef<number | null>(null);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false), [confirmed, setConfirmed] = useState(false);

  const send = useCallback((message: Record<string, unknown>) => {
    if (closed.current || input.current?.readyState !== 'open') return;
    try { input.current.send(JSON.stringify(message)); } catch { /* Connection monitoring handles closure. */ }
  }, []);
  const release = useCallback(() => {
    for (const key of pressed.current) send({ type: 'key_up', key });
    for (const button of buttons.current) send({ type: 'mouse_up', button, ...lastPoint.current });
    pressed.current.clear(); buttons.current.clear();
  }, [send]);
  const closeLocal = useCallback(() => {
    release(); closed.current = true;
    if (pointerFrame.current !== null) cancelAnimationFrame(pointerFrame.current);
    pointerFrame.current = null;
    const connection = peer.current;
    peer.current = null; input.current = null;
    if (connection) { connection.onconnectionstatechange = null; connection.close(); }
    if (video.current) video.current.srcObject = null;
  }, [release]);
  const fail = useCallback((message: string) => {
    closeLocal();
    if (mounted.current) { setStatus('Connection ended'); setError(message); }
  }, [closeLocal]);

  useEffect(() => {
    let cancelled = false;
    mounted.current = true; closed.current = false;
    const current = () => !cancelled && !closed.current;
    const read = async () => {
      const response = await portalApi.getRemoteSession(sessionId, OPTIONS);
      if (!current()) return null;
      if (!response.data || !remoteSessionIsLive(response.data.session.status, response.data.session.terminationPhase)) {
        fail(response.error ?? 'Remote access has ended.'); return null;
      }
      return response.data;
    };
    const connect = async () => {
      const first = await read();
      if (!first || !current()) return;
      const connection = new RTCPeerConnection({ iceServers: first.iceServers ?? [] });
      peer.current = connection;
      connection.addTransceiver('video', { direction: 'recvonly' });
      // Deliver key/button releases reliably; pointer motion is coalesced below.
      input.current = connection.createDataChannel('input', { ordered: true });
      connection.createDataChannel('control', { ordered: true });
      connection.ontrack = event => {
        if (current() && event.track.kind === 'video' && video.current) {
          video.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          void video.current.play().catch(() => fail('The browser could not play the remote video.'));
        }
      };
      connection.onconnectionstatechange = () => {
        if (current() && ['failed', 'closed', 'disconnected'].includes(connection.connectionState)) fail('The remote connection was lost.');
      };
      await connection.setLocalDescription(await connection.createOffer());
      const iceDeadline = Date.now() + 5000;
      while (current() && connection.iceGatheringState !== 'complete' && Date.now() < iceDeadline) await sleep(50);
      if (!current()) return;
      if (!connection.localDescription?.sdp) throw new Error('The browser could not create a connection offer.');
      const offered = await portalApi.submitRemoteOffer(sessionId, connection.localDescription.sdp, OPTIONS);
      if (!current()) return;
      if (!offered.data?.success) throw new Error(offered.error ?? 'The computer could not start the session.');
      const answerDeadline = Date.now() + 45000;
      let answered = false;
      while (current() && Date.now() < answerDeadline) {
        const response = await read();
        if (!response || !current()) return;
        if (response.session.webrtcAnswer) {
          await connection.setRemoteDescription({ type: 'answer', sdp: response.session.webrtcAnswer });
          answered = true; break;
        }
        await sleep(1000);
      }
      if (!current()) return;
      if (!answered) throw new Error('The computer did not answer in time.');
      setStatus('Waiting for video…');
      const videoDeadline = Date.now() + 20000;
      while (current() && (connection.connectionState !== 'connected' || (video.current?.readyState ?? 0) < 2)) {
        if (Date.now() >= videoDeadline) throw new Error('The video connection could not be established.');
        await sleep(100);
      }
      if (!current()) return;
      setStatus('Connected');
      while (current()) { await sleep(10000); if (current() && !await read()) return; }
    };
    void connect().catch(e => { if (current()) fail(e instanceof Error ? e.message : 'Remote access is unavailable.'); });
    return () => { cancelled = true; mounted.current = false; closeLocal(); };
  }, [sessionId, closeLocal, fail]);

  useEffect(() => {
    window.addEventListener('blur', release);
    // If unload cannot POST, the endpoint still stops when viewer presence expires.
    window.addEventListener('pagehide', closeLocal);
    return () => { window.removeEventListener('blur', release); window.removeEventListener('pagehide', closeLocal); };
  }, [release, closeLocal]);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let remainder = 0;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = remotePoint(event.clientX, event.clientY, element.getBoundingClientRect(), element.videoWidth, element.videoHeight);
      if (!point) return;
      const result = remoteWheel(remainder, event.deltaY, event.deltaMode);
      remainder = result.remainder;
      if (result.steps) send({ type: 'mouse_scroll', ...point, delta: result.steps });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [send]);

  const end = async () => {
    if (ending || confirmed) return;
    closeLocal(); setEnding(true); setError(null); setStatus('Ending session…');
    try {
      const response = await portalApi.endRemoteSession(sessionId, OPTIONS);
      if (!response.data?.success) throw new Error(response.error ?? 'The server did not confirm the end request.');
      let phase = response.data.terminationPhase;
      const deadline = Date.now() + 10000;
      while (mounted.current && phase !== 'confirmed' && Date.now() < deadline) {
        await sleep(1000);
        const state = await portalApi.getRemoteSession(sessionId, OPTIONS);
        if (!state.data) throw new Error(state.error ?? 'The computer has not confirmed disconnection.');
        phase = state.data.session.terminationPhase ?? 'pending';
      }
      if (phase !== 'confirmed') throw new Error('The computer has not confirmed disconnection yet. Retry to check.');
      if (mounted.current) { setConfirmed(true); setStatus('Session ended.'); }
    } catch (e) {
      if (mounted.current) { setStatus('Disconnected locally'); setError(e instanceof Error ? e.message : 'Retry to confirm disconnection.'); }
    } finally { if (mounted.current) setEnding(false); }
  };
  return <div className="space-y-4" data-testid="remote-viewer">
    <div className="flex items-center justify-between gap-4">
      <div><h1 className="font-display text-2xl font-semibold">Remote access</h1><p role={error ? 'alert' : 'status'}>{error ?? status}</p></div>
      <button data-testid="remote-end" onClick={() => void end()} disabled={ending || confirmed} className="rounded border px-4 py-2">{ending ? 'Ending…' : 'End session'}</button>
    </div>
    <video ref={video} data-testid="remote-video" tabIndex={0} autoPlay muted playsInline
      className="min-h-[360px] w-full rounded bg-black object-contain" onBlur={release} onContextMenu={e => e.preventDefault()}
      onMouseMove={e => {
        const p = remotePoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), e.currentTarget.videoWidth, e.currentTarget.videoHeight);
        if (!p) return; lastPoint.current = p;
        if (pointerFrame.current === null) pointerFrame.current = requestAnimationFrame(() => {
          pointerFrame.current = null;
          if ((input.current?.bufferedAmount ?? Infinity) < 65536) send({ type: 'mouse_move', ...lastPoint.current });
        });
      }}
      onMouseDown={e => {
        const p = remotePoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), e.currentTarget.videoWidth, e.currentTarget.videoHeight);
        const button = ['left', 'middle', 'right'][e.button];
        if (!p || !button) return;
        e.preventDefault(); e.currentTarget.focus(); lastPoint.current = p; buttons.current.add(button);
        send({ type: 'mouse_down', button, ...p });
      }}
      onMouseUp={e => { const button = ['left', 'middle', 'right'][e.button]; if (button) { buttons.current.delete(button); send({ type: 'mouse_up', button, ...lastPoint.current }); } }}
      onMouseLeave={release}
      onKeyDown={e => { const key = remoteKey(e.code, e.key); if (key) { e.preventDefault(); pressed.current.add(key); send({ type: 'key_down', key, capsLock: e.getModifierState('CapsLock') }); } }}
      onKeyUp={e => { const key = remoteKey(e.code, e.key); if (key) { e.preventDefault(); pressed.current.delete(key); send({ type: 'key_up', key }); } }}
    />
    <a href={withBase('/remote')} className="inline-block underline">Return to assigned computers</a>
  </div>;
}
