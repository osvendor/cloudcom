import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getRedisMock } = vi.hoisted(() => ({ getRedisMock: vi.fn<() => unknown>(() => null) }));
vi.mock('./redis', () => ({ getRedis: getRedisMock }));

const CLAIMS = {
  sessionId: 'session-1',
  orgId: 'org-1',
  portalUserId: 'portal-user-1',
  authEpoch: 4,
  assignmentId: 'assignment-1',
  assignmentVersion: 7,
};
const CALLER = { ip: '203.0.113.10', userAgent: 'Mozilla/5.0 portal' };

function makeRedisStore() {
  const values = new Map<string, string>();
  const expiries = new Map<string, number>();
  return {
    values,
    expiries,
    setex: vi.fn(async (key: string, ttl: number, value: string) => {
      values.set(key, value);
      expiries.set(key, ttl);
      return 'OK';
    }),
    eval: vi.fn(async (_script: string, _keyCount: number, key: string) => {
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    }),
  };
}

beforeEach(() => {
  vi.resetModules();
  getRedisMock.mockReset();
  getRedisMock.mockReturnValue(null);
});

afterEach(() => vi.useRealTimers());

describe('portal remote WS tickets', () => {
  it('fails closed when Redis is absent', async () => {
    const { createPortalRemoteWsTicket, consumePortalRemoteWsTicket } = await import('./portalRemoteSessionAuth');
    await expect(createPortalRemoteWsTicket(CLAIMS, CALLER)).rejects.toThrow('unavailable');
    await expect(consumePortalRemoteWsTicket('ticket', CALLER)).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('stores every portal-specific claim in Redis and returns it after a bound one-time consume', async () => {
    const redis = makeRedisStore();
    getRedisMock.mockReturnValue(redis);
    const { createPortalRemoteWsTicket, consumePortalRemoteWsTicket, PORTAL_REMOTE_WS_TICKET_TTL_SECONDS } = await import('./portalRemoteSessionAuth');
    const issued = await createPortalRemoteWsTicket(CLAIMS, CALLER);
    const [key, raw] = [...redis.values.entries()][0]!;
    expect(key).toBe(`portal:remote:ws_ticket:${issued.ticket}`);
    expect(redis.expiries.get(key)).toBe(PORTAL_REMOTE_WS_TICKET_TTL_SECONDS);
    expect(JSON.parse(raw)).toMatchObject({ version: 1, ...CLAIMS, ip: CALLER.ip });
    expect(JSON.parse(raw).uaHash).not.toBe(CALLER.userAgent);

    await expect(consumePortalRemoteWsTicket(issued.ticket, CALLER)).resolves.toMatchObject({ ok: true, ...CLAIMS });
    await expect(consumePortalRemoteWsTicket(issued.ticket, CALLER)).resolves.toEqual({ ok: false, reason: 'not_found' });
  });

  it('burns a ticket on an IP or user-agent mismatch', async () => {
    const redis = makeRedisStore();
    getRedisMock.mockReturnValue(redis);
    const { createPortalRemoteWsTicket, consumePortalRemoteWsTicket } = await import('./portalRemoteSessionAuth');
    const ipTicket = await createPortalRemoteWsTicket(CLAIMS, CALLER);
    await expect(consumePortalRemoteWsTicket(ipTicket.ticket, { ...CALLER, ip: '198.51.100.2' }))
      .resolves.toEqual({ ok: false, reason: 'ip_mismatch' });
    await expect(consumePortalRemoteWsTicket(ipTicket.ticket, CALLER))
      .resolves.toEqual({ ok: false, reason: 'not_found' });

    const uaTicket = await createPortalRemoteWsTicket(CLAIMS, CALLER);
    await expect(consumePortalRemoteWsTicket(uaTicket.ticket, { ...CALLER, userAgent: 'curl/8' }))
      .resolves.toEqual({ ok: false, reason: 'ua_mismatch' });
  });

  it('permits exactly one concurrent consumer', async () => {
    const redis = makeRedisStore();
    getRedisMock.mockReturnValue(redis);
    const { createPortalRemoteWsTicket, consumePortalRemoteWsTicket } = await import('./portalRemoteSessionAuth');
    const { ticket } = await createPortalRemoteWsTicket(CLAIMS, CALLER);
    const results = await Promise.all([consumePortalRemoteWsTicket(ticket, CALLER), consumePortalRemoteWsTicket(ticket, CALLER)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === 'not_found')).toHaveLength(1);
  });

  it('rejects expired and malformed records after consuming them', async () => {
    vi.useFakeTimers();
    const redis = makeRedisStore();
    getRedisMock.mockReturnValue(redis);
    const { createPortalRemoteWsTicket, consumePortalRemoteWsTicket } = await import('./portalRemoteSessionAuth');
    const { ticket } = await createPortalRemoteWsTicket(CLAIMS, CALLER);
    vi.advanceTimersByTime(60_001);
    await expect(consumePortalRemoteWsTicket(ticket, CALLER)).resolves.toEqual({ ok: false, reason: 'expired' });

    redis.values.set('portal:remote:ws_ticket:malformed', '{bad json');
    await expect(consumePortalRemoteWsTicket('malformed', CALLER)).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(consumePortalRemoteWsTicket('malformed', CALLER)).resolves.toEqual({ ok: false, reason: 'not_found' });
  });
});
