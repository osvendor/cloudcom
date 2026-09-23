import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandThreeCxCallLogPage } from './threecx-call-log';

const context = { contractVersion: 1 as const, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/threecx-call-log', organizationId: 'org-a' };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function mount(request: (path: string) => Promise<Response>) {
  const page = new CloudCommandThreeCxCallLogPage();
  page.context = context;
  page.hostApi = { request };
  document.body.append(page);
  return page;
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
describe('3CX Call Log page', () => {
  it('does not query call reports until an operator searches', async () => {
    const request = vi.fn(async () => Response.json({ items: [], nextSkip: null, scope: 'full_pbx' }));
    const page = mount(request);
    await flush();
    expect(page.shadowRoot!.textContent).toContain('Full-PBX reports only');
    expect(request).not.toHaveBeenCalled();
  });
  it('explains department isolation refusal without showing records', async () => {
    const page = mount(async () => Response.json({ code: 'report_scope_unverified' }, { status: 403 }));
    page.shadowRoot!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(page.shadowRoot!.textContent).toContain('unavailable for department-scoped connections');
    expect(page.shadowRoot!.querySelector('table')).toBeNull();
  });
  it('renders escaped call metadata and marks incomplete loaded results', async () => {
    const page = mount(async () => Response.json({ scope: 'full_pbx', items: [{ StartTime: '2026-09-22', SourceDn: '<img src=x>', DestinationDn: '200', Status: 'Answered', TalkingDuration: '0:01:00', Direction: 'Inbound', Answered: true }], nextSkip: null, truncated: true }));
    page.shadowRoot!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(page.shadowRoot!.textContent).toContain('<img src=x>');
    expect(page.shadowRoot!.querySelector('img')).toBeNull();
    expect(page.shadowRoot!.textContent).toContain('continuation is unavailable');
    expect(page.shadowRoot!.querySelector('#export')).toBeTruthy();
  });
});
