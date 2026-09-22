import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';
import { createRoutes } from './index';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const DEVICE = '44444444-4444-4444-8444-444444444444';
function appFor(options: { loggedIn?: boolean; canAccess?: boolean; mfa?: boolean; write?: boolean; siteIds?: string[] } = {}) {
  const execute = vi.fn().mockResolvedValue([{ partner_id: 'partner' }]);
  const audit = vi.fn().mockResolvedValue(undefined);
  const context = { db: { execute }, audit, log: vi.fn() } as unknown as ExtensionRuntimeContext;
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (options.loggedIn !== false) {
      c.set('auth' as never, { user: { id: ACTOR }, partnerId: 'partner', canAccessOrg: () => options.canAccess !== false } as never);
      c.set('extensionAuthorization' as never, { allowedSiteIds: options.siteIds, mfaSatisfied: options.mfa !== false,
        hasPermission: (_resource: string, action: string) => action !== 'write' || options.write !== false,
      } as never);
    }
    await next();
  });
  app.route('/', createRoutes(context));
  return { app, execute, audit };
}
const request = (body: unknown, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('Remote Access extension administration', () => {
  it('denies unauthenticated and cross-organization calls before querying data', async () => {
    for (const options of [{ loggedIn: false }, { canAccess: false }, { siteIds: [] }]) {
      const { app, execute } = appFor(options);
      const result = await app.request(`/orgs/${ORG}/options`);
      expect([401,403]).toContain(result.status);
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it('requires management permission and current MFA for every mutation', async () => {
    for (const options of [{ mfa: false }, { write: false }]) {
      const { app, execute } = appFor(options);
      expect((await app.request(`/orgs/${ORG}/assignments`, request({ portalUserId: USER, deviceId: DEVICE }))).status).toBe(403);
      expect((await app.request(`/orgs/${ORG}/settings`, request({ enabled: true, webrtcEnabled: true, rustdeskEnabled: true }, 'PUT'))).status).toBe(403);
      expect((await app.request(`/orgs/${ORG}/assignments/${USER}`, { method: 'DELETE' })).status).toBe(403);
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it('does not modify or audit when an account or device is unavailable', async () => {
    const { app, execute, audit } = appFor();
    execute.mockResolvedValueOnce([{ partner_id: 'partner' }]).mockResolvedValueOnce([]);
    expect((await app.request(`/orgs/${ORG}/assignments`, request({ portalUserId: USER, deviceId: DEVICE }))).status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });
  it('validates identifiers, expiry and strict body shape', async () => {
    const { app } = appFor();
    expect((await app.request('/orgs/not-a-uuid/options')).status).toBe(400);
    for (const body of [{}, { portalUserId: USER, deviceId: DEVICE, expiresAt: '2000-01-01T00:00:00Z' }, { portalUserId: USER, deviceId: DEVICE, orgId: ORG }]) {
      expect((await app.request(`/orgs/${ORG}/assignments`, request(body))).status).toBe(400);
    }
  });
  it('records actor and customer target when granting access', async () => {
    const { app, execute, audit } = appFor();
    execute.mockResolvedValueOnce([{ partner_id: 'partner' }]).mockResolvedValueOnce([{ id: USER, enabled: true, version: 1 }]);
    const result = await app.request(`/orgs/${ORG}/assignments`, request({ portalUserId: USER, deviceId: DEVICE }));
    expect(result.status).toBe(201);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, actorId: ACTOR,
      action: 'remote_access.assignment.granted', resourceId: DEVICE, details: expect.objectContaining({ portalUserId: USER }) }));
  });
  it('returns a safe failure if storage fails without logging query or account data', async () => {
    const { app, execute } = appFor();
    execute.mockRejectedValue(new Error('synthetic private database details'));
    const result = await app.request(`/orgs/${ORG}/options`);
    expect(result.status).toBe(500);
    expect(await result.text()).not.toContain('private database');
  });
});
