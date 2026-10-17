import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandHealthPage } from './health';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const context = (organizationId = 'org-a') => ({ contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/health', organizationId });
const payload = (cards: Array<{ id: string; title: string; status: 'healthy' | 'unknown' | 'attention' | 'critical'; value: string; detail: string }> = [{ id: 'api', title: 'API', status: 'healthy', value: 'Ready', detail: 'All systems nominal.' }]) => ({ checkedAt: new Date().toISOString(), refreshSeconds: 30, targetEndpoints: 500, cards, enrolled: 12 });
function mount(request: (path: string) => Promise<Response>) {
  const page = new CloudCommandHealthPage();
  page.context = context();
  page.hostApi = { request };
  document.body.append(page);
  return page;
}

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

describe('operations health page', () => {
  it('shows the platform administrator message on 403', async () => {
    const page = mount(async () => new Response('{}', { status: 403 }));
    await flush();
    expect(page.shadowRoot!.textContent).toContain('Operations health access is not assigned to this account.');
  });

  it('clears a successful response after a later failure', async () => {
    let calls = 0;
    const page = mount(async () => ++calls === 1 ? Response.json(payload()) : new Response('{}', { status: 503 }));
    await flush();
    expect(page.shadowRoot!.textContent).toContain('All systems nominal.');
    (page.shadowRoot!.querySelector('#refresh') as HTMLButtonElement).click();
    await flush();
    expect(page.shadowRoot!.textContent).not.toContain('All systems nominal.');
    expect(page.shadowRoot!.textContent).toContain('Operations health is unavailable.');
  });

  it('uses critical severity, escapes values, and shows rollout context', async () => {
    const page = mount(async () => Response.json(payload([
      { id: 'unknown', title: '<unknown>', status: 'unknown', value: 'u', detail: 'u' },
      { id: 'attention', title: 'Attention', status: 'attention', value: 'a', detail: 'a' },
      { id: 'critical', title: 'Critical', status: 'critical', value: '<script>alert(1)</script>', detail: 'c' },
    ])));
    await flush();
    expect(page.shadowRoot!.querySelector('[role="status"]')!.textContent).toContain('critical');
    expect(page.shadowRoot!.innerHTML).toContain('&lt;unknown&gt;');
    expect(page.shadowRoot!.innerHTML).not.toContain('<script>alert(1)</script>');
    expect(page.shadowRoot!.textContent).toContain('This target describes rollout progress, not server capacity.');
    expect(page.shadowRoot!.querySelector('.meter')).toBeTruthy();
    expect(page.shadowRoot!.querySelector('.meter')!.getAttribute('aria-label')).toContain('0 healthy');
    expect(page.shadowRoot!.querySelector('.meter')!.getAttribute('aria-label')).toContain('1 attention');
    expect(page.shadowRoot!.querySelector('.meter')!.getAttribute('aria-label')).toContain('1 critical');
    expect(page.shadowRoot!.querySelector('.meter')!.getAttribute('aria-label')).toContain('1 unknown');
    expect(page.shadowRoot!.querySelector('.meter .critical')!.getAttribute('style')).toContain('width:33.33333333333333%');
  });

  it('stops polling when hidden or disconnected', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const page = mount(async () => { calls += 1; return Response.json(payload()); });
    await Promise.resolve();
    expect(calls).toBe(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(1);
    page.remove();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(1);
  });

  it('ignores a late response from an invalidated context and times out hangs', async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const page = mount(() => new Promise<Response>(r => { resolve = r; }));
    page.context = context('org-b');
    resolve(Response.json(payload([{ id: 'old', title: 'Old', status: 'healthy', value: 'old', detail: 'old' }])));
    await vi.runOnlyPendingTimersAsync();
    expect(page.shadowRoot!.textContent).not.toContain('Old');
    const hanging = mount(() => new Promise<Response>(() => {}));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hanging.shadowRoot!.textContent).toContain('Operations health request timed out.');
  });
});
