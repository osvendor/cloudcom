import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from 'hono/types';
import { createRoutes } from './index';
import type { GuardedFetch } from './transport';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const EXTENSION = 101;
type GuardedFetchMock = ReturnType<typeof vi.fn<GuardedFetch>>;

const row = (over: Record<string, unknown> = {}) => ({
  id: CONNECTION, org_id: ORG, origin: 'https://pbx.example.test', client_id: 'client', secret_ciphertext: 'ciphertext-secret',
  department_id: null, enabled: true, version: 1, last_verified_at: null, ...over,
});
const providerUser = (over: Record<string, unknown> = {}) => ({
  Id: EXTENSION, Number: '101', FirstName: 'Ada', LastName: 'Lovelace', EmailAddress: 'ada@example.test', Mobile: '+15551212',
  OutboundCallerID: '101', CurrentProfileName: 'Available', VMEmailOptions: 'Attachment', VMPlayMsgDateTime: 'Play24Hr',
  Enabled: true, IsRegistered: true, Enable2FA: false, Require2FA: false, VMEnabled: true, VMPlayCallerID: true,
  HideInPhonebook: false, MyPhoneShowRecordings: false, MyPhoneAllowDeleteRecordings: false, MyPhoneHideForwardings: false,
  MyPhonePush: false, SendEmailMissedCalls: false, WebMeetingApproveParticipants: false, PrimaryGroupId: 4,
  Groups: [{ GroupId: 4, Name: 'Support', Rights: { RoleName: 'Member', secret: 'not-returned' } }],
  Phones: [{ Id: 8, Name: 'Desk', MacAddress: '00:11:22:33:44:55', TemplateName: 'T54W', Interface: 'eth0', PhoneProvisioningLink: 'secret-url', PIN: '1234' }],
  ForwardingProfiles: [], ForwardingExceptions: [], Greetings: [], Blfs: 'private raw blf', arbitrarySecret: 'never-returned', ...over,
});

function harness(options: { results?: unknown[]; read?: boolean; write?: boolean; mfa?: boolean; sites?: number[]; access?: boolean; auth?: boolean; fetch?: GuardedFetchMock } = {}) {
  const queued = [...(options.results ?? [[{ partner_id: PARTNER }]])];
  const execute = vi.fn(async () => queued.shift() ?? []);
  const decryptForColumn = vi.fn(() => 'provider-secret');
  const audit = vi.fn(async () => undefined);
  const fetch: GuardedFetchMock = options.fetch ?? vi.fn<GuardedFetch>();
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => {
    if (options.auth !== false) c.set('auth', { user: { id: USER }, partnerId: PARTNER, canAccessOrg: (id: string) => options.access !== false && id !== OTHER_ORG });
    c.set('extensionAuthorization', {
      hasPermission: (_resource: string, action: string) => action === 'read' ? options.read !== false : options.write === true,
      mfaSatisfied: options.mfa === true, allowedSiteIds: options.sites,
    });
    await next();
  });
  app.route('/', createRoutes({ db: { execute }, secrets: { decryptForColumn }, audit, log: vi.fn() } as never, fetch));
  return { app, execute, decryptForColumn, audit, fetch };
}
function request<E extends Env>(app: Hono<E>, path: string, init?: RequestInit) { return app.request(`http://local${path}`, init); }
function token() { return new Response(JSON.stringify({ access_token: 'token' })); }
function getUser(raw = providerUser()) { return new Response(JSON.stringify(raw)); }
function forwardingProfiles() {
  return [
    { Id: 1, Name: 'Available', NoAnswerTimeout: 20, RingMyMobile: false, CustomProviderValue: 'keep-me', AvailableRoute: { NoAnswerInternal: { To: 'Extension', Number: '102' } } },
    { Id: 2, Name: 'Away', NoAnswerTimeout: 30, RingMyMobile: true, CustomProviderValue: 'also-keep', AwayRoute: { External: { To: 'External', External: '+15550000' } } },
  ];
}

describe('Cloud Command 3CX extension details', () => {
  it('returns a scoped positive projection without credentials, phones provisioning data, PINs, or raw BLFs', async () => {
    const h = harness({ results: [[{ partner_id: PARTNER }], [row()]] });
    h.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser());
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user: { Id: EXTENSION, Number: '101', FirstName: 'Ada' }, groups: [{ id: 4, name: 'Support' }], phones: [{ id: 8, name: 'Desk' }], blf: { configured: true, entries: [], readable: false }, editable: { forwarding: false } });
    expect(body.revision).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(body);
    for (const forbidden of ['ciphertext-secret', 'provider-secret', 'PhoneProvisioningLink', 'secret-url', 'PIN', '1234', 'private raw blf', 'arbitrarySecret', 'not-returned']) expect(serialized).not.toContain(forbidden);
    expect(h.decryptForColumn).toHaveBeenCalledOnce();
  });

  it.each([
    ['no host auth', { auth: false }, 401],
    ['missing read permission', { read: false }, 403],
    ['cross organization', { access: false }, 403],
    ['site-restricted authorization', { sites: [4] }, 403],
  ])('rejects %s before connection, secret, or provider use', async (_label, options, status) => {
    const h = harness(options);
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`);
    expect(res.status).toBe(status);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.decryptForColumn).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('hides a partner-mismatched organization before loading its connection', async () => {
    const h = harness({ results: [[{ partner_id: 'other-partner' }]] });
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`);
    expect(res.status).toBe(404);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.decryptForColumn).not.toHaveBeenCalled();
  });

  it.each(['-1', '01', 'abc', '2147483648'])('rejects invalid extension id %s before provider work', async id => {
    const h = harness({ results: [[{ partner_id: PARTNER }]] });
    const res = await request(h.app, `/threecx/users/${id}?orgId=${ORG}`);
    expect(res.status).toBe(400);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.decryptForColumn).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, row({ enabled: false })])('returns not available for a missing or disabled connection', async connection => {
    const h = harness({ results: [[{ partner_id: PARTNER }], connection ? [connection] : []] });
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`);
    expect(res.status).toBe(404);
    expect(h.decryptForColumn).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('returns 404 when the extension does not belong to the configured department', async () => {
    const h = harness({ results: [[{ partner_id: PARTNER }], [row({ department_id: 4 })]] });
    h.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser(providerUser({ Groups: [{ GroupId: 9, Name: 'Elsewhere' }] })));
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('not_available');
  });

  it('only enables forwarding edits for write access with verified MFA', async () => {
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [row()]] });
    h.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser());
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`);
    expect(res.status).toBe(200);
    expect((await res.json()).editable).toMatchObject({ general: true, voicemail: true, forwarding: true });
  });

  it.each([
    ['missing write permission', { write: false, mfa: true }],
    ['missing verified MFA', { write: true, mfa: false }],
  ])('rejects PATCH with %s before connection or provider work', async (_label, options) => {
    const h = harness(options);
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 'a'.repeat(64), changes: { FirstName: 'Grace' } }) });
    expect(res.status).toBe(403);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { password: 'no' }, { Groups: [] }, { Enable2FA: true }, { Require2FA: false }, { Blfs: 'raw' },
  ])('rejects unsupported credential, group, 2FA, and raw-BLF PATCH fields before provider work', async changes => {
    const h = harness({ write: true, mfa: true });
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 'a'.repeat(64), changes }) });
    expect(res.status).toBe(400);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.decryptForColumn).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('PATCHes an allowlisted scalar identity field and accepts a 204 provider update', async () => {
    const current = providerUser();
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [row()], [{ partner_id: PARTNER }], [row()], [row()]] });
    h.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser(current)).mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser(current)).mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const initial = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`);
    const { revision } = await initial.json();
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, changes: { FirstName: 'Grace', VMEnabled: false } }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(h.fetch).toHaveBeenLastCalledWith(expect.stringContaining(`/Users(${EXTENSION})`), expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ FirstName: 'Grace', VMEnabled: false }) }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'cloudcommand.threecx.user.update', details: { extensionId: EXTENSION, fields: ['FirstName', 'VMEnabled'] } }));
  });

  it('updates forwarding through one scoped bulk request while preserving whole provider profiles', async () => {
    const initialProfiles = forwardingProfiles();
    const current = providerUser({ ForwardingProfiles: initialProfiles });
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [row()], [{ partner_id: PARTNER }], [row()], [row()]] });
    h.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser(current)).mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser(current)).mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const detail = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`);
    const { revision } = await detail.json();
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, changes: { ForwardingProfiles: [{ Id: 1, NoAnswerTimeout: 45, RingMyMobile: true }] } }) });
    expect(res.status).toBe(200);
    const expectedProfiles = forwardingProfiles();
    expectedProfiles[0] = { ...expectedProfiles[0], NoAnswerTimeout: 45, RingMyMobile: true };
    expect(h.fetch).toHaveBeenLastCalledWith(expect.stringContaining('/Users/Pbx.MultiUserUpdate'), expect.objectContaining({ method: 'POST', body: JSON.stringify({ ids: [EXTENSION], user: { ForwardingProfiles: expectedProfiles } }) }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ details: { extensionId: EXTENSION, fields: ['ForwardingProfiles'] } }));
  });

  it('rejects unknown forwarding profiles after preflight without a bulk update', async () => {
    const current = providerUser({ ForwardingProfiles: forwardingProfiles() });
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [row()], [{ partner_id: PARTNER }], [row()], [row()]] });
    h.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser(current)).mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser(current));
    const initial = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`);
    const { revision } = await initial.json();
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, changes: { ForwardingProfiles: [{ Id: 99, RingMyMobile: true }] } }) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unknown_forwarding_profile');
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(h.fetch.mock.calls.some(([url]) => String(url).includes('Pbx.MultiUserUpdate'))).toBe(false);
  });

  it.each([
    ['duplicate profile IDs', { ForwardingProfiles: [{ Id: 1, RingMyMobile: true }, { Id: 1, NoAnswerTimeout: 20 }] }],
    ['unsafe timeout', { ForwardingProfiles: [{ Id: 1, NoAnswerTimeout: 4 }] }],
    ['provider destination edit', { ForwardingProfiles: [{ Id: 1, RingMyMobile: true, AvailableRoute: { NoAnswerInternal: { Number: '999' } } }] }],
    ['caller bulk IDs', { ids: [999], ForwardingProfiles: [{ Id: 1, RingMyMobile: true }] }],
    ['arbitrary profile field', { ForwardingProfiles: [{ Id: 1, RingMyMobile: true, arbitrary: 'no' }] }],
  ])('rejects %s before provider mutation', async (_label, changes) => {
    const h = harness({ write: true, mfa: true });
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 'a'.repeat(64), changes }) });
    expect(res.status).toBe(400);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.decryptForColumn).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rejects mixed scalar and forwarding edits before a provider mutation', async () => {
    const current = providerUser({ ForwardingProfiles: forwardingProfiles() });
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [row()], [{ partner_id: PARTNER }], [row()], [row()]] });
    h.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser(current)).mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser(current));
    const initial = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`);
    const { revision } = await initial.json();
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, changes: { FirstName: 'Grace', ForwardingProfiles: [{ Id: 1, RingMyMobile: true }] } }) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('save_forwarding_separately');
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(h.fetch.mock.calls.some(([url]) => String(url).includes('/Users/Pbx.MultiUserUpdate'))).toBe(false);
  });

  it('applies the stale revision guard before a forwarding bulk update', async () => {
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [row()]] });
    h.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser(providerUser({ ForwardingProfiles: forwardingProfiles() })));
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 'c'.repeat(64), changes: { ForwardingProfiles: [{ Id: 1, RingMyMobile: true }] } }) });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('extension_changed_reload_before_saving');
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.fetch.mock.calls.some(([url]) => String(url).includes('Pbx.MultiUserUpdate'))).toBe(false);
  });

  it('returns a conflict for a stale detail revision without a PATCH', async () => {
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [row()]] });
    h.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser());
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 'b'.repeat(64), changes: { LastName: 'Hopper' } }) });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('extension_changed_reload_before_saving');
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('returns a conflict when the connection version changes after detail preflight', async () => {
    const h = harness({ write: true, mfa: true, results: [[{ partner_id: PARTNER }], [row()], [{ partner_id: PARTNER }], [row()], [row({ version: 2 })]] });
    h.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser()).mockResolvedValueOnce(token()).mockResolvedValueOnce(getUser());
    const detail = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`);
    const { revision } = await detail.json();
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, changes: { LastName: 'Hopper' } }) });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('connection_changed_reload_before_saving');
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });

  it('redacts provider error bodies and credentials', async () => {
    const h = harness({ results: [[{ partner_id: PARTNER }], [row()]] });
    h.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response('provider said provider-secret and ciphertext-secret', { status: 500 }));
    const res = await request(h.app, `/threecx/users/${EXTENSION}?orgId=${ORG}`);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain('provider_request_failed');
    expect(body).not.toContain('provider-secret');
    expect(body).not.toContain('ciphertext-secret');
  });
});
