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
  page.context = context;
  page.hostApi = api;
  document.body.append(page);
  return page;
}

afterEach(() => { document.body.replaceChildren(); });

describe('CloudCommandThreeCxPage', () => {
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
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/threecx/connection', '/threecx/test']);
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
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/threecx/connection', '/threecx/test', '/threecx/connection', '/threecx/connection', '/threecx/users?skip=0',
    ]);
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
    const page = mount({ request: async () => Response.json({ connected: true, canManage: false, origin: 'https://pbx.example.com', clientId: 'hidden' }) });
    await flush();
    const root = page.shadowRoot!;
    expect(root.querySelector('#origin')).toBeNull();
    expect(root.querySelector('#test')).toBeNull();
    expect(root.querySelector('#save')).toBeNull();
    expect(root.textContent).toContain('read-only access');
    expect(root.querySelector<HTMLButtonElement>('#refresh-users')!.disabled).toBe(false);
  });

  it('disables extension reads for a configured but disabled connection', async () => {
    const page = mount({ request: async () => Response.json({ connected: true, canManage: false, enabled: false }) });
    await flush();
    const root = page.shadowRoot!;
    expect(root.textContent).toContain('This connection is disabled.');
    expect(root.querySelector<HTMLButtonElement>('#refresh-users')!.disabled).toBe(true);
  });

  it('can load through an empty filtered page when the service provides a next skip', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === '/threecx/connection') return Response.json({ connected: true, canManage: false, enabled: true });
      if (path === '/threecx/users?skip=0') return Response.json({ items: [], nextSkip: 100, truncated: false });
      if (path === '/threecx/users?skip=100') return Response.json({ items: [{ Id: 2, Number: '200', FirstName: 'Grace', LastName: 'Hopper', EmailAddress: null, Mobile: null, Enabled: true, IsRegistered: false, CurrentProfileName: null }], nextSkip: null, truncated: false });
      throw new Error(`unexpected ${path}`);
    });
    const page = mount({ request });
    await flush();
    let root = page.shadowRoot!;
    (root.querySelector('#refresh-users') as HTMLButtonElement).click();
    await flush(); await flush();
    root = page.shadowRoot!;
    expect(root.querySelector<HTMLButtonElement>('#more-users')).toBeTruthy();
    (root.querySelector('#more-users') as HTMLButtonElement).click();
    await flush(); await flush();
    expect(root.textContent).toContain('Grace Hopper');
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/threecx/connection', '/threecx/users?skip=0', '/threecx/users?skip=100']);
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
