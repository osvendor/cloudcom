import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UnifiedNativeSignInPage from './UnifiedNativeSignInPage';

const mocks = vi.hoisted(() => ({ restore: vi.fn(), bootstrap: vi.fn(), login: vi.fn(), props: {} as Record<string, any> }));
vi.mock('../../stores/auth', () => ({ apiLogin: mocks.login,
  restoreAccessTokenFromCookieDetailed: mocks.restore,
  bootstrapFromCfAccessRedirect: mocks.bootstrap,
  useAuthStore: { getState: () => ({ tokens: null }) } }));
vi.mock('../auth/LoginPage', () => ({ default: (props: Record<string, any>) => {
  mocks.props = props; return <p>Unified sign-in form</p>;
} }));

describe('unified native browser entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.restore.mockResolvedValue('auth-failed');
    mocks.bootstrap.mockResolvedValue(true);
    window.history.replaceState({}, '', '/remote/sign-in?' + new URLSearchParams({
      clientId: 'cloudcom-rustdesk-v1', redirectUri: 'http://127.0.0.1:12345/cloudcom/callback',
      codeChallenge: 'A'.repeat(43), codeChallengeMethod: 'S256', state: 'A'.repeat(43),
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it('routes a restored staff session without trusting persisted identity or querying customers', async () => {
    mocks.restore.mockResolvedValue('restored');
    const navigate = vi.fn(); render(<UnifiedNativeSignInPage navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/remote\/native\?.*unified=1$/)));
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
  });
  it('does not navigate if a cookie restores tokens but its user bootstrap fails', async () => {
    mocks.restore.mockResolvedValue('restored');
    mocks.bootstrap.mockResolvedValue(false);
    const navigate = vi.fn(); render(<UnifiedNativeSignInPage navigate={navigate} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in could not be checked');
    expect(navigate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('routes only a verified remote customer profile to customer authorization', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ user: { accessMode: 'remote_only' } }) } as Response);
    const navigate = vi.fn(); render(<UnifiedNativeSignInPage navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/portal\/remote\/native\?/)));
  });
  it('shows one full sign-in form, with staff automatic SSO disabled for customer compatibility', async () => {
    render(<UnifiedNativeSignInPage />);
    expect(await screen.findByText('Unified sign-in form')).toBeTruthy();
    expect(mocks.props.skipAutomaticStaffSso).toBe(true);
    expect(mocks.props.next).toMatch(/^\/remote\/native\?/);
  });
  it.each(['transient', 'throttled', 'origin-rejected'])('does not downgrade a %s staff session result', async result => {
    mocks.restore.mockResolvedValue(result);
    render(<UnifiedNativeSignInPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in could not be checked');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects malformed input before querying any account', () => {
    window.history.replaceState({}, '', '/remote/sign-in?state=bad');
    render(<UnifiedNativeSignInPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('invalid');
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it('requests the server identity guard for password fallback and keeps company context errors actionable', async () => {
    render(<UnifiedNativeSignInPage />);
    await screen.findByText('Unified sign-in form');
    mocks.login.mockResolvedValue({ success: false, status: 401 });
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 400 } as Response);
    const result = await mocks.props.authenticate('person@example.test', 'synthetic-password');
    expect(result.success).toBe(false);
    expect(result.error).toContain('company portal');
    expect(fetch).toHaveBeenLastCalledWith('/api/v1/portal/auth/login', expect.objectContaining({
      body: JSON.stringify({ email: 'person@example.test', password: 'synthetic-password', unifiedNative: true }),
    }));
  });
});
