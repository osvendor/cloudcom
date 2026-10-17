import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { healthRoutes, type HealthAuth } from './health';
import { createRoutes } from './index';

const admin: HealthAuth = { user: { id: 'operator', isPlatformAdmin: true }, scope: 'system', principal: { kind: 'user_session' } };
function harness(auth: HealthAuth | undefined = admin, overrides = {}, full = false) {
  const read = vi.fn(async (auth: HealthAuth) => auth.user?.isPlatformAdmin ? ({ checkedAt: new Date().toISOString(), targetEndpoints: 500, refreshSeconds: 30, enrolled: 25, cards: [] }) : null);
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('auth' as never, auth as never); c.set('extensionAuthorization' as never, { hasPermission: () => true, ...overrides } as never); await next(); });
  if (full) app.route('/', createRoutes({} as never, vi.fn() as never, undefined, undefined, undefined, read));
  else app.route('/', healthRoutes(read));
  return { app, read };
}
describe('operations health authorization', () => {
  it.each([
    { ...admin, scope: 'organization' },
    { ...admin, user: { id: 'operator', isPlatformAdmin: false } },
    { ...admin, principal: { kind: 'api_key' } },
    { ...admin, allowedSiteIds: [] }, {},
  ])('denies non-platform or restricted principals before collection', async auth => {
    const h = harness(auth); expect((await h.app.request('/health')).status).toBe(403); expect(h.read).not.toHaveBeenCalled();
  });
  it('allows platform administrators who retain partner membership', async () => {
    const h = harness({ ...admin, scope: 'partner' }); expect((await h.app.request('/health')).status).toBe(200);
  });
  it.each([{ hasPermission: () => false }, { allowedSiteIds: [] }])('enforces extension authorization', async permission => {
    const h = harness(admin, permission); expect((await h.app.request('/health')).status).toBe(403); expect(h.read).not.toHaveBeenCalled();
  });
  it('uses the global gate ahead of client routes and ignores org query spoofing', async () => {
    const h = harness(admin, {}, true); const response = await h.app.request('/health?orgId=another-client');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(h.read).toHaveBeenCalledWith(admin);
  });
  it('never returns raw collection failures', async () => {
    const h = harness(); h.read.mockRejectedValue(new Error('secret database host'));
    const response = await h.app.request('/health'); expect(response.status).toBe(503); expect(await response.text()).not.toContain('secret');
  });
});
