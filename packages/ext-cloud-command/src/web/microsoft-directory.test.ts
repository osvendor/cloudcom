import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandMicrosoftPage } from './microsoft';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const user = { id: 'u1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@example.test', userType: 'Member', licenseSummary: 'M365_BUSINESS_PREMIUM', givenName: 'Ada', surname: 'Lovelace', department: 'Engineering', jobTitle: 'Analyst', officeLocation: 'London', accountEnabled: true };
async function mount(canManage = true, complete = true, userType = user.userType, mailboxRecords: unknown[] = [], oneDrive?: string | null, mailboxPartial = false,
  layout: { columns: string[]; widths: Record<string, number>; sortKey: string | null; sortDirection: 'asc' | 'desc' } | null = null,
  snapshot?: unknown) {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage, tenantName: 'Contoso' });
    if (path === '/microsoft/directory/snapshot') return snapshot
      ? Response.json(snapshot) : new Response(null, { status: 404 });
    if (path === '/microsoft/directory/refresh') return Response.json({ queued: true }, { status: 202 });
    if (path === '/microsoft/resources/users') return Response.json({
      items: [{ id: user.id, values: { ...user, userType, ...(oneDrive === undefined ? {} : { oneDrive }) } }],
      columns: [{ key: 'displayName', label: 'User' }, { key: 'userType', label: 'Type' }, { key: 'licenseSummary', label: 'License' }, { key: 'userPrincipalName', label: 'Sign-in name' }, { key: 'accountEnabled', label: 'Account state' }],
      complete, checkedAt: '2026-09-22T12:00:00Z',
    });
    if (path === '/microsoft/resources/groups') return Response.json({
      items: [
        { id: 'g1', values: { displayName: 'Dispatch', mail: 'dispatch@example.test', mailEnabled: true, groupKind: 'Distribution list' } },
        { id: 'g2', values: { displayName: 'Private admins', mailEnabled: false, groupKind: 'Security group' } },
      ],
      columns: [{ key: 'displayName', label: 'Group' }], complete, checkedAt: '2026-09-22T11:00:00Z',
    });
    if (path === '/microsoft/directory/exclusions') return Response.json({ items: [] });
    if (path.startsWith('/microsoft/directory/layout/')) return Response.json({ layout });
    if (path === '/microsoft/administration' && JSON.parse(String(init?.body)).type === 'mailbox.inventory') return Response.json({ records: mailboxRecords, partial: mailboxPartial, collectedAt: '2026-09-22T12:00:00Z' });
    if (path === '/microsoft/administration' && JSON.parse(String(init?.body)).type === 'mailbox.addresses.get') return Response.json({ mailboxId: user.id, primarySmtpAddress: 'ada@example.test', aliases: ['alias@example.test'], policyEnabled: false });
    if (path === '/microsoft/administration' && JSON.parse(String(init?.body)).type === 'user.licenses.get') return Response.json({ items: [
      { skuId: 'direct-sku', name: 'Business Standard', assignedByGroup: null, state: 'Active' },
      { skuId: 'group-sku', name: 'Business Premium', assignedByGroup: 'group-id', state: 'Active' },
    ] });
    if (path === '/microsoft/administration' && JSON.parse(String(init?.body)).type === 'user.license.remove') return Response.json({ accepted: true, changed: true, verified: true });
    if (path === '/microsoft/administration' && JSON.parse(String(init?.body)).type === 'user.get') return Response.json(user);
    if (path === '/microsoft/administration' && JSON.parse(String(init?.body)).type === 'user.drive.usage.get') return Response.json({ oneDrive: '1.0 GB' });
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
  it('queues a background refresh without clearing the displayed snapshot or making live inventory calls', async () => {
    const at = '2026-09-25T12:00:00Z';
    const data = { items: [{ id: 'u1', values: { displayName: 'Ada' } }],
      columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: at };
    const { root, request } = await mount(true, true, user.userType, [], undefined, false, null, {
      directory: { status: 'ready', collectedAt: at,
        data: { users: data, groups: { ...data, items: [] }, licenses: { ...data, items: [] }, mailboxes: [] } },
      usage: { status: 'never', collectedAt: null, data: null }, lastAttemptAt: at,
    });
    root.querySelector<HTMLButtonElement>('#refresh-resource')!.click();
    await flush(); await flush();
    expect(request.mock.calls.some(([path, init]) => path === '/microsoft/directory/refresh' && init?.method === 'POST')).toBe(true);
    expect(root.textContent).toContain('Refresh requested');
    expect(root.textContent).toContain('Ada');
    expect(request.mock.calls.some(([path]) => path.startsWith('/microsoft/resources/') || path === '/microsoft/administration')).toBe(false);
  });
  it('uses the shared snapshot for users, usage and shared mailbox classification without starting live inventory reads', async () => {
    const at = '2026-09-25T12:00:00Z';
    const resource = (items: unknown[]) => ({ items, columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: at });
    const mailbox = { id: 'shared-id', primarySmtpAddress: 'team@example.test', recipientType: 'SharedMailbox',
      archiveEnabled: false, mailboxBytes: 2048, archiveBytes: null, statisticsUnavailable: false, collectedAt: at };
    const { root, request } = await mount(true, true, user.userType, [], undefined, false, null, {
      directory: { status: 'ready', collectedAt: at, data: {
        users: resource([{ id: 'u1', values: { displayName: 'Ada', licenseSummary: 'Business Standard', oneDrive: null } }]),
        groups: resource([]), licenses: resource([]),
        mailboxes: [{ id: mailbox.id, primarySmtpAddress: mailbox.primarySmtpAddress,
          recipientType: mailbox.recipientType, archiveEnabled: false }],
      } },
      usage: { status: 'ready', collectedAt: at, data: {
        mailboxInventory: { records: [mailbox], partial: false, collectedAt: at },
        oneDriveByUserId: { u1: '2.0 GB' },
      } },
    });
    expect(root.textContent).toContain('2.0 GB');
    root.querySelector<HTMLButtonElement>('[data-resource="shared-mailboxes"]')!.click();
    await flush(); await flush();
    expect(root.textContent).toContain('team@example.test');
    expect(root.textContent).toContain('2.0 KB');
    expect(request.mock.calls.some(([path]) => path === '/microsoft/resources/users' || path === '/microsoft/administration')).toBe(false);
  });
  it('shows collected mailbox bytes when only archive statistics are unavailable', async () => {
    const at = '2026-09-25T12:00:00Z';
    const resource = (items: unknown[]) => ({ items, columns: [{ key: 'displayName', label: 'User' }],
      complete: true, checkedAt: at });
    const mailbox = { id: 'u1', primarySmtpAddress: 'qa@example.test', recipientType: 'UserMailbox',
      archiveEnabled: true, mailboxBytes: 2048, archiveBytes: null,
      statisticsUnavailable: true, collectedAt: at };
    const { root } = await mount(true, true, user.userType, [], undefined, false, null, {
      directory: { status: 'ready', collectedAt: at, data: {
        users: resource([{ id: 'u1', values: { displayName: 'QA', licenseSummary: 'Business Standard' } }]),
        groups: resource([]), licenses: resource([]),
        mailboxes: [{ id: mailbox.id, primarySmtpAddress: mailbox.primarySmtpAddress,
          recipientType: mailbox.recipientType, archiveEnabled: true }],
      } },
      usage: { status: 'ready', collectedAt: at, data: {
        mailboxInventory: { records: [mailbox], partial: false, collectedAt: at }, oneDriveByUserId: {},
      } },
    });
    expect(root.textContent).toContain('2.0 KB');
    expect(root.textContent).toContain('Usage unavailable');
    expect(root.textContent).toContain('Mailbox usage: 1 unavailable');
    expect(root.textContent).not.toContain('Usage not loaded');
  });
  it('labels an aged complete snapshot as stale without claiming the directory was partial', async () => {
    const at = '2026-09-25T10:00:00Z';
    const data = { items: [{ id: 'u1', values: { displayName: 'Ada' } }],
      columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: at };
    const { root } = await mount(true, true, user.userType, [], undefined, false, null, {
      directory: { status: 'stale', collectedAt: at,
        data: { users: data, groups: { ...data, items: [] }, licenses: { ...data, items: [] }, mailboxes: [] } },
      usage: { status: 'never', collectedAt: null, data: null },
    });
    expect(root.textContent).toContain('snapshot is stale');
    expect(root.textContent).toContain('Complete directory');
    expect(root.textContent).not.toContain('Partial directory');
  });
  it('waits for an uncollected snapshot instead of launching browser-wide live reads', async () => {
    const { root, request } = await mount(true, true, user.userType, [], undefined, false, null, {
      directory: { status: 'never', collectedAt: null, data: null },
      usage: { status: 'never', collectedAt: null, data: null },
    });
    expect(root.textContent).toContain('background directory snapshot is being prepared');
    expect(request.mock.calls.some(([path]) => path.startsWith('/microsoft/resources/')
      || path === '/microsoft/administration')).toBe(false);
  });
  it('shows assignment origin and permits confirmed removal of only a direct license', async () => {
    const { root, request } = await mount();
    root.querySelector<HTMLButtonElement>('[data-expand="u1"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-detail="u1"]')!.click();
    await flush(); await flush();
    root.querySelector<HTMLButtonElement>('#licenses-open')!.click();
    await flush(); await flush();
    expect(root.textContent).toContain('Inherited from group');
    expect(root.querySelector('[data-license-remove="group-sku"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-license-remove="direct-sku"]')!.click();
    root.querySelector<HTMLInputElement>('#license-confirmation')!.value = 'REMOVE_LICENSE';
    root.querySelector<HTMLInputElement>('#license-confirmation')!.dispatchEvent(new Event('input'));
    root.querySelector<HTMLButtonElement>('#license-submit')!.click();
    await flush();
    expect(request.mock.calls.some(([, init]) => JSON.parse(String(init?.body || '{}')).type === 'user.license.remove')).toBe(true);
    expect(root.textContent).toContain('License removal verified');
  });
  it('restores account-scoped column order, widths and sort and saves changes', async () => {
    const saved = { columns: ['displayName', 'oneDrive', 'mailbox'], widths: { mailbox: 210 }, sortKey: 'oneDrive', sortDirection: 'desc' as const };
    const { root, request } = await mount(true, true, user.userType, [], undefined, false, saved);
    expect(Array.from(root.querySelectorAll('thead th')).map(cell => cell.textContent?.trim()).slice(0, 3)).toEqual(['User', 'OneDrive ↓', 'Mailbox']);
    expect(root.querySelector('[data-sort="mailbox"]')?.parentElement?.getAttribute('style')).toContain('210px');
    root.querySelector<HTMLButtonElement>('[data-column="archive"]')!.click();
    await flush();
    const writes = request.mock.calls.filter(([path, init]) => path === '/microsoft/directory/layout/users' && init?.method === 'PUT');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]![1]?.body)).columns).toContain('archive');
  });
  it('combines users, shared mailboxes, and mail-enabled groups without exposing security groups', async () => {
    const { root } = await mount(true, true, user.userType, [{
      id: user.id, primarySmtpAddress: 'ada@example.test', recipientType: 'SharedMailbox',
      archiveEnabled: false, mailboxBytes: 0, archiveBytes: null,
      collectedAt: '2026-09-22T12:00:00Z', statisticsUnavailable: false,
    }]);
    root.querySelector<HTMLButtonElement>('[data-resource="all"]')!.click();
    await flush(); await flush();
    expect(root.querySelector('[data-resource="all"]')?.getAttribute('aria-selected')).toBe('true');
    const table = root.querySelector('table')!.textContent ?? '';
    expect(table).toContain('Ada Lovelace');
    expect(table).toContain('Shared mailbox');
    expect(table).toContain('Dispatch');
    expect(table).toContain('Groups');
    expect(table).not.toContain('Private admins');
    expect(root.querySelector('[data-detail="u1"]')?.textContent).toContain('Manage mailbox');
    expect(root.querySelector('[data-detail="g1"]')).toBeTruthy();
    root.querySelector<HTMLButtonElement>('[data-detail="u1"]')!.click();
    await flush(); await flush();
    expect(root.querySelector('#detail-title')?.textContent).toBe('Shared mailbox');
  });
  it('loads primary address and aliases when opening a mailbox account', async () => {
    const { root, request } = await mount(true, true, user.userType, [{
      id: user.id, primarySmtpAddress: 'ada@example.test', recipientType: 'UserMailbox',
      archiveEnabled: false, mailboxBytes: 0, archiveBytes: null,
      collectedAt: '2026-09-22T12:00:00Z', statisticsUnavailable: false,
    }]);
    root.querySelector<HTMLButtonElement>('[data-expand="u1"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-detail="u1"]')!.click();
    await flush(); await flush();
    expect(root.querySelector<HTMLInputElement>('#addresses-primary')?.value).toBe('ada@example.test');
    expect(root.querySelector('.address-aliases')?.textContent).toContain('alias@example.test');
    expect(request.mock.calls.some(([, init]) => JSON.parse(String(init?.body || '{}')).type === 'mailbox.addresses.get')).toBe(true);
  });
  it('sorts directory rows from column headings in both directions', async () => {
    const { root, request } = await mount();
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/resources/users') return Response.json({
        items: [
          { id: 'z', values: { displayName: 'Zoe', userPrincipalName: 'zoe@example.test', licenseSummary: 'Unlicensed' } },
          { id: 'a', values: { displayName: 'Ada', userPrincipalName: 'ada@example.test', licenseSummary: 'Unlicensed' } },
        ], columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: '2026-09-22T12:00:00Z',
      });
      if (path === '/microsoft/directory/exclusions') return Response.json({ items: [] });
      if (path === '/microsoft/administration' && JSON.parse(String(init?.body)).type === 'mailbox.inventory') return Response.json({ records: [], partial: false, collectedAt: '2026-09-22T12:00:00Z' });
      throw new Error(`Unexpected ${path}`);
    });
    root.querySelector<HTMLButtonElement>('#refresh-resource')!.click(); await flush(); await flush();
    expect(root.querySelector('tbody tr:first-child')?.textContent).toContain('Ada');
    root.querySelector<HTMLButtonElement>('[data-sort="displayName"]')!.click();
    expect(root.querySelector('thead th:first-child')?.getAttribute('aria-sort')).toBe('ascending');
    root.querySelector<HTMLButtonElement>('[data-sort="displayName"]')!.click();
    expect(root.querySelector('thead th:first-child')?.getAttribute('aria-sort')).toBe('descending');
    expect(root.querySelector('tbody tr:first-child')?.textContent).toContain('Zoe');
  });
  it('does not call a directory complete while Exchange classification is partial', async () => {
    const { root } = await mount(true, true, user.userType, [], undefined, true);
    expect(root.textContent).toContain('Partial directory');
    expect(root.textContent).toContain('Some shared mailboxes may still appear under Users');
    expect(root.textContent).not.toContain('Complete directory');
  });
  it('loads usage for a searched mailbox beyond the first 200 without starting a tenant-wide size sweep', async () => {
    const { root, request } = await mount();
    const accounts = Array.from({ length: 201 }, (_, index) => ({ id: `id-${index + 1}`, values: {
      displayName: `Person${index + 1}`, userPrincipalName: `person${index + 1}@example.test`, licenseSummary: 'Unlicensed',
    } }));
    const mailboxes = accounts.map(account => ({ id: account.id, primarySmtpAddress: String(account.values.userPrincipalName),
      recipientType: 'UserMailbox', archiveEnabled: false, mailboxBytes: null, archiveBytes: null,
      collectedAt: '2026-09-22T12:00:00Z', statisticsUnavailable: true }));
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/resources/users') return Response.json({ items: accounts, columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: '2026-09-22T12:00:00Z' });
      if (path === '/microsoft/directory/exclusions') return Response.json({ items: [] });
      if (path === '/microsoft/administration') {
        const operation = JSON.parse(String(init?.body));
        if (operation.type === 'mailbox.inventory') return Response.json({ records: mailboxes, partial: false, collectedAt: '2026-09-22T12:00:00Z' });
        if (operation.type === 'mailbox.statistics.get') {
          if (operation.mailboxId === 'id-1') return new Promise(() => {});
          return Response.json({ ...mailboxes.find(row => row.id === operation.mailboxId), mailboxBytes: 1024 ** 3, statisticsUnavailable: false });
        }
      }
      throw new Error(`Unexpected ${path}`);
    });
    root.querySelector<HTMLButtonElement>('#refresh-resource')!.click(); await flush(); await flush();
    expect(root.textContent).toContain('Search for another account to load its usage');
    const filter = root.querySelector<HTMLInputElement>('#filter')!;
    filter.value = 'Person201'; filter.dispatchEvent(new Event('input'));
    await flush(); await flush();
    const sizeReads = request.mock.calls.map(([, init]) => JSON.parse(String(init?.body || '{}')))
      .filter(operation => operation.type === 'mailbox.statistics.get');
    expect(sizeReads.map(operation => operation.mailboxId)).toEqual(['id-1', 'id-201']);
    expect(root.querySelector('table')?.textContent).toContain('1.0 GB');
  });
  it('fills concealed OneDrive usage from a direct account lookup without a report-privacy warning', async () => {
    const { root, request } = await mount(true, true, user.userType, [], 'Names concealed in Microsoft reports');
    await flush();
    expect(root.querySelector('[data-column="oneDrive"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('table')?.textContent).toContain('1.0 GB');
    expect(root.textContent).not.toContain('change that report privacy setting');
    expect(request.mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).type === 'user.drive.usage.get')).toBe(true);
  });
  it('expands account actions without making a mutation and opens an editing drawer', async () => {
    const { root, request } = await mount();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-expand="u1"]')!.click();
    expect(root.querySelector('[data-expand="u1"]')?.getAttribute('aria-expanded')).toBe('true');
    root.querySelector<HTMLButtonElement>('[data-detail="u1"]')!.click();
    await flush();
    expect(root.querySelector('[role="dialog"]')).toBeTruthy();
    expect(root.querySelector<HTMLInputElement>('#user-displayName')?.value).toBe(user.displayName);
    expect(request.mock.calls.filter(([, init]) => init?.body).every(([, init]) => ['mailbox.inventory', 'user.get', 'user.globalAdmin.get'].includes(JSON.parse(String(init?.body)).type))).toBe(true);
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
    const headers = Array.from(root.querySelectorAll('thead th')).map(header => header.querySelector('button')?.firstChild?.textContent?.trim() ?? header.textContent?.trim());
    expect(headers.slice(0, 6)).toEqual(['User', 'Type', 'License', 'Mailbox', 'Archive', 'OneDrive']);
    expect(headers).not.toContain('Exclude');
    expect(root.querySelector('[data-column="exclude"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('[data-column="mailbox"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('table')?.textContent).not.toContain('Member');
    expect(root.querySelectorAll<HTMLTableCellElement>('tbody tr:first-child td')[1]?.textContent).toBe('User');
    expect(root.querySelector('table')?.textContent).toContain('M365_BUSINESS_PREMIUM');
    expect(root.querySelector('table')?.textContent).toContain('M365_BUSINESS_PREMIUM');
    root.querySelector<HTMLButtonElement>('[data-column="exclude"]')!.click();
    expect(root.querySelector('thead')?.textContent).toContain('Exclude');
    root.querySelector<HTMLButtonElement>('[data-column="mailbox"]')!.click();
    expect(root.querySelector('thead')?.textContent).not.toContain('Mailbox');
  });

  it('uses the original user label instead of Graph member and guest types', async () => {
    const { root } = await mount(true, true, 'Guest');
    expect(root.querySelector('table')?.textContent).not.toContain('Guest');
    expect(root.querySelector('table')?.textContent).not.toContain('Member');
    expect(root.querySelectorAll<HTMLTableCellElement>('tbody tr:first-child td')[1]?.textContent).toBe('User');
  });

  it('separates an Exchange-classified shared mailbox from user accounts and shows its usage', async () => {
    const { root, page } = await mount(true, true, user.userType, [{
      id: user.id, primarySmtpAddress: 'ada@example.test', recipientType: 'SharedMailbox',
      archiveEnabled: true, mailboxBytes: 2 * 1024 ** 3, archiveBytes: 512 * 1024 ** 2,
      collectedAt: '2026-09-22T12:00:00Z', statisticsUnavailable: false,
    }]);
    expect(root.querySelector('table')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-resource="shared-mailboxes"]')!.click();
    await flush(); await flush();
    expect(page.shadowRoot!.querySelector('table')?.textContent).toContain('ada@example.test');
    expect(page.shadowRoot!.querySelector('table')?.textContent).toContain('2.0 GB');
    expect(page.shadowRoot!.querySelector('table')?.textContent).toContain('512.0 MB');
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-detail="u1"]')!.click();
    await flush(); await flush();
    expect(page.shadowRoot!.querySelector('#detail-title')?.textContent).toBe('Shared mailbox');
    expect(page.shadowRoot!.textContent).toContain('Manage forwarding');
    expect(page.shadowRoot!.textContent).toContain('Delegate mailbox');
    expect(page.shadowRoot!.querySelector('#user-password-reset-start')).toBeNull();
    expect(page.shadowRoot!.querySelector('#global-admin-enabled')).toBeNull();
  });

  it('marks a failed mailbox size read unavailable and retries it on manual refresh', async () => {
    const mailbox = { id: user.id, primarySmtpAddress: 'ada@example.test', recipientType: 'SharedMailbox',
      archiveEnabled: false, mailboxBytes: null, archiveBytes: null,
      collectedAt: '2026-09-22T12:00:00Z', statisticsUnavailable: true };
    const { root, request } = await mount(true, true, user.userType, [mailbox]);
    root.querySelector<HTMLButtonElement>('[data-resource="shared-mailboxes"]')!.click();
    await flush(); await flush(); await flush();
    expect(root.querySelector('table')?.textContent).toContain('Usage unavailable');
    expect(root.querySelector('table')?.textContent).not.toContain('Loading usage…');
    expect(root.textContent).toContain('Mailbox usage: 1 unavailable');
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path.startsWith('/microsoft/directory/layout/')) return Response.json({ layout: null });
      if (path === '/microsoft/administration') {
        const operation = JSON.parse(String(init?.body));
        if (operation.type === 'mailbox.inventory') return Response.json({ records: [mailbox], partial: false, collectedAt: mailbox.collectedAt });
        if (operation.type === 'mailbox.statistics.get') return Response.json({ ...mailbox, mailboxBytes: 1024 ** 3, statisticsUnavailable: false });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    root.querySelector<HTMLButtonElement>('#refresh-resource')!.click();
    await flush(); await flush(); await flush();
    expect(root.querySelector('table')?.textContent).toContain('1.0 GB');
    expect(request.mock.calls.filter(([, init]) => init?.body && JSON.parse(String(init.body)).type === 'mailbox.statistics.get')).toHaveLength(2);
  });

  it('shows the retained directory scopes and marks unavailable mailbox actions', async () => {
    const { root } = await mount();
    expect(root.textContent).toContain('All');
    expect(root.textContent).toContain('Shared mailboxes');
    expect(root.textContent).toContain('Groups');
    expect(root.textContent).toContain('Exclude');
    root.querySelector<HTMLButtonElement>('[data-expand="u1"]')!.click();
    expect(root.textContent).toContain('Delegate mailbox');
    expect(root.querySelector('#user-password-reset-start')).toBeNull();
    expect(root.querySelector('[data-row-security="reset-password"]')).toBeTruthy();
    expect(root.textContent).toContain('Manage forwarding');
  });

  it('creates a distribution list through the typed Exchange action without requiring a group owner', async () => {
    const { root, request } = await mount();
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/administration') {
        const operation = JSON.parse(String(init?.body));
        if (operation.type === 'distribution.create') return Response.json({ accepted: true, verified: true, id: null,
          primarySmtpAddress: operation.primarySmtpAddress });
      }
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/resources/users') return Response.json({ items: [], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/directory/exclusions') return Response.json({ items: [] });
      if (path.startsWith('/microsoft/directory/layout/')) return Response.json({ layout: null });
      throw new Error(`Unexpected ${path}`);
    });
    root.querySelector<HTMLButtonElement>('[data-resource="groups"]')!.click(); await flush(); await flush();
    root.querySelector<HTMLButtonElement>('#create-group')!.click(); await flush();
    const kind = root.querySelector<HTMLSelectElement>('#create-group-kind')!;
    kind.value = 'distribution'; kind.dispatchEvent(new Event('change', { bubbles: true }));
    const name = root.querySelector<HTMLInputElement>('#create-group-name')!;
    name.value = 'QA Distribution'; name.dispatchEvent(new Event('input', { bubbles: true }));
    const address = root.querySelector<HTMLInputElement>('#create-group-address')!;
    address.value = 'qa@example.test'; address.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('#create-group-submit')!.click(); await flush(); await flush();
    expect(request.mock.calls.some(([, init]) => String(init?.body || '').includes('"type":"distribution.create"'))).toBe(true);
    expect(root.textContent).toContain('Microsoft verified the new group');
    expect(root.textContent).toContain('qa@example.test');
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
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
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
  it.each([true, false])('keeps the temporary password visible when license assignment verification is %s', async verified => {
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
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/resources/users') return Response.json({ items: [], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/directory/exclusions') return Response.json({ items: [] });
      throw new Error(`Unexpected ${path}`);
    });
    root.querySelector<HTMLButtonElement>('#create-user')!.click(); await flush(); await flush();
    expect(root.querySelectorAll<HTMLSelectElement>('#create-user-license option')).toHaveLength(3);
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
    expect(root.textContent).toContain(verified ? 'License assigned and verified.' : 'Microsoft accepted the license assignment. Refresh the user to verify it appears.');
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
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
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
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
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
    for (const action of ['Delete user', 'Reset password', 'Delegate mailbox', 'Threat Hunting']) expect(root.textContent).not.toContain(action);
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
    const lastButton = root.querySelector<HTMLButtonElement>('#user-drive-link')!;
    lastButton.focus(); lastButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(root.activeElement).toBe(close);
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(root.activeElement).toBe(lastButton);
    lastButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flush();
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
