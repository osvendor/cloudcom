import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandMicrosoftPage } from './microsoft';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const user = { id: 'u1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@example.test', givenName: 'Ada', surname: 'Lovelace', department: 'Engineering', jobTitle: 'Analyst', officeLocation: 'London', accountEnabled: true };
async function mount(canManage = true, complete = true) {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage, tenantName: 'Contoso' });
    if (path === '/microsoft/resources/users') return Response.json({
      items: [{ id: user.id, values: user }],
      columns: [{ key: 'displayName', label: 'Name' }, { key: 'userPrincipalName', label: 'Sign-in name' }, { key: 'accountEnabled', label: 'Enabled' }, { key: 'department', label: 'Department' }],
      complete, checkedAt: '2026-09-22T12:00:00Z',
    });
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
    expect(request.mock.calls.filter(([, init]) => init?.body).every(([, init]) => JSON.parse(String(init?.body)).type === 'user.get')).toBe(true);
    root.querySelector<HTMLButtonElement>('#detail-close')!.click();
    await flush();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('hides and restores columns without changing directory data or making requests', async () => {
    const { root, request } = await mount();
    const calls = request.mock.calls.length;
    root.querySelector<HTMLButtonElement>('[data-column="department"]')!.click();
    expect(root.querySelector('[data-column="department"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('table')?.textContent).not.toContain('Engineering');
    expect(root.querySelector('table')?.textContent).toContain('Ada Lovelace');
    root.querySelector<HTMLButtonElement>('#reset-columns')!.click();
    expect(root.querySelector('[data-column="department"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('table')?.textContent).toContain('Engineering');
    expect(request.mock.calls).toHaveLength(calls);
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
    const save = root.querySelector<HTMLButtonElement>('#user-sessions-revoke-start')!;
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
