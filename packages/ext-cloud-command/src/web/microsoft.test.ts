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
      path.startsWith('/microsoft/resources/')
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

  it('sends only the account-enabled field when changing sign-in access', async () => {
    let enabled = false;
    const user = { id: 'user-1', displayName: 'Ada', givenName: '', surname: '', department: '', jobTitle: '', officeLocation: '' };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ ...user, accountEnabled: enabled });
        if (body.type === 'user.update') { enabled = body.update.accountEnabled; return Response.json({ accepted: true }); }
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); openUser(page, 'user-1'); await flush();
    page.shadowRoot!.querySelector<HTMLInputElement>('#user-account-enabled')!.checked = true;
    page.shadowRoot!.querySelector<HTMLInputElement>('#user-account-enabled')!.dispatchEvent(new Event('change', { bubbles: true }));
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-user-save="accountEnabled"]')!.click(); await flush(); await flush(); await flush();
    const update = request.mock.calls.map(([, init]) => init?.body).find(body => String(body).includes('user.update'));
    expect(JSON.parse(String(update))).toEqual({ type: 'user.update', id: 'user-1', update: { accountEnabled: true } });
    expect(page.shadowRoot!.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('saved and verified');
  });

  it('saves independently edited profile fields in separate requests', async () => {
    const user = { id: 'user-1', displayName: 'Ada', givenName: '', surname: '', department: 'Research', jobTitle: '', officeLocation: '', accountEnabled: true };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
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
    editUserField(page, 'department', 'Analytical Engine');
    const root = page.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-user-save="displayName"]')!.click(); await flush(); await flush();
    const updates = request.mock.calls.map(([, init]) => init?.body).filter(body => String(body).includes('user.update'))
      .map(body => JSON.parse(String(body)).update);
    expect(updates).toEqual([{ displayName: 'Ada Byron' }]);
    expect(root.querySelector<HTMLInputElement>('#user-department')!.value).toBe('Analytical Engine');
    expect(root.querySelector<HTMLButtonElement>('[data-user-save="department"]')!.disabled).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-user-save="department"]')!.click(); await flush(); await flush();
    const finalUpdates = request.mock.calls.map(([, init]) => init?.body).filter(body => String(body).includes('user.update'))
      .map(body => JSON.parse(String(body)).update);
    expect(finalUpdates).toEqual([{ displayName: 'Ada Byron' }, { department: 'Analytical Engine' }]);
  });

  it('reports an uncertain result after bounded readback retries without repeating the mutation', async () => {
    let verifyReads = 0;
    let mutationAccepted = false;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
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

  it('requires explicit confirmation before sending a bounded group membership change', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return emptyResource();
      if (path === '/microsoft/resources/groups') return Response.json({ items: [{ id: 'group-1', values: { displayName: 'Operators' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const type = JSON.parse(String(init?.body)).type;
        if (type === 'group.get') return Response.json({ displayName: 'Operators' });
        if (type === 'group.member.remove') return Response.json({ accepted: true });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-detail="group-1"]')!.click(); await flush();
    const root = page.shadowRoot!; root.querySelector<HTMLInputElement>('#group-member-user-id')!.value = 'user-9'; (root.querySelector<HTMLSelectElement>('#group-member-action')!).value = 'remove';
    root.querySelector<HTMLButtonElement>('#group-member-submit')!.click(); await flush();
    expect(request.mock.calls.some(([, init]) => String(init?.body).includes('group.member.remove'))).toBe(false);
    root.querySelector<HTMLInputElement>('#group-member-confirm')!.checked = true; root.querySelector<HTMLButtonElement>('#group-member-submit')!.click(); await flush();
    const mutation = request.mock.calls.map(([, init]) => init?.body).find(body => String(body).includes('group.member.remove'));
    expect(JSON.parse(String(mutation))).toEqual({ type: 'group.member.remove', groupId: 'group-1', userId: 'user-9' });
    expect(page.shadowRoot!.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('verification is pending');
  });

  it('requires confirmation for password reset and clears the one-time password when the drawer closes', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
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
    expect(root.querySelectorAll('[data-user-save]').length).toBeGreaterThan(1);
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
