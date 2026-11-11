import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../lib/navigation', () => ({ navigateTo: vi.fn(async () => {}) }));
import AuthOverlay from './AuthOverlay';
import * as auth from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(navigateTo).mockClear();
  window.history.replaceState({}, '', '/devices');
  auth.useAuthStore.setState({ isAuthenticated: true, isLoading: false, tokens: null, sessionExpiredReason: null, authThrottledUntil: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('keeps a slow refresh on the same page past both the fetch and safety deadlines, then accepts late completion', async () => {
  let resolve!: (value: 'restored') => void;
  vi.spyOn(auth, 'restoreAccessTokenFromCookieDetailed').mockReturnValue(new Promise(r => { resolve = r; }));
  render(<AuthOverlay />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(navigateTo).not.toHaveBeenCalled();
  await act(async () => {
    auth.useAuthStore.setState({ tokens: { accessToken: 'late-valid-token', expiresInSeconds: 900 } });
    resolve('restored');
  });
  expect(navigateTo).not.toHaveBeenCalled();
  expect(screen.queryByText(/Session recovery is taking longer/)).toBeNull();
});

it('preserves retryable recovery without another login and retries only on request', async () => {
  const restore = vi.spyOn(auth, 'restoreAccessTokenFromCookieDetailed').mockResolvedValue('transient');
  render(<AuthOverlay />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(screen.getByRole('button', { name: 'Retry session recovery' })).toBeInTheDocument();
  expect(auth.useAuthStore.getState().isAuthenticated).toBe(true);
  expect(navigateTo).not.toHaveBeenCalled();
  expect(restore).toHaveBeenCalledTimes(1);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry session recovery' })); });
  expect(restore).toHaveBeenCalledTimes(2);
  expect(navigateTo).not.toHaveBeenCalled();
});

it.each(['auth-failed', 'origin-rejected'] as const)('still redirects a definitive %s verdict', async outcome => {
  vi.spyOn(auth, 'restoreAccessTokenFromCookieDetailed').mockResolvedValue(outcome);
  render(<AuthOverlay />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true });
  expect(auth.useAuthStore.getState().tokens).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry session recovery' })).toBeNull();
});

it('does not replace a revoked-session mask with transient recovery or restore tokens', async () => {
  let resolve!: (value: 'transient') => void;
  vi.spyOn(auth, 'restoreAccessTokenFromCookieDetailed').mockReturnValue(new Promise(r => { resolve = r; }));
  render(<AuthOverlay />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  await act(async () => {
    auth.useAuthStore.setState({ isAuthenticated: false, tokens: null, sessionExpiredReason: 'session-expired' });
    resolve('transient');
  });
  expect(screen.getByTestId('session-expired-overlay')).toBeInTheDocument();
  expect(auth.useAuthStore.getState().tokens).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry session recovery' })).toBeNull();
});

it('owns a slow CF handoff and retries it after the success marker was consumed', async () => {
  auth.useAuthStore.setState({ isAuthenticated: false });
  window.history.replaceState({}, '', '/?cf-access-login=success');
  let resolve!: (value: 'transient') => void;
  const bootstrap = vi.spyOn(auth, 'bootstrapFromCfAccessRedirectDetailed')
    .mockReturnValueOnce(new Promise(r => { resolve = r; }))
    .mockResolvedValue('transient');
  render(<AuthOverlay />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(window.location.search).toBe('');
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(navigateTo).not.toHaveBeenCalled();
  await act(async () => { resolve('transient'); });
  expect(screen.getByRole('button', { name: 'Retry session recovery' })).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry session recovery' })); });
  expect(bootstrap).toHaveBeenCalledTimes(2);
  expect(navigateTo).not.toHaveBeenCalled();
});

it('preserves the CF failure redirect instead of issuing a competing bare login navigation', async () => {
  auth.useAuthStore.setState({ isAuthenticated: false });
  window.history.replaceState({}, '', '/?cf-access-login=success');
  vi.spyOn(auth, 'bootstrapFromCfAccessRedirectDetailed').mockResolvedValue('auth-failed');
  render(<AuthOverlay />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(navigateTo).toHaveBeenCalledExactlyOnceWith('/login?error=cf-access', { replace: true });
  expect(screen.getByRole('link', { name: 'Continue to sign in' })).toHaveAttribute('href', '/login?error=cf-access');
});

it('offers an actionable exit when a superseded CF handoff has no session and navigation stalls', async () => {
  auth.useAuthStore.setState({ isAuthenticated: false });
  vi.mocked(navigateTo).mockImplementationOnce(() => new Promise(() => {}));
  window.history.replaceState({}, '', '/?cf-access-login=success');
  vi.spyOn(auth, 'bootstrapFromCfAccessRedirectDetailed').mockResolvedValue('cancelled');

  render(<AuthOverlay />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(screen.getByRole('link', { name: 'Continue to sign in' })).toHaveAttribute('href', '/login');
});

it('keeps an escape link when terminal CF navigation rejects', async () => {
  auth.useAuthStore.setState({ isAuthenticated: false });
  window.history.replaceState({}, '', '/?cf-access-login=success');
  vi.mocked(navigateTo).mockRejectedValueOnce(new Error('router unavailable'));
  vi.spyOn(auth, 'bootstrapFromCfAccessRedirectDetailed').mockResolvedValue('auth-failed');
  render(<AuthOverlay />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  const link = screen.getByRole('link', { name: 'Continue to sign in' });
  expect(link).toHaveAttribute('href', '/login?error=cf-access');
  expect(link).toHaveAttribute('data-astro-reload');
  expect(navigateTo).toHaveBeenCalledTimes(1);
});

it.each(['live', 'expired', 'pending'] as const)('respects the current %s session after a cancelled CF handoff', async state => {
  auth.useAuthStore.setState({ isAuthenticated: false });
  window.history.replaceState({}, '', '/?cf-access-login=success');
  let resolve!: (value: 'cancelled') => void;
  const bootstrap = vi.spyOn(auth, 'bootstrapFromCfAccessRedirectDetailed').mockReturnValue(new Promise(r => { resolve = r; }));
  const restore = vi.spyOn(auth, 'restoreAccessTokenFromCookieDetailed');
  render(<AuthOverlay />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  await act(async () => {
    auth.useAuthStore.setState({
      isAuthenticated: state !== 'expired',
      tokens: state === 'live' ? { accessToken: 'new-session', expiresInSeconds: 900 } : null,
      sessionExpiredReason: state === 'expired' ? 'session-expired' : null,
    });
    resolve('cancelled');
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(navigateTo).not.toHaveBeenCalled();
  expect(bootstrap).toHaveBeenCalledTimes(1);
  expect(restore).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: 'Continue to sign in' })).toBeNull();
  if (state === 'expired') expect(screen.getByTestId('session-expired-overlay')).toBeInTheDocument();
  if (state === 'pending') expect(screen.getByRole('button', { name: 'Retry session recovery' })).toBeInTheDocument();
  if (state === 'live') expect(auth.useAuthStore.getState().tokens?.accessToken).toBe('new-session');
});
