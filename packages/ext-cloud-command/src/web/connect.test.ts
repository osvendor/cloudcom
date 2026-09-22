import './index';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandConnectPage } from './connect';
import type { CloudCommandHostApi } from './index';

const context = (organizationId = 'org-a') => ({ contractVersion: 1 as const, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/connect', organizationId });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function mount(request: CloudCommandHostApi['request'] = async () => Response.json({ connected: false, canManage: true })) {
  const page = new CloudCommandConnectPage();
  page.context = context();
  page.hostApi = { request };
  document.body.append(page);
  return { page, request };
}

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState({}, '', '/extensions/cloudcommand/connect');
});

describe('CloudCommandConnectPage', () => {
  it('defaults to 3CX and embeds its real configuration form with the trusted host bridge', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/threecx/connection' && init?.method === 'PUT') return Response.json({ connected: true, canManage: true, enabled: true });
      if (path === '/threecx/connection') return Response.json({ connected: false, canManage: true });
      if (path === '/threecx/test') return Response.json({ success: true, groups: [{ id: 7, name: 'Support' }] });
      throw new Error(`unexpected ${path}`);
    });
    const { page } = mount(request);
    await flush();
    let root = page.shadowRoot!;
    const child = root.querySelector<HTMLElement>('cloudcommand-threecx-page')!;
    await flush(); await flush();
    let childRoot = child.shadowRoot!;
    expect(childRoot.querySelector('#extensions-heading')).toBeNull();
    (childRoot.querySelector('#origin') as HTMLInputElement).value = 'https://pbx.example.com';
    (childRoot.querySelector('#clientId') as HTMLInputElement).value = 'client-id';
    (childRoot.querySelector('#secret') as HTMLInputElement).value = 'secret';
    (childRoot.querySelector('#test') as HTMLButtonElement).click();
    await flush(); await flush();
    childRoot = child.shadowRoot!;
    (childRoot.querySelector('#departmentId') as HTMLSelectElement).value = '7';
    (childRoot.querySelector('#save') as HTMLButtonElement).click();
    await flush(); await flush();
    expect(request.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(['/threecx/test', '/threecx/connection']));
    expect(request.mock.calls.some(([path, init]) => path === '/threecx/test' && init?.method === 'POST')).toBe(true);
    expect(request.mock.calls.some(([path, init]) => path === '/threecx/connection' && init?.method === 'PUT')).toBe(true);
    const save = request.mock.calls.find(([path, init]) => path === '/threecx/connection' && init?.method === 'PUT')!;
    expect(JSON.parse(String(save[1]?.body))).toMatchObject({ origin: 'https://pbx.example.com', clientId: 'client-id', departmentId: 7, secret: 'secret' });
    expect(request.mock.calls.some(([path]) => path.startsWith('/threecx/users'))).toBe(false);
  });

  it('uses hash navigation for the 3CX provider pill and exposes only real native setup links', () => {
    window.history.replaceState({}, '', '/extensions/cloudcommand/connect#threecx');
    const { page } = mount();
    const root = page.shadowRoot!;
    const pill = root.querySelector<HTMLButtonElement>('[data-provider="threecx"]')!;
    expect(pill.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector<HTMLButtonElement>('[data-provider="microsoft"]')).toBeTruthy();
    expect(root.querySelector('[data-provider="checkpoint"]')).toBeNull();
    pill.focus();
    pill.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    pill.click();
    expect(window.location.hash).toBe('#threecx');
  });

  it('replaces the child on an organization change so its prior draft cannot survive', async () => {
    const request = vi.fn(async () => Response.json({ connected: false, canManage: true }));
    const { page } = mount(request);
    await flush();
    const oldChild = page.shadowRoot!.querySelector<HTMLElement>('cloudcommand-threecx-page')!;
    (oldChild.shadowRoot!.querySelector('#origin') as HTMLInputElement).value = 'https://old.example.com';
    page.context = context('org-b');
    await flush();
    expect(page.shadowRoot!.querySelector('cloudcommand-threecx-page')).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    page.hostApi = { request: async () => Response.json({ connected: false, canManage: true }) };
    await flush();
    const newChild = page.shadowRoot!.querySelector<HTMLElement>('cloudcommand-threecx-page')!;
    expect(newChild).not.toBe(oldChild);
    expect((newChild.shadowRoot!.querySelector('#origin') as HTMLInputElement).value).not.toBe('https://old.example.com');
  });

  it('keeps a same-organization draft when the host refreshes its bridge', async () => {
    const { page } = mount();
    await flush();
    const child = page.shadowRoot!.querySelector<HTMLElement>('cloudcommand-threecx-page')!;
    (child.shadowRoot!.querySelector('#origin') as HTMLInputElement).value = 'https://draft.example.com';
    page.hostApi = { request: async () => Response.json({ connected: false, canManage: true }) };
    page.context = context();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-provider="threecx"]')!.click();
    await flush();
    expect(page.shadowRoot!.querySelector('cloudcommand-threecx-page')).toBe(child);
    expect((child.shadowRoot!.querySelector('#origin') as HTMLInputElement).value).toBe('https://draft.example.com');
  });

  it('hides credential actions for readers', async () => {
    const { page } = mount(async () => Response.json({ connected: true, canManage: false, enabled: true }));
    await flush();
    const child = page.shadowRoot!.querySelector<HTMLElement>('cloudcommand-threecx-page')!;
    expect(child.shadowRoot!.textContent).toContain('read-only access');
    expect(child.shadowRoot!.querySelector('#secret')).toBeNull();
    expect(child.shadowRoot!.querySelector('#save')).toBeNull();
  });

  it('does not render a late connection from the prior organization', async () => {
    let finish!: (response: Response) => void;
    const { page } = mount(() => new Promise<Response>(resolve => { finish = resolve; }));
    page.context = context('org-b');
    page.hostApi = { request: async () => Response.json({ connected: false, canManage: false }) };
    await flush();
    finish(Response.json({ connected: true, canManage: true, origin: 'https://old.example.com' }));
    await flush();
    const child = page.shadowRoot!.querySelector<HTMLElement>('cloudcommand-threecx-page')!;
    expect(child.shadowRoot!.querySelector('#origin')).toBeNull();
    expect(child.shadowRoot!.textContent).not.toContain('old.example.com');
  });

  it('selects native provider panels and restores them through hash navigation', async () => {
    const { page } = mount();
    page.shadowRoot!.querySelector<HTMLButtonElement>('[data-provider="microsoft"]')!.click();
    expect(page.shadowRoot!.querySelector('cloudcommand-microsoft-connect')).toBeTruthy();
    expect(page.shadowRoot!.querySelector('a')).toBeNull();
    window.history.replaceState({}, '', '/extensions/cloudcommand/connect#google');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(page.shadowRoot!.querySelector('a')!.getAttribute('href')).toBe('/integrations#google');
    expect(page.shadowRoot!.querySelector('cloudcommand-threecx-page')).toBeNull();
    window.history.replaceState({}, '', '/extensions/cloudcommand/connect#threecx');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flush();
    expect(page.shadowRoot!.querySelector('cloudcommand-threecx-page')).toBeTruthy();
  });
  it('selects Microsoft when an OAuth callback is present before the hash is restored', () => {
    window.history.replaceState({}, '', '/extensions/cloudcommand/connect?state=callback-state&admin_consent=True&tenant=tenant-a');
    const { page } = mount();
    expect(page.shadowRoot!.querySelector('cloudcommand-microsoft-connect')).toBeTruthy();
  });
});
