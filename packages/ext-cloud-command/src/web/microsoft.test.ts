import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandMicrosoftPage } from './microsoft';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const emptyResource = () => Response.json({ items: [], columns: [], complete: true, checkedAt: 'now' });
function mount(request: (path: string, init?: RequestInit) => Promise<Response>, org = 'org-a') {
  const page = new CloudCommandMicrosoftPage();
  page.context = { contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/microsoft', organizationId: org };
  page.hostApi = { request }; document.body.append(page); return page;
}
afterEach(() => { document.body.replaceChildren(); window.location.hash = ''; });

describe('CloudCommandMicrosoftPage', () => {
  it('shows unavailable and read-only connection states honestly', async () => {
    const unavailable = mount(async () => Response.json({ available: false, connected: false, canManage: false, reason: 'Not installed' })); await flush();
    expect(unavailable.shadowRoot!.textContent).toContain('Provider unavailable');
    document.body.replaceChildren();
    const reader = mount(async (path) => path.startsWith('/microsoft/resources/') ? emptyResource() : Response.json({ available: true, connected: true, canManage: false, enabled: true, tenantName: 'Contoso' })); await flush();
    expect(reader.shadowRoot!.querySelector('#bind')).toBeNull(); expect(reader.shadowRoot!.textContent).toContain('read-only access');
  });

  it('binds an authorized tenant and changes resources through the hash', async () => {
    let bound = false;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/connection' && init?.method === 'PUT') { bound = true; return Response.json({ available: true, connected: true, canManage: true, enabled: true, tenantId: 't1', tenantName: 'Contoso', version: 2 }); }
      if (path === '/microsoft/connection') return Response.json(bound ? { available: true, connected: true, canManage: true, enabled: true, tenantId: 't1', tenantName: 'Contoso', version: 2 } : { available: true, connected: false, canManage: true, version: 1 });
      if (path === '/microsoft/tenants') return Response.json({ items: [{ id: 't1', name: 'Contoso', domain: 'contoso.example' }] });
      if (path.startsWith('/microsoft/resources/')) return emptyResource();
      throw new Error(`unexpected ${path}`);
    });
    const page = mount(request); await flush(); let root = page.shadowRoot!;
    (root.querySelector('#load-tenants') as HTMLButtonElement).click(); await flush(); await flush(); root = page.shadowRoot!;
    (root.querySelector('#tenant') as HTMLSelectElement).value = 't1'; (root.querySelector('#bind') as HTMLButtonElement).click(); await flush(); await flush(); await flush();
    window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush(); await flush();
    expect(request.mock.calls.map(([path]) => path)).toContain('/microsoft/resources/groups');
  });

  it('ignores a late response after the organization context changes', async () => {
    let resolveOld!: (response: Response) => void;
    let calls = 0;
    const page = mount((path) => {
      if (path !== '/microsoft/connection') return Promise.resolve(Response.json({}));
      calls += 1;
      return calls === 1 ? new Promise<Response>((resolve) => { resolveOld = resolve; }) : Promise.resolve(Response.json({ available: true, connected: false, canManage: false }));
    }); await flush();
    page.context = { contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/microsoft', organizationId: 'org-b' };
    resolveOld(Response.json({ available: false, connected: false, canManage: false, reason: 'old org' })); await flush();
    expect(page.shadowRoot!.textContent).not.toContain('old org');
  });

  it('captures an unchecked enabled toggle when binding', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/microsoft/connection' && init?.method === 'PUT') { expect(JSON.parse(String(init.body))).toMatchObject({ tenantId: 't1', enabled: false, version: 1 }); return Response.json({ available: true, connected: true, canManage: true, enabled: false, tenantId: 't1', version: 2 }); }
      if (path === '/microsoft/connection') return Response.json({ available: true, connected: false, canManage: true, version: 1 });
      if (path === '/microsoft/tenants') return Response.json({ items: [{ id: 't1', name: 'Tenant', domain: 'tenant.example' }] });
      return emptyResource();
    });
    const page = mount(request); await flush(); let root = page.shadowRoot!;
    (root.querySelector('#load-tenants') as HTMLButtonElement).click(); await flush(); await flush(); root = page.shadowRoot!;
    (root.querySelector('#tenant') as HTMLSelectElement).value = 't1'; (root.querySelector('#enabled') as HTMLInputElement).checked = false; (root.querySelector('#bind') as HTMLButtonElement).click(); await flush(); await flush();
    expect(request.mock.calls.some(([path, init]) => path === '/microsoft/connection' && (init as RequestInit)?.method === 'PUT')).toBe(true);
  });

  it('does not apply a late save response after the organization changes', async () => {
    let resolveSave!: (response: Response) => void;
    const page = mount((path, init) => {
      if (path === '/microsoft/connection' && init?.method === 'PUT') return new Promise<Response>((resolve) => { resolveSave = resolve; });
      if (path === '/microsoft/connection') return Promise.resolve(Response.json({ available: true, connected: false, canManage: true, version: 1 }));
      if (path === '/microsoft/tenants') return Promise.resolve(Response.json({ items: [{ id: 't1', name: 'Tenant', domain: 'tenant.example' }] }));
      return Promise.resolve(emptyResource());
    });
    await flush(); let root = page.shadowRoot!; (root.querySelector('#load-tenants') as HTMLButtonElement).click(); await flush(); await flush(); root = page.shadowRoot!;
    (root.querySelector('#tenant') as HTMLSelectElement).value = 't1'; (root.querySelector('#bind') as HTMLButtonElement).click(); await flush();
    page.context = { contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/microsoft', organizationId: 'org-b' }; resolveSave(Response.json({ available: true, connected: true, canManage: true, tenantName: 'old tenant' })); await flush(); await flush();
    expect(page.shadowRoot!.textContent).not.toContain('old tenant');
  });

  it('does not paint an old pending resource read while a tenant bind is pending', async () => {
    let resolveUsers!: (response: Response) => void; let resolveBind!: (response: Response) => void;
    const page = mount((path, init) => {
      if (path === '/microsoft/connection' && init?.method === 'PUT') return new Promise<Response>((resolve) => { resolveBind = resolve; });
      if (path === '/microsoft/connection') return Promise.resolve(Response.json({ available: true, connected: true, canManage: true, enabled: true, tenantId: 'old', version: 1 }));
      if (path === '/microsoft/tenants') return Promise.resolve(Response.json({ items: [{ id: 'new', name: 'New tenant', domain: 'new.example' }] }));
      if (path === '/microsoft/resources/users') return new Promise<Response>((resolve) => { resolveUsers = resolve; });
      return Promise.resolve(emptyResource());
    });
    await flush(); let root = page.shadowRoot!; (root.querySelector('#load-tenants') as HTMLButtonElement).click(); await flush(); await flush(); root = page.shadowRoot!;
    (root.querySelector('#tenant') as HTMLSelectElement).value = 'new'; (root.querySelector('#bind') as HTMLButtonElement).click(); await flush();
    resolveUsers(Response.json({ items: [{ id: 'old', values: { name: 'old tenant row' } }], columns: [{ key: 'name', label: 'Name' }], complete: true, checkedAt: 'old' })); await flush(); await flush();
    expect(page.shadowRoot!.textContent).not.toContain('old tenant row');
    resolveBind(Response.json({ available: true, connected: true, canManage: true, enabled: true, tenantId: 'new', version: 2 }));
  });

  it('keeps only the latest rapid resource response and preserves filter focus', async () => {
    let users!: (response: Response) => void; let groups!: (response: Response) => void;
    const page = mount((path) => {
      if (path === '/microsoft/connection') return Promise.resolve(Response.json({ available: true, connected: true, canManage: false, enabled: true }));
      if (path === '/microsoft/resources/users') return new Promise<Response>((resolve) => { users = resolve; });
      if (path === '/microsoft/resources/groups') return new Promise<Response>((resolve) => { groups = resolve; });
      return Promise.resolve(emptyResource());
    });
    await flush(); window.location.hash = 'groups'; window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    users(Response.json({ items: [{ id: 'u', values: { name: 'old user' } }], columns: [{ key: 'name', label: 'Name' }], complete: true, checkedAt: 'old' }));
    groups(Response.json({ items: [{ id: 'g', values: { name: 'new group' } }], columns: [{ key: 'name', label: 'Name' }], complete: true, checkedAt: 'new' })); await flush(); await flush();
    const root = page.shadowRoot!; expect(root.textContent).toContain('new group'); expect(root.textContent).not.toContain('old user');
    const filter = root.querySelector<HTMLInputElement>('#filter')!; filter.value = 'new'; filter.dispatchEvent(new Event('input', { bubbles: true })); await flush(); expect(root.activeElement).toBe(root.querySelector('#filter'));
  });

  it('shows a visible error for a malformed successful resource response', async () => {
    const page = mount(async (path) => path.startsWith('/microsoft/resources/') ? Response.json({ items: {} }) : Response.json({ available: true, connected: true, canManage: false, enabled: true })); await flush(); await flush();
    expect(page.shadowRoot!.querySelector('[data-testid="status"]')!.textContent).toContain('Invalid Microsoft resource response.');
  });
});
