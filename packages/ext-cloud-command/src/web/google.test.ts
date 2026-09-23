import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandGooglePage } from './google';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const context = (organizationId: string) => ({ contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/google', organizationId });
afterEach(() => document.body.replaceChildren());
describe('Google directory page', () => {
  it('shows native connection state and a bounded user page', async () => {
    const request = vi.fn(async (path: string) => Response.json(path === '/google/connection'
      ? { available: true, connected: true, enabled: true, customerDomain: 'example.test' }
      : { items: [{ name: 'One', email: 'one@example.test', suspended: false, admin: false }], nextPageToken: 'next', complete: false }));
    const page = new CloudCommandGooglePage(); page.context = context('org-a'); page.hostApi = { request }; document.body.append(page);
    await flush(); await flush();
    expect(page.shadowRoot!.textContent).toContain('One');
    expect(page.shadowRoot!.textContent).toContain('more pages are available');
    expect(request).toHaveBeenCalledWith('/google/directory/users', undefined);
  });
  it('discards results from an earlier organization', async () => {
    let resolveOld!: (result: Response) => void;
    const request = vi.fn(async (path: string) => path === '/google/connection'
      ? Response.json({ available: true, connected: true, enabled: true })
      : new Promise<Response>(resolve => { resolveOld = resolve; }));
    const page = new CloudCommandGooglePage(); page.context = context('org-a'); page.hostApi = { request }; document.body.append(page);
    await flush();
    page.context = context('org-b');
    resolveOld(Response.json({ items: [{ name: 'Old Org' }], nextPageToken: null, complete: true }));
    await flush();
    expect(page.shadowRoot!.textContent).not.toContain('Old Org');
  });
  it('loads archived users through their own scoped tab', async () => {
    const request = vi.fn(async (path: string) => Response.json(path === '/google/connection'
      ? { available: true, connected: true, enabled: true }
      : { items: [{ id: 'u1', name: 'Archived', email: 'old@example.test', archived: true }], nextPageToken: null, complete: true }));
    const page = new CloudCommandGooglePage(); page.context = context('org-a'); page.hostApi = { request }; document.body.append(page);
    await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-kind="archived"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith('/google/directory/archived', undefined);
    expect(page.shadowRoot!.textContent).toContain('Archived');
  });
  it('requires a manager and typed email confirmation before suspending', async () => {
    const request = vi.fn(async (path: string) => Response.json(path === '/google/connection'
      ? { available: true, connected: true, enabled: true, canManage: true }
      : path === '/google/users/suspension' ? { ok: true, userId: '123456', suspended: true }
        : { items: [{ id: '123456', name: 'One', email: 'one@example.test', suspended: false, admin: false }], nextPageToken: null, complete: true }));
    const page = new CloudCommandGooglePage(); page.context = context('org-a'); page.hostApi = { request }; document.body.append(page);
    await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-suspend="123456"]')!.click();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#confirm-action')!.click();
    await flush();
    expect(request.mock.calls.some(([path]) => path === '/google/users/suspension')).toBe(false);
    page.shadowRoot!.querySelector<HTMLInputElement>('#confirm-email')!.value = 'one@example.test';
    page.shadowRoot!.querySelector<HTMLButtonElement>('#confirm-action')!.click();
    await flush(); await flush();
    expect(request.mock.calls.some(([path]) => path === '/google/users/suspension')).toBe(true);
  });
  it('saves only a changed first or last name from a compact account editor', async () => {
    const request = vi.fn(async (path: string) => Response.json(path === '/google/connection'
      ? { available: true, connected: true, enabled: true, canManage: true }
      : path === '/google/users/profile' ? { ok: true, userId: '123456', givenName: 'New', familyName: 'Person' }
        : { items: [{ id: '123456', name: 'Old Person', givenName: 'Old', familyName: 'Person', email: 'one@example.test', suspended: false, admin: false }], nextPageToken: null, complete: true }));
    const page = new CloudCommandGooglePage(); page.context = context('org-a'); page.hostApi = { request }; document.body.append(page);
    await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-profile="123456"]')!.click();
    expect(page.shadowRoot!.textContent).toContain('Edit account');
    page.shadowRoot!.querySelector<HTMLInputElement>('#profile-given')!.value = 'New';
    page.shadowRoot!.querySelector<HTMLButtonElement>('#save-profile')!.click();
    await flush(); await flush();
    const call = (request.mock.calls as unknown as [string, RequestInit | undefined][]).find(([path]) => path === '/google/users/profile');
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1]!.body as string)).toMatchObject({ givenName: 'New', familyName: 'Person', expectedGivenName: 'Old' });
  });
});
