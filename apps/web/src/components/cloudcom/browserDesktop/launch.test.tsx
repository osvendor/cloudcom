import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { launchBrowserDesktop, isBrowserDesktopActive } from './launch';
import { endBrowserSession } from './lifecycle';
vi.mock('./lifecycle', () => ({ endBrowserSession: vi.fn() }));
vi.mock('./upstream/components/DesktopViewer', () => ({ default: ({ closing }: { closing: boolean }) => <div>{closing ? 'Transport stopped' : 'Viewer ready'}</div> }));
describe('browser desktop shell', () => {
  it('keeps secrets out of markup and blocks reopening until confirmed close succeeds', async () => {
    vi.mocked(endBrowserSession).mockRejectedValueOnce(new Error('Device disconnect unconfirmed')).mockResolvedValueOnce();
    await act(async () => launchBrowserDesktop({ sessionId: 'session', connectCode: 'secret-code', deviceId: 'device' }));
    expect(await screen.findByRole('dialog')).toHaveFocus();
    expect(document.body.textContent).not.toContain('secret-code');
    expect(isBrowserDesktopActive()).toBe(true);
    expect(() => launchBrowserDesktop({ sessionId: 'other', connectCode: 'another' })).toThrow('Disconnect');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect and close' }));
    expect(await screen.findByText('Device disconnect unconfirmed')).toBeVisible();
    expect(screen.getByText('Transport stopped')).toBeInTheDocument();
    expect(isBrowserDesktopActive()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry disconnect' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(isBrowserDesktopActive()).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });
});
