import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createRoutes } from './index';
import { projectCallLog } from './threecx-call-log';
import { ProviderError } from './transport';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const row = (department: number | null) => ({ id: '33333333-3333-4333-8333-333333333333', org_id: ORG, origin: 'https://pbx.example.test', client_id: 'client', secret_ciphertext: 'cipher', department_id: department, enabled: true, version: 1, last_verified_at: null });
const range = 'start=2026-09-21T00%3A00%3A00.000Z&end=2026-09-22T00%3A00%3A00.000Z';
function harness(department: number | null, access = true) {
  const queue = [[{ partner_id: PARTNER }], [row(department)], [{ partner_id: PARTNER }], [row(department)]];
  const db = { execute: vi.fn(async () => queue.shift() ?? []) };
  const secrets = { decryptForColumn: vi.fn(() => 'plain-secret'), encryptForColumn: vi.fn() };
  const fetch = vi.fn();
  const audit = vi.fn();
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => {
    c.set('auth', { user: { id: ORG }, partnerId: PARTNER, canAccessOrg: () => access });
    c.set('extensionAuthorization', { hasPermission: (_resource: string, action: string) => action === 'read', mfaSatisfied: false });
    await next();
  });
  app.route('/', createRoutes({ db, secrets, audit, log: vi.fn() } as never, fetch));
  return { app, db, secrets, fetch, audit };
}
const read = (app: Hono<{ Variables: Record<string, unknown> }>, query = range) => app.request(`http://local/threecx/call-log?orgId=${ORG}&${query}`);

describe('3CX call log', () => {
  it('denies cross-organization access before connection or credential reads', async () => {
    const h = harness(null, false);
    expect((await read(h.app)).status).toBe(403);
    expect(h.db.execute).not.toHaveBeenCalled();
    expect(h.secrets.decryptForColumn).not.toHaveBeenCalled();
  });
  it('fails closed for department-scoped connections without contacting the PBX', async () => {
    const h = harness(7);
    const response = await read(h.app);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'report_scope_unverified' });
    expect(h.secrets.decryptForColumn).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'cloudcommand.threecx.call_log.read', result: 'failure', details: { reason: 'report_scope_unverified' } }));
  });
  it.each(['start=not-a-date&end=2026-09-22T00%3A00%3A00.000Z', 'start=2026-09-21T00%3A00%3A00.000Z&end=2026-10-23T00%3A00%3A00.000Z'])('rejects invalid bounded queries: %s', async query => {
    const h = harness(null);
    expect((await read(h.app, query)).status).toBe(400);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('rejects unbounded or misaligned offsets before contacting the PBX', async () => {
    const h = harness(null);
    const response = await read(h.app, `${range}&skip=101`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_report_page' });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('uses one fixed PBX function and returns only allowlisted call metadata', async () => {
    const h = harness(null);
    h.fetch.mockResolvedValueOnce(Response.json({ access_token: 'token' })).mockResolvedValueOnce(Response.json({ value: [{ CallId: 'abc', StartTime: '2026-09-21T12:00:00Z', SourceDn: '100', DestinationDn: '200', Answered: true, TalkingDuration: '0:01:00', secret: 'must-not-leak' }] }));
    const response = await read(h.app);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ scope: 'full_pbx', items: [{ CallId: 'abc', Answered: true }], nextSkip: null });
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
    const url = String(h.fetch.mock.calls[1][0]);
    expect(url).toContain('/xapi/v1/ReportCallLogData/Pbx.GetCallLogData(');
    expect(url).toContain('%24top=100');
    expect(url).not.toContain('must-not-leak');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'cloudcommand.threecx.call_log.read', result: 'success', details: { returned: 1, truncated: false, offset: 0 } }));
  });
  it('permits only provider-confirmed same-function offset continuation', async () => {
    const h = harness(null);
    h.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/connect/token')) return Response.json({ access_token: 'token' });
      const next = new URL(url);
      next.searchParams.set('$skip', '100');
      return Response.json({ value: [{ CallId: 'one' }], '@odata.nextLink': next.toString() });
    });
    const first = await (await read(h.app)).json();
    expect(first).toMatchObject({ nextSkip: 100, truncated: true });
    const second = await (await read(h.app, `${range}&skip=100&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(second).toMatchObject({ nextSkip: null, truncated: true });
  });
  it('rejects an invented or altered page cursor before PBX access', async () => {
    const h = harness(null);
    const response = await read(h.app, `${range}&skip=100&cursor=${'0'.repeat(13)}.${'a'.repeat(64)}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'invalid_report_cursor' });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('ignores a provider continuation that changes the function query', async () => {
    const h = harness(null);
    h.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/connect/token')) return Response.json({ access_token: 'token' });
      const next = new URL(url);
      next.searchParams.set('$skip', '100');
      next.searchParams.set('$top', '1000');
      return Response.json({ value: [{ CallId: 'one' }], '@odata.nextLink': next.toString() });
    });
    expect(await (await read(h.app)).json()).toMatchObject({ nextSkip: null, truncated: true });
  });
  it('ignores a provider continuation that changes the report path', async () => {
    const h = harness(null);
    h.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/connect/token')) return Response.json({ access_token: 'token' });
      const next = new URL(url);
      next.pathname = '/xapi/v1/Users';
      next.searchParams.set('$skip', '100');
      return Response.json({ value: [{ CallId: 'one' }], '@odata.nextLink': next.toString() });
    });
    expect(await (await read(h.app)).json()).toMatchObject({ nextSkip: null, truncated: true });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it('labels provider continuation as incomplete and never returns an offset cursor', async () => {
    const h = harness(null);
    h.fetch.mockResolvedValueOnce(Response.json({ access_token: 'token' })).mockResolvedValueOnce(Response.json({ value: [{ CallId: 'one' }], '@odata.nextLink': 'https://untrusted.example/next' }));
    const body = await (await read(h.app)).json();
    expect(body).toMatchObject({ truncated: true, nextSkip: null });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed call payloads rather than forwarding provider objects', () => {
    expect(() => projectCallLog({ Answered: 'yes' })).toThrow(ProviderError);
    expect(() => projectCallLog({ SourceDn: '<script>\n' })).toThrow(ProviderError);
  });
});
