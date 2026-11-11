import { createHmac } from 'node:crypto';

export type TotpSecret = { key: Buffer; algorithm: 'sha1' | 'sha256' | 'sha512'; digits: 6 | 8; period: number };
const invalid = (): never => { throw new Error('invalid_otp_secret'); };

/** Parse only TOTP seeds; never include supplied values in errors. */
export function parseTotpSecret(value: string): TotpSecret {
  if (typeof value !== 'string' || value.length > 4096) return invalid();
  let secret = value.trim();
  let algorithm: TotpSecret['algorithm'] = 'sha1';
  let digits: TotpSecret['digits'] = 6;
  let period = 30;
  if (/^otpauth:/i.test(secret)) {
    let uri: URL;
    try { uri = new URL(secret); } catch { return invalid(); }
    if (uri.protocol !== 'otpauth:' || uri.hostname !== 'totp' || uri.username || uri.password || uri.port || uri.hash) return invalid();
    for (const key of ['secret', 'algorithm', 'digits', 'period']) {
      if (uri.searchParams.getAll(key).length > 1) return invalid();
    }
    secret = uri.searchParams.get('secret') ?? '';
    const alg = (uri.searchParams.get('algorithm') ?? 'SHA1').toLowerCase();
    if (alg !== 'sha1' && alg !== 'sha256' && alg !== 'sha512') return invalid();
    algorithm = alg;
    const d = uri.searchParams.get('digits') ?? '6';
    if (d !== '6' && d !== '8') return invalid();
    digits = Number(d) as 6 | 8;
    const p = uri.searchParams.get('period') ?? '30';
    if (!/^[1-9]\d{0,2}$/.test(p) || Number(p) < 15 || Number(p) > 120) return invalid();
    period = Number(p);
  }
  const encoded = secret.toUpperCase();
  if (!/^[A-Z2-7]+={0,6}$/.test(encoded)) return invalid();
  const raw = encoded.replace(/=+$/, '');
  if (![0, 2, 4, 5, 7].includes(raw.length % 8)) return invalid();
  if (encoded.includes('=') && encoded.length % 8 !== 0) return invalid();
  let bits = 0, accumulator = 0;
  const bytes: number[] = [];
  for (const ch of raw) {
    accumulator = (accumulator << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); }
  }
  if ((bits && (accumulator & ((1 << bits) - 1)) !== 0) || bytes.length < 10 || bytes.length > 128) return invalid();
  return { key: Buffer.from(bytes), algorithm, digits, period };
}

export function generateTotp(value: string, now = Date.now()): { code: string; expiresAt: string } {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_otp_time');
  const config = parseTotpSecret(value);
  try {
    const step = Math.floor(now / (config.period * 1000));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const digest = createHmac(config.algorithm, config.key).update(counter).digest();
    const offset = digest[digest.length - 1]! & 15;
    const numeric = digest.readUInt32BE(offset) & 0x7fffffff;
    return { code: String(numeric % (10 ** config.digits)).padStart(config.digits, '0'), expiresAt: new Date((step + 1) * config.period * 1000).toISOString() };
  } finally { config.key.fill(0); }
}
