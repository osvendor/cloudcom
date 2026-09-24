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

const { portalUserRow, activeOrgResult } = vi.hoisted(() => ({
  portalUserRow: { current: null as Record<string, unknown> | null },
  activeOrgResult: { current: null as { orgId: string; partnerId: string } | null },
}));

const resolveOrgTimezone = vi.hoisted(() => vi.fn(async () => 'UTC'));
const gateway = vi.hoisted(() => vi.fn());
const passwordCheck = vi.hoisted(() => vi.fn());
vi.mock('../../services/portalCompanyGateway', () => ({ checkPortalCompanyGateway: gateway }));
vi.mock('../../services/password', () => ({ verifyPassword: passwordCheck, hashPassword: vi.fn(), isPasswordStrong: vi.fn() }));

vi.mock('../../services/portal/timezone', () => ({
  resolveOrgTimezone,
}));

// Same projection-applying mock as authOrgStatusGate.test.ts — a naive echo
// mock would hide a column the middleware forgot to select.
function project(columns: Record<string, unknown>): Array<Record<string, unknown>> {
  const row = portalUserRow.current;
  if (!row) return [];
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(columns)) out[key] = row[key] ?? null;
  return [out];
}

vi.mock('../../db', () => ({
  db: {
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(project(columns)) }),
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
  },
  portalBranding: { orgId: 'orgId', enablePasswordReset: 'enablePasswordReset' },
}));
vi.mock('../../services/email', () => ({ getEmailService: () => null }));
vi.mock('../../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => activeOrgResult.current),
  isUsableOrgStatus: (s: string) => s === 'active' || s === 'trial',
  invalidateAgentTenantCache: vi.fn(async () => undefined),
}));

import { authRoutes, portalAuthMiddleware } from './auth';
import { portalSessions } from './helpers';
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
  portalSessions.clear();
  portalUserRow.current = {
    id: USER_ID,
    orgId: ORG_ID,
    email: 'cust@acme.example',
    name: 'Cust',
    contactId: null,
    receiveNotifications: true,
    status: 'active',
    authMethod: 'password',
    authEpoch: 1,
    accessMode: 'standard',
  };
  activeOrgResult.current = { orgId: ORG_ID, partnerId: 'partner-1' };
});

describe('two-step remote login', () => {
  function login() {
    const app = new Hono(); app.route('/', authRoutes);
    return app.request('/auth/login', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': 'company-assertion',
    }, body: JSON.stringify({ email: 'cust@acme.example', password: 'synthetic-password' }) });
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
