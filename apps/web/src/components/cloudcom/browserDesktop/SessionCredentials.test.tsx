import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionCredentials from './SessionCredentials';
const mocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: mocks.fetchWithAuth }));
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const row = { id: 'credential', name: 'Client login', username: 'operator', hasPassword: true, hasOtp: true };
afterEach(cleanup);
beforeEach(() => { mocks.fetchWithAuth.mockReset(); mocks.fetchWithAuth.mockImplementation(async () => response({ credentials: [row] })); });
async function open() { fireEvent.click(screen.getByText('Credentials')); await screen.findByText('Client login'); }
describe('session credentials', () => {
  it('loads only on explicit open and uses session scoping, not ambient client', async () => {
    render(<SessionCredentials sessionId="session-a" enabled />);
    expect(mocks.fetchWithAuth).not.toHaveBeenCalled(); await open();
    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/credentials/sessions/session-a/credentials?q=', expect.objectContaining({ skipOrgIdInjection: true, cache: 'no-store' }));
    expect(screen.queryByRole('combobox')).toBeNull();
  });
  it('clears secret and results when session changes', async () => {
    const view = render(<SessionCredentials sessionId="session-a" enabled />); await open();
    mocks.fetchWithAuth.mockResolvedValue(response({ value: 'synthetic-secret' }));
    fireEvent.click(screen.getByText('Reveal password')); await screen.findByText('Password: synthetic-secret');
    view.rerender(<SessionCredentials sessionId="session-b" enabled />);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText(/synthetic-secret/)).toBeNull();
  });
  it('discards a pending reveal after close, and restores button focus', async () => {
    render(<SessionCredentials sessionId="session-a" enabled />); await open();
    let finish!: (value: Response) => void;
    mocks.fetchWithAuth.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByText('Reveal password')); fireEvent.click(screen.getByText('Close'));
    finish(response({ value: 'stale-secret' }));
    await waitFor(() => expect(screen.queryByText(/stale-secret/)).toBeNull());
    expect(document.activeElement).toBe(screen.getByText('Credentials'));
  });
  it('marks local input and closes on Escape without sending keys to parent', async () => {
    const parentKeys = vi.fn(); render(<div onKeyDown={parentKeys}><SessionCredentials sessionId="session-a" enabled /></div>); await open();
    const input = screen.getByLabelText('Search credentials'); expect(input.closest('[data-browser-local-input="true"]')).not.toBeNull();
    fireEvent.keyDown(input, { key: 'x' }); expect(parentKeys).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('uses ISO OTP expiry and automatically clears the displayed code', async () => {
    render(<SessionCredentials sessionId="session-a" enabled />); await open();
    mocks.fetchWithAuth.mockImplementation(async () => response({ code: '123456', expiresAt: new Date(Date.now() + 100).toISOString() }));
    fireEvent.click(screen.getByText('Show OTP')); await screen.findByText('OTP code: 123456');
    await waitFor(() => expect(screen.queryByText('OTP code: 123456')).toBeNull());
  });
  it('discards old client search results when a newer query is submitted', async () => {
    render(<SessionCredentials sessionId="session-a" enabled />); await open();
    let finish!: (value: Response) => void;
    mocks.fetchWithAuth.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    fireEvent.change(screen.getByLabelText('Search credentials'), { target: { value: 'old' } });
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.change(screen.getByLabelText('Search credentials'), { target: { value: 'new' } });
    finish(response({ credentials: [{ ...row, name: 'Stale result' }] }));
    await waitFor(() => expect(screen.queryByText('Stale result')).toBeNull());
  });
  it('hides the vault immediately when disconnected', async () => {
    const view = render(<SessionCredentials sessionId="session-a" enabled />); await open();
    view.rerender(<SessionCredentials sessionId="session-a" enabled={false} />);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByText('Credentials')).toBeDisabled();
  });
});

