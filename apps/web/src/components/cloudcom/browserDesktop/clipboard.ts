/** Session-local, text-only browser clipboard bridge. Never logs or persists content. */
export class BrowserClipboard {
  private channel: RTCDataChannel | null = null;
  private text: string | null = null;
  private unsupportedFormat: 'rtf' | 'image' | null = null;
  private epoch = 0;
  private busy = false;
  private copyTimer: ReturnType<typeof setTimeout> | undefined;
  private armed = false;
  private lastCopyRequestAt: number | null = null;
  private pending: { hash: string; finish: (ok: boolean) => void } | null = null;

  constructor(private notice: (message: string) => void,
    private write: (text: string) => Promise<void> = text => navigator.clipboard.writeText(text)) {}

  attach(channel: RTCDataChannel) {
    this.clear();
    this.channel = channel;
    const epoch = this.epoch;
    channel.onmessage = event => {
      if (this.epoch !== epoch || typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) return;
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'ack' && payload.hash === this.pending?.hash) this.pending?.finish(true);
        if (payload.type === 'rtf' || payload.type === 'image') {
          // Keep the format only, never rich data or the previous text. Copying
          // an obsolete credential after a clipboard format change is unsafe.
          this.text = null;
          this.unsupportedFormat = payload.type;
          if (this.armed) { this.disarm(); void this.copy(); }
          return;
        }
        if (payload.type !== 'text' || typeof payload.text !== 'string' || new TextEncoder().encode(payload.text).length > 1024 * 1024) return;
        this.text = payload.text;
        this.unsupportedFormat = null;
        if (this.armed) {
          this.disarm();
          void this.copy();
        }
      } catch { /* Ignore malformed remote data without echoing it. */ }
    };
    channel.onclose = () => { if (this.epoch === epoch) this.clear(); };
  }

  private disarm() {
    this.armed = false;
    clearTimeout(this.copyTimer);
  }

  /** Ctrl+C still goes to the remote application; copy its next clipboard update. */
  requestCopy(dispatch?: () => void): boolean {
    const now = Date.now();
    // Some browser shells emit both keydown and a native copy command.
    if (this.lastCopyRequestAt !== null && now - this.lastCopyRequestAt < 250) return false;
    this.lastCopyRequestAt = now;
    this.disarm();
    this.armed = true;
    this.copyTimer = setTimeout(() => {
      this.disarm();
      // The agent suppresses duplicate updates, so an unchanged value is valid.
      void this.copy();
    }, 1500);
    dispatch?.();
    return true;
  }

  async copy() {
    if (this.channel?.readyState === 'open' && this.unsupportedFormat) {
      this.notice(`Remote clipboard contains ${this.unsupportedFormat === 'rtf' ? 'rich text' : 'an image'} without a plain-text value. This browser supports plain-text clipboard transfer only.`);
      return;
    }
    if (this.channel?.readyState !== 'open' || this.text === null) {
      this.notice('Copy text on the remote desktop first. Clipboard access may be disabled by policy.');
      return;
    }
    try { await this.write(this.text); }
    catch { this.notice('Your browser blocked clipboard access. Click Copy remote text to allow copying.'); }
  }

  async paste(text: string, dispatch: () => void) {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') {
      this.notice('Clipboard is unavailable for this session. Use Paste Text if permitted.');
      return;
    }
    if (!text) return;
    if (new TextEncoder().encode(text).length > 1024 * 1024) {
      this.notice('Clipboard text is too large (maximum 1 MB).');
      return;
    }
    if (this.busy) { this.notice('Wait for the current paste to finish.'); return; }
    this.busy = true;
    const epoch = this.epoch;
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('text' + text));
      if (this.epoch !== epoch || channel.readyState !== 'open') return;
      const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
      const ok = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => finish(false), 2000);
        const finish = (success: boolean) => {
          clearTimeout(timer);
          this.pending = null;
          resolve(success);
        };
        this.pending = { hash, finish };
        try { channel.send(JSON.stringify({ type: 'text', text })); }
        catch { finish(false); }
      });
      if (this.epoch !== epoch) return;
      if (ok && channel.readyState === 'open') {
        // The agent suppresses echoing a value it just received. A successful
        // ACK establishes the remote clipboard value even without an update.
        // Retain it so Ctrl+C of the same text can copy back on its timer.
        this.text = text;
        this.unsupportedFormat = null;
        dispatch();
      }
      else this.notice('Paste was not confirmed by the remote clipboard. Nothing was pasted. Check clipboard policy or update the agent.');
    } catch { this.notice('Clipboard transfer failed. Nothing was pasted.'); }
    finally { if (this.epoch === epoch) this.busy = false; }
  }

  clear() {
    this.epoch++;
    this.disarm();
    this.pending?.finish(false);
    this.channel = null;
    this.text = null;
    this.unsupportedFormat = null;
    this.lastCopyRequestAt = null;
    this.busy = false;
  }
}
