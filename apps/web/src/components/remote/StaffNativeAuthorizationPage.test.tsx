import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StaffNativeAuthorizationPage from './StaffNativeAuthorizationPage';

const mocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), runAction: vi.fn() }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: mocks.fetchWithAuth }));
vi.mock('@/lib/runAction', () => ({
  ActionError: class ActionError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } },
  runAction: mocks.runAction,
  handleActionError: vi.fn(),
}));

describe('StaffNativeAuthorizationPage', () => {
  beforeEach(() => {
    mocks.fetchWithAuth.mockReset();
    mocks.runAction.mockReset();
    window.history.replaceState({}, '', '/remote/native?clientId=cloudcom-rustdesk-v1&redirectUri=http%3A%2F%2F127.0.0.1%3A1024%2Fcloudcom%2Fcallback&codeChallenge=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC&codeChallengeMethod=S256&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('posts the exact request only after the staff member explicitly continues', async () => {
    mocks.runAction.mockImplementation(async ({ request }) => {
      await request();
      return { redirectUri: 'http://127.0.0.1:1024/cloudcom/callback?code=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
    });
    const navigate = vi.fn();
    render(<StaffNativeAuthorizationPage navigate={navigate} />);
    expect(mocks.fetchWithAuth).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('staff-native-continue-button'));
    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1));
    const [path, options] = mocks.fetchWithAuth.mock.calls[0]!;
    expect(path).toBe('/staff-native/authorize');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      clientId: 'cloudcom-rustdesk-v1', redirectUri: 'http://127.0.0.1:1024/cloudcom/callback',
      codeChallenge: 'C'.repeat(43), codeChallengeMethod: 'S256', state: 'A'.repeat(43),
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringContaining('?code=')));
  });

  it('disables continuation for malformed requests and never calls the API', () => {
    window.history.replaceState({}, '', '/remote/native?clientId=wrong');
    render(<StaffNativeAuthorizationPage />);
    expect(screen.getByTestId('staff-native-continue-button')).toBeDisabled();
    expect(screen.getByRole('alert').textContent).toMatch(/invalid or incomplete/i);
    expect(mocks.fetchWithAuth).not.toHaveBeenCalled();
  });

  it('adds the authority only after validating the unified callback', async () => {
    window.history.replaceState({}, '', window.location.pathname + window.location.search + '&unified=1');
    const callback = 'http://127.0.0.1:1024/cloudcom/callback?code=' + 'A'.repeat(43) + '&state=' + 'A'.repeat(43);
    mocks.runAction.mockResolvedValue({ redirectUri: callback });
    const navigate = vi.fn();
    render(<StaffNativeAuthorizationPage navigate={navigate} />);
    fireEvent.click(screen.getByTestId('staff-native-continue-button'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(callback + '&authority=staff'));
  });

  it('displays an error and refuses to navigate when the server returns an unsafe callback', async () => {
    mocks.runAction.mockResolvedValue({ redirectUri: 'https://attacker.example/?code=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    const navigate = vi.fn();
    render(<StaffNativeAuthorizationPage navigate={navigate} />);
    fireEvent.click(screen.getByTestId('staff-native-continue-button'));
    expect(await screen.findByText(/invalid callback/i)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});
