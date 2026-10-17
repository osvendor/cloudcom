import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createRoutes } from './index';
import { backupAttention, idriveAction } from './idrive-contract';
import { assertIDriveTargets, clientOperationResult, createIDriveProvider, scopeIDriveInventory } from './idrive-provider';

const org = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const partner = '33333333-3333-4333-8333-333333333333';
const operation = '44444444-4444-4444-8444-444444444444';
const inventory = {
  devices: [{ device_id: 'a', company_id: 1, name: 'Our PC' }, { device_id: 'b', company_id: 1, name: 'Other client PC' }],
  groups: [{ id: 10, name: 'Our client', device_ids: ['a'] }, { id: 20, name: 'Other client', device_ids: ['b'] }],
  plans: [{ id: 100, groups: ['10'], devices: [] }, { id: 200, groups: ['20'], devices: [] }, { id: 300, groups: ['10', '20'], devices: [] }],
};
const connection = { id: operation, org_id: org, company_id: 1, group_id: 10, enabled: true, version: 1, secret_ciphertext: 'cipher', stale_hours: 48 };
function harness(options: { access?: boolean; write?: boolean; mfa?: boolean; admin?: boolean; read?: boolean; sites?: string[]; rows?: unknown[]; claims?: boolean } = {}) {
  const queue = [...(options.rows ?? [[{ partner_id: partner }], [connection]])];
  const execute = vi.fn(async () => queue.shift() ?? []);
  const fetch = vi.fn(async (url: string) => Response.json(url.includes('/device/summary') ? inventory.devices : url.includes('/backup_plan') ? inventory.plans : inventory.groups));
  const decrypt = vi.fn(() => 'secret-key'); const audit = vi.fn(async () => {});
  const runDb = vi.fn(async (_auth: unknown, work: () => Promise<unknown>) => work());
  const context = { db: { execute }, audit, log: vi.fn(), secrets: { decryptForColumn: decrypt, encryptForColumn: vi.fn(() => 'enc:v3:test') } };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, { user: { id: actor, isPlatformAdmin: options.admin }, partnerId: partner, canAccessOrg: () => options.access !== false } as never);
    c.set('extensionAuthorization' as never, { hasPermission: (_r: string, verb: string) => verb === 'read' ? options.read !== false : options.write === true, mfaSatisfied: options.mfa === true, allowedSiteIds: options.sites } as never);
    await next();
  });
  app.route('/', createRoutes(context as never, fetch, undefined, undefined, undefined, undefined, runDb as never));
  const request = (path: string, data?: unknown, method = 'POST') => app.request(`http://test/idrive/${path}?orgId=${org}`, data === undefined ? undefined : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  return { request, execute, fetch, decrypt, audit, runDb };
}
describe('IDrive client boundaries', () => {
  it('only projects the mapped group and hides shared plans', () => {
    const data = scopeIDriveInventory(inventory, 10);
    expect(data.devices.map(d => d.device_id)).toEqual(['a']);
    expect(data.plans.map(p => p.id)).toEqual([100]);
    expect(data.sharedPlansHidden).toBe(1);
    expect(JSON.stringify(data)).not.toContain('Other client');
  });
  it('fails closed when the assigned group disappears', () => expect(() => scopeIDriveInventory(inventory, 99)).toThrow('idrive_group_unavailable'));
  it.each([
    { kind: 'device.edit', data: { device_id: 'b', custom_tag: 'x' } },
    { kind: 'plan.edit', id: 300, data: { is_enabled: false } },
    { kind: 'group.edit', id: 10, data: { add_device_ids: ['b'] } },
    { kind: 'group.edit', id: 20, data: { name: 'renamed' } },
  ])('rejects cross-client mutation %j', action => expect(() => assertIDriveTargets(idriveAction.parse(action), scopeIDriveInventory(inventory, 10))).toThrow());
  it('accepts an owned device update', () => expect(() => assertIDriveTargets(idriveAction.parse({ kind: 'device.edit', data: { device_id: 'a', custom_tag: 'server' } }), scopeIDriveInventory(inventory, 10))).not.toThrow());
  it('redacts other-client identities from conflict reports', () => {
    const result = clientOperationResult({ conflicts: [{ device: 'Other client PC' }], message: 'Secret client' }, 10);
    expect(JSON.stringify(result)).not.toContain('Other client PC');
    expect(JSON.stringify(result)).not.toContain('Secret client');
    expect(result).toMatchObject({ counts: { conflicts: 1 } });
  });
  it('distinguishes a local preview, a provider dry run and a real response', () => {
    expect(clientOperationResult({ localPreview: true }, 10, true)).toMatchObject({ providerResponded: false, providerDryRun: false, localPreview: true });
    expect(clientOperationResult({}, 10, true)).toMatchObject({ providerResponded: true, providerDryRun: true });
    expect(clientOperationResult({}, 10)).toMatchObject({ providerResponded: true, providerDryRun: false, localPreview: false });
  });
});
describe('IDrive transport and input', () => {
  it('uses a fixed HTTPS origin and server company, with redirects disabled', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true }));
    await createIDriveProvider(fetch).action('secret', 1, idriveAction.parse({ kind: 'device.edit', data: { device_id: 'a', custom_tag: 'x' } }), false);
    expect(fetch.mock.calls[0][0]).toBe('https://api.idrive360.com/api/msp/device');
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', method: 'PUT', headers: { Authorization: 'Bearer secret' } });
    expect(JSON.parse(fetch.mock.calls[0][1].body as string).company_id).toBe(1);
  });
  it('does not send local-only previews to IDrive', async () => {
    const fetch = vi.fn();
    await createIDriveProvider(fetch).action('secret', 1, idriveAction.parse({ kind: 'device.edit', data: { device_id: 'a', custom_tag: 'x' } }), true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not leak provider failure bodies', async () => {
    const fetch = vi.fn(async () => new Response('token=secret', { status: 401 }));
    await expect(createIDriveProvider(fetch).company('secret', 1)).rejects.toThrow('idrive_access_denied');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects caller company overrides and undocumented operations', () => {
    expect(idriveAction.safeParse({ kind: 'device.edit', data: { company_id: 2, device_id: 'a', custom_tag: 'x' } }).success).toBe(false);
    expect(idriveAction.safeParse({ kind: 'device.delete', data: { device_id: 'a' } }).success).toBe(false);
  });
  it('flags clearly stale timezone-less dates without marking recent dates failed', () => {
    const now = Date.parse('2026-10-13T23:00:00Z');
    expect(backupAttention({ backup_status: 'Success', last_backup: '2026-10-13T03:00:00' }, 48, now)).toBeNull();
    expect(backupAttention({ backup_status: 'Success', last_backup: '2026-02-06T03:00:00' }, 48, now)).toContain('older');
    expect(backupAttention({ backup_status: 'Failed' }, 48, now)).toBe('Failed');
  });
});
describe('IDrive routes', () => {
  it.each([{ access: false }, { read: false }, { sites: ['site'] }])('denies unauthorized reads before touching secrets', async options => {
    const h = harness(options); expect((await h.request('inventory')).status).toBe(403);
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.decrypt).not.toHaveBeenCalled();
  });
  it('returns only mapped client inventory', async () => {
    const h = harness(); const response = await h.request('inventory'); expect(response.status).toBe(200);
    const body = await response.json(); expect(body.devices.map((d: any) => d.device_id)).toEqual(['a']);
    expect(h.runDb).toHaveBeenCalledTimes(2);
  });
  it('requires a platform admin to change mappings', async () => {
    const h = harness({ write: true, mfa: true }); expect((await h.request('connection', {}, 'PUT')).status).toBe(403); expect(h.fetch).not.toHaveBeenCalled();
  });
  it('denies account-wide inventory to an ordinary client user', async () => {
    const h = harness({ rows: [[{ partner_id: partner }], [{ ...connection, group_id: null }]] });
    expect((await h.request('inventory')).status).toBe(403); expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([{ write: false, mfa: true }, { write: true, mfa: false }])('requires write and MFA-policy satisfaction', async options => {
    const h = harness(options); expect((await h.request('preview', {})).status).toBe(403); expect(h.fetch).not.toHaveBeenCalled();
  });
  it('rejects an already used or expired preview before provider dispatch', async () => {
    const h = harness({ write: true, mfa: true });
    expect((await h.request('execute', { previewId: operation, confirmed: true })).status).toBe(409); expect(h.fetch).not.toHaveBeenCalled();
  });
  it('rejects a cross-client device even for an authorized writer', async () => {
    const h = harness({ write: true, mfa: true });
    expect((await h.request('preview', { kind: 'device.edit', data: { device_id: 'b', custom_tag: 'x' } })).status).toBe(403);
    expect(h.fetch).toHaveBeenCalledTimes(3); // Inventory GETs only.
  });
});

