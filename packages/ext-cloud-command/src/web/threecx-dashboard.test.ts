import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandThreeCxDashboardPage } from './threecx-dashboard';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const context = (organizationId = 'org-a') => ({ contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/threecx-dashboard', organizationId });
const dashboard = (over: Record<string, unknown> = {}) => ({ scope: 'department', extensions: { total: 2, registered: 1, complete: true }, status: null, statusAvailability: 'department_scoped', checkedAt: '2026-09-22T00:00:00Z', ...over });
afterEach(() => document.body.replaceChildren());
describe('3CX dashboard page', () => {
  it('labels department counts and suppresses PBX-wide fields', async () => {
    const page = new CloudCommandThreeCxDashboardPage();
    page.context = context(); page.hostApi = { request: async () => Response.json(dashboard()) }; document.body.append(page);
    await flush();
    expect(page.shadowRoot!.textContent).toContain('Selected department');
    expect(page.shadowRoot!.textContent).toContain('PBX-wide status is hidden');
    expect(page.shadowRoot!.textContent).toContain('Registered');
  });
  it('marks incomplete counts and renders full PBX status', async () => {
    const page = new CloudCommandThreeCxDashboardPage();
    page.context = context(); page.hostApi = { request: async () => Response.json(dashboard({ scope: 'full_pbx', extensions: { total: 1000, registered: 7, complete: false }, statusAvailability: 'available', status: { Version: '20.0', CallsActive: 3, MaxSimCalls: 9, TrunksRegistered: 1, TrunksTotal: 2, HasNotRunningServices: false, BackupScheduled: true } })) }; document.body.append(page);
    await flush();
    expect(page.shadowRoot!.textContent).toContain('Partial extension count');
    expect(page.shadowRoot!.textContent).toContain('Active calls');
    expect(page.shadowRoot!.textContent).toContain('20.0');
  });
  it('does not render a previous organization response', async () => {
    const resolves: Array<(value: Response) => void> = [];
    const request = vi.fn(() => new Promise<Response>(done => { resolves.push(done); }));
    const page = new CloudCommandThreeCxDashboardPage(); page.context = context(); page.hostApi = { request }; document.body.append(page);
    page.context = context('org-b');
    resolves[0](Response.json(dashboard()));
    await flush();
    expect(page.shadowRoot!.textContent).not.toContain('Selected department');
  });
});
