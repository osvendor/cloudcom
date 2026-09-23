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
    expect(request).toHaveBeenCalledWith('/google/directory/users');
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
});
