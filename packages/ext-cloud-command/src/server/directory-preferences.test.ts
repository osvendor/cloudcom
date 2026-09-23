import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountDirectoryPreferenceRoutes } from './directory-preferences';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ACTOR_A = '33333333-3333-4333-8333-333333333333';
const ACTOR_B = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
function harness(options: { org?: string; actor?: string; manage?: boolean; rows?: unknown[] } = {}) {
  const execute = vi.fn(async () => options.rows?.shift() ?? []);
  const audit = vi.fn(async () => undefined);
  const app = new Hono<{ Variables: any }>();
  app.use('*', async (c, next) => {
    c.set('scope', { organizationId: options.org ?? ORG_A, actorId: options.actor ?? ACTOR_A, partnerId: 'partner' });
    c.set('canManage', options.manage === true);
    await next();
  });
  mountDirectoryPreferenceRoutes(app as never, { db: { execute }, audit } as never);
  return { app, execute, audit };
}
const path = (user = USER) => `/microsoft/directory/users/${user}/exclude`;

describe('per-technician Microsoft directory exclusion preferences', () => {
  it('lists exclusions in one bounded host-scoped query', async () => {
    const h = harness({ rows: [[{ microsoft_user_id: USER }]] });
    const response = await h.app.request('/microsoft/directory/exclusions');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [USER] });
    expect(JSON.stringify(h.execute.mock.calls[0])).toContain(ORG_A);
    expect(JSON.stringify(h.execute.mock.calls[0])).toContain(ACTOR_A);
    expect(JSON.stringify(h.execute.mock.calls[0])).toContain('LIMIT 1001');
  });
  it('rejects a partial exclusion inventory rather than treating it as complete', async () => {
    const h = harness({ rows: [Array.from({ length: 1001 }, () => ({ microsoft_user_id: USER }))] });
    const response = await h.app.request('/microsoft/directory/exclusions');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'directory_preference_limit' });
  });
  it('reads only the host-scoped actor and organization preference', async () => {
    const h = harness({ rows: [[{ excluded: true }]] });
    await expect((await h.app.request(path())).json()).resolves.toEqual({ excluded: true });
    const query = JSON.stringify(h.execute.mock.calls[0]);
    expect(query).toContain(ORG_A); expect(query).toContain(ACTOR_A); expect(query).toContain(USER);
  });
  it.each([
    ['other organization', { org: ORG_B, actor: ACTOR_A }],
    ['other actor in the same organization', { org: ORG_A, actor: ACTOR_B }],
  ])('does not fall back to another %s preference', async (_label, options) => {
    const h = harness(options);
    await expect((await h.app.request(path())).json()).resolves.toEqual({ excluded: false });
    const query = JSON.stringify(h.execute.mock.calls[0]);
    expect(query).toContain(options.org!); expect(query).toContain(options.actor!);
  });
  it('writes only the host-scoped preference, requires MFA/write, and audits the resulting scalar', async () => {
    const h = harness({ manage: true, rows: [[{ excluded: true }]] });
    const res = await h.app.request(path(), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ excluded: true }) });
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ excluded: true });
    const query = JSON.stringify(h.execute.mock.calls[0]);
    expect(query).toContain(ORG_A); expect(query).toContain(ACTOR_A); expect(query).toContain(USER);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A, actorId: ACTOR_A, resourceId: USER, details: { excluded: true } }));
  });
  it.each([{ manage: false }, { manage: false, rows: [] }])('denies a preference write without host write/MFA capability', async options => {
    const h = harness(options);
    expect((await h.app.request(path(), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ excluded: true }) })).status).toBe(403);
    expect(h.execute).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled();
  });
  it.each([['not-a-uuid', { excluded: true }], [USER, { excluded: 'yes' }], [USER, { excluded: true, extra: true }]])('rejects malformed user or preference inputs before persistence: %s', async (id, body) => {
    const h = harness({ manage: true });
    expect((await h.app.request(path(id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(400);
    expect(h.execute).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled();
  });
});
