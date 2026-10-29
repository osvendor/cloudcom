import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { agentRequestConcurrency } from './agentRequestConcurrency';
import { agentAdmission, createUnifiConfigBudget } from './agentAdmission';
const path = '/api/v1/agents/' + 'a'.repeat(64) + '/heartbeat';
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
it('queues agents before downstream work while human auth bypasses the queue', async () => {
  const app = new Hono(); app.use('*', agentRequestConcurrency(1));
  const entered: string[] = []; const release: Array<() => void> = [];
  app.all('*', async c => { entered.push(c.req.query('n') ?? 'auth'); if (c.req.path === path) await new Promise<void>(r => release.push(r)); return c.text('ok'); });
  const first = app.request(path + '?n=1'); await flush();
  const second = app.request(path + '?n=2'); const third = app.request(path + '?n=3'); await flush();
  expect(entered).toEqual(['1']); expect((await app.request('/api/v1/auth/cf-access-login')).status).toBe(200);
  release.shift()!(); await first; await flush(); expect(entered).toEqual(['1', 'auth', '2']);
  release.shift()!(); await second; await flush(); expect(entered.at(-1)).toBe('3'); release.shift()!(); await third;
});
it('removes an aborted queued client and hands the permit to the next live client', async () => {
  const app = new Hono(); app.use('*', agentRequestConcurrency(1)); let calls = 0; let finish!: () => void;
  app.all('*', async c => { calls++; if (calls === 1) await new Promise<void>(r => { finish = r; }); return c.text('ok'); });
  const first = app.request(path); await flush(); const abort = new AbortController();
  const cancelled = app.request(new Request('http://localhost' + path, { signal: abort.signal }));
  const next = app.request(path); await flush(); abort.abort(); expect((await cancelled).status).toBe(499);
  expect(calls).toBe(1); finish(); await first; expect((await next).status).toBe(200); expect(calls).toBe(2);
});
it('releases permits when downstream throws and leaves downloads outside the agent queue', async () => {
  const app = new Hono(); app.use('*', agentRequestConcurrency(1)); let calls = 0;
  app.onError((_e, c) => c.text('failed', 500)); app.all('*', c => { if (++calls === 1) throw Error('failed'); return c.text('ok'); });
  expect((await app.request(path)).status).toBe(500); expect((await app.request(path)).status).toBe(200);
  expect((await app.request('/api/v1/agents/download/windows/amd64')).status).toBe(200);
});
it('rejects invalid capacity settings rather than silently accepting NaN or unbounded limits', () => {
  for (const limit of [NaN, -1, 1.5, 65]) expect(() => agentRequestConcurrency(limit)).toThrow();
});

it('allows only the reserved config lane past a busy agent FIFO while preserving auth and its single slot', async () => {
  const app = new Hono();
  app.use('*', agentAdmission(() => ({ mode: 'enforce', decide: () => ({ action: 'shed', reason: 'level', retryAfterSec: 30 }) }), createUnifiConfigBudget(() => 0)));
  app.use('*', agentRequestConcurrency(1));
  let releaseHeartbeat!: () => void;
  let releaseConfig!: () => void;
  let configStarted = false;
  app.post('/api/v1/agents/:id/heartbeat', async c => { await new Promise<void>(r => { releaseHeartbeat = r; }); return c.text('ok'); });
  app.get('/api/v1/agents/:id/unifi-collectors', async c => {
    configStarted = true;
    await new Promise<void>(r => { releaseConfig = r; });
    return c.json({ error: 'Unauthorized' }, 401);
  });
  const heartbeat = app.request(path, { method: 'POST' }); await flush();
  const configPath = path.replace('heartbeat', 'unifi-collectors');
  const config = app.request(configPath); await flush();
  expect(configStarted).toBe(true);
  expect((await app.request(configPath)).status).toBe(503);
  releaseConfig(); expect((await config).status).toBe(401);
  releaseHeartbeat(); expect((await heartbeat).status).toBe(200);
});

it('does not let an unmarked config path or a client header bypass a busy FIFO', async () => {
  const app = new Hono(); app.use('*', agentRequestConcurrency(1));
  let release!: () => void; let configCalls = 0;
  app.get('/api/v1/agents/:id/heartbeat', async c => { await new Promise<void>(r => { release = r; }); return c.text('ok'); });
  app.get('/api/v1/agents/:id/unifi-collectors', c => { configCalls++; return c.text('ok'); });
  const heartbeat = app.request(path); await flush();
  const config = app.request(path.replace('heartbeat', 'unifi-collectors'), { headers: { unifiConfigAdmissionReserved: 'true', 'x-unifi-config-admission-reserved': 'true' } });
  await flush(); expect(configCalls).toBe(0);
  release(); await heartbeat; expect((await config).status).toBe(200); expect(configCalls).toBe(1);
});

it('requires the exact config method and path even when an internal marker is present', async () => {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('unifiConfigAdmissionReserved', true); await next(); });
  app.use('*', agentRequestConcurrency(1));
  let release!: () => void; let calls = 0;
  app.all('*', async c => { calls++; if (calls === 1) await new Promise<void>(r => { release = r; }); return c.text('ok'); });
  const first = app.request(path); await flush();
  const wrongMethod = app.request(path.replace('heartbeat', 'unifi-collectors'), { method: 'POST' });
  await flush(); expect(calls).toBe(1);
  release(); await first; await wrongMethod; expect(calls).toBe(2);
});
