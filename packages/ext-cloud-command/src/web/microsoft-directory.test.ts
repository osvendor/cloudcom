import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandMicrosoftPage } from './microsoft';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const user = { id: 'u1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@example.test', userType: 'Member', licenseSummary: 'M365_BUSINESS_PREMIUM', givenName: 'Ada', surname: 'Lovelace', department: 'Engineering', jobTitle: 'Analyst', officeLocation: 'London', accountEnabled: true };
async function mount(canManage = true, complete = true, userType = user.userType) {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage, tenantName: 'Contoso' });
    if (path === '/microsoft/resources/users') return Response.json({
      items: [{ id: user.id, values: { ...user, userType } }],
      columns: [{ key: 'displayName', label: 'User' }, { key: 'userType', label: 'Type' }, { key: 'licenseSummary', label: 'License' }, { key: 'userPrincipalName', label: 'Sign-in name' }, { key: 'accountEnabled', label: 'Account state' }],
      complete, checkedAt: '2026-09-22T12:00:00Z',
    });
    if (path === '/microsoft/directory/exclusions') return Response.json({ items: [] });
    if (path === '/microsoft/administration' && JSON.parse(String(init?.body)).type === 'user.get') return Response.json(user);
    throw new Error(`Unexpected request ${path}`);
  });
  const page = new CloudCommandMicrosoftPage();
  page.context = { contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/microsoft', organizationId: 'org-a' };
  page.hostApi = { request };
  document.body.append(page);
  await flush(); await flush();
  return { page, root: page.shadowRoot!, request };
}
afterEach(() => { document.body.replaceChildren(); window.location.hash = ''; });

describe('Microsoft directory interaction', () => {
  it('expands account actions without making a mutation and opens an editing drawer', async () => {
    const { root, request } = await mount();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-expand="u1"]')!.click();
    expect(root.querySelector('[data-expand="u1"]')?.getAttribute('aria-expanded')).toBe('true');
    root.querySelector<HTMLButtonElement>('[data-detail="u1"]')!.click();
    await flush();
    expect(root.querySelector('[role="dialog"]')).toBeTruthy();
    expect(root.querySelector<HTMLInputElement>('#user-displayName')?.value).toBe(user.displayName);
    expect(request.mock.calls.filter(([, init]) => init?.body).every(([, init]) => ['user.get', 'user.globalAdmin.get'].includes(JSON.parse(String(init?.body)).type))).toBe(true);
    root.querySelector<HTMLButtonElement>('#detail-close')!.click();
    await flush();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('uses the MSP directory identity and omits generic profile and account-state columns', async () => {
    const { root, request } = await mount();
    const calls = request.mock.calls.length;
    expect(root.querySelector('thead')?.textContent).toContain('User');
    expect(root.querySelector('thead')?.textContent).not.toMatch(/Enabled|Department|Job title/i);
    expect(root.querySelector('[data-column="userPrincipalName"]')).toBeNull();
    expect(root.querySelector('[data-column="accountEnabled"]')).toBeNull();
    expect(root.querySelector('table')?.textContent).not.toContain('Engineering');
    expect(root.querySelector('table')?.textContent).toContain('Ada Lovelace');
    root.querySelector<HTMLButtonElement>('#reset-columns')!.click();
    expect(root.querySelector('thead')?.textContent).toContain('User');
    expect(root.querySelector('table')?.textContent).not.toContain('Engineering');
    expect(request.mock.calls).toHaveLength(calls);
  });

  it('keeps the Cloud Command directory column order while marking unavailable data honestly', async () => {
    const { root } = await mount();
    const headers = Array.from(root.querySelectorAll('thead th')).map(header => header.textContent?.trim());
    expect(headers.slice(0, 6)).toEqual(['User', 'Type', 'License', 'Mailbox', 'Archive', 'OneDrive']);
    expect(headers).not.toContain('Exclude');
    expect(root.querySelector('[data-column="exclude"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('table')?.textContent).not.toContain('Member');
    expect(root.querySelectorAll<HTMLTableCellElement>('tbody tr:first-child td')[1]?.textContent).toBe('Unavailable');
    expect(root.querySelector('table')?.textContent).toContain('M365_BUSINESS_PREMIUM');
    expect(root.querySelector('table')?.textContent).toContain('Unavailable');
    root.querySelector<HTMLButtonElement>('[data-column="exclude"]')!.click();
    expect(root.querySelector('thead')?.textContent).toContain('Exclude');
  });

  it('keeps Graph guests recognizable without treating members as mailbox types', async () => {
    const { root } = await mount(true, true, 'Guest');
    expect(root.querySelector('table')?.textContent).toContain('Guest');
    expect(root.querySelector('table')?.textContent).not.toContain('Member');
    expect(root.querySelectorAll<HTMLTableCellElement>('tbody tr:first-child td')[1]?.textContent).toBe('Guest');
  });

  it('shows the retained directory scopes and marks unavailable mailbox actions', async () => {
    const { root } = await mount();
    expect(root.textContent).toContain('All');
    expect(root.textContent).toContain('Shared mailboxes');
    expect(root.textContent).toContain('Groups');
    expect(root.textContent).toContain('Exclude');
    root.querySelector<HTMLButtonElement>('[data-expand="u1"]')!.click();
    expect(root.textContent).toContain('Mailbox delegation is not available yet.');
    expect(root.querySelector('#user-password-reset-start')).toBeNull();
    expect(root.querySelector('[data-row-security="reset-password"]')).toBeTruthy();
    expect(root.textContent).not.toContain('Delegate mailbox');
    expect(root.textContent).toContain('Manage forwarding');
  });

  it('loads verified domains and creates an account without claiming assignments were applied', async () => {
    const { root, request } = await mount();
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/administration') {
        const operation = JSON.parse(String(init?.body));
        if (operation.type === 'user.domains.list') return Response.json({ domains: ['example.test'] });
        if (operation.type === 'licenses.list') return Response.json({ items: [], partial: false });
        if (operation.type === 'user.create') return Response.json({ accepted: true, id: '11111111-1111-4111-8111-111111111111', userPrincipalName: operation.user.userPrincipalName, temporaryPassword: 'temporary-secret' });
      }
      if (path === '/microsoft/resources/users') return Response.json({ items: [], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/directory/exclusions') return Response.json({ items: [] });
      throw new Error(`Unexpected ${path}`);
    });
    root.querySelector<HTMLButtonElement>('#create-user')!.click();
    await flush();
    expect(root.querySelector('#create-user-title')?.textContent).toBe('Add user');
    expect(root.querySelector<HTMLSelectElement>('[aria-label="Domain"]')?.value).toBe('example.test');
    expect(root.textContent).toContain('Force change password at next sign-in');
    root.querySelector<HTMLInputElement>('#create-user-name')!.value = 'New User';
    root.querySelector<HTMLInputElement>('#create-user-local')!.value = 'new';
    root.querySelector<HTMLButtonElement>('#create-user-submit')!.click();
    await flush(); await flush();
    expect(request.mock.calls.some(([, init]) => JSON.parse(String(init?.body || '{}')).type === 'user.create')).toBe(true);
    expect(root.querySelector<HTMLInputElement>('[aria-label="Temporary password"]')?.value).toBe('temporary-secret');
    expect(root.textContent).toContain('MFA enrollment, aliases, and group membership remain separate actions');
    expect(root.querySelector<HTMLButtonElement>('#create-user-close')).toBeTruthy();
    expect(root.querySelector('#create-user-submit')).toBeNull();
  });
  it.each([true, false])('keeps the temporary password visible when Business Standard assignment verification is %s', async verified => {
    const { root, request } = await mount();
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/administration') {
        const operation = JSON.parse(String(init?.body));
        if (operation.type === 'user.domains.list') return Response.json({ domains: ['example.test'] });
        if (operation.type === 'licenses.list') return Response.json({ items: [
          { skuId: '11111111-1111-4111-8111-111111111111', skuPartNumber: 'O365_BUSINESS_PREMIUM', capabilityStatus: 'Enabled', consumedUnits: 1, prepaidUnits: { enabled: 2 } },
          { skuId: '22222222-2222-4222-8222-222222222222', skuPartNumber: 'AAD_PREMIUM_P2', capabilityStatus: 'Enabled', consumedUnits: 0, prepaidUnits: { enabled: 2 } },
        ], partial: false });
        if (operation.type === 'user.create') return Response.json({ accepted: true, id: '33333333-3333-4333-8333-333333333333', userPrincipalName: operation.user.userPrincipalName, temporaryPassword: 'one-time-secret' });
        if (operation.type === 'user.license.assign') return Response.json({ accepted: true, changed: true, verified });
      }
      if (path === '/microsoft/resources/users') return Response.json({ items: [], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/directory/exclusions') return Response.json({ items: [] });
      throw new Error(`Unexpected ${path}`);
    });
    root.querySelector<HTMLButtonElement>('#create-user')!.click(); await flush(); await flush();
    expect(root.querySelectorAll<HTMLSelectElement>('#create-user-license option')).toHaveLength(2);
    expect(root.textContent).not.toContain('AAD_PREMIUM_P2');
    root.querySelector<HTMLInputElement>('#create-user-name')!.value = 'New User';
    root.querySelector<HTMLInputElement>('#create-user-local')!.value = 'new';
    root.querySelector<HTMLInputElement>('#create-user-location')!.value = 'GB';
    root.querySelector<HTMLSelectElement>('#create-user-license')!.value = '11111111-1111-4111-8111-111111111111';
    root.querySelector<HTMLButtonElement>('#create-user-submit')!.click(); await flush(); await flush();
    const mutations = request.mock.calls.map(([, init]) => JSON.parse(String(init?.body || '{}'))).filter(op => op.type === 'user.create' || op.type === 'user.license.assign');
    expect(mutations).toEqual([
      { type: 'user.create', user: { displayName: 'New User', userPrincipalName: 'new@example.test', usageLocation: 'GB' } },
      { type: 'user.license.assign', id: '33333333-3333-4333-8333-333333333333', license: { skuId: '11111111-1111-4111-8111-111111111111' } },
    ]);
    expect(root.querySelector<HTMLInputElement>('[aria-label="Temporary password"]')?.value).toBe('one-time-secret');
    expect(root.textContent).toContain(verified ? 'Business Standard assigned and verified.' : 'Microsoft accepted the license assignment. Refresh the user to verify it appears.');
  });
  it('keeps the created account and password visible when the separate license step fails', async () => {
    const { root, request } = await mount();
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/administration') {
        const operation = JSON.parse(String(init?.body));
        if (operation.type === 'user.domains.list') return Response.json({ domains: ['example.test'] });
        if (operation.type === 'licenses.list') return Response.json({ items: [{ skuId: '11111111-1111-4111-8111-111111111111', skuPartNumber: 'O365_BUSINESS_PREMIUM', capabilityStatus: 'Enabled', consumedUnits: 0, prepaidUnits: { enabled: 1 } }], partial: false });
        if (operation.type === 'user.create') return Response.json({ accepted: true, id: '33333333-3333-4333-8333-333333333333', userPrincipalName: operation.user.userPrincipalName, temporaryPassword: 'one-time-secret' });
        if (operation.type === 'user.license.assign') return Response.json({ error: 'Seat was taken' }, { status: 409 });
      }
      if (path === '/microsoft/resources/users') return Response.json({ items: [], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/directory/exclusions') return Response.json({ items: [] });
      throw new Error(`Unexpected ${path}`);
    });
    root.querySelector<HTMLButtonElement>('#create-user')!.click(); await flush(); await flush();
    root.querySelector<HTMLInputElement>('#create-user-name')!.value = 'New User';
    root.querySelector<HTMLInputElement>('#create-user-local')!.value = 'new';
    root.querySelector<HTMLInputElement>('#create-user-location')!.value = 'CA';
    root.querySelector<HTMLSelectElement>('#create-user-license')!.value = '11111111-1111-4111-8111-111111111111';
    root.querySelector<HTMLButtonElement>('#create-user-submit')!.click(); await flush(); await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="Temporary password"]')?.value).toBe('one-time-secret');
    expect(root.textContent).toContain('User created; license assignment was not confirmed.');
    expect(root.querySelector('#create-user-submit')).toBeNull();
  });

  it('hides per-staff excluded users by default and restores them from the Exclude scope', async () => {
    let excluded = true;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true, tenantName: 'Contoso' });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: '11111111-1111-4111-8111-111111111111', values: { displayName: 'Hidden Ada', userPrincipalName: 'ada@example.test' } }], columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/directory/exclusions') return Response.json({ items: excluded ? ['11111111-1111-4111-8111-111111111111'] : [] });
      if (path.endsWith('/exclude') && init?.method === 'PUT') { excluded = JSON.parse(String(init.body)).excluded; return Response.json({ excluded }); }
      throw new Error(`Unexpected ${path}`);
    });
    const page = new CloudCommandMicrosoftPage();
    page.context = { contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/microsoft', organizationId: 'org-a' };
    page.hostApi = { request }; document.body.append(page);
    await flush(); await flush(); await flush();
    const root = page.shadowRoot!;
    expect(root.querySelector('[data-expand="11111111-1111-4111-8111-111111111111"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-directory-scope="exclude"]')!.click();
    expect(root.querySelector('[data-expand="11111111-1111-4111-8111-111111111111"]')).toBeTruthy();
    root.querySelector<HTMLButtonElement>('[data-column="exclude"]')!.click();
    expect(root.querySelector('table')?.textContent).toContain('Excluded');
    root.querySelector<HTMLButtonElement>('[data-expand="11111111-1111-4111-8111-111111111111"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-directory-exclude]')!.click(); await flush();
    expect(request.mock.calls.map(([, init]) => init?.body).some(body => String(body).includes('"excluded":false'))).toBe(true);
    expect(root.querySelector('[data-expand="11111111-1111-4111-8111-111111111111"]')).toBeNull();
  });

  it('filters rows by email and retains keyboard focus', async () => {
    const { root } = await mount();
    const input = root.querySelector<HTMLInputElement>('#filter')!;
    input.value = 'missing@example.test'; input.dispatchEvent(new Event('input'));
    await flush();
    expect(root.querySelector('[data-expand="u1"]')).toBeNull();
    expect(root.activeElement).toBe(root.querySelector('#filter'));
    const next = root.querySelector<HTMLInputElement>('#filter')!;
    next.value = 'ada@example.test'; next.dispatchEvent(new Event('input'));
    await flush();
    expect(root.querySelector('[data-expand="u1"]')).toBeTruthy();
  });

  it('keeps partial result counts honest and omits unsupported controls', async () => {
    const { root } = await mount(true, false);
    expect(root.textContent).toMatch(/partial|loaded/i);
    for (const action of ['Delete user', 'Reset password', 'Delegate mailbox', 'Threat Hunting', 'Message trace']) expect(root.textContent).not.toContain(action);
    expect(root.querySelector('[data-resource="sites"]')).toBeNull();
  });

  it('opens read-only account details without exposing a save action', async () => {
    const { root } = await mount(false);
    root.querySelector<HTMLButtonElement>('[data-expand="u1"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-detail="u1"]')!.click(); await flush();
    expect(root.querySelector<HTMLInputElement>('#user-displayName')?.disabled).toBe(true);
    expect(root.querySelector('#user-save')).toBeNull();
  });

  it('wraps drawer keyboard focus and returns focus when closed', async () => {
    const { root } = await mount();
    root.querySelector<HTMLButtonElement>('[data-expand="u1"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-detail="u1"]')!.click(); await flush();
    const close = root.querySelector<HTMLButtonElement>('#detail-close')!;
    const save = root.querySelector<HTMLButtonElement>('#autoreply-open')!;
    save.focus(); save.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(root.activeElement).toBe(close);
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(root.activeElement).toBe(save);
    save.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flush();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.activeElement).toBe(root.querySelector('[data-expand="u1"]'));
  });

  it('clears expanded rows and pending account drafts immediately on organization change', async () => {
    const { page, root } = await mount();
    root.querySelector<HTMLButtonElement>('[data-expand="u1"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-detail="u1"]')!.click(); await flush();
    const name = root.querySelector<HTMLInputElement>('#user-displayName')!;
    name.value = 'Private draft'; name.dispatchEvent(new Event('input'));
    page.context = { contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/microsoft', organizationId: 'org-b' };
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.textContent).not.toContain('Private draft');
    await flush();
    root.querySelector<HTMLButtonElement>('[data-expand="u1"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-detail="u1"]')!.click(); await flush();
    expect(root.querySelector<HTMLInputElement>('#user-displayName')!.value).toBe(user.displayName);
  });
});
