import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from 'hono/types';
import { createRoutes } from './index';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ID = '44444444-4444-4444-8444-444444444444';
const row = (over: Record<string, unknown> = {}) => ({
  id: ID, org_id: ORG, origin: 'https://pbx.example.test', client_id: 'client', secret_ciphertext: 'cipher',
  department_id: null, enabled: true, version: 1, last_verified_at: null, ...over,
});

function harness(options: { results?: unknown[]; read?: boolean; write?: boolean; mfa?: boolean; sites?: number[]; access?: boolean; partnerId?: string | null } = {}) {
  const queued = [...(options.results ?? [[{ partner_id: PARTNER }]])];
  const execute = vi.fn(async () => queued.shift() ?? []);
  const decryptForColumn = vi.fn(() => 'plain-secret');
  const encryptForColumn = vi.fn(() => 'enc:v3:test-key:encrypted-secret');
  const audit = vi.fn(async () => undefined);
  const fetch = vi.fn();
  const context = {
    db: { execute }, secrets: { decryptForColumn, encryptForColumn }, audit, log: vi.fn(),
  };
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => {
    c.set('auth', options.access === false ? { user: { id: USER }, partnerId: options.partnerId ?? PARTNER, canAccessOrg: () => false } : {
      user: { id: USER }, partnerId: options.partnerId ?? PARTNER, canAccessOrg: () => true,
    });
    c.set('extensionAuthorization', {
      hasPermission: (_resource: string, action: string) => action === 'read' ? options.read !== false : options.write === true,
      mfaSatisfied: options.mfa === true,
      allowedSiteIds: options.sites,
    });
    await next();
  });
  app.route('/', createRoutes(context as never, fetch));
  return { app, execute, decryptForColumn, encryptForColumn, audit, fetch };
}

function request<E extends Env>(app: Hono<E>, path: string, init?: RequestInit) {
  return app.request(`http://local${path}`, init);
}
function config(over: Record<string, unknown> = {}) {
  return { origin: 'https://pbx.example.test', clientId: 'client', secret: 'new-secret', departmentId: null, enabled: true, version: 1, ...over };
}

describe('Cloud Command 3CX routes', () => {
  it('requires injected auth before any organization or secret access', async () => {
    const execute = vi.fn();
    const app = new Hono().route('/', createRoutes({ db: { execute }, secrets: {}, audit: vi.fn(), log: vi.fn() } as never, vi.fn()));
    const res = await request(app, `/threecx/connection?orgId=${ORG}`);
    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['missing read permission', { read: false }],
    ['site-restricted authorization', { sites: [7] }],
    ['cross-organization access', { access: false }],
  ])('denies %s before database/secret work', async (_label, options) => {
    const h = harness(options);
    const res = await request(h.app, `/threecx/connection?orgId=${ORG}`);
    expect(res.status).toBe(403);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.decryptForColumn).not.toHaveBeenCalled();
  });

  it('requires both write permission and MFA for configuration', async () => {
    for (const options of [{ write: false, mfa: true }, { write: true, mfa: false }]) {
      const h = harness(options);
      const res = await request(h.app, `/threecx/test?orgId=${ORG}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config()) });
      expect(res.status).toBe(403);
      expect(h.execute).not.toHaveBeenCalled();
    }
  });

  it('looks up the active organization and rejects a partner mismatch before loading a connection', async () => {
    const h = harness({ results: [[{ partner_id: 'other-partner' }]] });
    const res = await request(h.app, `/threecx/connection?orgId=${ORG}`);
    expect(res.status).toBe(404);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.decryptForColumn).not.toHaveBeenCalled();
  });

  it('projects a connection without ever returning its encrypted secret', async () => {
    const h = harness({ results: [[{ partner_id: PARTNER }], [row()]] });
    const res = await request(h.app, `/threecx/connection?orgId=${ORG}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ connected: true, origin: 'https://pbx.example.test', clientId: 'client', version: 1, canManage: false });
    expect(JSON.stringify(body)).not.toContain('cipher');
    expect(h.decryptForColumn).not.toHaveBeenCalled();
  });

  it('rejects stale configuration versions before decrypting or contacting the provider', async () => {
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [row({ version: 2 })]] });
    const res = await request(h.app, `/threecx/test?orgId=${ORG}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config({ secret: undefined, version: 1 })) });
    expect(res.status).toBe(409);
    expect(h.decryptForColumn).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('only preserves a prior secret for the exact same PBX target', async () => {
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [row()]] });
    const res = await request(h.app, `/threecx/test?orgId=${ORG}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config({ secret: undefined, clientId: 'other-client' })) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('secret_required');
    expect(h.decryptForColumn).not.toHaveBeenCalled();
  });

  it('preserves a prior secret only for the same target', async () => {
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [row()]] });
    h.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] })));
    const res = await request(h.app, `/threecx/test?orgId=${ORG}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config({ secret: undefined })) });
    expect(res.status).toBe(200);
    expect(h.decryptForColumn).toHaveBeenCalledWith('cloudcommand_threecx_connections', `secret_ciphertext:${ORG}`, 'cipher');
  });

  it('verifies and encrypts a new configuration before inserting its safe summary', async () => {
    const saved = row({ version: 1, last_verified_at: '2026-09-21T00:00:00.000Z' });
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [], [saved]] });
    h.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] })));
    const res = await request(h.app, `/threecx/connection?orgId=${ORG}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config({ version: null })) });
    expect(res.status).toBe(200);
    expect(h.encryptForColumn).toHaveBeenCalledWith('cloudcommand_threecx_connections', `secret_ciphertext:${ORG}`, 'new-secret');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'cloudcommand.threecx.configure', resourceId: ID }));
    expect(JSON.stringify(await res.json())).not.toContain('new-secret');
  });

  it('returns a conflict when an update loses its version race after verification', async () => {
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [row()], []] });
    h.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] })));
    const res = await request(h.app, `/threecx/connection?orgId=${ORG}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config()) });
    expect(res.status).toBe(409);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('disables an unchanged existing configuration without a provider call during an outage', async () => {
    const previous = row();
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [previous], [row({ enabled: false, version: 2 })]] });
    const res = await request(h.app, `/threecx/connection?orgId=${ORG}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config({ secret: undefined, enabled: false })),
    });
    expect(res.status).toBe(200);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.decryptForColumn).toHaveBeenCalledTimes(1);
    expect((await res.json()).enabled).toBe(false);
  });

  it.each([
    ['bad body', '{'],
    ['unknown configuration field', JSON.stringify({ ...config(), surprise: true })],
    ['invalid PBX origin', JSON.stringify(config({ origin: 'http://pbx.example.test' }))],
  ])('rejects invalid configs: %s', async (_label, body) => {
    const h = harness({ write: true, mfa: true });
    const res = await request(h.app, `/threecx/test?orgId=${ORG}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(res.status).toBe(400);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('does not decrypt a disabled connection for reads', async () => {
    const h = harness({ results: [[{ partner_id: PARTNER }], [row({ enabled: false })]] });
    const res = await request(h.app, `/threecx/users?orgId=${ORG}`);
    expect(res.status).toBe(404);
    expect(h.decryptForColumn).not.toHaveBeenCalled();
  });

  it('projects only the allowed user fields and filters a department', async () => {
    const h = harness({ results: [[{ partner_id: PARTNER }], [row({ department_id: 4 })]] });
    h.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [
        { Id: 1, Number: '101', FirstName: 'A', LastName: null, EmailAddress: 'a@example.test', Mobile: null, Enabled: true, IsRegistered: false, CurrentProfileName: 'User', Groups: [{ GroupId: 4 }], ignored: 'nope' },
        { Id: 2, Number: '102', FirstName: 'B', LastName: null, EmailAddress: null, Mobile: null, Enabled: true, IsRegistered: true, CurrentProfileName: 'User', Groups: [{ GroupId: 9 }] },
      ] })));
    const res = await request(h.app, `/threecx/users?orgId=${ORG}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ items: [{ Id: 1, Number: '101' }], nextSkip: null });
    expect(JSON.stringify(body)).not.toContain('ignored');
  });
});
