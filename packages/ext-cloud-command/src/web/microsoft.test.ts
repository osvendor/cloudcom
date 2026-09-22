import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandMicrosoftPage } from './microsoft';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const emptyResource = () => Response.json({ items: [], columns: [], complete: true, checkedAt: 'now' });
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
  document.body.replaceChildren();
  window.location.hash = '';
});

describe('CloudCommandMicrosoftPage', () => {
  it('shows 3CX navigation only when its connection is usable or manageable', async () => {
    const page = mount(async (path) =>
      path === '/threecx/connection'
        ? Response.json({ connected: true, enabled: true, canManage: false })
        : Response.json({ available: true, connected: false, canManage: false }),
    );
    await flush();
    await flush();
    expect(page.shadowRoot!.querySelector('[data-testid="go-threecx"]')).toBeTruthy();
  });

  it('hides a disabled 3CX connection from a read-only user', async () => {
    const page = mount(async (path) =>
      path === '/threecx/connection'
        ? Response.json({ connected: true, enabled: false, canManage: false })
        : Response.json({ available: true, connected: false, canManage: false }),
    );
    await flush();
    await flush();
    expect(page.shadowRoot!.querySelector('[data-testid="go-threecx"]')).toBeNull();
  });

  it('hides 3CX navigation when its status request fails without breaking Microsoft', async () => {
    const page = mount(async (path) => {
      if (path === '/threecx/connection') return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ available: false, connected: false, canManage: false, reason: 'Not installed' });
    });
    await flush();
    await flush();
    expect(page.shadowRoot!.querySelector('[data-testid="go-threecx"]')).toBeNull();
    expect(page.shadowRoot!.textContent).toContain('Provider unavailable');
  });

  it('shows unavailable and read-only connection states honestly', async () => {
    const unavailable = mount(async () =>
      Response.json({ available: false, connected: false, canManage: false, reason: 'Not installed' }),
    );
    await flush();
    expect(unavailable.shadowRoot!.textContent).toContain('Provider unavailable');
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
    expect(page.shadowRoot!.querySelector('#setup-integrations')?.getAttribute('href')).toBe('/extensions/cloudcommand/connect#microsoft');
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

  it('polls bounded user readbacks until an eventually propagated update matches without duplicating the mutation', async () => {
    const user = { id: 'user-1', displayName: 'Ada Lovelace', givenName: 'Ada', surname: 'Lovelace', department: 'Engineering', jobTitle: 'Analyst', officeLocation: 'London', accountEnabled: true };
    let gets = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada Lovelace' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'user.get') return Response.json({ ...user, displayName: gets++ >= 2 ? 'Ada Byron' : user.displayName });
        if (body.type === 'user.update') return Response.json({ accepted: true });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-detail="user-1"]')!.click(); await flush();
    const name = page.shadowRoot!.querySelector<HTMLInputElement>('#user-displayName')!; name.value = 'Ada Byron';
    page.shadowRoot!.querySelector<HTMLButtonElement>('#user-save')!.click(); await new Promise(resolve => setTimeout(resolve, 1100));
    const update = request.mock.calls.map(([, init]) => init?.body).find(body => String(body).includes('user.update'));
    expect(JSON.parse(String(update))).toEqual({ type: 'user.update', id: 'user-1', update: { displayName: 'Ada Byron', givenName: 'Ada', surname: 'Lovelace', department: 'Engineering', jobTitle: 'Analyst', officeLocation: 'London', accountEnabled: true } });
    expect(request.mock.calls.filter(([, init]) => String(init?.body).includes('user.update'))).toHaveLength(1);
    expect(page.shadowRoot!.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('saved and verified');
  });

  it('reports a mismatched user readback as uncertain without retrying', async () => {
    let gets = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
      if (path === '/threecx/connection') return Response.json({ connected: false });
      if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: 'user-1', values: { displayName: 'Ada' } }], columns: [{ key: 'displayName', label: 'Name' }], complete: true, checkedAt: 'now' });
      if (path === '/microsoft/administration') {
        const type = JSON.parse(String(init?.body)).type;
        if (type === 'user.get') return Response.json({ displayName: gets++ ? 'Ada' : 'Ada', givenName: '', surname: '', department: '', jobTitle: '', officeLocation: '', accountEnabled: true });
        if (type === 'user.update') return Response.json({ accepted: true });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const page = mount(request); await flush(); await flush(); page.shadowRoot!.querySelector<HTMLButtonElement>('[data-detail="user-1"]')!.click(); await flush();
    page.shadowRoot!.querySelector<HTMLInputElement>('#user-displayName')!.value = 'Changed'; page.shadowRoot!.querySelector<HTMLButtonElement>('#user-save')!.click(); await new Promise(resolve => setTimeout(resolve, 3100));
    expect(page.shadowRoot!.querySelector('[data-testid="detail-mutation-feedback"]')!.textContent).toContain('did not confirm');
    expect(request.mock.calls.filter(([, init]) => String(init?.body).includes('user.update'))).toHaveLength(1);
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
    const page = mount(request); await flush(); await flush(); page.shadowRoot!.querySelector<HTMLButtonElement>('[data-detail="user-1"]')!.click(); await flush();
    page.shadowRoot!.querySelector<HTMLInputElement>('#user-displayName')!.value = 'Changed'; page.shadowRoot!.querySelector<HTMLButtonElement>('#user-save')!.click(); await flush();
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
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-detail="user-1"]')!.click(); await flush();
    page.shadowRoot!.querySelector<HTMLInputElement>('#user-displayName')!.value = 'Changed'; page.shadowRoot!.querySelector<HTMLButtonElement>('#user-save')!.click(); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#detail-close')!.click();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-detail="user-1"]')!.click(); await flush();
    expect(page.shadowRoot!.querySelector<HTMLButtonElement>('#user-save')!.disabled).toBe(false);
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
});
