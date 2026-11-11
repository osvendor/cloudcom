import { renderToString } from 'react-dom/server';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
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

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const writeClipboard = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: writeClipboard } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

function testChannel() {
  const channel = Object.assign(new EventTarget(), {
    readyState: 'open', send: vi.fn(), bufferedAmount: 0,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onclose: null as (() => void) | null,
  });
  return {
    channel,
    receive(payload: unknown) {
      const event = new MessageEvent('message', { data: JSON.stringify(payload) });
      channel.dispatchEvent(event);
      channel.onmessage?.(event);
    },
    messages: () => channel.send.mock.calls.map(([json]) => JSON.parse(json)),
  };
}

async function connectedViewer(deviceId = 'test-device') {
  const control = testChannel();
  const input = testChannel();
  const clipboard = testChannel();
  const close = vi.fn();
  vi.mocked(connectWebRTC).mockImplementation(async (_auth, deps) => ({
    kind: 'webrtc', capabilities: capabilitiesFor('webrtc'), videoElement: deps.videoElement,
    pc: { getStats: vi.fn().mockResolvedValue(new Map()) } as unknown as RTCPeerConnection,
    controlChannel: control.channel as unknown as RTCDataChannel,
    inputChannel: input.channel as unknown as RTCDataChannel,
    openReliableInput: () => null, close,
  }));
  const onError = vi.fn();
  const view = render(<DesktopViewer
    params={{ mode: 'desktop', apiUrl: 'https://breeze.example.com', sessionId: 'transport-session', connectCode: 'transport-code', deviceId }}
    closing={false} onDisconnect={() => {}} onError={onError}
  />);
  await waitFor(() => expect(connectWebRTC).toHaveBeenCalledOnce());
  await act(async () => {
    const deps = vi.mocked(connectWebRTC).mock.calls[0]![1];
    deps.onConnected();
    // The callback runs after negotiation, just as a real agent-created channel does.
    deps.onClipboardChannel(clipboard.channel as unknown as RTCDataChannel);
  });
  expect(await screen.findByRole('button', { name: 'Copy remote text' })).toBeVisible();
  expect(clipboard.channel.onmessage).toBeTypeOf('function');
  expect(onError).not.toHaveBeenCalled();
  return { view, control, input, clipboard, close, onError };
}

async function enableComposition(control: ReturnType<typeof testChannel>) {
  await act(async () => { control.receive({ type: 'input_capabilities', typeText: true }); });
  const input = await screen.findByTestId('ime-capture');
  expect(input).toHaveFocus();
  return input;
}

function holdControl(target: HTMLElement) {
  fireEvent.keyDown(target, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
}

function assertNextControlChord(target: HTMLElement, input: ReturnType<typeof testChannel>) {
  input.channel.send.mockClear();
  fireEvent.keyDown(target, { key: 'a', code: 'KeyA', ctrlKey: true });
  expect(input.messages()).toContainEqual(expect.objectContaining({ type: 'key_press', key: 'a', modifiers: ['ctrl'] }));
  expect(input.messages()).not.toContainEqual(expect.objectContaining({ type: 'key_down', key: 'a' }));
}

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
    const { view, close, clipboard, input } = await connectedViewer();
    view.unmount();
    expect(close).toHaveBeenCalled();
    // A message from the ended session must not copy into the local clipboard.
    clipboard.receive({ type: 'text', text: 'ended session text' });
    expect(writeClipboard).not.toHaveBeenCalled();
    expect(input.messages().some(message => message.type === 'key_press')).toBe(false);
  });

  it('pastes from the focused IME input only after clipboard acknowledgement and preserves a held-Ctrl follow-up', async () => {
    const { control, input, clipboard } = await connectedViewer();
    const target = await enableComposition(control);
    const text = 'synthetic browser paste';
    const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('text' + text))).toString('hex');
    holdControl(target);
    fireEvent.keyDown(target, { key: 'v', code: 'KeyV', ctrlKey: true });
    fireEvent.paste(target, { clipboardData: { getData: (format: string) => format === 'text/plain' ? text : '' } });
    await waitFor(() => expect(clipboard.messages()).toContainEqual({ type: 'text', text }));
    expect(input.messages()).not.toContainEqual(expect.objectContaining({ key: 'v' }));
    await act(async () => { clipboard.receive({ type: 'ack', hash }); });
    await waitFor(() => expect(input.messages()).toContainEqual(expect.objectContaining({ type: 'key_press', key: 'v', modifiers: ['ctrl'] })));
    assertNextControlChord(target, input);
  });

  it('copies through the focused IME input without overwriting the local clipboard on unsolicited updates', async () => {
    const { control, input, clipboard } = await connectedViewer();
    const target = await enableComposition(control);
    clipboard.receive({ type: 'text', text: 'earlier remote text' });
    expect(writeClipboard).not.toHaveBeenCalled();
    holdControl(target);
    fireEvent.copy(target);
    expect(input.messages()).toContainEqual(expect.objectContaining({ type: 'key_press', key: 'c', modifiers: ['ctrl'] }));
    await act(async () => { clipboard.receive({ type: 'text', text: 'selected remote text' }); });
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledExactlyOnceWith('selected remote text'));
    assertNextControlChord(target, input);
  });

  it('keeps a held-Ctrl follow-up chord correct after the keyboard copy shortcut', async () => {
    const { view, input } = await connectedViewer();
    const target = view.container.querySelector('video')!;
    holdControl(target);
    fireEvent.keyDown(target, { key: 'c', code: 'KeyC', ctrlKey: true });
    expect(input.messages()).toContainEqual(expect.objectContaining({ type: 'key_press', key: 'c', modifiers: ['ctrl'] }));
    assertNextControlChord(target, input);
  });

  it('restores remembered remapping, releases held modifiers on change, and saves the new preference', async () => {
    const storageKey = 'breeze-viewer-prefs:device:remembered-device';
    localStorage.setItem(storageKey, JSON.stringify({ remapCmdCtrl: true }));
    const { view, input } = await connectedViewer('remembered-device');
    fireEvent.click(screen.getByTitle('More options'));
    const toggle = await screen.findByRole('menuitemcheckbox', { name: 'Cmd↔Ctrl remap' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    holdControl(view.container.querySelector('video')!);
    expect(input.messages()).toContainEqual(expect.objectContaining({ type: 'key_down', key: 'meta' }));
    input.channel.send.mockClear();
    fireEvent.click(toggle);
    expect(input.messages()).toContainEqual(expect.objectContaining({ type: 'key_up', key: 'meta' }));
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ remapCmdCtrl: false }));
  });
});
