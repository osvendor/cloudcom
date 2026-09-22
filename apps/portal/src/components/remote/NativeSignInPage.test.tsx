// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import NativeSignInPage from './NativeSignInPage';
import { apiPost } from '../../lib/api';
import type { NativeLoginRequest } from '../../lib/nativeLogin';

vi.mock('../../lib/api', () => ({ apiPost: vi.fn() }));

const mockedApiPost = vi.mocked(apiPost);
const value = 'A'.repeat(42) + 'A';
const request: NativeLoginRequest = {
  clientId: 'cloudcom-rustdesk-v1',
  redirectUri: 'http://127.0.0.1:12345/cloudcom/callback',
  codeChallenge: value,
  codeChallengeMethod: 'S256',
  state: value
};

afterEach(() => {
  cleanup();
  mockedApiPost.mockReset();
});

describe('NativeSignInPage', () => {
  it('disables the button and makes no API call for an invalid request', () => {
    render(<NativeSignInPage accountName="customer@example.com" request={null} />);

    expect(screen.getByRole('button', { name: 'Continue to app' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('invalid');
    expect(mockedApiPost).not.toHaveBeenCalled();
  });

  it('sends the exact authorize payload on approval', async () => {
    mockedApiPost.mockResolvedValue({
      data: { redirectUri: `${request.redirectUri}?code=${value}&state=${request.state}` }
    });
    render(<NativeSignInPage accountName="customer@example.com" request={request} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue to app' }));

    await waitFor(() => expect(mockedApiPost).toHaveBeenCalledTimes(1));
    expect(mockedApiPost).toHaveBeenCalledWith('/portal/remote/native/authorize', request);
  });

  it('allows only one API call while an approval is pending', async () => {
    let resolve!: (value: { data: { redirectUri: string } }) => void;
    mockedApiPost.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<NativeSignInPage accountName="customer@example.com" request={request} />);
    const button = screen.getByRole('button', { name: 'Continue to app' });

    fireEvent.click(button);
    fireEvent.click(button);
    expect(mockedApiPost).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled();
    await act(async () => { resolve({ data: { redirectUri: `${request.redirectUri}?code=${value}&state=${request.state}` } }); });
  });

  it('shows an API error and enables retry', async () => {
    mockedApiPost.mockResolvedValueOnce({ error: 'Approval failed' });
    render(<NativeSignInPage accountName="customer@example.com" request={request} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue to app' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Approval failed'));
    expect(screen.getByRole('button', { name: 'Continue to app' })).toBeEnabled();
  });

  it('blocks a malicious callback response and shows an error', async () => {
    mockedApiPost.mockResolvedValue({
      data: { redirectUri: 'https://attacker.example/callback?code=bad&state=bad' }
    });
    render(<NativeSignInPage accountName="customer@example.com" request={request} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue to app' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('secure sign-in response'));
    expect(screen.getByRole('button', { name: 'Continue to app' })).toBeEnabled();
  });
});
