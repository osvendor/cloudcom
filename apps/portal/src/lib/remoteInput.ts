const keys: Record<string, string> = {
  Enter: 'return', NumpadEnter: 'return', Escape: 'escape', Tab: 'tab', Space: 'space',
  Backspace: 'backspace', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', PageUp: 'pageup', PageDown: 'pagedown',
  ControlLeft: 'ctrl', ControlRight: 'ctrl', ShiftLeft: 'shift', ShiftRight: 'shift',
  AltLeft: 'alt', AltRight: 'alt', MetaLeft: 'meta', MetaRight: 'meta',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
  NumpadAdd: 'add', NumpadSubtract: 'subtract', NumpadMultiply: 'multiply', NumpadDivide: 'divide', NumpadDecimal: 'decimal',
};
export function remoteKey(code: string, key: string): string | null {
  if (keys[code]) return keys[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  return key.length === 1 ? key.toLowerCase() : null;
}
export function remoteSessionIsLive(status: string, phase?: string): boolean {
  return ['pending', 'connecting', 'active'].includes(status) && (phase === undefined || phase === 'none');
}
export function remoteWheel(remainder: number, delta: number, mode: number) {
  if (!Number.isFinite(delta)) return { remainder: 0, steps: 0 };
  const units = mode === 0 ? (remainder + delta) / 100 : mode === 2 ? delta * 10 : delta;
  const whole = Math.trunc(units);
  return { remainder: mode === 0 ? (units - whole) * 100 : 0, steps: Math.max(-10, Math.min(10, whole)) };
}
export function remotePoint(x: number, y: number, box: { left: number; top: number; width: number; height: number }, width: number, height: number) {
  if (![width, height, box.width, box.height].every(n => Number.isFinite(n) && n > 0)) return null;
  const scale = Math.min(box.width / width, box.height / height);
  const left = box.left + (box.width - width * scale) / 2;
  const top = box.top + (box.height - height * scale) / 2;
  if (x < left || y < top || x >= left + width * scale || y >= top + height * scale) return null;
  return { x: Math.floor((x - left) / scale), y: Math.floor((y - top) / scale) };
}
