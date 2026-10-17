import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootstrapFromCfAccessRedirectDetailed, useAuthStore } from './auth';
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  useAuthStore.getState().logout();
  useAuthStore.setState({ sessionExpiredReason: null, authThrottledUntil: null });
});
afterEach(() => { vi.unstubAllGlobals(); });

it.each([500, 503, 401, 403])('classifies users/me %s without populating a session', async status => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('/auth/refresh')
    ? json(200, { tokens: { accessToken: 'fresh', expiresInSeconds: 900 } }) : json(status, {})));
  expect(await bootstrapFromCfAccessRedirectDetailed()).toBe(status >= 500 ? 'transient' : 'auth-failed');
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
  expect(useAuthStore.getState().tokens).toBeNull();
});

it('treats a users/me timeout as retryable', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/auth/refresh')) return json(200, { tokens: { accessToken: 'fresh', expiresInSeconds: 900 } });
    throw new DOMException('Timed out', 'TimeoutError');
  }));
  expect(await bootstrapFromCfAccessRedirectDetailed()).toBe('transient');
});

it('cannot resurrect a logged-out session from a late users/me response', async () => {
  let resolve!: (value: Response) => void;
  let requested!: () => void;
  const pending = new Promise<void>(r => { requested = r; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/auth/refresh')) return json(200, { tokens: { accessToken: 'fresh', expiresInSeconds: 900 } });
    requested();
    return new Promise<Response>(r => { resolve = r; });
  }));
  const result = bootstrapFromCfAccessRedirectDetailed();
  await pending;
  useAuthStore.getState().logout();
  resolve(json(200, { id: 'u1', email: 'user@example.test' }));
  expect(await result).toBe('cancelled');
  expect(useAuthStore.getState().tokens).toBeNull();
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
});
