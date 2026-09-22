import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const m = vi.hoisted(() => ({ redis: vi.fn(), limit: vi.fn() }));
vi.mock('../../services/redis', () => ({ getRedis: m.redis }));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: m.limit }));
import { portalRemoteStartRateLimit } from './remoteRateLimit';
const app = () => { const a = new Hono(); a.use('*', async (c, next) => { c.set('portalAuth', { user: { id: 'portal-user', orgId: 'org-a' } }); await next(); }); a.use('*', portalRemoteStartRateLimit); a.post('/start', c => c.json({ ok: true })); return a; };
beforeEach(() => { vi.clearAllMocks(); m.redis.mockReturnValue('redis'); m.limit.mockResolvedValue({ allowed: true }); });
describe('portalRemoteStartRateLimit', () => {
  it('uses a shared organization-and-portal-user identity for create and offer admission', async () => { await expect(app().request('/start', { method: 'POST' })).resolves.toMatchObject({ status: 200 }); expect(m.limit).toHaveBeenCalledWith('redis', 'portal_remote_start:org-a:portal-user', 20, 60); });
  it('denies before the endpoint with Retry-After when the shared bucket is exhausted', async () => { m.limit.mockResolvedValue({ allowed: false }); const r = await app().request('/start', { method: 'POST' }); expect(r.status).toBe(429); expect(r.headers.get('retry-after')).toBe('60'); });
});
