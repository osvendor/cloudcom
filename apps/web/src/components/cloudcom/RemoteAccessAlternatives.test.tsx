import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RemoteAccessAlternatives from './RemoteAccessAlternatives';

const mocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), showToast: vi.fn() }));

vi.mock('@/stores/auth', () => ({ fetchWithAuth: mocks.fetchWithAuth }));
vi.mock('@/components/shared/Toast', () => ({ showToast: mocks.showToast }));

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('RemoteAccessAlternatives', () => {
  beforeEach(() => {
    mocks.fetchWithAuth.mockReset();
    mocks.showToast.mockReset();
  });

  it('does not fetch providers until the technician explicitly opens the chooser', async () => {
    mocks.fetchWithAuth.mockResolvedValue(response({ providers: [] }));
    render(<RemoteAccessAlternatives deviceId="device-1" />);

    expect(mocks.fetchWithAuth).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('other-remote-tools-button'));

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/devices/device-1/remote-access-options'));
    expect(await screen.findByText(/No other remote tools/i)).toBeTruthy();
  });

  it('toggles closed and responds to Escape', async () => {
    mocks.fetchWithAuth.mockResolvedValue(response({ providers: [] }));
    render(<RemoteAccessAlternatives deviceId="device-1" />);
    const trigger = screen.getByTestId('other-remote-tools-button');
    fireEvent.click(trigger);
    await screen.findByTestId('remote-access-alternatives');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('remote-access-alternatives')).toBeNull();
    fireEvent.click(trigger);
    await screen.findByTestId('remote-access-alternatives');
    fireEvent.click(trigger);
    expect(screen.queryByTestId('remote-access-alternatives')).toBeNull();
  });

  it('shows an actionable missing-ID explanation and refuses that provider click', async () => {
    mocks.fetchWithAuth.mockResolvedValue(response({
      providers: [{ id: 'rustdesk', name: 'RustDesk', available: false, skipReason: 'missing_device_identifier' }],
    }));
    render(<RemoteAccessAlternatives deviceId="device-1" />);
    fireEvent.click(screen.getByTestId('other-remote-tools-button'));

    const provider = await screen.findByTestId('remote-access-option-rustdesk');
    expect(provider).toBeDisabled();
    expect(provider).toHaveAttribute('title', expect.stringMatching(/missing the identifier/i));
    fireEvent.click(provider);
    expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('posts the selected provider only, closes the pre-opened popup, and invokes a custom scheme', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(response({ providers: [{ id: 'rustdesk', name: 'RustDesk', available: true, skipReason: null }] }))
      .mockResolvedValueOnce(response({ launchUrl: 'rustdesk://12345?password=never-rendered', providerId: 'rustdesk', scheme: 'rustdesk' }));
    const popup = { close: vi.fn(), location: { href: '' } };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<RemoteAccessAlternatives deviceId="device-1" />);
    fireEvent.click(screen.getByTestId('other-remote-tools-button'));
    fireEvent.click(await screen.findByTestId('remote-access-option-rustdesk'));

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledWith(
      '/devices/device-1/remote-access-options/rustdesk/launch', { method: 'POST' },
    ));
    await waitFor(() => expect(popup.close).toHaveBeenCalled());
    expect(click).toHaveBeenCalled();
    // The secret-bearing URL must not be rendered into visible UI.
    expect(screen.queryByText(/never-rendered/)).toBeNull();
    open.mockRestore();
    click.mockRestore();
  });

  it('closes a pre-opened popup when launch fails', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(response({ providers: [{ id: 'rustdesk', name: 'RustDesk', available: true, skipReason: null }] }))
      .mockResolvedValueOnce(response({ error: 'denied', code: 'remote_denied' }, 403));
    const popup = { close: vi.fn(), location: { href: '' } };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    render(<RemoteAccessAlternatives deviceId="device-1" />);
    fireEvent.click(screen.getByTestId('other-remote-tools-button'));
    fireEvent.click(await screen.findByTestId('remote-access-option-rustdesk'));

    await waitFor(() => expect(popup.close).toHaveBeenCalled());
    open.mockRestore();
  });

  it('refuses a response bound to a different provider', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(response({ providers: [{ id: 'rustdesk', name: 'RustDesk', available: true, skipReason: null }] }))
      .mockResolvedValueOnce(response({ launchUrl: 'rustdesk://12345', providerId: 'other-tool', scheme: 'rustdesk' }));
    const popup = { close: vi.fn(), opener: null, document: { createElement: () => ({}), head: { appendChild: vi.fn() } }, location: { href: '' } };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    render(<RemoteAccessAlternatives deviceId="device-1" />);
    fireEvent.click(screen.getByTestId('other-remote-tools-button'));
    fireEvent.click(await screen.findByTestId('remote-access-option-rustdesk'));

    await waitFor(() => expect(popup.close).toHaveBeenCalled());
    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/unsafe launch/i) }));
    open.mockRestore();
  });

  it('surfaces a blocked popup for an HTTPS provider instead of silently treating the launch as successful', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(response({ providers: [{ id: 'web', name: 'Web tool', available: true, skipReason: null }] }))
      .mockResolvedValueOnce(response({ launchUrl: 'https://remote.example/session', providerId: 'web', scheme: 'https' }));
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<RemoteAccessAlternatives deviceId="device-1" />);
    fireEvent.click(screen.getByTestId('other-remote-tools-button'));
    fireEvent.click(await screen.findByTestId('remote-access-option-web'));

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/blocked.*window/i) })));
    open.mockRestore();
  });

  it('keeps only one launch request in flight across rapid duplicate clicks', async () => {
    let resolveLaunch: ((value: Response) => void) | undefined;
    mocks.fetchWithAuth
      .mockResolvedValueOnce(response({ providers: [{ id: 'rustdesk', name: 'RustDesk', available: true, skipReason: null }] }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveLaunch = resolve; }));
    const popup = { close: vi.fn(), opener: null, document: { createElement: () => ({}), head: { appendChild: vi.fn() } }, location: { href: '' } };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<RemoteAccessAlternatives deviceId="device-1" />);
    fireEvent.click(screen.getByTestId('other-remote-tools-button'));
    const button = await screen.findByTestId('remote-access-option-rustdesk');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(2);
    resolveLaunch?.(response({ launchUrl: 'rustdesk://12345', providerId: 'rustdesk', scheme: 'rustdesk' }));
    await waitFor(() => expect(popup.close).toHaveBeenCalled());
    open.mockRestore();
    click.mockRestore();
  });

  it('clears an in-flight launch after closing and reopening the menu', async () => {
    let resolveLaunch: ((value: Response) => void) | undefined;
    const providers = { providers: [{ id: 'rustdesk', name: 'RustDesk', available: true, skipReason: null }] };
    mocks.fetchWithAuth
      .mockResolvedValueOnce(response(providers))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveLaunch = resolve; }))
      .mockResolvedValueOnce(response(providers));
    const popup = { close: vi.fn(), opener: null, document: { createElement: () => ({}), head: { appendChild: vi.fn() } }, location: { href: '' } };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<RemoteAccessAlternatives deviceId="device-1" />);
    fireEvent.click(screen.getByTestId('other-remote-tools-button'));
    fireEvent.click(await screen.findByTestId('remote-access-option-rustdesk'));
    fireEvent.click(screen.getByRole('button', { name: /close other remote tools/i }));
    resolveLaunch?.(response({ launchUrl: 'rustdesk://12345', providerId: 'rustdesk', scheme: 'rustdesk' }));
    await waitFor(() => expect(popup.close).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('other-remote-tools-button'));
    const reopened = await screen.findByTestId('remote-access-option-rustdesk');
    expect(reopened).not.toBeDisabled();
    open.mockRestore();
    click.mockRestore();
  });

  it('ignores a late options result for an old device selection', async () => {
    let resolveOld: ((value: Response) => void) | undefined;
    mocks.fetchWithAuth.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }));
    const { rerender } = render(<RemoteAccessAlternatives deviceId="old-device" />);
    fireEvent.click(screen.getByTestId('other-remote-tools-button'));
    rerender(<RemoteAccessAlternatives deviceId="new-device" />);
    resolveOld?.(response({ providers: [{ id: 'old', name: 'Old device tool', available: true, skipReason: null }] }));

    await waitFor(() => expect(screen.queryByText('Old device tool')).toBeNull());
    expect(screen.queryByTestId('remote-access-alternatives')).toBeNull();
  });
});
