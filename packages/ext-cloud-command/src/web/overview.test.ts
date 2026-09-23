import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandOverviewPage } from './overview';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const context = (organizationId = 'org-a') => ({ contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/overview', organizationId });
function mount(request: (path: string) => Promise<Response>) {
 const page = new CloudCommandOverviewPage(); page.context = context(); page.hostApi = { request }; document.body.append(page); return page;
}
afterEach(() => document.body.replaceChildren());
describe('organization provider overview', () => {
 it('shows only enabled providers to a reader', async () => {
  const page = mount(async path => Response.json({ connected: true, canManage: false, enabled: path.startsWith('/microsoft'), available: true }));
  await flush();
  expect(page.shadowRoot!.querySelector('[data-provider="microsoft"]')).toBeTruthy();
  expect(page.shadowRoot!.querySelector('[data-provider="threecx"]')).toBeNull();
 });
 it('offers setup to managers but hides Microsoft until its backend is available', async () => {
  const page = mount(async path => Response.json({ connected: false, canManage: true, available: !path.startsWith('/microsoft') }));
  await flush();
  expect(page.shadowRoot!.textContent).toContain('Configure 3CX');
  expect(page.shadowRoot!.querySelector('[data-provider="microsoft"]')).toBeNull();
 });
 it('routes a manager configuration action to Connect', async () => {
  const page = mount(async () => Response.json({ connected: false, canManage: true, available: true }));
  await flush();
  const navigate = vi.fn(); page.addEventListener('breeze-extension-event', navigate);
  (page.shadowRoot!.querySelector('[data-provider="threecx"]') as HTMLButtonElement).click();
  expect(navigate.mock.calls[0][0].detail).toMatchObject({ path: '/extensions/cloudcommand/connect#threecx' });
 });
 it('reports partial status failure without hiding the working provider', async () => {
  const page = mount(async path => path.startsWith('/microsoft') ? Response.json({}, {status:503}) : Response.json({ connected:true, enabled:true }));
  await flush();
  expect(page.shadowRoot!.textContent).toContain('Some service statuses could not be loaded');
  expect(page.shadowRoot!.querySelector('[data-provider="threecx"]')).toBeTruthy();
 });
 it('clears old organization services immediately and ignores late responses', async () => {
  const pending: Array<(response:Response)=>void> = [];
  const page = mount(() => new Promise<Response>(resolve => pending.push(resolve)));
  page.context = context('org-b');
  pending.slice(3).forEach(resolve => resolve(Response.json({ connected:false, canManage:false, available:true })));
  await flush();
  pending.slice(0,3).forEach(resolve => resolve(Response.json({ connected:true, enabled:true, available:true })));
  await flush();
  expect(page.shadowRoot!.querySelector('[data-provider]')).toBeNull();
  expect(page.shadowRoot!.textContent).toContain('No enabled services');
 });
});
