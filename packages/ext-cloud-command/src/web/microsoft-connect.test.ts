import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandMicrosoftConnect } from './microsoft-connect';
import type { CloudCommandHostApi } from './index';

const context = (organizationId = 'org-a') => ({ contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/connect', organizationId });
const tenantId = '11111111-1111-4111-8111-111111111111';
const status = (extra = {}) => ({ state: 'needs_attention', canManage: true, canStart: false, reason: 'Administration setup is pending.', capabilities: [{ id: 'directory', label: 'Directory inventory', status: 'ready' }, { id: 'exchange', label: 'Exchange administration', status: 'pending' }], ...extra });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function mount(request: CloudCommandHostApi['request']) {
  const page = new CloudCommandMicrosoftConnect();
  page.context = context(); page.hostApi = { request }; document.body.append(page); return page;
}
afterEach(() => { document.body.replaceChildren(); window.sessionStorage.clear(); window.history.replaceState({}, '', '/extensions/cloudcommand/connect#microsoft'); });

describe('Microsoft Connect onboarding', () => {
  it('shows individual readiness without claiming administration is ready or linking to a second setup', async () => {
    const page = mount(async () => Response.json(status())); await flush();
    expect(page.shadowRoot!.textContent).toContain('Setup needs attention');
    expect(page.shadowRoot!.textContent).toContain('Exchange administration');
    expect(page.shadowRoot!.querySelector('#start')).toBeNull();
    expect(page.shadowRoot!.querySelector('a')).toBeNull();
  });
  it('rechecks through the organization bridge and reports the outcome', async () => {
    const request = vi.fn(async () => Response.json(status()));
    const page = mount(request); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#recheck')!.click(); await flush();
    expect(request).toHaveBeenLastCalledWith('/microsoft/onboarding/recheck', { method: 'POST' });
    expect(page.shadowRoot!.textContent).toContain('Setup checked.');
  });
  it('surfaces failed rechecks and does not offer consent to readers', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json(status())).mockResolvedValueOnce(Response.json({}, { status: 503 }));
    const page = mount(request); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#recheck')!.click(); await flush();
    expect(page.shadowRoot!.querySelector('[role="alert"]')!.textContent).toContain('could not be checked');
    page.remove();
    const reader = mount(async () => Response.json(status({ canManage: false, canStart: true }))); await flush();
    expect(reader.shadowRoot!.querySelector('button')).toBeNull();
  });
  it('discards late responses after an organization change until a fresh bridge is supplied', async () => {
    let resolve!: (response: Response) => void;
    const page = mount(() => new Promise<Response>(done => { resolve = done; }));
    page.context = context('org-b');
    resolve(Response.json(status({ tenantName: 'Old tenant' }))); await flush();
    expect(page.shadowRoot!.textContent).not.toContain('Old tenant');
    page.hostApi = { request: async () => Response.json(status({ tenantName: 'New tenant' })) }; await flush();
    expect(page.shadowRoot!.textContent).toContain('New tenant');
  });
  it('does not deliver a consent link after provider navigation disconnects the page', async () => {
    let resolve!: (response: Response) => void;
    const request = vi.fn().mockResolvedValueOnce(Response.json(status({ canStart: true, tenantId }))).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const page = mount(request); await flush();
    page.shadowRoot!.querySelector<HTMLButtonElement>('#start')!.click(); page.remove();
    resolve(Response.json({ authorizationUrl: 'https://login.microsoftonline.com/common/adminconsent' })); await flush();
    expect(page.shadowRoot!.querySelector('a')).toBeNull();
  });
  it('rejects an unexpected authorization origin', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json(status({ canStart: true, tenantId }))).mockResolvedValueOnce(Response.json({ authorizationUrl: 'https://unexpected.example.com' }));
    const page = mount(request); await flush(); page.shadowRoot!.querySelector<HTMLButtonElement>('#start')!.click(); await flush();
    expect(page.shadowRoot!.querySelector('a')).toBeNull();
    expect(page.shadowRoot!.querySelector('[role="alert"]')).toBeTruthy();
  });
  it('sends the selected tenant and version, remembers the authorization origin, and continues in the same tab', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json(status({ canStart: true, tenantId, version: 7 }))).mockResolvedValueOnce(Response.json({ authorizationUrl: 'https://login.microsoftonline.com/common/adminconsent?state=first-state' }));
    const page = mount(request); await flush(); page.shadowRoot!.querySelector<HTMLButtonElement>('#start')!.click(); await flush();
    const start = request.mock.calls[1] as [string, RequestInit?];
    expect(JSON.parse(String(start[1]?.body))).toEqual({ tenantId, version: 7 });
    expect(window.sessionStorage.getItem('cloudcommand.microsoft.onboarding.first-state')).toBe('org-a');
    expect(page.shadowRoot!.querySelector('a')!.getAttribute('target')).toBeNull();
  });
  it('clears a callback URL and completes it only for its initiating organization', async () => {
    window.history.replaceState({}, '', '/extensions/cloudcommand/connect?state=return-state&code=secret-code#microsoft');
    window.sessionStorage.setItem('cloudcommand.microsoft.onboarding.return-state', 'org-a');
    const request = vi.fn().mockResolvedValueOnce(Response.json(status())).mockResolvedValueOnce(Response.json({ success: true })).mockResolvedValueOnce(Response.json(status({ state: 'ready' })));
    const page = mount(request); await flush(); await flush(); await flush();
    expect(window.location.search).toBe('');
    expect(request.mock.calls.some(([path]) => path === '/microsoft/onboarding/complete')).toBe(true);
    const complete = request.mock.calls.find(([path]) => path === '/microsoft/onboarding/complete')!;
    expect(JSON.parse(String(complete[1]?.body))).toEqual({ state: 'return-state', code: 'secret-code' });
    expect(page.shadowRoot!.textContent).toContain('Ready');
  });
  it('does not submit a callback in another organization', async () => {
    window.history.replaceState({}, '', '/extensions/cloudcommand/connect?state=wrong-org&error=access_denied#microsoft');
    window.sessionStorage.setItem('cloudcommand.microsoft.onboarding.wrong-org', 'org-a');
    const request = vi.fn(async () => Response.json(status()));
    const page = new CloudCommandMicrosoftConnect(); page.context = context('org-b'); page.hostApi = { request }; document.body.append(page); await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(page.shadowRoot!.textContent).toContain('Select the organization');
  });
});
