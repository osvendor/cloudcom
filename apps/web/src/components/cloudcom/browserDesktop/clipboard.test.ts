import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { BrowserClipboard } from './clipboard';

function setup() {
  vi.stubGlobal('crypto', webcrypto);
  const notice = vi.fn();
  const write = vi.fn().mockResolvedValue(undefined);
  const channel = { readyState: 'open', send: vi.fn(), onmessage: null, onclose: null } as unknown as RTCDataChannel;
  const bridge = new BrowserClipboard(notice, write);
  bridge.attach(channel);
  const receive = (data: unknown) => channel.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  return { notice, write, channel, bridge, receive };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('browser text clipboard', () => {
  it('does not overwrite local clipboard for unsolicited remote data', async () => {
    const { bridge, receive, write } = setup();
    receive({ type: 'text', text: 'remote value' });
    expect(write).not.toHaveBeenCalled();
    await bridge.copy();
    expect(write).toHaveBeenCalledWith('remote value');
  });
  it('copies the next update after Ctrl+C and offers a gesture fallback on denial', async () => {
    const { bridge, receive, write, notice } = setup();
    write.mockRejectedValueOnce(new Error('do not expose this value'));
    bridge.requestCopy();
    receive({ type: 'text', text: 'private value' });
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith('private value');
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('Click Copy remote text'));
    expect(JSON.stringify(notice.mock.calls)).not.toContain('private value');
  });
  it('deduplicates keydown and native copy commands while allowing subsequent copies', () => {
    const { bridge } = setup();
    vi.useFakeTimers();
    const dispatch = vi.fn();
    expect(bridge.requestCopy(dispatch)).toBe(true);
    expect(bridge.requestCopy(dispatch)).toBe(false);
    expect(dispatch).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(251);
    expect(bridge.requestCopy(dispatch)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    bridge.clear();
  });
  it('installs acknowledgement before sending and pastes only after matching ack', async () => {
    const { bridge, channel, receive } = setup();
    const dispatch = vi.fn();
    // Compute rather than hardcode fixture hash to keep test focused on ordering.
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('texthello'));
    const hash = Buffer.from(digest).toString('hex');
    vi.mocked(channel.send).mockImplementation(() => {
      receive({ type: 'ack', hash: 'wrong' });
      expect(dispatch).not.toHaveBeenCalled();
      receive({ type: 'ack', hash });
    });
    await bridge.paste('hello', dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it('never dispatches stale clipboard after channel close', async () => {
    const { bridge, channel, notice } = setup();
    const dispatch = vi.fn();
    const done = bridge.paste('sample', dispatch);
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalled());
    // Close is an immediate failed acknowledgement, with the same no-paste guarantee.
    channel.onclose?.({} as Event);
    await done;
    expect(dispatch).not.toHaveBeenCalled();
    expect(notice.mock.calls.flat().join()).not.toContain('sample');
  });
  it('can copy the acknowledged pasted value when the agent suppresses its echo', async () => {
    const { bridge, channel, receive, write } = setup();
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('textsame value'));
    const hash = Buffer.from(digest).toString('hex');
    vi.mocked(channel.send).mockImplementation(() => receive({ type: 'ack', hash }));
    await bridge.paste('same value', vi.fn());
    expect(write).not.toHaveBeenCalled();
    vi.useFakeTimers();
    bridge.requestCopy();
    await vi.advanceTimersByTimeAsync(1501);
    expect(write).toHaveBeenCalledExactlyOnceWith('same value');
  });
  it('fails closed after the acknowledgement timeout', async () => {
    const { bridge, channel, notice } = setup();
    const dispatch = vi.fn();
    vi.useFakeTimers();
    let sent!: () => void;
    const didSend = new Promise<void>(resolve => { sent = resolve; });
    vi.mocked(channel.send).mockImplementation(() => sent());
    const done = bridge.paste('private text', dispatch);
    await didSend;
    await vi.advanceTimersByTimeAsync(2001);
    await done;
    expect(dispatch).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('Nothing was pasted'));
    expect(JSON.stringify(notice.mock.calls)).not.toContain('private text');
  });
  it('clears cached text and pending copy on session end', async () => {
    const { bridge, receive, write } = setup();
    receive({ type: 'text', text: 'old client' });
    bridge.requestCopy();
    bridge.clear();
    await bridge.copy();
    expect(write).not.toHaveBeenCalled();
  });
  it.each(['rtf', 'image'])('clears stale text and gives safe feedback for %s', async type => {
    const { bridge, receive, write, notice } = setup();
    receive({ type: 'text', text: 'previous secret' });
    bridge.requestCopy();
    receive({ type, rtf: 'rich secret', image: 'image secret' });
    await bridge.copy();
    expect(write).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('without a plain-text value'));
    expect(JSON.stringify(notice.mock.calls)).not.toContain('secret');
    receive({ type: 'text', text: 'new text' });
    await bridge.copy();
    expect(write).toHaveBeenCalledExactlyOnceWith('new text');
  });
  it('rejects oversized text and absent channel without dispatch', async () => {
    const { bridge, channel } = setup();
    const dispatch = vi.fn();
    await bridge.paste('é'.repeat(524289), dispatch);
    expect(channel.send).not.toHaveBeenCalled();
    bridge.clear();
    await bridge.paste('value', dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
