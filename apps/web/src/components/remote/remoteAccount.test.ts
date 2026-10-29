import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ restore: vi.fn(), bootstrap: vi.fn(), fetch: vi.fn(), state: {} as any }));
vi.mock('../../stores/auth', () => ({ restoreAccessTokenFromCookieDetailed: m.restore,
  bootstrapFromCfAccessRedirect: m.bootstrap, useAuthStore: { getState: () => m.state } }));
import { resolveRemoteAccount } from './remoteAccount';
beforeEach(() => {
  vi.resetAllMocks(); m.state = { tokens: null, isAuthenticated: false };
  m.restore.mockResolvedValue('auth-failed'); m.bootstrap.mockResolvedValue(true);
  vi.stubGlobal('fetch', m.fetch);
});
afterEach(() => vi.unstubAllGlobals());
describe('shared remote account selection', () => {
  it('uses staff authority first without looking up customer accounts', async () => {
    m.restore.mockResolvedValue('restored');
    expect(await resolveRemoteAccount()).toEqual({ kind: 'staff' });
    expect(m.bootstrap).toHaveBeenCalledOnce(); expect(m.fetch).not.toHaveBeenCalled();
  });
  it.each(['transient', 'throttled', 'origin-rejected'])('does not downgrade a %s staff check', async value => {
    m.restore.mockResolvedValue(value);
    await expect(resolveRemoteAccount()).rejects.toThrow(); expect(m.fetch).not.toHaveBeenCalled();
  });
  it('requires normal staff SSO for a verified staff identity even when a portal cookie exists', async () => {
    m.fetch.mockResolvedValue(Response.json({ kind: 'staff' }));
    expect(await resolveRemoteAccount()).toEqual({ kind: 'staff-sso' }); expect(m.fetch).toHaveBeenCalledOnce();
  });
  it('uses only a server-verified remote-only customer profile', async () => {
    const user = { id: 'u', orgId: 'o', email: 'customer@example.test', accessMode: 'remote_only' };
    m.fetch.mockResolvedValueOnce(Response.json({ kind: 'customer' })).mockResolvedValueOnce(Response.json({ user }));
    expect(await resolveRemoteAccount()).toEqual({ kind: 'customer', user });
  });
  it('rejects a failed identity check without trying the customer account', async () => {
    m.fetch.mockRejectedValue(new Error('Access redirect'));
    await expect(resolveRemoteAccount()).rejects.toThrow(); expect(m.fetch).toHaveBeenCalledOnce();
  });
});
