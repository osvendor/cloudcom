import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchWithAuth } from '@/stores/auth';
import { endBrowserSession } from './lifecycle';
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
beforeEach(() => vi.mocked(fetchWithAuth).mockReset());
describe('browser session close', () => {
  it('accepts raced End only when the device confirms termination', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(new Response('{}', { status: 400 })).mockResolvedValueOnce(new Response(JSON.stringify({ status: 'disconnected', terminationPhase: 'confirmed' })));
    await expect(endBrowserSession('session')).resolves.toBeUndefined();
    expect(fetchWithAuth).toHaveBeenLastCalledWith('/remote/sessions/session');
  });
  it('does not interpret authorization failure as a successful disconnect', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(endBrowserSession('session')).rejects.toThrow('Unable to end');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
  it('retains an unconfirmed session after failed status read', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(endBrowserSession('session')).rejects.toThrow('Unable to confirm');
  });
});
