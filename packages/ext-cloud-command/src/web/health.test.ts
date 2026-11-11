import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandHealthPage } from './health';
import type { AlertWorkload, AlertWorkloadGroup } from '../server/health';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const context = (organizationId = 'org-a') => ({ contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/health', organizationId });
const payload = (cards: Array<{ id: string; title: string; status: 'healthy' | 'unknown' | 'attention' | 'critical'; value: string; detail: string }> = [{ id: 'api', title: 'API', status: 'healthy', value: 'Ready', detail: 'All systems nominal.' }]) => ({ checkedAt: new Date().toISOString(), refreshSeconds: 30, targetEndpoints: 500, cards, enrolled: 12 });
const group = (group: string, label: string, totalMs = 0): AlertWorkloadGroup => ({
  group, label, evaluations: totalMs ? 10 : 0, perMinute: totalMs ? 2 : 0,
  totalMs, averageMs: totalMs / 10, maxMs: totalMs, errors: 0, queryCount: 0, dbElapsedMs: 0,
});
const workload = (groups: AlertWorkloadGroup[], observedMs = 300_000): AlertWorkload => ({ windowMs: 300_000, bucketMs: 5000, observedMs, groups });
function mount(request: (path: string) => Promise<Response>) {
  const page = new CloudCommandHealthPage();
  page.context = context();
  page.hostApi = { request };
  document.body.append(page);
  return page;
}

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

describe('operations health page', () => {
  it('renders and sorts individual monitors without requests or adding to parent totals', async () => {
    const detail = (id: string, label: string, totalMs: number) => {
      const { group: _group, ...metrics } = group('scripts', label, totalMs);
      return { id, ...metrics, queryCount: totalMs, dbElapsedMs: totalMs / 2 };
    };
    const request = vi.fn(async () => Response.json({ ...payload(), alertWorkload: {
      ...workload([group('scripts', 'Scripts / RustDesk', 600)]), scriptMonitorLimit: 64,
      scriptMonitors: [detail('a', 'Managed RustDesk', 100), detail('b', 'OS-TEST', 300), detail('c', 'Default RustDesk', 200)],
    } }));
    const page = mount(request); await flush();
    const rows = () => [...page.shadowRoot!.querySelectorAll('[data-script-monitor]')].map(row => row.getAttribute('data-script-monitor'));
    expect(rows()).toEqual(['b', 'c', 'a']);
    expect(page.shadowRoot!.querySelectorAll('[data-workload-group="scripts"]')).toHaveLength(1);
    expect(page.shadowRoot!.querySelector('[data-workload-group="scripts"]')!.textContent).toContain('600 ms');
    (page.shadowRoot!.querySelector('.monitor-breakdown [data-workload-sort="totalMs"]') as HTMLButtonElement).click();
    expect(rows()).toEqual(['a', 'c', 'b']);
    expect(request).toHaveBeenCalledTimes(1);
    expect(page.shadowRoot!.textContent).toContain('saved-result evaluations, not script launches');
    expect(page.shadowRoot!.textContent).toContain('an absent monitor does not mean zero cost');
  });

  it('escapes monitor names, distinguishes duplicate names, and shows overflow', async () => {
    const { group: _group, ...metrics } = group('scripts', '<script>same</script>', 100);
    const page = mount(async () => Response.json({ ...payload(), alertWorkload: {
      ...workload([group('scripts', 'Scripts', 300)]), scriptMonitorLimit: 64,
      scriptMonitors: [{ ...metrics, id: 'one' }, { ...metrics, id: 'two' }, { ...metrics, id: '__other_script_monitors__', label: 'Other script monitors (detail limit reached)' }],
    } }));
    await flush();
    expect(page.shadowRoot!.querySelector('script')).toBeNull();
    expect([...page.shadowRoot!.querySelectorAll('.monitor-id')].map(node => node.textContent)).toEqual(['one', 'two']);
    expect(page.shadowRoot!.textContent).toContain('detail limit reached');
  });

  it('shows empty and invalid detail states without suppressing valid group totals', async () => {
    let details: unknown = [];
    const page = mount(async () => Response.json({ ...payload(), alertWorkload: {
      ...workload([group('scripts', 'Scripts', 100)]), scriptMonitorLimit: 64, scriptMonitors: details,
    } }));
    await flush();
    expect(page.shadowRoot!.textContent).toContain('No individual script monitors observed');
    details = [{ id: 'bad', label: 'Bad', totalMs: -1 }];
    (page.shadowRoot!.querySelector('#refresh') as HTMLButtonElement).click(); await flush();
    expect(page.shadowRoot!.textContent).toContain('Individual monitor telemetry is unavailable');
    expect(page.shadowRoot!.querySelector('[data-workload-group="scripts"]')).toBeTruthy();
  });

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

  it('keeps older backends usable and shows unavailable rather than zero telemetry', async () => {
    const page = mount(async () => Response.json(payload()));
    await flush();
    expect(page.shadowRoot!.textContent).toContain('All systems nominal.');
    expect(page.shadowRoot!.textContent).toContain('Per-group telemetry is unavailable');
    expect(page.shadowRoot!.querySelector('.workload table')).toBeNull();
  });

  it('sorts elapsed work descending by default and supports local header sorting without requests', async () => {
    const request = vi.fn(async () => Response.json({ ...payload(), alertWorkload: workload([
      group('network', 'Network', 50), group('scripts', 'Scripts / RustDesk', 300), group('hardware', 'Hardware', 100),
    ]) }));
    const page = mount(request);
    await flush();
    const rows = () => [...page.shadowRoot!.querySelectorAll('tbody tr')].map(row => row.getAttribute('data-workload-group'));
    expect(rows()).toEqual(['scripts', 'hardware', 'network']);
    expect(page.shadowRoot!.querySelector('[aria-sort="descending"]')!.textContent).toContain('Total time');
    (page.shadowRoot!.querySelector('[data-workload-sort="totalMs"]') as HTMLButtonElement).click();
    expect(rows()).toEqual(['network', 'hardware', 'scripts']);
    (page.shadowRoot!.querySelector('[data-workload-sort="label"]') as HTMLButtonElement).click();
    expect(rows()).toEqual(['hardware', 'network', 'scripts']);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('shows zero activity, partial windows, and shared preparation separately from checks', async () => {
    const prep = { ...group('preparation', 'Shared preparation', 20), evaluations: 2, perMinute: 4 };
    const page = mount(async () => Response.json({ ...payload(), alertWorkload: workload([
      group('network', 'Network'), group('hardware', 'Hardware'), prep,
    ], 30_000) }));
    await flush();
    expect(page.shadowRoot!.textContent).toContain('No alert-group evaluations recorded in this window.');
    expect(page.shadowRoot!.textContent).toContain('30 seconds observed');
    expect(page.shadowRoot!.querySelector('tbody [data-workload-group="preparation"]')).toBeNull();
    expect(page.shadowRoot!.querySelector('.preparation')!.textContent).toContain('2 runs · 4 runs/min');
    expect(page.shadowRoot!.textContent).toContain('not counted as checks');
    expect(page.shadowRoot!.textContent).toContain('Process-local measurements reset on restart');
    expect(page.shadowRoot!.textContent).toContain('not CPU percentages');
    expect(page.shadowRoot!.textContent).not.toContain('NaN');
  });

  it('escapes group labels and renders measured database time, query counts and errors', async () => {
    const row = { ...group('network', '<img src=x onerror=alert(1)>', 1200), queryCount: 7, dbElapsedMs: 1500, errors: 2 };
    const page = mount(async () => Response.json({ ...payload(), alertWorkload: workload([row]) }));
    await flush();
    const cells = page.shadowRoot!.querySelectorAll('tbody tr td');
    expect(page.shadowRoot!.querySelector('img')).toBeNull();
    expect(page.shadowRoot!.innerHTML).toContain('&lt;img');
    expect(cells[3]!.textContent).toContain('1.5 s');
    expect(cells[4]!.textContent).toBe('7');
    expect(cells[5]!.textContent).toBe('2');
    expect(cells[5]!.classList.contains('critical')).toBe(true);
    expect(page.shadowRoot!.textContent).toContain('driver and network waits');
    expect(page.shadowRoot!.textContent).toContain('sum can exceed total time');
  });

  it.each([
    { ...workload([]), observedMs: -1 },
    workload([group('unbounded-client-id', 'Unknown')]),
    workload([group('network', 'Network'), group('network', 'Duplicate')]),
    workload([{ ...group('network', 'Network'), totalMs: 'bad' as unknown as number }]),
  ])('rejects invalid telemetry without breaking the remaining health cards', async alertWorkload => {
    const page = mount(async () => Response.json({ ...payload(), alertWorkload }));
    await flush();
    expect(page.shadowRoot!.textContent).toContain('Per-group telemetry is unavailable');
    expect(page.shadowRoot!.textContent).toContain('All systems nominal.');
  });

  it('escapes request errors and clears previous workload rows', async () => {
    let calls = 0;
    const page = mount(async () => {
      if (++calls === 1) return Response.json({ ...payload(), alertWorkload: workload([group('network', 'Network')]) });
      throw new Error('<img src=x onerror=alert(1)>');
    });
    await flush();
    (page.shadowRoot!.querySelector('#refresh') as HTMLButtonElement).click();
    await flush();
    expect(page.shadowRoot!.querySelector('img')).toBeNull();
    expect(page.shadowRoot!.querySelector('.workload')).toBeNull();
    expect(page.shadowRoot!.querySelector('[role=alert]')!.innerHTML).toContain('&lt;img');
  });
});
