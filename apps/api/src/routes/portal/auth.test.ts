/**
 * POST /portal/auth/logout for a disabled portal user (sweep 2026-09-08
 * G5-6).
 *
 * `portalAuthMiddleware`'s account-status gate used to reject EVERY request
 * from a disabled portal user with 403 before the route handler ever ran —
 * logout included. That trapped a disabled user logged-in-but-blocked: the
 * session cookie was never cleared, so `/portal/login` bounced them straight
 * back to `/portal/quotes`, which 403'd again. Logout must succeed and clear
 * the cookie for an authenticated-but-inactive portal user; every OTHER
 * inactive-account request must still fail closed, now carrying a distinct
 * `code` the portal app can map to a dedicated "access disabled" page instead
 * of the generic outage copy (see authOrgStatusGate.test.ts for that half).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { portalUserRow, portalUserRows, activeOrgResult, whereSpy, limitSpy, rateSpies, auditSpy } = vi.hoisted(() => ({
  portalUserRow: { current: null as Record<string, unknown> | null },
  // When set, every select returns ALL these rows (several accounts on one address).
  portalUserRows: { current: null as Array<Record<string, unknown>> | null },
  activeOrgResult: { current: null as { orgId: string; partnerId: string } | null },
  whereSpy: vi.fn(),
  limitSpy: vi.fn(),
  rateSpies: { check: vi.fn(), clear: vi.fn() },
  auditSpy: vi.fn(async (..._args: unknown[]) => undefined),
}));

const resolveOrgTimezone = vi.hoisted(() => vi.fn(async () => 'UTC'));
const gateway = vi.hoisted(() => vi.fn());
const passwordCheck = vi.hoisted(() => vi.fn());
const staffLookup = vi.hoisted(() => vi.fn());
vi.mock('../../services/portalCompanyGateway', () => ({ checkPortalCompanyGateway: gateway }));

vi.mock('../../services/portal/timezone', () => ({
  resolveOrgTimezone,
}));

// Same projection-applying mock as authOrgStatusGate.test.ts — a naive echo
// mock would hide a column the middleware forgot to select.
function project(columns: Record<string, unknown>): Array<Record<string, unknown>> {
  const rows = portalUserRows.current ?? (portalUserRow.current ? [portalUserRow.current] : []);
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(columns)) out[key] = row[key] ?? null;
    return out;
  });
}

// Logout's durable signed-out record commits in its own system transaction;
// this suite exercises the route around it, so the write itself is stubbed
// (auth.logout.test.ts and portalLogoutRevocation.integration.test.ts cover it).
const revokePortalSessionDurably = vi.hoisted(() => vi.fn(async (_token: string, _userId: string) => undefined));
vi.mock('../../services/portal/sessionRevocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/portal/sessionRevocation')>()),
  revokePortalSessionDurably,
}));

vi.mock('../../db', () => ({
  db: {
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    select: (columns: Record<string, unknown>) => ({
      from: (table: Record<string, unknown>) => ({
        where: (w: unknown) => { whereSpy(w); return { limit: (n: number) => { limitSpy(n); return table.id === 'staff-id' ? staffLookup() : Promise.resolve(project(columns)); } }; },
      }),
    }),
  },
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));
vi.mock('../../db/schema', () => ({
  discoveredAssetTypeEnum: { enumValues: [] },
  portalUsers: {
    id: 'id',
    orgId: 'orgId',
    email: 'email',
    name: 'name',
    contactId: 'contactId',
    receiveNotifications: 'receiveNotifications',
    status: 'status',
    passwordHash: 'passwordHash',
    authMethod: 'authMethod',
    authEpoch: 'authEpoch',
    browserAccess: 'browserAccess',
    accessMode: 'accessMode',
  },
  portalBranding: { orgId: 'orgId', enablePasswordReset: 'enablePasswordReset' },
  users: { id: 'staff-id', email: 'staff-email' },
}));
vi.mock('./helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpers')>();
  return {
    ...actual,
    checkRateLimit: vi.fn(async (...args: Parameters<typeof actual.checkRateLimit>) => { rateSpies.check(...args); return actual.checkRateLimit(...args); }),
    clearRateLimitKeys: vi.fn(async (...args: Parameters<typeof actual.clearRateLimitKeys>) => { rateSpies.clear(...args); return actual.clearRateLimitKeys(...args); }),
  };
});
vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeAuditEventAsync: auditSpy,
}));
vi.mock('../../services/password', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/password')>()),
  verifyPassword: passwordCheck,
}));
vi.mock('../../services/email', () => ({ getEmailService: () => null }));
vi.mock('../../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => activeOrgResult.current),
  isUsableOrgStatus: (s: string) => s === 'active' || s === 'trial',
  invalidateAgentTenantCache: vi.fn(async () => undefined),
}));
// W3: the access-policy resolver is the boundary under test here; the pick,
// isSignInMethodAllowed and the error class stay real.
const resolvePolicy = vi.hoisted(() => vi.fn());
vi.mock('../../services/portalAccessPolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/portalAccessPolicy')>()),
  resolvePortalAccessPolicy: resolvePolicy,
}));

import { authRoutes, portalAuthMiddleware } from './auth';
import { portalRateLimitBuckets, portalSessions } from './helpers';
import { PortalAccessPolicyOrgNotFoundError, pickEffectivePortalAccessPolicy } from '../../services/portalAccessPolicy';
import { PgDialect } from 'drizzle-orm/pg-core';
import { verifyPassword } from '../../services/password';
import { PORTAL_LOGIN_CANDIDATE_CAP } from './loginCandidates';
import {
  PORTAL_SESSION_COOKIE_NAME,
  PORTAL_CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from './schemas';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const USER_ID = '11111111-2222-4333-8444-555566667777';
const TOKEN = 'portal-session-token-for-logout-test';
const CSRF_TOKEN = 'csrf-token-for-logout-test';

function seedSession() {
  portalSessions.set(TOKEN, {
    token: TOKEN,
    portalUserId: USER_ID,
    orgId: ORG_ID,
    authEpoch: 1,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  gateway.mockResolvedValue({ ok: true, orgId: ORG_ID });
  passwordCheck.mockResolvedValue(true);
  staffLookup.mockResolvedValue([]);
  portalSessions.clear();
  portalUserRows.current = null;
  portalRateLimitBuckets.clear();
  portalUserRow.current = {
    id: USER_ID,
    orgId: ORG_ID,
    email: 'cust@acme.example',
    name: 'Cust',
    contactId: null,
    receiveNotifications: true,
    status: 'active',
    authMethod: 'password',
    browserAccess: 'granted',
    authEpoch: 1,
    accessMode: 'standard',
  };
  activeOrgResult.current = { orgId: ORG_ID, partnerId: 'partner-1' };
  resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'allowed'));
});

describe('two-step remote login', () => {
  function login(unifiedNative = false) {
    const app = new Hono(); app.route('/', authRoutes);
    return app.request('/auth/login', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': 'company-assertion',
    }, body: JSON.stringify({ email: 'cust@acme.example', password: 'synthetic-password', unifiedNative }) });
  }
  beforeEach(() => { portalUserRow.current!.passwordHash = 'synthetic-hash'; portalUserRow.current!.accessMode = 'remote_only'; });
  it('does not issue a session when a correct individual password has the wrong company', async () => {
    gateway.mockResolvedValue({ ok: false, status: 403 });
    expect((await login()).status).toBe(403);
    expect(gateway).toHaveBeenCalledWith('company-assertion', ORG_ID);
    expect(portalSessions.size).toBe(0);
  });
  it('still requires the individual password before company authorization', async () => {
    passwordCheck.mockResolvedValue(false);
    expect((await login()).status).toBe(401);
    expect(gateway).not.toHaveBeenCalled(); expect(portalSessions.size).toBe(0);
  });
  it('creates a remote-only session when both credentials pass', async () => {
    const response = await login(); expect(response.status).toBe(200);
    expect((await response.json()).user.accessMode).toBe('remote_only');
    expect(portalSessions.size).toBe(1);
  });
  it('does not turn a staff denial into a customer session for a shared identity', async () => {
    staffLookup.mockResolvedValue([{ id: 'staff-account' }]);
    const response = await login(true);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid email or password' });
    expect(portalSessions.size).toBe(0);
    expect(gateway).not.toHaveBeenCalled();
  });
  it('does not query staff identity before proving the customer password', async () => {
    passwordCheck.mockResolvedValue(false);
    expect((await login(true)).status).toBe(401);
    expect(staffLookup).not.toHaveBeenCalled();
  });
  it('allows an authenticated remote customer through the existing company gate', async () => {
    expect((await login(true)).status).toBe(200);
    expect(staffLookup).toHaveBeenCalledOnce();
    expect(gateway).toHaveBeenCalledWith('company-assertion', ORG_ID);
    expect(portalSessions.size).toBe(1);
  });
  it('preserves ordinary portal login when the unified flow is not requested', async () => {
    staffLookup.mockResolvedValue([{ id: 'staff-account' }]);
    expect((await login()).status).toBe(200);
    expect(staffLookup).not.toHaveBeenCalled();
  });
  it('does not issue a unified remote login for a standard portal account', async () => {
    portalUserRow.current!.accessMode = 'standard';
    expect((await login(true)).status).toBe(403);
    expect(portalSessions.size).toBe(0);
  });
});

describe('remote-only middleware authorization', () => {
  const app = new Hono();
  app.use('/api/v1/portal/*', portalAuthMiddleware);
  app.get('/api/v1/portal/*', c => c.json({ reachedHandler: true }));

  it.each(['/devices', '/devices/export.csv', '/tickets', '/invoices', '/quotes', '/reports'])('blocks direct calls to %s', async path => {
    seedSession();
    portalUserRow.current!.accessMode = 'remote_only';
    const result = await app.request(`/api/v1/portal${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(result.status).toBe(403);
    expect(await result.json()).toMatchObject({ code: 'PORTAL_REMOTE_ONLY' });
  });

  it('allows remote handlers and preserves ordinary portal accounts', async () => {
    seedSession();
    portalUserRow.current!.accessMode = 'remote_only';
    expect((await app.request('/api/v1/portal/remote/devices', { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    portalUserRow.current!.accessMode = 'standard';
    expect((await app.request('/api/v1/portal/devices', { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });
});
const NO_ROW = { entraEnabled: null, googleEnabled: null, passwordMode: null, selfRegistrationMode: null, ssoNewPersonMode: null, ssoSessionMaxHours: null };
/** A resolved policy built by the real pick with entra runnable: 'sso_only' is effective, 'allowed' is today's default. */
function policyFor(orgId: string, mode: 'allowed' | 'sso_only') {
  const org = mode === 'sso_only' ? { ...NO_ROW, entraEnabled: true, passwordMode: 'sso_only' as const } : null;
  // W4: Microsoft is effective only for an org with a proven tenant (plan D2), which entra sessions pin (D9).
  const proven = mode === 'sso_only';
  return {
    orgId, partnerId: 'partner-1', entraTenant: proven ? { tenantId: PROVEN_TENANT_ID, provenAt: '2026-11-01T00:00:00.000Z' } : null,
    ...pickEffectivePortalAccessPolicy(org, null, { entra: true, google: false, selfRegistration: false }, { entraTenantProven: proven }),
  };
}
const PROVEN_TENANT_ID = '72f988bf-86f1-41af-91ab-2d7cd011db47';

describe('portalAuthMiddleware partner context', () => {
  it('surfaces the active organization owning partner on portalAuth', async () => {
    seedSession();
    activeOrgResult.current = {
      orgId: ORG_ID,
      partnerId: 'partner-network-visibility',
    };

    const app = new Hono();

    app.use('*', portalAuthMiddleware);

    app.get('/protected', (c) => {
      const auth = c.get('portalAuth');

      return c.json({
        orgId: auth.user.orgId,
        partnerId: auth.partnerId,
      });
    });

    const res = await app.request('/protected', {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      orgId: ORG_ID,
      partnerId: 'partner-network-visibility',
    });
  });
});

describe('POST /auth/logout — disabled portal user', () => {
  it('succeeds and clears the session for a disabled portal user (bearer auth)', async () => {
    seedSession();
    portalUserRow.current = { ...portalUserRow.current, status: 'disabled' };

    const res = await authRoutes.request('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(portalSessions.has(TOKEN)).toBe(false);
  });

  it('clears the session cookie for a disabled portal user (cookie auth)', async () => {
    seedSession();
    portalUserRow.current = { ...portalUserRow.current, status: 'disabled' };

    const res = await authRoutes.request('/auth/logout', {
      method: 'POST',
      headers: {
        cookie: `${PORTAL_SESSION_COOKIE_NAME}=${TOKEN}; ${PORTAL_CSRF_COOKIE_NAME}=${CSRF_TOKEN}`,
        [CSRF_HEADER_NAME]: CSRF_TOKEN,
      },
    });

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${PORTAL_SESSION_COOKIE_NAME}=;`);
    expect(setCookie).toContain('Max-Age=0');
    expect(portalSessions.has(TOKEN)).toBe(false);
  });

  it('still succeeds for an active portal user (no regression)', async () => {
    seedSession();

    const res = await authRoutes.request('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(portalSessions.has(TOKEN)).toBe(false);
  });

  it('does not consult the org-status gate for a disabled user signing out', async () => {
    seedSession();
    portalUserRow.current = { ...portalUserRow.current, status: 'disabled' };
    // If logout consulted the org gate we would never learn either way from
    // the response, so make the org gate itself fail — a regression that
    // re-adds the org check ahead of the logout exemption would 403 here.
    activeOrgResult.current = null;

    const res = await authRoutes.request('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
  });
});

// The projection mock serves every select from portalUserRow, so `orgName`
// on the row models the organizations.name the route must look up.
describe('POST /auth/login — organization name in the user payload', () => {
  it('carries the organization name, not the generic fallback', async () => {
    portalUserRow.current = {
      ...portalUserRow.current,
      passwordHash: 'stored-hash',
      orgName: 'Default Organization',
    };
    const app = new Hono();
    app.route('/', authRoutes);

    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cust@acme.example', password: 'pw', orgId: ORG_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.orgName).toBe('Default Organization');
    expect(body.user.organizationName).toBe('Default Organization');
  });

  it('surfaces the organization name on portalAuth for /profile and /me', async () => {
    seedSession();
    portalUserRow.current = { ...portalUserRow.current, orgName: 'Default Organization' };
    const app = new Hono();
    app.use('*', portalAuthMiddleware);
    app.get('/p', (c) => c.json({ orgName: c.get('portalAuth').user.orgName }));
    const res = await app.request('/p', { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(await res.json()).toEqual({ orgName: 'Default Organization' });
  });
});

// #10934: a portal user in a churned/archived org used to get a 200 at login,
// then a 403 on the very next request and a silent bounce back to /login.
// The refusal belongs at login, but only AFTER the password verifies, so the
// distinct message can never be used to learn whether an email exists.
describe('POST /auth/login — unavailable organization (#10934)', () => {
  const login = (password = 'pw') => {
    const app = new Hono();
    app.route('/', authRoutes);
    return app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cust@acme.example', password, orgId: ORG_ID }),
    });
  };

  beforeEach(() => {
    portalUserRow.current = { ...portalUserRow.current, passwordHash: 'stored-hash', orgName: 'Acme' };
  });

  it('refuses a churned/archived org with a clear message and code, and issues no session', async () => {
    activeOrgResult.current = null; // getActiveOrgTenant: churned, archived, deleted or partner inactive
    const res = await login();

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('PORTAL_ORG_UNAVAILABLE');
    expect(body.error).toMatch(/no longer active/i);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(portalSessions.size).toBe(0);
  });

  it('still signs in an active org', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect((await res.json()).accessToken).toBeTruthy();
  });

  it('does not reveal the org state on a wrong password', async () => {
    activeOrgResult.current = null;
    const { verifyPassword } = await import('../../services/password');
    vi.mocked(verifyPassword).mockResolvedValueOnce(false);
    const res = await login('wrong');

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid email or password');
  });

  it('does not reveal the org state for an unknown email', async () => {
    activeOrgResult.current = null;
    portalUserRow.current = null;
    const res = await login();

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid email or password');
  });
});

// ---------------------------------------------------------------------------
// Portal registration W2 (spec §6 invariant 8): login must not reveal that an
// address has more than one account. Review Focus 3.
// ---------------------------------------------------------------------------

describe('POST /auth/login — uniform failure for an email with several accounts (W2)', () => {
  const OTHER_ORG = '7c0a1f7e-2222-4222-8333-444455556666';
  const acct = (id: string, orgId: string, email: string, password: string) => ({
    ...portalUserRow.current, id, orgId, email, passwordHash: `hash:${password}`, status: 'active', browserAccess: 'granted', authEpoch: 1, orgName: 'Acme',
  });
  const login = (body: Record<string, unknown>) => {
    const app = new Hono();
    app.route('/', authRoutes);
    return app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  };
  const rateShape = () => rateSpies.check.mock.calls.map((c) => String(c[0]).split(':').slice(0, 3).join(':'));

  beforeEach(() => {
    activeOrgResult.current = { orgId: ORG_ID, partnerId: 'partner-1' };
    vi.mocked(verifyPassword).mockImplementation(async (hash: string, pw: string) => hash === `hash:${pw}`);
  });

  it('duplicate-email login is indistinguishable from a bad password', async () => {
    portalUserRows.current = [
      acct('11111111-0000-4000-8000-000000000001', ORG_ID, 'shared@x.test', 'SamePass1!'),
      acct('11111111-0000-4000-8000-000000000002', OTHER_ORG, 'shared@x.test', 'SamePass1!'),
    ];
    const dup = await login({ email: 'shared@x.test', password: 'SamePass1!' });
    const dupShape = rateShape();
    const dupAudit = auditSpy.mock.calls.at(-1)?.[1] as Record<string, unknown>;

    rateSpies.check.mockClear();
    portalUserRows.current = [acct('11111111-0000-4000-8000-000000000003', ORG_ID, 'solo@x.test', 'Right1!')];
    const bad = await login({ email: 'solo@x.test', password: 'wrong' });

    expect(dup.status).toBe(401);
    expect(bad.status).toBe(401);
    expect(await dup.json()).toEqual(await bad.json());
    expect(await (await login({ email: 'solo@x.test', password: 'wrong' })).json()).toEqual({ error: 'Invalid email or password' });
    // Same two throttling buckets per attempt (per IP, per account).
    expect(dupShape).toEqual(['portal:login:ip', expect.stringMatching(/^portal:/)]);
    expect(rateShape().slice(0, 2)).toEqual(dupShape);
    expect(rateSpies.clear).not.toHaveBeenCalled();
    expect(portalSessions.size).toBe(0);
    // Several candidates with no winner audit like an unknown address.
    expect(dupAudit).toMatchObject({ actorType: 'system', result: 'denied' });
    expect(dupAudit.orgId).toBeUndefined();
  });

  it('duplicate email with different passwords signs in to the org whose password verified', async () => {
    portalUserRows.current = [
      acct('11111111-0000-4000-8000-000000000001', ORG_ID, 'shared@x.test', 'PassA1!'),
      acct('11111111-0000-4000-8000-000000000002', OTHER_ORG, 'shared@x.test', 'PassB1!'),
    ];
    activeOrgResult.current = { orgId: OTHER_ORG, partnerId: 'partner-1' };
    const res = await login({ email: 'shared@x.test', password: 'PassB1!' });
    expect(res.status).toBe(200);
    const [session] = [...portalSessions.values()];
    expect(session).toMatchObject({ portalUserId: '11111111-0000-4000-8000-000000000002', orgId: OTHER_ORG });
    // Every candidate was verified (no short-circuit), the winner audited.
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(2);
    expect(auditSpy.mock.calls.at(-1)?.[1]).toMatchObject({ actorId: '11111111-0000-4000-8000-000000000002', orgId: OTHER_ORG, result: 'success' });
    expect(rateSpies.clear).toHaveBeenCalledTimes(1);
  });

  it('no longer answers "Multiple portal accounts found" (the 400 is gone)', async () => {
    portalUserRows.current = [
      acct('11111111-0000-4000-8000-000000000001', ORG_ID, 'shared@x.test', 'PassA1!'),
      acct('11111111-0000-4000-8000-000000000002', OTHER_ORG, 'shared@x.test', 'PassB1!'),
    ];
    const res = await login({ email: 'shared@x.test', password: 'nope' });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toMatch(/multiple/i);
  });

  it('orgId narrows candidates to that org; every lookup requires a password login with browser access', async () => {
    portalUserRows.current = [acct('11111111-0000-4000-8000-000000000001', ORG_ID, 'shared@x.test', 'PassA1!')];
    await login({ email: 'shared@x.test', password: 'PassA1!', orgId: ORG_ID });
    const narrowed = new PgDialect().sqlToQuery(whereSpy.mock.calls[0]![0] as never).params;
    expect(narrowed).toEqual(expect.arrayContaining(['orgId', ORG_ID, 'email', 'shared@x.test', 'authMethod', 'password', 'browserAccess', 'granted']));
    expect(limitSpy).toHaveBeenCalledWith(PORTAL_LOGIN_CANDIDATE_CAP + 1);

    whereSpy.mockClear();
    await login({ email: 'shared@x.test', password: 'PassA1!' });
    const open = new PgDialect().sqlToQuery(whereSpy.mock.calls[0]![0] as never).params;
    expect(open).not.toContain(ORG_ID);
    expect(open).toEqual(expect.arrayContaining(['browserAccess', 'granted']));
  });

  it('an account with no password (invite pending) still costs one dummy verify and gets the generic 401', async () => {
    portalUserRows.current = [{ ...acct('11111111-0000-4000-8000-000000000001', ORG_ID, 'pending@x.test', 'x'), passwordHash: null, status: 'invited' }];
    const res = await login({ email: 'pending@x.test', password: 'Whatever1!' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid email or password' });
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Portal registration W3 (#11380): the access policy at login (inv. 8 / 11,
// Review Focus 1). A password login refused by policy is the bad-password 401.
// ---------------------------------------------------------------------------

describe('POST /auth/login — access policy (W3)', () => {
  const login = (password: string) => {
    const app = new Hono();
    app.route('/', authRoutes);
    return app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cust@acme.example', password, orgId: ORG_ID }),
    });
  };
  const rateKeys = () => rateSpies.check.mock.calls.map((c) => String(c[0]));
  const buckets = () => [...portalRateLimitBuckets.entries()].map(([k, b]) => [k, b.count]);

  beforeEach(() => {
    portalUserRow.current = { ...portalUserRow.current, passwordHash: 'hash:Right1!', orgName: 'Acme' };
    vi.mocked(verifyPassword).mockImplementation(async (hash: string, pw: string) => hash === `hash:${pw}`);
  });

  it('login under sso_only equals a bad password (status, body, rate-limit buckets, no clear)', async () => {
    const bad = await login('Wrong1!');
    const badText = await bad.text();
    const badKeys = rateKeys();
    const badBuckets = buckets();
    expect(resolvePolicy).not.toHaveBeenCalled(); // a wrong password never reaches the policy

    rateSpies.check.mockClear();
    portalRateLimitBuckets.clear();
    resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
    const refused = await login('Right1!');

    expect(bad.status).toBe(401);
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe(badText);
    expect(JSON.parse(badText)).toEqual({ error: 'Invalid email or password' });
    expect(badKeys).toHaveLength(2);
    expect(rateKeys()).toEqual(badKeys);
    expect(buckets()).toEqual(badBuckets);
    expect(rateSpies.clear).not.toHaveBeenCalled();
    expect(refused.headers.get('set-cookie')).toBeNull();
    expect(portalSessions.size).toBe(0);
    expect(resolvePolicy).toHaveBeenCalledWith(ORG_ID);
  });

  it('the policy refusal comes before the org-unavailable 403 (it never reveals org state)', async () => {
    resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
    activeOrgResult.current = null;
    const res = await login('Right1!');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid email or password' });
  });

  it('an org the resolver cannot find is refused with the same 401', async () => {
    resolvePolicy.mockRejectedValue(new PortalAccessPolicyOrgNotFoundError(ORG_ID));
    const res = await login('Right1!');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid email or password' });
    expect(portalSessions.size).toBe(0);
  });

  it('policy allowed (no rows): signs in and mints a password session', async () => {
    const res = await login('Right1!');
    expect(res.status).toBe(200);
    const [session] = [...portalSessions.values()];
    expect(session).toMatchObject({ portalUserId: USER_ID, orgId: ORG_ID, method: 'password' });
    expect(rateSpies.clear).toHaveBeenCalledTimes(1);
  });
});
