import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandMicrosoftPage } from './microsoft';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const emptyResource = () => Response.json({ items: [], columns: [], complete: true, checkedAt: 'now' });
function openUser(page: CloudCommandMicrosoftPage, id: string) {
  const expand = page.shadowRoot!.querySelector<HTMLButtonElement>(`[data-expand="${id}"]`)!;
  if (expand.getAttribute('aria-expanded') !== 'true') expand.click();
  page.shadowRoot!.querySelector<HTMLButtonElement>(`[data-detail="${id}"]`)!.click();
}
function editUserField(page: CloudCommandMicrosoftPage, field: string, value: string) {
  const input = page.shadowRoot!.querySelector<HTMLInputElement>(`#user-${field}`)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function mount(request: (path: string, init?: RequestInit) => Promise<Response>, org = 'org-a') {
  const page = new CloudCommandMicrosoftPage();
  page.context = {
    contractVersion: 1,
    extensionName: 'cloudcommand',
    path: '/extensions/cloudcommand/microsoft',
    organizationId: org,
  };
  page.hostApi = { request };
  document.body.append(page);
  return page;
}
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  window.location.hash = '';
});

describe('CloudCommandMicrosoftPage', () => {
  it('stops the domain loading state on an error and allows retry', async () => {
    let attempts = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return emptyResource();
      if (path === '/microsoft/administration') {
        const type = JSON.parse(String(init?.body)).type;
        if (type === 'user.domains.list') return ++attempts === 1
          ? Response.json({ error: 'provider_rejected' }, { status: 502 }) : Response.json({ domains: ['example.test'] });
        if (type === 'licenses.list') return Response.json({ items: [], partial: false });
      }
      return emptyResource();
    });
    const page = mount(request); await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#create-user')!.click(); await flush(); await flush();
    expect(page.shadowRoot!.querySelector<HTMLButtonElement>('#create-user-domains-retry')).not.toBeNull();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#create-user-domains-retry')!.click(); await flush();
    expect(page.shadowRoot!.querySelector<HTMLSelectElement>('#create-user-domain')!.value).toBe('example.test');
  });
  it('offers every available tenant license during account creation', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return emptyResource();
      if (path === '/microsoft/administration') {
        const type = JSON.parse(String(init?.body)).type;
        if (type === 'user.domains.list') return Response.json({ domains: ['example.test'] });
        if (type === 'licenses.list') return Response.json({ partial: false, items: [
          { skuId: '11111111-1111-4111-8111-111111111111', skuPartNumber: 'O365_BUSINESS_PREMIUM', capabilityStatus: 'Enabled', consumedUnits: 1, prepaidUnits: { enabled: 2 } },
          { skuId: '22222222-2222-4222-8222-222222222222', skuPartNumber: 'ENTERPRISEPACK', capabilityStatus: 'Enabled', consumedUnits: 0, prepaidUnits: { enabled: 3 } },
          { skuId: '33333333-3333-4333-8333-333333333333', skuPartNumber: 'EXHAUSTED', capabilityStatus: 'Enabled', consumedUnits: 2, prepaidUnits: { enabled: 2 } },
        ] });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#create-user')!.click(); await flush(); await flush();
    const options = [...page.shadowRoot!.querySelector<HTMLSelectElement>('#create-user-license')!.options];
    expect(options.map(option => option.value)).toEqual(['', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
    expect(options[2]!.textContent).toContain('Office 365 E3');
  });
  it('shows a read-only OneDrive link without granting access', async () => {
    const userId = '66666666-6666-4666-8666-666666666666';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: userId, values: { displayName: 'QA User' } }], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ id: userId, displayName: 'QA User' });
        if (body.type === 'user.globalAdmin.get') return Response.json({ enabled: false });
        if (body.type === 'user.drive.link.get') return Response.json({ url: 'https://tenant-my.sharepoint.com/personal/qa' });
      }
      return emptyResource();
    });
    const page = mount(request); await flush(); await flush(); openUser(page, userId); await flush();
    const root = page.shadowRoot!;
    expect(root.querySelector('a[href*="sharepoint.com"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('#user-drive-link')!.click(); await flush();
    expect(request.mock.calls.filter(([, init]) => String(init?.body).includes('user.drive.link.get'))).toHaveLength(1);
    const link = root.querySelector<HTMLAnchorElement>('a[href="https://tenant-my.sharepoint.com/personal/qa"]')!;
    expect(link.textContent).toBe('Open OneDrive');
    expect(link.rel).toContain('noopener');
    expect(root.textContent).toContain('still needs file access');
  });
  it('adds a user to a selected Microsoft 365 group through the typed operation', async () => {
    const userId = '66666666-6666-4666-8666-666666666666';
    const groupId = '88888888-8888-4888-8888-888888888888';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: userId, values: { displayName: 'QA User' } }],
        columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [
        { id: groupId, values: { displayName: 'QA Group', groupKind: 'Microsoft 365 group' } },
        { id: '99999999-9999-4999-8999-999999999999', values: { displayName: 'Security', groupKind: 'Security group' } },
      ], columns: [{ key: 'displayName', label: 'Group' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ id: userId, displayName: 'QA User' });
        if (body.type === 'user.globalAdmin.get') return Response.json({ enabled: false });
        if (body.type === 'group.member.add') return Response.json({ accepted: true, verified: true, changed: true });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, userId); await flush();
    const root = page.shadowRoot!;
    root.querySelector<HTMLButtonElement>('#user-group-open')!.click(); await flush(); await flush();
    expect(root.textContent).toContain('QA Group');
    const select = root.querySelector<HTMLSelectElement>('#user-group-select')!;
    expect([...select.options].map(option => option.textContent)).not.toContain('Security');
    select.value = groupId; select.dispatchEvent(new Event('change', { bubbles: true }));
    const checkbox = root.querySelector<HTMLInputElement>('#user-group-confirm')!;
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('#user-group-submit')!.click(); await flush();
    const calls = request.mock.calls.filter(([path, init]) => path === '/microsoft/administration'
      && String(init?.body).includes('group.member.add'));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({ type: 'group.member.add', groupId, userId });
    expect(root.textContent).toContain('Group membership added and verified.');
  });
  it('does not offer membership writes from a partial group inventory', async () => {
    const userId = '66666666-6666-4666-8666-666666666666';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: userId, values: { displayName: 'QA User' } }],
        columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [{
        id: '88888888-8888-4888-8888-888888888888', values: { displayName: 'QA Group', groupKind: 'Microsoft 365 group' },
      }], columns: [{ key: 'displayName', label: 'Group' }], complete: false, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ id: userId, displayName: 'QA User' });
        if (body.type === 'user.globalAdmin.get') return Response.json({ enabled: false });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, userId); await flush();
    const root = page.shadowRoot!;
    root.querySelector<HTMLButtonElement>('#user-group-open')!.click(); await flush(); await flush();
    expect(root.textContent).toContain('complete group list is unavailable');
    expect(root.querySelector('#user-group-submit')).toBeNull();
    expect(request.mock.calls.some(([path, init]) => path === '/microsoft/administration'
      && String(init?.body).includes('group.member.add'))).toBe(false);
  });
  it('assigns an available license to an existing account once and waits for readback', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    const skuId = '77777777-7777-4777-8777-777777777777';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id, values: { displayName: 'Ada', userPrincipalName: 'ada@example.com' } }],
        columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ id, displayName: 'Ada' });
        if (body.type === 'user.globalAdmin.get') return Response.json({ enabled: false });
        if (body.type === 'user.licenses.get') return Response.json({ items: [] });
        if (body.type === 'licenses.list') return Response.json({ items: [{ skuId, skuPartNumber: 'O365_BUSINESS_PREMIUM',
          capabilityStatus: 'Enabled', consumedUnits: 1, prepaidUnits: { enabled: 2 } }], partial: false });
        if (body.type === 'user.license.assign') return Response.json({ accepted: true, verified: false });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, id); await flush();
    const root = page.shadowRoot!;
    root.querySelector<HTMLButtonElement>('#licenses-open')!.click(); await flush(); await flush();
    const select = root.querySelector<HTMLSelectElement>('#license-assign-sku')!;
    expect(select).not.toBeNull();
    select.value = skuId; select.dispatchEvent(new Event('change', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('#license-assign')!.click(); await flush();
    const assignments = request.mock.calls.filter(([path, init]) => path === '/microsoft/administration' &&
      String(init?.body).includes('user.license.assign'));
    expect(assignments).toHaveLength(1);
    expect(JSON.parse(String(assignments[0]![1]?.body))).toEqual({ type: 'user.license.assign', id, license: { skuId } });
    expect(root.textContent).toContain('readback is pending');
    expect(root.querySelector<HTMLButtonElement>('#license-assign')?.disabled).toBe(true);
  });
  it('searches bounded message trace pages, loads detail, and labels partial CSV coverage', async () => {
    const now = new Date(Date.now() - 60000).toISOString();
    const first = { messageTraceId: '66666666-6666-4666-8666-666666666666', received: now, sender: 'sender@example.com', recipient: 'recipient@example.com', subject: 'Test', status: 'Delivered' };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: false });
      if (path === '/microsoft/resources/users') return emptyResource();
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'trace.search') return Response.json({ rows: body.cursor ? [] : [first], next: body.cursor ? null : { received: first.received, recipient: first.recipient }, partial: !body.cursor, checkedAt: now });
        if (body.type === 'trace.detail') return Response.json({ messageTraceId: first.messageTraceId, recipient: first.recipient, events: [{ date: now, event: 'DELIVER', detail: 'Delivered' }], partial: false });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush();
    const root = page.shadowRoot!; root.querySelector<HTMLButtonElement>('#trace-open')!.click();
    root.querySelector<HTMLFormElement>('#trace-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush();
    expect(root.textContent).toContain('more pages available');
    expect(root.textContent).toContain('CSV includes only loaded rows');
    root.querySelector<HTMLButtonElement>('[data-trace-detail="0"]')!.click(); await flush();
    expect(root.textContent).toContain('DELIVER');
    root.querySelector<HTMLButtonElement>('#trace-more')!.click(); await flush();
    const calls = request.mock.calls.filter(([path, init]) => path === '/microsoft/administration' && String(init?.body).includes('trace.search'));
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]![1]?.body)).cursor).toEqual({ received: first.received, recipient: first.recipient });
    expect(root.textContent).not.toContain('more pages available');
  });
  it('loads direct rights for a selected tenant mailbox and confirms one delegation change', async () => {
    const id = '66666666-6666-4666-8666-666666666666', delegateId = '77777777-7777-4777-8777-777777777777';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [
        { id, values: { displayName: 'Owner', userPrincipalName: 'owner@example.com' } },
        { id: delegateId, values: { displayName: 'Delegate', userPrincipalName: 'delegate@example.com' } },
      ], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ id, displayName: 'Owner' });
        if (body.type === 'user.globalAdmin.get') return Response.json({ enabled: false });
        if (body.type === 'mailbox.delegation.list') return Response.json({ mailboxId: id, entries: [{ delegateAddress: 'delegate@example.com',
          fullAccess: true, sendAs: false, sendOnBehalf: true }], partial: false, checkedAt: '2026-09-25T00:00:00Z' });
        if (body.type === 'mailbox.delegation.get') return Response.json({ mailboxId: id, delegateId,
          delegateAddress: 'delegate@example.com', fullAccess: false, sendAs: false, sendOnBehalf: false });
        if (body.type === 'mailbox.delegation.set') return Response.json({ mailboxId: id, delegateId,
          delegateAddress: 'delegate@example.com', fullAccess: body.right === 'FullAccess', sendAs: false, sendOnBehalf: false,
          accepted: true, verified: true });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, id); await flush();
    const root = page.shadowRoot!; root.querySelector<HTMLButtonElement>('#delegation-open')!.click(); await flush();
    expect(root.textContent).toContain('Current delegates');
    expect(root.querySelector('.delegation-current')?.textContent).toContain('delegate@example.com');
    expect(root.querySelector('.delegation-current')?.textContent).toContain('Send on Behalf');
    const select = root.querySelector<HTMLSelectElement>('#delegation-user')!;
    select.value = delegateId; select.dispatchEvent(new Event('change', { bubbles: true })); await flush();
    expect(root.querySelector<HTMLButtonElement>('[data-delegation-right="FullAccess"]')?.disabled).toBe(true);
    const confirm = root.querySelector<HTMLInputElement>('#delegation-confirm')!;
    confirm.checked = true; confirm.dispatchEvent(new Event('change', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-delegation-right="FullAccess"]')!.click(); await flush();
    const write = request.mock.calls.find(([path, init]) => path === '/microsoft/administration' && String(init?.body).includes('mailbox.delegation.set'));
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ type: 'mailbox.delegation.set', mailboxId: id, delegateId, right: 'FullAccess', enabled: true });
    expect(root.querySelector<HTMLButtonElement>('[data-delegation-right="FullAccess"]')?.disabled).toBe(true);
  });
  it('saves primary address and aliases independently after a mailbox read', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    let primary = 'ada@example.com'; const aliases: string[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id, values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ id, displayName: 'Ada' });
        if (body.type === 'user.globalAdmin.get') return Response.json({ enabled: false });
        if (body.type === 'mailbox.addresses.get') return Response.json({ mailboxId: id, primarySmtpAddress: primary, aliases, policyEnabled: false });
        if (body.type === 'mailbox.primary.set' || body.type === 'mailbox.alias.add' || body.type === 'mailbox.alias.remove') {
          if (body.type === 'mailbox.primary.set') primary = body.address;
          if (body.type === 'mailbox.alias.add') aliases.push(body.address);
          if (body.type === 'mailbox.alias.remove') aliases.splice(aliases.indexOf(body.address), 1);
          return Response.json({ mailboxId: id, primarySmtpAddress: primary, aliases, policyEnabled: false, accepted: true, verified: true });
        }
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, id); await flush();
    const root = page.shadowRoot!; root.querySelector<HTMLButtonElement>('#addresses-open')!.click(); await flush();
    const alias = root.querySelector<HTMLInputElement>('#addresses-alias')!;
    alias.value = 'alias@example.com'; alias.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('#addresses-alias-add')!.click(); await flush();
    expect(root.querySelector<HTMLButtonElement>('#addresses-alias-add')?.disabled).toBe(true);
    root.querySelector<HTMLButtonElement>('#addresses-refresh')!.click(); await flush();
    const input = root.querySelector<HTMLInputElement>('#addresses-primary')!;
    input.value = 'new@example.com'; input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('#addresses-primary-save')!.click(); await flush();
    const writes = request.mock.calls.filter(([path, init]) => path === '/microsoft/administration' && /mailbox\.(alias|primary)\./.test(String(init?.body)))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(writes).toEqual([
      { type: 'mailbox.alias.add', mailboxId: id, address: 'alias@example.com' },
      { type: 'mailbox.primary.set', mailboxId: id, address: 'new@example.com' },
    ]);
  });
  it('loads one internal/external reply and sends a scheduled save only for the selected mailbox', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id, values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ id, displayName: 'Ada' });
        if (body.type === 'user.globalAdmin.get') return Response.json({ enabled: false });
        if (body.type === 'mailbox.autoreply.get') return Response.json({ mailboxId: id, state: 'Disabled', internalMessage: '', externalMessage: '', externalAudience: 'All', start: null, end: null });
        if (body.type === 'mailbox.autoreply.set') return Response.json({ mailboxId: id, state: body.state, internalMessage: body.message, externalMessage: body.message, externalAudience: 'All', start: body.start, end: body.end, accepted: true, verified: true });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, id); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#autoreply-open')!.click(); await flush();
    const root = page.shadowRoot!;
    const state = root.querySelector<HTMLSelectElement>('#autoreply-state')!;
    state.value = 'Scheduled'; state.dispatchEvent(new Event('change', { bubbles: true }));
    for (const [selector, value] of [['#autoreply-start', '2026-09-24T10:00'], ['#autoreply-end', '2026-09-25T10:00'], ['#autoreply-message', 'Away']] as const) {
      const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
      input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    root.querySelector<HTMLButtonElement>('#autoreply-save')!.click(); await flush();
    const write = request.mock.calls.find(([path, init]) => path === '/microsoft/administration' && String(init?.body).includes('mailbox.autoreply.set'));
    const body = JSON.parse(String(write?.[1]?.body));
    expect(body).toMatchObject({ type: 'mailbox.autoreply.set', mailboxId: id, state: 'Scheduled', message: 'Away' });
    expect(Date.parse(body.end)).toBeGreaterThan(Date.parse(body.start));
    expect(root.querySelector<HTMLButtonElement>('#autoreply-save')?.disabled).toBe(true);
  });
  it('loads and saves forwarding for the selected mailbox, then requires a refresh', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id, values: { displayName: 'Ada', userPrincipalName: 'ada@example.com' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ id, displayName: 'Ada', userPrincipalName: 'ada@example.com' });
        if (body.type === 'user.globalAdmin.get') return Response.json({ enabled: false });
        if (body.type === 'mailbox.forwarding.get') return Response.json({ mailboxId: id, smtpAddress: null, keepCopy: true, internalRecipient: null });
        if (body.type === 'mailbox.forwarding.set') return Response.json({ mailboxId: id, smtpAddress: body.smtpAddress, keepCopy: body.keepCopy, internalRecipient: null, accepted: true, verified: true });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush();
    openUser(page, id); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#forwarding-open')!.click(); await flush();
    const input = page.shadowRoot!.querySelector<HTMLInputElement>('#forwarding-address')!;
    input.value = 'new@example.com'; input.dispatchEvent(new Event('input', { bubbles: true }));
    page.shadowRoot!.querySelector<HTMLButtonElement>('#forwarding-save')!.click(); await flush();
    const write = request.mock.calls.find(([path, init]) => path === '/microsoft/administration' && String(init?.body).includes('mailbox.forwarding.set'));
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ type: 'mailbox.forwarding.set', mailboxId: id, smtpAddress: 'new@example.com', keepCopy: true });
    expect(page.shadowRoot!.querySelector<HTMLButtonElement>('#forwarding-save')?.disabled).toBe(true);
    expect(page.shadowRoot!.textContent).toContain('saved and verified');
  });
  it('creates a Microsoft 365 group with a selected owner and shows the assigned address', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-9', values: { displayName: 'Ada', userPrincipalName: 'ada@example.test' } }], columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/groups') return emptyResource();
      if (path === '/microsoft/administration' && JSON.parse(String(init?.body)).type === 'group.create')
        return Response.json({ accepted: true, id: 'group-1', verified: true, mail: 'ops@tenant.onmicrosoft.com' });
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#create-group')!.click(); await flush();
    const root = page.shadowRoot!;
    for (const [selector, value] of [['#create-group-name', 'Ops'], ['#create-group-alias', 'ops'], ['#create-group-owner', 'user-9']] as const) {
      const input = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
      input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    root.querySelector<HTMLButtonElement>('#create-group-submit')!.click(); await flush();
    const write = request.mock.calls.find(([path, init]) => path === '/microsoft/administration' && String(init?.body).includes('group.create'));
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ type: 'group.create', group: { displayName: 'Ops', mailNickname: 'ops', ownerId: 'user-9' } });
    expect(root.textContent).toContain('ops@tenant.onmicrosoft.com');
    expect(root.textContent).toContain('Group details were verified');
  });
  it('saves only a group display-name change after a verified readback', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [{ id: 'group-1', values: { displayName: 'Old', groupKind: 'Microsoft 365 group' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/users') return emptyResource();
      if (path === '/microsoft/administration') {
        const type = JSON.parse(String(init?.body)).type;
        if (type === 'group.get') return Response.json({ id: 'group-1', displayName: 'Old', mail: 'old@example.test', groupTypes: ['Unified'], onPremisesSyncEnabled: null, isAssignableToRole: false });
        if (type === 'group.update') return Response.json({ accepted: true, changed: true, verified: true });
        if (type === 'group.settings.get') return Response.json({ groupId: 'group-1', kind: 'microsoft365', displayName: 'Old',
          primarySmtpAddress: 'old@example.test', requireSenderAuthenticationEnabled: false, emailAddressPolicyEnabled: null, aliases: [] });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-detail="group-1"]')!.click(); await flush(); await flush();
    const input = page.shadowRoot!.querySelector<HTMLInputElement>('#group-name')!;
    input.value = 'New'; input.dispatchEvent(new Event('input', { bubbles: true }));
    page.shadowRoot!.querySelector<HTMLButtonElement>('#group-name-save')!.click(); await flush();
    const write = request.mock.calls.find(([path, init]) => path === '/microsoft/administration' && String(init?.body).includes('group.update'));
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ type: 'group.update', id: 'group-1', update: { displayName: 'New' } });
    expect(page.shadowRoot!.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('saved and verified');
    await vi.waitFor(() => expect(page.shadowRoot!.querySelector('[data-testid="group-settings"]')!.textContent).toContain('old@example.test'));
    expect(page.shadowRoot!.querySelector('[data-testid="group-settings"]')!.textContent).toContain('Allowed');
  });
  it('saves a distribution-list name through the typed Exchange action', async () => {
    const groupId = '88888888-8888-4888-8888-888888888888';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [{ id: groupId, values: { displayName: 'Old list', groupKind: 'Distribution list' } }], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/users') return emptyResource();
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'group.get') return Response.json({ id: groupId, displayName: 'Old list', mail: 'old@example.test', groupTypes: [], onPremisesSyncEnabled: null, isAssignableToRole: false });
        if (body.type === 'group.people.list') return Response.json({ groupId, members: [], owners: [], complete: true, otherMemberCount: 0 });
        if (body.type === 'distribution.members.get') return Response.json({ groupId, members: [], complete: true });
        if (body.type === 'group.settings.get') return Response.json({ groupId, kind: 'distribution', displayName: 'Old list', primarySmtpAddress: 'old@example.test', requireSenderAuthenticationEnabled: true, emailAddressPolicyEnabled: false, aliases: [] });
        if (body.type === 'distribution.name.set') return Response.json({ groupId, displayName: 'New list', accepted: true, verified: true, changed: true });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>(`[data-detail="${groupId}"]`)!.click(); await flush(); await flush();
    const input = page.shadowRoot!.querySelector<HTMLInputElement>('#group-name')!;
    expect(input.value).toBe('Old list');
    expect(page.shadowRoot!.querySelector<HTMLButtonElement>('#group-name-save')!.disabled).toBe(true);
    input.value = 'New list'; input.dispatchEvent(new Event('input', { bubbles: true }));
    page.shadowRoot!.querySelector<HTMLButtonElement>('#group-name-save')!.click(); await flush();
    const writes = request.mock.calls.filter(([path, init]) => path === '/microsoft/administration' && String(init?.body).includes('name.set'));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({ type: 'distribution.name.set', groupId, displayName: 'New list' });
    expect(page.shadowRoot!.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('saved and verified');
  });
  it('waits for delayed group-name readback without submitting a second write', async () => {
    let reads = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [{ id: 'group-1', values: { displayName: 'Old', groupKind: 'Microsoft 365 group' } }], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/users') return emptyResource();
      if (path === '/microsoft/administration') {
        const type = JSON.parse(String(init?.body)).type;
        if (type === 'group.get') return Response.json({ id: 'group-1', displayName: ++reads >= 3 ? 'New' : 'Old', groupTypes: ['Unified'], onPremisesSyncEnabled: null, isAssignableToRole: false });
        if (type === 'group.update') return Response.json({ accepted: true, changed: true, verified: false });
        if (type === 'group.settings.get') return Response.json({ groupId: 'group-1', kind: 'microsoft365', displayName: 'Old',
          primarySmtpAddress: 'old@example.test', requireSenderAuthenticationEnabled: true, emailAddressPolicyEnabled: null, aliases: [] });
        if (type === 'group.people.list') return Response.json({ groupId: 'group-1', members: [], owners: [], complete: true, otherMemberCount: 0 });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-detail="group-1"]')!.click(); await flush();
    const input = page.shadowRoot!.querySelector<HTMLInputElement>('#group-name')!;
    input.value = 'New'; input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.useFakeTimers();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#group-name-save')!.click();
    await vi.waitFor(() => expect(page.shadowRoot!.textContent).toContain('Waiting for Microsoft'), { interval: 1 });
    expect(page.shadowRoot!.querySelector<HTMLButtonElement>('#group-name-save')!.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(page.shadowRoot!.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('saved and verified');
    expect(request.mock.calls.filter(([path, init]) => path === '/microsoft/administration' && String(init?.body).includes('group.update'))).toHaveLength(1);
  });
  it('requires explicit confirmation to change a group external-sender policy', async () => {
    const groupId = '88888888-8888-4888-8888-888888888888';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [{ id: groupId, values: { displayName: 'QA Group', groupKind: 'Microsoft 365 group' } }], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/users') return emptyResource();
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'group.get') return Response.json({ id: groupId, displayName: 'QA Group', groupTypes: ['Unified'], onPremisesSyncEnabled: null, isAssignableToRole: false });
        if (body.type === 'group.people.list') return Response.json({ groupId, members: [], owners: [], complete: true, otherMemberCount: 0 });
        if (body.type === 'group.settings.get') return Response.json({ groupId, kind: 'microsoft365', displayName: 'QA Group', primarySmtpAddress: 'qa@example.test', requireSenderAuthenticationEnabled: true, emailAddressPolicyEnabled: null, aliases: ['old@example.test'] });
        if (body.type === 'group.external.set') return Response.json({ groupId, allowExternalSenders: true, accepted: true, verified: true, changed: true });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>(`[data-detail="${groupId}"]`)!.click(); await flush(); await flush();
    const root = page.shadowRoot!;
    expect(root.querySelector('[data-testid="group-settings"]')!.textContent).toContain('Not allowed');
    expect(root.querySelector('[data-testid="group-settings"]')!.textContent).toContain('old@example.test');
    root.querySelector<HTMLInputElement>('#group-external-allow')!.click();
    expect(root.querySelector<HTMLButtonElement>('#group-external-save')!.disabled).toBe(true);
    expect(request.mock.calls.some(([, init]) => String(init?.body).includes('group.external.set'))).toBe(false);
    root.querySelector<HTMLInputElement>('#group-external-confirm')!.click();
    root.querySelector<HTMLButtonElement>('#group-external-save')!.click(); await flush();
    expect(request.mock.calls.filter(([, init]) => String(init?.body).includes('group.external.set'))).toHaveLength(1);
    expect(root.querySelector('[data-testid="group-settings"]')!.textContent).toContain('Allowed');
    expect(root.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('saved and verified');
  });
  it('confirms primary-address changes and keeps the previous address visible', async () => {
    const groupId = '88888888-8888-4888-8888-888888888888';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [{ id: groupId, values: { displayName: 'QA', groupKind: 'Distribution list' } }], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/users') return emptyResource();
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'distribution.members.get') return Response.json({ groupId, members: [], complete: true });
        if (body.type === 'group.settings.get') return Response.json({ groupId, kind: 'distribution', displayName: 'QA', primarySmtpAddress: 'qa@example.test', requireSenderAuthenticationEnabled: true, emailAddressPolicyEnabled: false, aliases: [] });
        if (body.type === 'group.primary.set') return Response.json({ groupId, primarySmtpAddress: 'new@example.test', accepted: true, verified: true, changed: true });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>(`[data-detail="${groupId}"]`)!.click(); await flush(); await flush();
    const root = page.shadowRoot!;
    const input = root.querySelector<HTMLInputElement>('#group-primary-address')!;
    input.value = 'new@example.test'; input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelector<HTMLButtonElement>('#group-primary-save')!.disabled).toBe(true);
    expect(request.mock.calls.some(([, init]) => String(init?.body).includes('group.primary.set'))).toBe(false);
    root.querySelector<HTMLInputElement>('#group-primary-confirm')!.click();
    root.querySelector<HTMLButtonElement>('#group-primary-save')!.click(); await flush();
    expect(request.mock.calls.filter(([, init]) => String(init?.body).includes('group.primary.set'))).toHaveLength(1);
    expect(root.querySelector('[data-testid="group-settings"]')!.textContent).toContain('qa@example.test');
    expect(root.querySelector('[data-testid="group-settings"]')!.textContent).toContain('new@example.test');
    expect(root.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('saved and verified');
  });
  it('shows service health to readers and preserves stale detail on refresh error', async () => {
    let healthCalls = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => path === '/microsoft/connection'
      ? Response.json({ available: true, connected: true, enabled: true, canManage: false, tenantName: 'Contoso' })
      : path === '/microsoft/administration' && String(init?.body).includes('mailbox.inventory')
        ? Response.json({ records: [], partial: false, collectedAt: '2026-09-22T12:00:00Z' })
      : path === '/microsoft/administration' && init?.method === 'POST'
        ? ++healthCalls === 1
          ? Response.json({ services: [{ id: 'Exchange Online', service: 'Exchange Online', status: 'serviceDegradation', issues: [{ id: 'EX123', title: 'Mail delay', impactDescription: 'Some mail is delayed' }] }], partial: false, checkedAt: '2026-09-22T12:00:00Z' })
          : Response.json({ error: 'provider_access_denied' }, { status: 403 })
        : emptyResource());
    const page = mount(request);
    await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#health-open')!.click();
    await flush();
    expect(page.shadowRoot!.textContent).toContain('Some services have issues');
    expect(page.shadowRoot!.textContent).toContain('Mail delay');
    page.shadowRoot!.querySelector<HTMLButtonElement>('#health-refresh')!.click();
    await flush();
    expect(page.shadowRoot!.textContent).toContain('Refresh failed');
    expect(page.shadowRoot!.textContent).toContain('ServiceHealth.Read.All');
    expect(page.shadowRoot!.textContent).toContain('Mail delay');
  });
  it('does not present a partial or empty service-health response as healthy', async () => {
    const page = mount(async path => path === '/microsoft/connection'
      ? Response.json({ available: true, connected: true, enabled: true, canManage: false })
      : path === '/microsoft/administration'
        ? Response.json({ services: [], partial: true, checkedAt: '2026-09-22T12:00:00Z' }) : emptyResource());
    await flush(); page.shadowRoot!.querySelector<HTMLButtonElement>('#health-open')!.click(); await flush();
    expect(page.shadowRoot!.textContent).toContain('Status unavailable');
    expect(page.shadowRoot!.textContent).not.toContain('No known service issues');
  });
  it('discards old-organization service health and disables it for a disconnected organization', async () => {
    let resolveOld!: (response: Response) => void;
    let connections = 0;
    const page = mount(async path => path === '/microsoft/connection'
      ? Response.json({ available: true, connected: ++connections === 1, enabled: true, canManage: false })
      : path === '/microsoft/administration'
        ? new Promise<Response>(resolve => { resolveOld = resolve; }) : emptyResource());
    await flush(); page.shadowRoot!.querySelector<HTMLButtonElement>('#health-open')!.click();
    page.context = { contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/microsoft', organizationId: 'org-b' };
    resolveOld(Response.json({ services: [{ id: 'private', service: 'Old tenant private service', status: 'serviceInterruption' }], partial: false, checkedAt: '2026-09-22T12:00:00Z' }));
    await flush();
    expect(page.shadowRoot!.textContent).not.toContain('Old tenant private service');
    expect(page.shadowRoot!.querySelector<HTMLButtonElement>('#health-open')?.disabled).toBe(true);
  });
  it('uses sidebar navigation and omits redundant connected setup and routine success text', async () => {
    const request = vi.fn(async (path: string) => path === '/microsoft/connection'
      ? Response.json({ available: true, connected: true, enabled: true, canManage: true, tenantName: 'Contoso' })
      : emptyResource());
    const page = mount(request);
    await flush(); await flush();
    expect(page.shadowRoot!.querySelector('[aria-label="Cloud Command providers"]')).toBeNull();
    expect(page.shadowRoot!.querySelector('#setup-integrations')).toBeNull();
    expect(page.shadowRoot!.textContent).not.toContain('Microsoft connection');
    expect(page.shadowRoot!.textContent).not.toContain('Users loaded.');
    expect(request.mock.calls.some(([path]) => path === '/threecx/connection')).toBe(false);
  });

  it('shows unavailable and read-only connection states honestly', async () => {
    const unavailable = mount(async () =>
      Response.json({ available: false, connected: false, canManage: false, reason: 'Not installed' }),
    );
    await flush();
    expect(unavailable.shadowRoot!.querySelector('.badge')!.textContent).toBe('Unavailable');
    expect(unavailable.shadowRoot!.textContent).toContain('Not installed');
    document.body.replaceChildren();
    const reader = mount(async (path) =>
      path.startsWith('/microsoft/resources/')
        ? emptyResource()
        : Response.json({
            available: true,
            connected: true,
            canManage: false,
            enabled: true,
            tenantName: 'Contoso',
          }),
    );
    await flush();
    expect(reader.shadowRoot!.querySelector('#bind')).toBeNull();
    expect(reader.shadowRoot!.textContent).toContain('Contoso');
  });

  it('ignores a late response after the organization context changes', async () => {
    let resolveOld!: (response: Response) => void;
    let calls = 0;
    const page = mount((path) => {
      if (path !== '/microsoft/connection') return Promise.resolve(Response.json({}));
      calls += 1;
      return calls === 1
        ? new Promise<Response>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(Response.json({ available: true, connected: false, canManage: false }));
    });
    await flush();
    page.context = {
      contractVersion: 1,
      extensionName: 'cloudcommand',
      path: '/extensions/cloudcommand/microsoft',
      organizationId: 'org-b',
    };
    resolveOld(Response.json({ available: false, connected: false, canManage: false, reason: 'old org' }));
    await flush();
    expect(page.shadowRoot!.textContent).not.toContain('old org');
  });

  it('shows native setup without discovering tenants or sending a binding mutation', async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ available: true, connected: false, enabled: false, canManage: true, status: 'pending-consent', reason: 'Admin consent is pending.' }));
    const page = mount(request);
    await flush();
    await flush();
    expect(page.shadowRoot!.textContent).toContain('Admin consent is pending.');
    expect(page.shadowRoot!.textContent).toContain('Connect Microsoft 365 in Extensions > Connect');
    expect(page.shadowRoot!.querySelector('#setup-integrations')).toBeNull();
    expect(page.shadowRoot!.querySelector('#tenant')).toBeNull();
    expect(page.shadowRoot!.querySelector('#bind')).toBeNull();
    expect(request.mock.calls.every(([path, init]) => path !== '/microsoft/tenants' && !init?.method)).toBe(true);
  });

  it('discards an old organization resource after switching organizations', async () => {
    let resolveOld!: (response: Response) => void;
    let calls = 0;
    const page = mount(async path => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: ++calls === 1, enabled: true, canManage: false });
      if (path === '/microsoft/resources/users') return new Promise<Response>(resolve => { resolveOld = resolve; });
      return Response.json({ connected: false });
    });
    await flush();
    page.context = { contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/microsoft', organizationId: 'org-b' };
    resolveOld(Response.json({ items: [{ id: 'old', values: { displayName: 'Old tenant secret row' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' }));
    await flush();
    expect(page.shadowRoot!.textContent).not.toContain('Old tenant secret row');
  });

  it('keeps only the latest rapid resource response and preserves filter focus', async () => {
    let users!: (response: Response) => void;
    let groups!: (response: Response) => void;
    const page = mount((path) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection')
        return Promise.resolve(
          Response.json({ available: true, connected: true, canManage: false, enabled: true }),
        );
      if (path === '/microsoft/resources/users')
        return new Promise<Response>((resolve) => {
          users = resolve;
        });
      if (path === '/microsoft/resources/groups')
        return new Promise<Response>((resolve) => {
          groups = resolve;
        });
      return Promise.resolve(emptyResource());
    });
    await flush();
    window.location.hash = 'groups';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flush();
    users(
      Response.json({
        items: [{ id: 'u', values: { name: 'old user' } }],
        columns: [{ key: 'name', label: 'Name' }],
        complete: true,
        checkedAt: 'old',
      }),
    );
    groups(
      Response.json({
        items: [{ id: 'g', values: { name: 'new group' } }],
        columns: [{ key: 'name', label: 'Name' }],
        complete: true,
        checkedAt: 'new',
      }),
    );
    await flush();
    await flush();
    const root = page.shadowRoot!;
    expect(root.textContent).toContain('new group');
    expect(root.textContent).not.toContain('old user');
    const filter = root.querySelector<HTMLInputElement>('#filter')!;
    filter.value = 'new';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(root.activeElement).toBe(root.querySelector('#filter'));
  });

  it('shows a visible error for a malformed successful resource response', async () => {
    const page = mount(async (path) =>
      path === '/microsoft/directory/snapshot'
        ? Promise.resolve(new Response(null, { status: 404 }))
        : path.startsWith('/microsoft/resources/')
        ? Response.json({ items: {} })
        : Response.json({ available: true, connected: true, canManage: false, enabled: true }),
    );
    await flush();
    await flush();
    expect(page.shadowRoot!.querySelector('[data-testid="status"]')!.textContent).toContain(
      'Invalid Microsoft resource response.',
    );
  });

  it('waits for delayed Graph propagation before reporting an update verified', async () => {
    const user = { id: 'user-1', displayName: 'Ada Lovelace', givenName: 'Ada', surname: 'Lovelace', department: 'Engineering', jobTitle: 'Analyst', officeLocation: 'London', accountEnabled: true };
    let gets = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada Lovelace' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ ...user, displayName: gets++ >= 7 ? 'Ada Byron' : user.displayName });
        if (body.type === 'user.update') return Response.json({ accepted: true });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush();
    openUser(page, 'user-1'); await flush();
    editUserField(page, 'displayName', 'Ada Byron');
    vi.useFakeTimers();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-user-save="displayName"]')!.click(); await vi.runAllTimersAsync();
    const update = request.mock.calls.map(([, init]) => init?.body).find(body => String(body).includes('user.update'));
    expect(JSON.parse(String(update))).toEqual({ type: 'user.update', id: 'user-1', update: { displayName: 'Ada Byron' } });
    expect(request.mock.calls.filter(([, init]) => String(init?.body).includes('user.update'))).toHaveLength(1);
    expect(request.mock.calls.filter(([, init]) => String(init?.body).includes('user.get'))).toHaveLength(8);
    expect(page.shadowRoot!.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('saved and verified');
    expect(page.shadowRoot!.querySelector('table')!.textContent).toContain('Ada Byron');
  });

  it('blocks sign-in through a confirmed, field-scoped update and verifies readback', async () => {
    let enabled = true;
    const user = { id: 'user-1', displayName: 'Ada', givenName: '', surname: '', department: '', jobTitle: '', officeLocation: '' };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada', userPrincipalName: 'ada@example.test', accountEnabled: enabled } }], columns: [{ key: 'displayName', label: 'User' }, { key: 'userPrincipalName', label: 'Sign-in name' }, { key: 'accountEnabled', label: 'Account state' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ ...user, accountEnabled: enabled });
        if (body.type === 'user.update') { enabled = body.update.accountEnabled; return Response.json({ accepted: true }); }
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-expand="user-1"]')!.click();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-row-security="block-sign-in"]')!.click(); await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLInputElement>('#user-security-confirm')!.click();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#user-security-submit')!.click(); await flush(); await flush(); await flush();
    const update = request.mock.calls.map(([, init]) => init?.body).find(body => String(body).includes('user.update'));
    expect(JSON.parse(String(update))).toEqual({ type: 'user.update', id: 'user-1', update: { accountEnabled: false } });
    expect(page.shadowRoot!.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('Sign-in blocked and verified');
  });

  it('saves only the MSP-relevant account name field and omits generic profile fields', async () => {
    const user = { id: 'user-1', displayName: 'Ada', givenName: '', surname: '', department: 'Research', jobTitle: '', officeLocation: '', accountEnabled: true };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: user.displayName } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ ...user });
        if (body.type === 'user.update') { Object.assign(user, body.update); return Response.json({ accepted: true }); }
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, 'user-1'); await flush();
    editUserField(page, 'displayName', 'Ada Byron');
    const root = page.shadowRoot!;
    expect(root.querySelector('#user-department')).toBeNull();
    expect(root.querySelector('#user-jobTitle')).toBeNull();
    expect(root.querySelector('#user-officeLocation')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-user-save="displayName"]')!.click(); await flush(); await flush();
    const updates = request.mock.calls.map(([, init]) => init?.body).filter(body => String(body).includes('user.update'))
      .map(body => JSON.parse(String(body)).update);
    expect(updates).toEqual([{ displayName: 'Ada Byron' }]);
    const finalUpdates = request.mock.calls.map(([, init]) => init?.body).filter(body => String(body).includes('user.update'))
      .map(body => JSON.parse(String(body)).update);
    expect(finalUpdates).toEqual([{ displayName: 'Ada Byron' }]);
  });

  it('reports an uncertain result after bounded readback retries without repeating the mutation', async () => {
    let verifyReads = 0;
    let mutationAccepted = false;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const type = JSON.parse(String(init?.body)).type;
        if (type === 'user.get') { if (mutationAccepted) verifyReads++; return Response.json({ displayName: 'Ada', givenName: '', surname: '', department: '', jobTitle: '', officeLocation: '', accountEnabled: true }); }
        if (type === 'user.update') { mutationAccepted = true; return Response.json({ accepted: true }); }
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, 'user-1'); await flush();
    vi.useFakeTimers();
    editUserField(page, 'displayName', 'Changed'); page.shadowRoot!.querySelector<HTMLButtonElement>('[data-user-save="displayName"]')!.click(); await vi.runAllTimersAsync();
    expect(page.shadowRoot!.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('did not confirm');
    expect(request.mock.calls.filter(([, init]) => String(init?.body).includes('user.update'))).toHaveLength(1);
    expect(verifyReads).toBe(15);
  });

  it('abandons a pending user verification after an organization change without issuing another mutation', async () => {
    let verify!: (response: Response) => void;
    let gets = 0;
    const request = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Promise.resolve(Response.json({ available: true, connected: true, enabled: true, canManage: true }));
      if (path === '/threecx/connection') return Promise.resolve(Response.json({ connected: false }));
      if (path === '/microsoft/resources/users') return Promise.resolve(Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' }));
      if (path === '/microsoft/administration') {
        const type = JSON.parse(String(init?.body)).type;
        if (type === 'user.get' && gets++ === 0) return Promise.resolve(Response.json({ displayName: 'Ada', givenName: '', surname: '', department: '', jobTitle: '', officeLocation: '', accountEnabled: true }));
        if (type === 'user.get') return new Promise<Response>(resolve => { verify = resolve; });
        if (type === 'user.update') return Promise.resolve(Response.json({ accepted: true }));
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, 'user-1'); await flush();
    editUserField(page, 'displayName', 'Changed'); page.shadowRoot!.querySelector<HTMLButtonElement>('[data-user-save="displayName"]')!.click(); await flush();
    page.context = { contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/microsoft', organizationId: 'org-b' };
    verify(Response.json({ displayName: 'Changed', givenName: '', surname: '', department: '', jobTitle: '', officeLocation: '', accountEnabled: true })); await flush();
    expect(request.mock.calls.filter(([, init]) => String(init?.body).includes('user.update'))).toHaveLength(1);
    expect(page.shadowRoot!.textContent).not.toContain('saved and verified');
  });

  it('cancels a closed drawer verification and lets a reopened drawer start usable', async () => {
    let verify!: (response: Response) => void;
    let gets = 0;
    const request = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Promise.resolve(Response.json({ available: true, connected: true, enabled: true, canManage: true }));
      if (path === '/threecx/connection') return Promise.resolve(Response.json({ connected: false }));
      if (path === '/microsoft/resources/users') return Promise.resolve(Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' }));
      if (path === '/microsoft/administration') {
        const type = JSON.parse(String(init?.body)).type;
        if (type === 'user.get' && gets++ === 0) return Promise.resolve(Response.json({ displayName: 'Ada', givenName: '', surname: '', department: '', jobTitle: '', officeLocation: '', accountEnabled: true }));
        if (type === 'user.get' && gets === 2) return new Promise<Response>(resolve => { verify = resolve; });
        if (type === 'user.get') return Promise.resolve(Response.json({ displayName: 'Ada', givenName: '', surname: '', department: '', jobTitle: '', officeLocation: '', accountEnabled: true }));
        if (type === 'user.update') return Promise.resolve(Response.json({ accepted: true }));
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush();
    openUser(page, 'user-1'); await flush();
    editUserField(page, 'displayName', 'Changed'); page.shadowRoot!.querySelector<HTMLButtonElement>('[data-user-save="displayName"]')!.click(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#detail-close')!.click();
    openUser(page, 'user-1'); await flush();
    expect(page.shadowRoot!.querySelector<HTMLButtonElement>('[data-user-save="displayName"]')!.disabled).toBe(true);
    verify(Response.json({ displayName: 'Changed', givenName: '', surname: '', department: '', jobTitle: '', officeLocation: '', accountEnabled: true })); await flush();
    expect(request.mock.calls.filter(([, init]) => String(init?.body).includes('user.update'))).toHaveLength(1);
    expect(page.shadowRoot!.textContent).not.toContain('saved and verified');
  });

  it('saves Global Administrator independently after explicit confirmation and verified readback', async () => {
    let globalAdmin = false;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ id: 'user-1', displayName: 'Ada', accountEnabled: true });
        if (body.type === 'user.globalAdmin.get') return Response.json({ enabled: globalAdmin });
        if (body.type === 'user.globalAdmin.set') { globalAdmin = body.enabled; return Response.json({ accepted: true, changed: true, enabled: globalAdmin }); }
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, 'user-1'); await flush(); await flush();
    const root = page.shadowRoot!;
    const enabled = root.querySelector<HTMLInputElement>('#global-admin-enabled')!;
    expect(enabled.checked).toBe(false);
    enabled.click();
    root.querySelector<HTMLButtonElement>('#global-admin-save')!.click(); await flush();
    expect(request.mock.calls.some(([, init]) => String(init?.body).includes('user.globalAdmin.set'))).toBe(false);
    const confirmation = root.querySelector<HTMLInputElement>('#global-admin-confirmation')!;
    confirmation.value = 'GLOBAL_ADMIN'; confirmation.dispatchEvent(new Event('input'));
    root.querySelector<HTMLButtonElement>('#global-admin-save')!.click(); await flush(); await flush();
    const writes = request.mock.calls.map(([, init]) => init?.body).filter(body => String(body).includes('user.globalAdmin.set'));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]))).toEqual({ type: 'user.globalAdmin.set', id: 'user-1', enabled: true, confirmation: 'GLOBAL_ADMIN' });
    expect(request.mock.calls.filter(([, init]) => String(init?.body).includes('user.globalAdmin.get'))).toHaveLength(2);
    expect(root.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('enabled and verified');
  });

  it('does not infer Global Administrator status when its independent read fails', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const type = JSON.parse(String(init?.body)).type;
        if (type === 'user.get') return Response.json({ id: 'user-1', displayName: 'Ada', accountEnabled: true });
        if (type === 'user.globalAdmin.get') return new Response(JSON.stringify({ error: 'Role lookup denied' }), { status: 403 });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, 'user-1'); await flush(); await flush();
    const root = page.shadowRoot!;
    expect(root.querySelector('#global-admin-enabled')).toBeNull();
    expect(root.querySelector('[data-testid="global-admin-status"]')!.textContent).toContain('unavailable');
    expect(root.querySelector<HTMLInputElement>('#user-displayName')?.disabled).toBe(false);
  });

  it('shows sanitized MFA methods and removes one only after confirmation and readback', async () => {
    let methods = [
      { id: 'method-phone', type: 'phone', detail: 'mobile ending 4567', removable: true },
      { id: 'method-authenticator', type: 'microsoftAuthenticator', detail: 'Microsoft Authenticator', removable: false },
      { type: 'fido2', removable: false },
      { type: 'password', removable: false },
    ];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ id: 'user-1', displayName: 'Ada', accountEnabled: true });
        if (body.type === 'user.globalAdmin.get') return Response.json({ enabled: false });
        if (body.type === 'user.mfa.methods.list') return Response.json({ items: methods });
        if (body.type === 'user.mfa.method.remove') { methods = methods.filter(method => method.id !== body.methodId); return Response.json({ accepted: true }); }
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush();
    const root = page.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-expand="user-1"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-mfa="user-1"]')!.click(); await flush(); await flush();
    expect(root.textContent).toContain('mobile ending 4567');
    expect(root.textContent).toContain('Microsoft Authenticator');
    expect(root.textContent).toContain('Security key');
    expect(root.textContent).toContain('Password');
    expect(root.textContent).toContain('Re-registration and per-user MFA state are unavailable');
    root.querySelector<HTMLButtonElement>('[data-mfa-remove="method-phone"]')!.click();
    root.querySelector<HTMLButtonElement>('#mfa-removal-submit')!.click(); await flush();
    expect(request.mock.calls.some(([, init]) => String(init?.body).includes('user.mfa.method.remove'))).toBe(false);
    const confirmation = root.querySelector<HTMLInputElement>('#mfa-removal-confirmation')!;
    confirmation.value = 'REMOVE_AUTH_METHOD'; confirmation.dispatchEvent(new Event('input'));
    root.querySelector<HTMLButtonElement>('#mfa-removal-submit')!.click(); await flush(); await flush();
    const write = request.mock.calls.map(([, init]) => init?.body).find(body => String(body).includes('user.mfa.method.remove'));
    expect(JSON.parse(String(write))).toEqual({ type: 'user.mfa.method.remove', id: 'user-1', kind: 'phone', methodId: 'method-phone', confirmation: 'REMOVE_AUTH_METHOD' });
    expect(request.mock.calls.filter(([, init]) => String(init?.body).includes('user.mfa.methods.list'))).toHaveLength(2);
    expect(root.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('removed and verified');
    expect(root.textContent).not.toContain('method-phone');
  });

  it('confirms recovery email, reports a pending readback, and requires refresh before another change', async () => {
    let currentEmail = '';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ id: 'user-1', displayName: 'Ada', accountEnabled: true });
        if (body.type === 'user.globalAdmin.get') return Response.json({ enabled: false });
        if (body.type === 'user.mfa.methods.list') return Response.json({ items: currentEmail ? [{ type: 'email', detail: currentEmail, removable: false }] : [] });
        if (body.type === 'user.mfa.recoveryEmail.set') { currentEmail = body.emailAddress; return Response.json({ accepted: true, verified: false }); }
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush();
    const root = page.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-expand="user-1"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-mfa="user-1"]')!.click(); await flush(); await flush();
    const email = root.querySelector<HTMLInputElement>('#mfa-recovery-email')!;
    email.value = 'qa@example.net'; email.dispatchEvent(new Event('input'));
    root.querySelector<HTMLButtonElement>('#mfa-recovery-save')!.click(); await flush();
    expect(request.mock.calls.some(([, init]) => String(init?.body).includes('user.mfa.recoveryEmail.set'))).toBe(false);
    root.querySelector<HTMLInputElement>('#mfa-recovery-confirm')!.click();
    root.querySelector<HTMLButtonElement>('#mfa-recovery-save')!.click(); await flush(); await flush();
    const write = request.mock.calls.map(([, init]) => init?.body).find(body => String(body).includes('user.mfa.recoveryEmail.set'));
    expect(JSON.parse(String(write))).toEqual({ type: 'user.mfa.recoveryEmail.set', id: 'user-1', emailAddress: 'qa@example.net', confirmation: 'SET_RECOVERY_EMAIL' });
    expect(root.textContent).toContain('readback is pending');
    expect(root.querySelector<HTMLInputElement>('#mfa-recovery-email')?.disabled).toBe(true);
    root.querySelector<HTMLButtonElement>('#mfa-methods-refresh')!.click(); await flush(); await flush();
    expect(root.textContent).toContain('Current: qa@example.net');
  });

  it('confirms the mobile phone, keeps it masked, and requires method refresh before another write', async () => {
    let mobile = '';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ id: 'user-1', displayName: 'Ada', accountEnabled: true });
        if (body.type === 'user.globalAdmin.get') return Response.json({ enabled: false });
        if (body.type === 'user.mfa.methods.list') return Response.json({ items: mobile ? [{ id: 'method-phone', type: 'phone', detail: 'mobile ending 1234', removable: true }] : [] });
        if (body.type === 'user.mfa.mobilePhone.set') { mobile = body.phoneNumber; return Response.json({ accepted: true, verified: true }); }
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush();
    const root = page.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-expand="user-1"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-mfa="user-1"]')!.click(); await flush(); await flush();
    const phone = root.querySelector<HTMLInputElement>('#mfa-mobile-phone')!;
    phone.value = '+1 5555551234'; phone.dispatchEvent(new Event('input'));
    root.querySelector<HTMLButtonElement>('#mfa-mobile-save')!.click(); await flush();
    expect(request.mock.calls.some(([, init]) => String(init?.body).includes('user.mfa.mobilePhone.set'))).toBe(false);
    root.querySelector<HTMLInputElement>('#mfa-mobile-confirm')!.click();
    root.querySelector<HTMLButtonElement>('#mfa-mobile-save')!.click(); await flush(); await flush();
    const write = request.mock.calls.map(([, init]) => init?.body).find(body => String(body).includes('user.mfa.mobilePhone.set'));
    expect(JSON.parse(String(write))).toEqual({ type: 'user.mfa.mobilePhone.set', id: 'user-1', phoneNumber: '+1 5555551234', confirmation: 'SET_MOBILE_PHONE' });
    expect(root.querySelector<HTMLInputElement>('#mfa-mobile-phone')?.disabled).toBe(true);
    root.querySelector<HTMLButtonElement>('#mfa-methods-refresh')!.click(); await flush(); await flush();
    expect(root.textContent).toContain('mobile ending 1234');
  });

  it('requires explicit confirmation before sending a bounded group membership change', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-9', values: { displayName: 'Ada Lovelace', userPrincipalName: 'ada@example.test' } }], columns: [{ key: 'displayName', label: 'User' }, { key: 'userPrincipalName', label: 'Sign-in name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [{ id: 'group-1', values: { displayName: 'Operators' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const type = JSON.parse(String(init?.body)).type;
        if (type === 'group.get') return Response.json({ displayName: 'Operators', groupTypes: ['Unified'], onPremisesSyncEnabled: false, isAssignableToRole: false });
        if (type === 'group.member.remove') return Response.json({ accepted: true, changed: true, verified: false });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-detail="group-1"]')!.click(); await flush(); await flush();
    const root = page.shadowRoot!;
    expect(root.querySelector('#group-member-user-id')).toBeNull();
    expect(root.textContent).toContain('Ada Lovelace');
    root.querySelector<HTMLInputElement>('#group-member-search')!.value = 'ada'; root.querySelector<HTMLInputElement>('#group-member-search')!.dispatchEvent(new Event('input'));
    await flush(); root.querySelector<HTMLButtonElement>('[data-member-user="user-9"]')!.click();
    (root.querySelector<HTMLSelectElement>('#group-member-action')!).value = 'remove';
    root.querySelector<HTMLButtonElement>('#group-member-submit')!.click(); await flush();
    expect(request.mock.calls.some(([, init]) => String(init?.body).includes('group.member.remove'))).toBe(false);
    root.querySelector<HTMLInputElement>('#group-member-confirm')!.checked = true; root.querySelector<HTMLButtonElement>('#group-member-submit')!.click(); await flush();
    const mutation = request.mock.calls.map(([, init]) => init?.body).find(body => String(body).includes('group.member.remove'));
    expect(JSON.parse(String(mutation))).toEqual({ type: 'group.member.remove', groupId: 'group-1', userId: 'user-9' });
    expect(page.shadowRoot!.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('readback did not confirm');
  });

  it('shows current group members and owners from a read-only typed request and refreshes without a write', async () => {
    const groupId = '88888888-8888-4888-8888-888888888888';
    let reads = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: false });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [{ id: groupId, values: { displayName: 'QA Group', groupKind: 'Microsoft 365 group' } }], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'group.get') return Response.json({ id: groupId, displayName: 'QA Group', groupTypes: ['Unified'], mailEnabled: true, securityEnabled: false, onPremisesSyncEnabled: null });
        if (body.type === 'group.people.list') { reads += 1; return Response.json({ groupId, complete: true, otherMemberCount: 0,
          members: [{ id: 'user-1', displayName: reads === 1 ? 'Ada Lovelace' : 'Ada Byron', userPrincipalName: 'ada@example.test' }],
          owners: [{ id: 'user-2', displayName: 'Owner', userPrincipalName: 'owner@example.test' }] }); }
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>(`[data-detail="${groupId}"]`)!.click(); await flush(); await flush();
    const root = page.shadowRoot!;
    expect(root.querySelector('[data-testid="current-group-people"]')!.textContent).toContain('Ada Lovelace');
    expect(root.querySelector('[data-testid="current-group-people"]')!.textContent).toContain('owner@example.test');
    root.querySelector<HTMLButtonElement>('#group-people-refresh')!.click(); await flush(); await flush();
    expect(root.querySelector('[data-testid="current-group-people"]')!.textContent).toContain('Ada Byron');
    expect(reads).toBe(2);
    expect(request.mock.calls.filter(([path, init]) => path === '/microsoft/administration'
      && String(init?.body).includes('group.') && !['group.get', 'group.people.list', 'group.settings.get'].includes(JSON.parse(String(init?.body)).type))).toHaveLength(0);
  });

  it('routes a distribution-list member change through the typed Exchange action', async () => {
    const groupId = '11111111-1111-4111-8111-111111111111';
    const memberId = '22222222-2222-4222-8222-222222222222';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: memberId, values: { displayName: 'Ada Lovelace', userPrincipalName: 'ada@example.test' } }], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [{ id: groupId, values: { displayName: 'Dispatch', mail: 'dispatch@example.test', groupKind: 'Distribution list' } }], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration' && JSON.parse(String(init?.body)).type === 'group.settings.get')
        return Response.json({ groupId, kind: 'distribution', displayName: 'Dispatch', primarySmtpAddress: 'dispatch@example.test', requireSenderAuthenticationEnabled: true, emailAddressPolicyEnabled: false, aliases: [] });
      if (path === '/microsoft/administration' && JSON.parse(String(init?.body)).type === 'distribution.members.get')
        return Response.json({ groupId, members: [{ id: memberId, displayName: 'Ada Lovelace', primarySmtpAddress: 'ada@example.test' }], complete: true });
      if (path === '/microsoft/administration' && JSON.parse(String(init?.body)).type === 'distribution.member.set')
        return Response.json({ accepted: true, changed: true, verified: true });
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush();
    window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush(); await flush();
    const root = page.shadowRoot!;
    root.querySelector<HTMLButtonElement>(`[data-detail="${groupId}"]`)!.click(); await flush(); await flush();
    expect(root.querySelector('[data-testid="current-group-people"]')!.textContent).toContain('ada@example.test');
    expect(root.querySelector('[data-testid="current-group-people"]')!.textContent).not.toContain('Owners');
    expect(root.querySelector('[data-testid="group-settings"]')!.textContent).toContain('Not allowed');
    expect(root.querySelector('#group-member-role')).toBeNull();
    expect(request.mock.calls.some(([, init]) => String(init?.body).includes('group.get'))).toBe(false);
    root.querySelector<HTMLButtonElement>(`[data-member-user="${memberId}"]`)!.click();
    root.querySelector<HTMLButtonElement>('#group-member-submit')!.click(); await flush();
    expect(request.mock.calls.some(([, init]) => String(init?.body).includes('distribution.member.set'))).toBe(false);
    root.querySelector<HTMLInputElement>('#group-member-confirm')!.checked = true;
    root.querySelector<HTMLButtonElement>('#group-member-submit')!.click(); await flush();
    const mutation = request.mock.calls.map(([, init]) => init?.body).find(body => String(body).includes('distribution.member.set'));
    expect(JSON.parse(String(mutation))).toEqual({ type: 'distribution.member.set', groupId, memberId, enabled: true });
    expect(root.textContent).toContain('Group assignment accepted and verified.');
  });

  it('shows distribution-list details to a read-only user without a Graph group lookup', async () => {
    const groupId = '11111111-1111-4111-8111-111111111111';
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: false });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [{ id: groupId, values: { displayName: 'Dispatch', mail: 'dispatch@example.test', groupKind: 'Distribution list' } }], columns: [], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/users') return Response.json({ items: [], columns: [], complete: true, checkedAt: 'now' });
      throw new Error(`Unexpected ${path} ${String(init?.body ?? '')}`);
    });
    const page = mount(request); await flush();
    window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush(); await flush();
    const root = page.shadowRoot!;
    root.querySelector<HTMLButtonElement>(`[data-detail="${groupId}"]`)!.click(); await flush();
    expect(root.textContent).toContain('dispatch@example.test');
    expect(root.querySelector('#group-member-submit')).toBeNull();
    expect(request.mock.calls.some(([, init]) => String(init?.body).includes('group.get'))).toBe(false);
  });

  it('does not offer group assignments from a partial user directory', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [{ id: 'group-1', values: { displayName: 'Operators', groupKind: 'Microsoft 365 group' } }], columns: [{ key: 'displayName', label: 'Group' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-9', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'User' }], complete: false, checkedAt: 'now' });
      if (path === '/microsoft/administration' && JSON.parse(String(init?.body)).type === 'group.get') return Response.json({ displayName: 'Operators', groupTypes: ['Unified'], onPremisesSyncEnabled: false, isAssignableToRole: false });
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush();
    window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-detail="group-1"]')!.click(); await flush(); await flush();
    expect(page.shadowRoot!.querySelector('[data-member-user]')).toBeNull();
    expect(page.shadowRoot!.querySelector<HTMLButtonElement>('#group-member-submit')?.disabled).toBe(true);
    expect(page.shadowRoot!.textContent).toContain('User directory is incomplete');
  });

  it('submits an owner change through the typed operation after confirmation', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-9', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/resources/groups') return Response.json({ items: [{ id: 'group-1', values: { displayName: 'Operators' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const type = JSON.parse(String(init?.body)).type;
        if (type === 'group.get') return Response.json({ displayName: 'Operators', groupTypes: ['Unified'], onPremisesSyncEnabled: false, isAssignableToRole: false });
        if (type === 'group.owner.add') return Response.json({ accepted: true, changed: true, verified: true });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush(); await flush();
    const root = page.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-detail="group-1"]')!.click(); await flush(); await flush();
    root.querySelector<HTMLButtonElement>('[data-member-user="user-9"]')!.click();
    root.querySelector<HTMLSelectElement>('#group-member-role')!.value = 'owner';
    root.querySelector<HTMLInputElement>('#group-member-confirm')!.checked = true;
    root.querySelector<HTMLButtonElement>('#group-member-submit')!.click(); await flush();
    const mutation = request.mock.calls.map(([, init]) => init?.body).find(body => String(body).includes('group.owner.add'));
    expect(JSON.parse(String(mutation))).toEqual({ type: 'group.owner.add', groupId: 'group-1', userId: 'user-9' });
    expect(root.textContent).toContain('Group assignment accepted and verified.');
  });

  it('requires confirmation for password reset and clears the one-time password when the drawer closes', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration' && init?.method === 'GET') return Response.json({ id: 'user-1', displayName: 'Ada', accountEnabled: true });
      if (path === '/microsoft/administration') return Response.json({ accepted: true, temporaryPassword: 'Example!Password123', forceChangePasswordNextSignIn: true });
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, 'user-1'); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#user-password-reset-start')!.click();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#user-security-submit')!.click(); await flush();
    expect(request.mock.calls.some(([, init]) => String(init?.body).includes('user.password.reset'))).toBe(false);
    page.shadowRoot!.querySelector<HTMLInputElement>('#user-security-confirm')!.click();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#user-security-submit')!.click(); await flush();
    expect(page.shadowRoot!.querySelector('#temporary-password')!.textContent).toBe('Example!Password123');
    expect(page.shadowRoot!.textContent).toContain('must change it at next sign-in');
    page.shadowRoot!.querySelector<HTMLButtonElement>('#detail-close')!.click();
    expect(page.shadowRoot!.textContent).not.toContain('Example!Password123');
  });

  it('keeps password-reset success intact and does not send a no-change profile update', async () => {
    const user = { id: 'user-1', displayName: 'Cloud Command QA Config Check', accountEnabled: false };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: user.id, values: { displayName: user.displayName } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const type = JSON.parse(String(init?.body)).type;
        if (type === 'user.get') return Response.json(user);
        if (type === 'user.password.reset') return Response.json({ accepted: true, temporaryPassword: 'Example!Password123', forceChangePasswordNextSignIn: true });
        if (type === 'user.update') return Response.json({ accepted: true });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, user.id); await flush();
    const root = page.shadowRoot!;
    root.querySelector<HTMLButtonElement>('#user-password-reset-start')!.click();
    root.querySelector<HTMLInputElement>('#user-security-confirm')!.click();
    root.querySelector<HTMLButtonElement>('#user-security-submit')!.click(); await flush();
    expect(root.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('Password reset.');
    expect(root.querySelectorAll('[data-user-save]').length).toBe(1);
    expect(root.querySelector<HTMLButtonElement>('[data-user-save="displayName"]')!.disabled).toBe(true);
    root.querySelector<HTMLButtonElement>('[data-user-save="displayName"]')!.click(); await flush();

    const operations = request.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)).type);
    expect(operations.filter(type => type === 'user.password.reset')).toHaveLength(1);
    expect(operations).not.toContain('user.update');
    expect(root.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('Password reset.');
    expect(root.querySelector('#temporary-password')).not.toBeNull();
  });

  it('confirms session revocation once and explains its propagation delay', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/directory/snapshot') return Promise.resolve(new Response(null, { status: 404 }));
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration' && init?.method === 'GET') return Response.json({ id: 'user-1', displayName: 'Ada', accountEnabled: true });
      if (path === '/microsoft/administration') return Response.json({ accepted: true });
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, 'user-1'); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#user-sessions-revoke-start')!.click();
    page.shadowRoot!.querySelector<HTMLInputElement>('#user-security-confirm')!.click();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#user-security-submit')!.click(); await flush();
    expect(request.mock.calls.filter(([, init]) => String(init?.body).includes('user.sessions.revoke'))).toHaveLength(1);
    expect(page.shadowRoot!.textContent).toContain('may take a few minutes');
  });
});
