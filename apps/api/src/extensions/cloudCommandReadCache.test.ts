import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ values: new Map<string,string>(), get: vi.fn(), set: vi.fn(), del: vi.fn(), eval: vi.fn(), outside: vi.fn(), scoped: vi.fn() }));
vi.mock('../services/redis', () => ({ getRedis: () => mocks }));
vi.mock('../db', () => ({ runOutsideDbContext: (fn:()=>unknown) => { mocks.outside(); return fn(); } }));
vi.mock('../middleware/auth', () => ({ withAuthDbAccessContext: (auth:unknown,fn:()=>unknown) => { mocks.scoped(auth); return fn(); } }));
import { cloudCommandReadCache as cache } from './cloudCommandReadCache';
describe('encrypted Microsoft read cache host boundary', () => {
  beforeEach(() => {
    vi.stubEnv('APP_ENCRYPTION_KEY','test-only-mailbox-cache-key-material');
    mocks.values.clear(); vi.clearAllMocks();
    mocks.get.mockImplementation(async key => mocks.values.get(key) ?? null);
    mocks.set.mockImplementation(async (key,value) => { mocks.values.set(key,value); return 'OK'; });
  });
  it('keeps mailbox content encrypted and refuses ciphertext swapped between bindings', async () => {
    await cache.set('org-a:tenant-a:mailbox-a', {message:'Private auto reply'}, 3600);
    const [key,raw] = [...mocks.values.entries()][0]!;
    expect(key).not.toContain('tenant-a'); expect(raw).not.toContain('Private auto reply');
    expect(await cache.get('org-a:tenant-a:mailbox-a')).toEqual({message:'Private auto reply'});
    mocks.get.mockResolvedValue(raw);
    expect(await cache.get('org-b:tenant-b:mailbox-a')).toBeNull();
  });
  it('rejects unbounded values and lifetimes', async () => {
    await expect(cache.set('a','x'.repeat(262145),3600)).rejects.toThrow('too large');
    await expect(cache.set('a',{},86401)).rejects.toThrow('lifetime');
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('uses token-conditioned atomic release, not unconditional deletion', async () => {
    await cache.release('lease','old-token');
    expect(mocks.eval).toHaveBeenCalledWith(expect.stringContaining("== ARGV[1]"),1,expect.stringMatching(/^cloudcommand:/),'old-token');
    expect(mocks.del).not.toHaveBeenCalled();
  });
  it('detaches background work and opens only explicit scoped DB work', async () => {
    const request={auth:{scope:'partner'}} as never; const fn=vi.fn(async()=>42);
    expect(await cache.withRequestDb(request,fn)).toBe(42);
    expect(mocks.scoped).toHaveBeenCalledWith({scope:'partner'});
    mocks.scoped.mockClear(); cache.runDetached(request,async()=>{ await fn(); });
    await Promise.resolve(); expect(mocks.outside).toHaveBeenCalledTimes(2); expect(mocks.scoped).not.toHaveBeenCalled();
  });
});
