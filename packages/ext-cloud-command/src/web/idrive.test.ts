import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandIDrivePage } from './idrive';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const context = (org = 'org-a') => ({ contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/idrive', organizationId: org });
const inventory = { devices: [{ device_id: 'a', name: 'Client PC', backup_status: 'Success', last_backup: '2026-10-13T01:00:00' }], plans: [], groups: [], attention: [] };
function mount(request: (path: string, init?: RequestInit) => Promise<Response>) {
  const page = new CloudCommandIDrivePage(); page.context = context(); page.hostApi = { request }; document.body.append(page); return page;
}
const read = async (path: string) => Response.json(path === '/idrive/connection' ? { connected: true, enabled: true, canManage: true, companyName: 'Test company', groupName: 'Test client', groupId: 10 } : path === '/idrive/inventory' ? inventory : { operations: [] });
afterEach(() => document.body.replaceChildren());
describe('IDrive page', () => {
  it('loads client backup inventory and refreshes without writes', async () => {
    const request = vi.fn(read); const page = mount(request); await flush();
    expect(page.shadowRoot!.textContent).toContain('Client PC');
    expect(page.shadowRoot!.textContent).toContain('Test client');
    expect(request.mock.calls.map(c => c[0])).toEqual(['/idrive/connection', '/idrive/inventory', '/idrive/history']);
  });
  it('renders provider text safely', async () => {
    const page = mount(async path => path === '/idrive/inventory' ? Response.json({ ...inventory, devices: [{ device_id: 'a', name: '<img src=x onerror=alert(1)>' }] }) : read(path));
    await flush(); expect(page.shadowRoot!.querySelector('img')).toBeNull();
    expect(page.shadowRoot!.textContent).toContain('<img');
  });
  it('requires preview and an explicit apply before a mutation', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => path === '/idrive/preview' ? Response.json({ previewId: 'preview', action: JSON.parse(init!.body as string), companyName: 'Test', groupName: 'Client', providerPreview: {} }) : read(path));
    const page = mount(request); await flush();
    (page.shadowRoot!.querySelector('[data-tag]') as HTMLButtonElement).click();
    (page.shadowRoot!.querySelector('#edit-tag') as HTMLInputElement).value = 'Server';
    (page.shadowRoot!.querySelector('#preview') as HTMLButtonElement).click(); await flush();
    expect(request.mock.calls.some(c => c[0] === '/idrive/execute')).toBe(false);
    expect(page.shadowRoot!.textContent).toContain('Apply this change');
    expect(page.shadowRoot!.textContent).toContain('Server');
  });
  it('clears client details and ignores late responses when switching organization', async () => {
    let resolve!: (r: Response) => void;
    const page = mount(() => new Promise(r => resolve = r));
    page.context = context('org-b'); resolve(Response.json({ connected: true, enabled: true, companyName: 'Old client' })); await flush();
    expect(page.shadowRoot!.textContent).not.toContain('Old client');
    page.hostApi = { request: read }; await flush();
    expect(page.shadowRoot!.textContent).toContain('Client PC');
  });
});
