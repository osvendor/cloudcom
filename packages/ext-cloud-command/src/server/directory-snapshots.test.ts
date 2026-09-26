import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountDirectorySnapshotRoutes } from './directory-snapshots';

const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
function harness(enabled = true, data: unknown[] = []) {
  const execute = vi.fn(async () => data);
  const audit = vi.fn(async () => undefined);
  const connection = vi.fn(async () => ({ available: true, connected: true, enabled,
    canManage: false, tenantId: TENANT }));
  const app = new Hono<{ Variables: any }>();
  app.use('*', async (c, next) => {
    c.set('scope', { organizationId: ORG, actorId: '33333333-3333-4333-8333-333333333333' });
    c.set('auth', { user: { id: '33333333-3333-4333-8333-333333333333' } });
    c.set('extensionAuthorization', {});
    await next();
  });
  mountDirectorySnapshotRoutes(app as never, { db: { execute }, audit } as never,
    { version: 1, connection } as never);
  return { app, execute, connection, audit };
}

describe('Microsoft directory snapshot read route', () => {
  it('returns separate source status and data for the currently bound generation', async () => {
    const h = harness(true, [{ tenant_id: TENANT, connection_generation: 3,
      directory_data: { users: [{ id: 'member' }] }, directory_collected_at: '2026-09-25T10:00:00Z',
      usage_data: { mailboxes: [] }, usage_collected_at: '2026-09-25T09:00:00Z',
      directory_status: 'ready', usage_status: 'stale', last_attempt_at: '2026-09-25T11:00:00Z' }]);
    const response = await h.app.request('/microsoft/directory/snapshot');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ tenantId: TENANT,
      directory: { status: 'ready', data: { users: [{ id: 'member' }] } },
      usage: { status: 'stale', collectedAt: '2026-09-25T09:00:00.000Z' } });
    const query = JSON.stringify(h.execute.mock.calls[0]);
    expect(query).toContain(ORG); expect(query).toContain(TENANT);
    expect(query).toContain('c.generation = s.connection_generation');
    expect(query).toContain('c.enabled = true');
  });
  it('does not query or disclose old data when the connection is disabled', async () => {
    const h = harness(false, [{ directory_data: { users: [{ id: 'old' }] } }]);
    const response = await h.app.request('/microsoft/directory/snapshot');
    expect(response.status).toBe(409);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('reports a never-collected source without treating an absent row as empty inventory', async () => {
    const h = harness();
    const response = await h.app.request('/microsoft/directory/snapshot');
    expect(await response.json()).toMatchObject({ directory: { status: 'never', data: null },
      usage: { status: 'never', data: null } });
  });
  it('persists a bounded manual refresh request without contacting Microsoft in the route', async () => {
    const h = harness(true, [{ org_id: ORG }]);
    const response = await h.app.request('/microsoft/directory/refresh', { method: 'POST' });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ queued: true });
    expect(h.connection).toHaveBeenCalledOnce();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'cloudcommand.microsoft.directory.refresh.request', orgId: ORG,
    }));
    const query = JSON.stringify(h.execute.mock.calls[0]);
    expect(query).toContain('refresh_requested_at');
    expect(query).toContain(ORG);
    expect(query).toContain(TENANT);
  });
  it('does not claim to queue or audit a refresh if the connection changed during the request', async () => {
    const h = harness();
    const response = await h.app.request('/microsoft/directory/refresh', { method: 'POST' });
    expect(response.status).toBe(409);
    expect(h.audit).not.toHaveBeenCalled();
  });
  it('cannot queue a refresh on a disabled connection', async () => {
    const h = harness(false);
    const response = await h.app.request('/microsoft/directory/refresh', { method: 'POST' });
    expect(response.status).toBe(409);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});
