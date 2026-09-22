import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandThreeCxPage, type CloudCommandHostApi } from './index';

const context = {
  contractVersion: 1 as const,
  extensionName: 'cloudcommand',
  path: '/extensions/cloudcommand/threecx',
  organizationId: 'org-1',
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(api: CloudCommandHostApi): CloudCommandThreeCxPage {
  // Instantiate the exported class directly. In happy-dom, this avoids relying
  // on cross-module custom-element upgrade timing while still exercising the
  // same connectedCallback and shadow-root implementation the host mounts.
  const page = new CloudCommandThreeCxPage();
  // The operational manifest route is directory-only. Existing page-level
  // tests exercise both explicitly supported regions together.
  page.displayMode = 'combined';
  page.context = context;
  page.hostApi = api;
  document.body.append(page);
  return page;
}

afterEach(() => { document.body.replaceChildren(); });

describe('CloudCommandThreeCxPage', () => {
  it('keeps the operational route directory-only', async () => {
    const page = new CloudCommandThreeCxPage();
    page.context = context;
    page.hostApi = { request: async (path) => path === '/threecx/users?skip=0'
      ? Response.json({ items: [], nextSkip: null, truncated: false })
      : Response.json({ connected: true, canManage: true, enabled: true }) };
    document.body.append(page);
    await flush();
    const root = page.shadowRoot!;
    expect(root.querySelector('#origin')).toBeNull();
    expect(root.querySelector('#connection-heading')).toBeNull();
    expect(root.querySelector('#refresh-users')).toBeTruthy();
    expect(root.querySelector('#configure-3cx')).toBeNull();
  });

  it('automatically reads the first extension page for an enabled combined view', async () => {
    const request = vi.fn(async (path: string) => path === '/threecx/users?skip=0'
      ? Response.json({ items: [{ Id: 1, Number: '100', FirstName: 'Ada', LastName: 'Lovelace', EmailAddress: null, Mobile: null, Enabled: true, IsRegistered: true, CurrentProfileName: null }], nextSkip: null, truncated: false })
      : Response.json({ connected: true, canManage: false, enabled: true }));
    const page = mount({ request });
    await flush(); await flush();
    expect(page.shadowRoot!.textContent).toContain('Ada Lovelace');
    expect(request.mock.calls.filter(([path]) => path === '/threecx/users?skip=0')).toHaveLength(1);
  });

  it('does not read extensions from a configuration-only view', async () => {
    const request = vi.fn(async (_path: string) => Response.json({ connected: true, canManage: true, enabled: true }));
    const page = new CloudCommandThreeCxPage();
    page.displayMode = 'configuration';
    page.context = context;
    page.hostApi = { request };
    document.body.append(page);
    await flush(); await flush();
    expect(request.mock.calls.map(([path]) => path)).not.toContain('/threecx/users?skip=0');
  });
  it('allows a first test to discover departments without silently selecting full PBX access', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/threecx/connection') return Response.json({ connected: false, canManage: true });
      expect(path).toBe('/threecx/test');
      expect(JSON.parse(String(init?.body))).toMatchObject({ departmentId: null, enabled: true });
      return Response.json({ success: true, groups: [{ id: 7, name: 'Support' }] });
    });
    const page = mount({ request });
    await flush();
    const root = page.shadowRoot!;
    expect(root.querySelector('#departmentId')!.textContent).not.toContain('undefined');
    (root.querySelector('#origin') as HTMLInputElement).value = 'https://pbx.example.com:5001';
    (root.querySelector('#clientId') as HTMLInputElement).value = 'client-id';
    (root.querySelector('#test') as HTMLButtonElement).click();
    await flush(); await flush();
    expect(root.querySelector<HTMLInputElement>('#full-pbx')!.checked).toBe(false);
    expect(root.querySelector<HTMLSelectElement>('#departmentId')!.value).toBe('');
    expect(root.querySelector('#departmentId')!.textContent).toContain('Support');
    expect(request.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(['/threecx/connection', '/microsoft/connection', '/threecx/test']));
  });

  it('preserves the draft through test, scope selection, and save while clearing the secret after a successful save', async () => {
    let connectionReads = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/threecx/connection') {
        if (init?.method === 'PUT') return Response.json({ connected: true });
        connectionReads += 1;
        return Response.json(connectionReads === 1
          ? { connected: false, canManage: true }
          : { connected: true, canManage: true, origin: 'https://pbx.example.com:5001', clientId: 'client-id', departmentId: 7, enabled: true });
      }
      if (path === '/threecx/test') return Response.json({ success: true, groups: [{ id: 7, name: 'Support' }] });
      if (path === '/threecx/users?skip=0') return Response.json({ items: [], nextSkip: null, truncated: false });
      throw new Error(`unexpected ${path}`);
    });
    const page = mount({ request });
    await flush();
    let root = page.shadowRoot!;
    (root.querySelector('#origin') as HTMLInputElement).value = 'https://pbx.example.com:5001';
    (root.querySelector('#clientId') as HTMLInputElement).value = 'client-id';
    (root.querySelector('#secret') as HTMLInputElement).value = 'pending-secret';
    (root.querySelector('#test') as HTMLButtonElement).click();
    await flush(); await flush();
    root = page.shadowRoot!;
    expect((root.querySelector('#origin') as HTMLInputElement).value).toBe('https://pbx.example.com:5001');
    expect((root.querySelector('#secret') as HTMLInputElement).value).toBe('pending-secret');
    (root.querySelector('#departmentId') as HTMLSelectElement).value = '7';
    (root.querySelector('#save') as HTMLButtonElement).click();
    await flush(); await flush(); await flush();
    root = page.shadowRoot!;
    expect((root.querySelector('#clientId') as HTMLInputElement).value).toBe('client-id');
    expect((root.querySelector('#departmentId') as HTMLSelectElement).value).toBe('7');
    expect((root.querySelector('#secret') as HTMLInputElement).value).toBe('');
    expect(request.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining([
      '/threecx/connection', '/microsoft/connection', '/threecx/test', '/threecx/users?skip=0',
    ]));
    expect(request.mock.calls.filter(([path]) => path === '/threecx/users?skip=0')).toHaveLength(1);
  });

  it('preserves an entered secret after a failed save and rejects stale group selections', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/threecx/connection') {
        if (init?.method === 'PUT') return Response.json({ error: 'conflict' }, { status: 409 });
        return Response.json({ connected: false, canManage: true });
      }
      if (path === '/threecx/test') return Response.json({ success: true, groups: [{ id: 7, name: 'Support' }] });
      throw new Error(`unexpected ${path}`);
    });
    const page = mount({ request });
    await flush();
    let root = page.shadowRoot!;
    (root.querySelector('#origin') as HTMLInputElement).value = 'https://pbx.example.com:5001';
    (root.querySelector('#clientId') as HTMLInputElement).value = 'client-id';
    (root.querySelector('#secret') as HTMLInputElement).value = 'keep-me';
    (root.querySelector('#test') as HTMLButtonElement).click();
    await flush(); await flush();
    root = page.shadowRoot!;
    (root.querySelector('#departmentId') as HTMLSelectElement).value = '7';
    (root.querySelector('#save') as HTMLButtonElement).click();
    await flush(); await flush();
    root = page.shadowRoot!;
    expect((root.querySelector('#secret') as HTMLInputElement).value).toBe('keep-me');
    expect(root.querySelector('[data-status]')!.textContent).toContain('conflict');

    (root.querySelector('#origin') as HTMLInputElement).value = 'https://other.example.com';
    (root.querySelector('#save') as HTMLButtonElement).click();
    await flush();
    expect(request.mock.calls.filter(([path]) => path === '/threecx/connection')).toHaveLength(2);
    expect(root.querySelector('[data-status]')!.textContent).toContain('Select a department');
  });

  it('does not render credential controls or mutation actions for a reader', async () => {
    const page = mount({ request: async (path) => path === '/threecx/users?skip=0'
      ? Response.json({ items: [], nextSkip: null, truncated: false })
      : Response.json({ connected: true, canManage: false, origin: 'https://pbx.example.com', clientId: 'hidden' }) });
    await flush(); await flush();
    const root = page.shadowRoot!;
    expect(root.querySelector('#origin')).toBeNull();
    expect(root.querySelector('#test')).toBeNull();
    expect(root.querySelector('#save')).toBeNull();
    expect(root.textContent).toContain('read-only access');
    expect(root.querySelector<HTMLButtonElement>('#refresh-users')!.disabled).toBe(false);
  });

  it('disables extension reads for a configured but disabled connection', async () => {
    const request = vi.fn(async (_path: string) => Response.json({ connected: true, canManage: false, enabled: false }));
    const page = mount({ request });
    await flush();
    const root = page.shadowRoot!;
    expect(root.textContent).toContain('This connection is disabled.');
    expect(root.querySelector<HTMLButtonElement>('#refresh-users')!.disabled).toBe(true);
    expect(request.mock.calls.map(([path]) => path)).not.toContain('/threecx/users?skip=0');
  });

  it('can load through an empty filtered page when the service provides a next skip', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === '/threecx/connection') return Response.json({ connected: true, canManage: false, enabled: true });
      if (path === '/threecx/users?skip=0') return Response.json({ items: [], nextSkip: 100, truncated: false });
      if (path === '/threecx/users?skip=100') return Response.json({ items: [{ Id: 2, Number: '200', FirstName: 'Grace', LastName: 'Hopper', EmailAddress: null, Mobile: null, Enabled: true, IsRegistered: false, CurrentProfileName: null }], nextSkip: null, truncated: false });
      throw new Error(`unexpected ${path}`);
    });
    const page = mount({ request });
    await flush(); await flush();
    let root = page.shadowRoot!;
    expect(root.querySelector<HTMLButtonElement>('#more-users')).toBeTruthy();
    (root.querySelector('#more-users') as HTMLButtonElement).click();
    await flush(); await flush();
    expect(root.textContent).toContain('Grace Hopper');
    expect(request.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(['/threecx/connection', '/microsoft/connection', '/threecx/users?skip=0', '/threecx/users?skip=100']));
  });

  it('shows Microsoft navigation only when Microsoft is available to this organization', async () => {
    const page = mount({ request: async (path) => path === '/microsoft/connection'
      ? Response.json({ available: true, connected: true, enabled: true, canManage: false })
      : Response.json({ connected: false, canManage: true }) });
    await flush(); await flush();
    expect(page.shadowRoot!.querySelector('#go-microsoft')).toBeTruthy();
  });

  it('hides a disabled Microsoft connection from a read-only user', async () => {
    const page = mount({ request: async (path) => path === '/microsoft/connection'
      ? Response.json({ available: true, connected: true, enabled: false, canManage: false })
      : Response.json({ connected: false, canManage: true }) });
    await flush(); await flush();
    expect(page.shadowRoot!.querySelector('#go-microsoft')).toBeNull();
  });


  it('hides unavailable Microsoft navigation without disrupting the 3CX page', async () => {
    const page = mount({ request: async (path) => path === '/microsoft/connection'
      ? Response.json({ available: false, connected: false, canManage: false })
      : Response.json({ connected: false, canManage: true }) });
    await flush(); await flush();
    expect(page.shadowRoot!.querySelector('#go-microsoft')).toBeNull();
    expect(page.shadowRoot!.textContent).toContain('No 3CX connection is configured.');
  });

  it('hides Microsoft navigation when its status request fails while keeping 3CX usable', async () => {
    const page = mount({ request: async (path) => {
      if (path === '/microsoft/connection') return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ connected: false, canManage: true });
    } });
    await flush(); await flush();
    expect(page.shadowRoot!.querySelector('#go-microsoft')).toBeNull();
    expect(page.shadowRoot!.querySelector('#origin')).toBeTruthy();
  });

  it('drops a delayed connection test after the organization changes', async () => {
    let resolveTest!: (response: Response) => void;
    const page = mount({ request: (path) => {
      if (path === '/threecx/test') return new Promise<Response>((resolve) => { resolveTest = resolve; });
      if (path === '/microsoft/connection') return Promise.resolve(Response.json({ available: false, connected: false, canManage: false }));
      return Promise.resolve(Response.json({ connected: false, canManage: true }));
    } });
    await flush();
    let root = page.shadowRoot!;
    (root.querySelector('#origin') as HTMLInputElement).value = 'https://old.example.com';
    (root.querySelector('#clientId') as HTMLInputElement).value = 'old-client';
    (root.querySelector('#test') as HTMLButtonElement).click();
    await flush();
    page.context = { ...context, organizationId: 'org-2' };
    resolveTest(Response.json({ success: true, groups: [{ id: 7, name: 'Old organization group' }] }));
    await flush(); await flush();
    root = page.shadowRoot!;
    expect(root.textContent).not.toContain('Old organization group');
    expect((root.querySelector<HTMLInputElement>('#origin') as HTMLInputElement).value).toBe('');
    expect(root.querySelector<HTMLButtonElement>('#test')!.disabled).toBe(false);
  });

  it('drops a delayed connection save after the organization changes', async () => {
    let resolveSave!: (response: Response) => void;
    const page = mount({ request: (path, init) => {
      if (path === '/threecx/connection' && init?.method === 'PUT') return new Promise<Response>((resolve) => { resolveSave = resolve; });
      if (path === '/microsoft/connection') return Promise.resolve(Response.json({ available: false, connected: false, canManage: false }));
      return Promise.resolve(Response.json({ connected: false, canManage: true }));
    } });
    await flush();
    let root = page.shadowRoot!;
    (root.querySelector('#origin') as HTMLInputElement).value = 'https://old.example.com';
    (root.querySelector('#clientId') as HTMLInputElement).value = 'old-client';
    (root.querySelector('#full-pbx') as HTMLInputElement).checked = true;
    (root.querySelector('#save') as HTMLButtonElement).click();
    await flush();
    page.context = { ...context, organizationId: 'org-2' };
    resolveSave(Response.json({ connected: true, canManage: true, origin: 'https://old.example.com', clientId: 'old-client', enabled: true }));
    await flush(); await flush();
    root = page.shadowRoot!;
    expect(root.textContent).not.toContain('old.example.com');
    expect((root.querySelector<HTMLInputElement>('#origin') as HTMLInputElement).value).toBe('');
    expect(root.querySelector<HTMLButtonElement>('#save')!.disabled).toBe(false);
  });

  it('drops a delayed extension response after the organization changes', async () => {
    const resolveUsers: Array<(response: Response) => void> = [];
    const page = mount({ request: (path) => {
      if (path === '/threecx/users?skip=0') return new Promise<Response>((resolve) => { resolveUsers.push(resolve); });
      if (path === '/microsoft/connection') return Promise.resolve(Response.json({ available: false, connected: false, canManage: false }));
      return Promise.resolve(Response.json({ connected: true, canManage: false, enabled: true }));
    } });
    await flush();
    let root = page.shadowRoot!;
    expect(root.querySelector('[data-status]')!.textContent).toContain('Loading extensions…');
    page.context = { ...context, organizationId: 'org-2' };
    await flush(); await flush();
    expect(resolveUsers).toHaveLength(2);
    resolveUsers[0](Response.json({ items: [{ Id: 9, Number: '999', FirstName: 'Old', LastName: 'Extension', EmailAddress: null, Mobile: null, Enabled: true, IsRegistered: true, CurrentProfileName: null }], nextSkip: null, truncated: false }));
    resolveUsers[1](Response.json({ items: [], nextSkip: null, truncated: false }));
    await flush(); await flush();
    root = page.shadowRoot!;
    expect(root.textContent).not.toContain('Old Extension');
    expect(root.querySelector<HTMLButtonElement>('#refresh-users')!.disabled).toBe(false);
    expect(root.textContent).toContain('No extensions found.');
  });

  it('opens read-only details in a drawer and restores focus when Escape closes it', async () => {
    const page = mount({ request: async (path) => path === '/threecx/users?skip=0'
      ? Response.json({ items: [{ Id: 1, Number: '100', FirstName: 'Ada', LastName: 'Lovelace', EmailAddress: 'ada@example.com', Mobile: '555-0100', Enabled: true, IsRegistered: true, CurrentProfileName: 'Default' }], nextSkip: null, truncated: false })
      : Response.json({ connected: true, canManage: false, enabled: true }) });
    await flush();
    let root = page.shadowRoot!;
    (root.querySelector('#refresh-users') as HTMLButtonElement).click();
    await flush(); await flush();
    root = page.shadowRoot!;
    const opener = root.querySelector<HTMLButtonElement>('[data-detail-index="0"]')!;
    opener.click();
    await flush();
    expect(root.querySelector('[role="dialog"]')!.textContent).toContain('ada@example.com');
    expect(root.querySelector<HTMLButtonElement>('#details-close')).toBe(root.activeElement);
    root.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.querySelector<HTMLButtonElement>('[data-detail-index="0"]')).toBe(root.activeElement);
  });
});
