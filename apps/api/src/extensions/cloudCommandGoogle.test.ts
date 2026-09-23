import { beforeEach, describe, expect, it, vi } from 'vitest';
const { dbMocks, googleMocks } = vi.hoisted(() => ({
  dbMocks: { results: [] as unknown[][], select: vi.fn() },
  googleMocks: { users: vi.fn(), groups: vi.fn(), decrypt: vi.fn() },
}));
vi.mock('../db', () => ({
  db: { select: () => { dbMocks.select(); return { from: () => ({ where: () => ({ limit: async () => dbMocks.results.shift() ?? [] }) }) }; } },
  withDbAccessContext: async (_: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../db/schema/google', () => ({ googleWorkspaceConnections: { orgId: 'org_id' } }));
vi.mock('../middleware/auth', () => ({ dbAccessContextFromAuth: () => ({}) }));
vi.mock('../config/env', () => ({ GOOGLE_WORKSPACE_ENABLED: true }));
vi.mock('../services/googleHelpers', () => ({ decryptConnectionKey: googleMocks.decrypt }));
vi.mock('../services/googleClient', () => ({ getDirectoryClient: () => ({ users: { list: googleMocks.users }, groups: { list: googleMocks.groups } }) }));
import { nativeGoogleServices } from './cloudCommandGoogle';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const row = { orgId: ORG, status: 'active', customerDomain: 'example.test', adminEmail: 'admin@example.test', serviceAccountKey: 'encrypted', lastVerifiedAt: new Date('2026-09-22') };
const auth = { user: { id: 'actor' }, scope: 'organization', orgId: ORG, canAccessOrg: (id: string) => id === ORG, allowedSiteIds: undefined };
const request = (orgId = ORG) => ({ auth, orgId, authorization: { allowedSiteIds: undefined, hasPermission: () => true, mfaSatisfied: true } }) as never;
beforeEach(() => { vi.clearAllMocks(); dbMocks.results.length = 0; googleMocks.decrypt.mockReturnValue('secret'); });
describe('native Google Workspace bridge', () => {
  it('reads only the current organization connection and returns no credential in status', async () => {
    dbMocks.results.push([row]);
    const result = await nativeGoogleServices.connection(request());
    expect(result).toMatchObject({ available: true, connected: true, enabled: true, customerDomain: 'example.test' });
    expect(JSON.stringify(result)).not.toContain('encrypted');
  });
  it('denies a different organization before credential access', async () => {
    expect(await nativeGoogleServices.directory(request(OTHER), 'users', null)).toMatchObject({ ok: false, code: 'access_denied' });
    expect(dbMocks.select).not.toHaveBeenCalled();
    expect(googleMocks.decrypt).not.toHaveBeenCalled();
  });
  it('rejects a row that does not match the requested organization', async () => {
    dbMocks.results.push([{ ...row, orgId: OTHER }]);
    expect(await nativeGoogleServices.directory(request(), 'users', null)).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(googleMocks.decrypt).not.toHaveBeenCalled();
  });
  it('uses the configured domain, bounded page and fixed user projection', async () => {
    dbMocks.results.push([row]);
    googleMocks.users.mockResolvedValue({ data: { users: [{ id: 'u1', primaryEmail: 'one@example.test', name: { fullName: 'One' }, suspended: false, isAdmin: false, secret: 'provider-secret' }], nextPageToken: 'next' } });
    const result = await nativeGoogleServices.directory(request(), 'users', 'token');
    expect(googleMocks.users).toHaveBeenCalledWith(expect.objectContaining({ domain: 'example.test', maxResults: 100, pageToken: 'token' }));
    expect(result).toMatchObject({ ok: true, nextPageToken: 'next' });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
  });
  it('keeps provider error bodies out of browser errors', async () => {
    dbMocks.results.push([row]);
    googleMocks.groups.mockRejectedValue(new Error('private provider body'));
    const result = await nativeGoogleServices.directory(request(), 'groups', null);
    expect(result).toMatchObject({ ok: false, code: 'provider_failed' });
    expect(JSON.stringify(result)).not.toContain('private provider body');
  });
});
