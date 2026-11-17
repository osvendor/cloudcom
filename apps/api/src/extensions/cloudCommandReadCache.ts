import { createHash, randomUUID } from 'node:crypto';
import type { MicrosoftRequest } from '@cloudcom/ext-cloud-command';
import { getRedis } from '../services/redis';
import { encryptSecret, decryptSecret } from '../services/secretCrypto';
import { runOutsideDbContext } from '../db';
import { withAuthDbAccessContext, type AuthContext } from '../middleware/auth';

const namespace = 'cloudcommand:mailbox-read:v1:';
const keyFor = (key: string) => namespace + createHash('sha256').update(key).digest('hex');
const ttl = (seconds: number) => {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) throw Error('Invalid cache lifetime');
  return seconds;
};
const redis = () => { const client = getRedis(); if (!client) throw Error('Read cache unavailable'); return client; };

/** Host-only, encrypted and key-bound. No mailbox content is logged or stored
 * in plaintext Redis. Connection/generation fencing is owned by the caller. */
export const cloudCommandReadCache = {
  async get(key: string): Promise<unknown | null> {
    const raw = await redis().get(keyFor(key));
    if (!raw) return null;
    try {
      const decoded = decryptSecret(raw, { aad: keyFor(key) });
      const envelope = JSON.parse(decoded ?? 'null');
      return envelope?.key === key && envelope.version === 1 ? envelope.value : null;
    } catch { return null; }
  },
  async set(key: string, value: unknown, seconds: number): Promise<void> {
    const plain = JSON.stringify({ version: 1, key, value });
    if (Buffer.byteLength(plain) > 256 * 1024) throw Error('Read cache value too large');
    const encrypted = encryptSecret(plain, { aad: keyFor(key) });
    if (!encrypted) throw Error('Read cache encryption unavailable');
    await redis().set(keyFor(key), encrypted, 'EX', ttl(seconds));
  },
  async delete(key: string): Promise<void> { await redis().del(keyFor(key)); },
  async claim(key: string, seconds: number): Promise<string | null> {
    const token = randomUUID();
    return await redis().set(keyFor(key), token, 'EX', ttl(seconds), 'NX') === 'OK' ? token : null;
  },
  async release(key: string, token: string): Promise<void> {
    await redis().eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, keyFor(key), token);
  },
  async epoch(key: string, rotate = false): Promise<string> {
    const value = await redis().eval("local v=redis.call('get',KEYS[1]); if not v or ARGV[2]=='1' then v=ARGV[1]; redis.call('set',KEYS[1],v,'EX',86400); end; return v", 1, keyFor(key), randomUUID(), rotate ? '1' : '0');
    if (typeof value !== 'string') throw Error('Read cache unavailable');
    return value;
  },
  runDetached(_request: MicrosoftRequest, work: () => Promise<void>): void {
    // Never inherit the transaction of the browser request that queued refresh.
    void runOutsideDbContext(work).catch(() => console.warn('[CloudCommand] Mailbox background refresh failed'));
  },
  withRequestDb<T>(request: MicrosoftRequest, work: () => Promise<T>): Promise<T> {
    return runOutsideDbContext(() => withAuthDbAccessContext(request.auth as AuthContext, work));
  },
};
