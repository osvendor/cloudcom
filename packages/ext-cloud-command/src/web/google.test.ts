import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandGooglePage } from './google';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const context = (organizationId: string) => ({ contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/google', organizationId });
afterEach(() => document.body.replaceChildren());
describe('Google directory page', () => {
  it('shows bounded Gmail audit trace and labels loaded-result search', async () => {
    const request = vi.fn(async (path: string) => Response.json(path === '/google/connection'
      ? { available: true, connected: true, enabled: true, canManage: true }
      : path.startsWith('/google/reports/trace')
        ? { asOf: '2026-09-22T11:00:00.000Z', items: [{ id: 't1', at: '2026-09-22T10:00:00Z', sender: 'one@example.test', recipient: 'two@example.test', subject: 'Test', status: 'Sent' }], nextPageToken: 'next', partial: false, warning: null }
        : { items: [], nextPageToken: null, complete: true }));
    const page = new CloudCommandGooglePage(); page.context = context('org-a'); page.hostApi = { request }; document.body.append(page);
    await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#trace-tab')!.click();
    await flush();
    expect(request.mock.calls.some(([path]) => path === '/google/reports/trace?days=7')).toBe(true);
    expect(page.shadowRoot!.textContent).toContain('one@example.test');
    expect(page.shadowRoot!.textContent).toContain('not final delivery proof');
    expect(page.shadowRoot!.textContent).toContain('More pages available');
    page.shadowRoot!.querySelector<HTMLButtonElement>('#more-trace')!.click();
    await flush();
    expect(request.mock.calls.some(([path]) => path.includes('pageToken=next&asOf=2026-09-22T11%3A00%3A00.000Z'))).toBe(true);
  });
  it('shows bounded security activity without provider parameter values', async () => {
    const request = vi.fn(async (path: string) => Response.json(path === '/google/connection'
      ? { available: true, connected: true, enabled: true, canManage: true }
      : path.startsWith('/google/reports/activity')
        ? { asOf: '2026-09-22T11:00:00.000Z', items: [{ id: 'a1', at: '2026-09-22T10:00:00Z', source: 'login', actor: 'one@example.test', ip: null, events: ['login_success'] }], nextPageToken: 'next', partial: false, warning: null }
        : { items: [], nextPageToken: null, complete: true }));
    const page = new CloudCommandGooglePage(); page.context = context('org-a'); page.hostApi = { request }; document.body.append(page);
    await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#activity-tab')!.click();
    await flush();
    expect(request.mock.calls.some(([path]) => path === '/google/reports/activity?source=login&days=7')).toBe(true);
    expect(page.shadowRoot!.textContent).toContain('login_success');
    expect(page.shadowRoot!.textContent).toContain('More pages available');
    expect(page.shadowRoot!.textContent).toContain('an empty page does not prove no activity');
    page.shadowRoot!.querySelector<HTMLButtonElement>('#more-activity')!.click();
    await flush();
    expect(request.mock.calls.some(([path]) => path.includes('pageToken=next&asOf=2026-09-22T11%3A00%3A00.000Z'))).toBe(true);
  });
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
  it('shows paged direct group members with their reported roles', async () => {
    const request = vi.fn(async (path: string) => Response.json(path === '/google/connection'
      ? { available: true, connected: true, enabled: true }
      : path.startsWith('/google/groups/g1/members')
        ? { items: [{ id: 'm1', email: 'owner@example.test', role: 'OWNER', type: 'USER', status: 'ACTIVE' }], nextPageToken: 'next', complete: false }
        : { items: [{ id: 'g1', name: 'Team', email: 'team@example.test', members: '1' }], nextPageToken: null, complete: true }));
    const page = new CloudCommandGooglePage(); page.context = context('org-a'); page.hostApi = { request }; document.body.append(page);
    await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-kind="groups"]')!.click();
    await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-members="g1"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith('/google/groups/g1/members', undefined);
    expect(page.shadowRoot!.textContent).toContain('owner@example.test');
    expect(page.shadowRoot!.textContent).toContain('OWNER');
    expect(page.shadowRoot!.textContent).toContain('Load more members');
  });
  it('shows compact read-only Gmail settings without a message body', async () => {
    const request = vi.fn(async (path: string) => Response.json(path === '/google/connection'
      ? { available: true, connected: true, enabled: true, canManage: true }
      : path === '/google/users/u1/mailbox-settings'
        ? { ok: true, email: 'one@example.test', forwardingEnabled: true, forwardingAddress: 'target@example.test',
          forwardingDisposition: 'leaveInInbox', vacationEnabled: true, vacationSubject: 'Away', vacationStartMs: null,
          vacationEndMs: null, responseBodyHtml: '<b>private</b>' }
        : { items: [{ id: 'u1', name: 'One', email: 'one@example.test', suspended: false, admin: false }], nextPageToken: null, complete: true }));
    const page = new CloudCommandGooglePage(); page.context = context('org-a'); page.hostApi = { request }; document.body.append(page);
    await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-mailbox="u1"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith('/google/users/u1/mailbox-settings', undefined);
    expect(page.shadowRoot!.textContent).toContain('target@example.test');
    expect(page.shadowRoot!.textContent).toContain('Away');
    expect(page.shadowRoot!.textContent).not.toContain('private');
  });
  it('shows a bounded storage report with missing metrics and partial coverage', async () => {
    const request = vi.fn(async (path: string) => Response.json(path === '/google/connection'
      ? { available: true, connected: true, enabled: true }
      : path.startsWith('/google/reports/storage')
        ? { date: '2026-09-20', items: [{ email: 'one@example.test', gmailMb: 0, driveMb: null, totalMb: 125 }],
          nextPageToken: 'next', partial: true, warning: 'Google returned incomplete or unavailable usage data for this date.' }
        : { items: [], nextPageToken: null, complete: true }));
    const page = new CloudCommandGooglePage(); page.context = context('org-a'); page.hostApi = { request }; document.body.append(page);
    await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#storage-tab')!.click();
    await flush();
    expect(request.mock.calls.some(([path]) => path.startsWith('/google/reports/storage?date='))).toBe(true);
    expect(page.shadowRoot!.textContent).toContain('one@example.test');
    expect(page.shadowRoot!.textContent).toContain('0 MB');
    expect(page.shadowRoot!.textContent).toContain('Unavailable');
    expect(page.shadowRoot!.textContent).toContain('Partial or unavailable data');
    expect(page.shadowRoot!.textContent).toContain('Load more');
  });
});
