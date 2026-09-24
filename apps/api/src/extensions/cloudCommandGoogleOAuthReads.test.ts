import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const { decrypt } = vi.hoisted(() => ({ decrypt: vi.fn(() => 'private-refresh') }));
vi.mock('../services/secretCrypto', () => ({ decryptForColumn: decrypt }));
import { oauthActivity, oauthDirectory, oauthMembers, oauthStorage, type GoogleOAuthConnection } from './cloudCommandGoogleOAuthReads';

const base = 'https://www.googleapis.com/auth/';
const row: GoogleOAuthConnection = { id: 'row', org_id: 'org', customer_id: 'C123', customer_domain: 'example.test',
  authorized_email: 'admin@example.test', refresh_token: 'encrypted', status: 'active', verified_at: new Date(),
  granted_scopes: [base + 'admin.directory.user.readonly', base + 'admin.directory.group.readonly',
    base + 'admin.reports.usage.readonly', base + 'admin.reports.audit.readonly'].join(' ') };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json' } });
let google: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv('CLOUDCOMMAND_GOOGLE_OAUTH_CLIENT_ID', 'client');
  vi.stubEnv('CLOUDCOMMAND_GOOGLE_OAUTH_CLIENT_SECRET', 'secret');
  google = vi.fn(async (url: string | URL) => String(url).includes('/token')
    ? response({ access_token: 'short-lived-token' }) : response({}));
  vi.stubGlobal('fetch', google);
  decrypt.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Cloud Command Google OAuth read adapter', () => {
  it('uses the verified customer and omits users outside its domain/customer', async () => {
    google.mockImplementation(async (url: string | URL) => String(url).includes('/token')
      ? response({ access_token: 'short-lived-token' })
      : response({ users: [
        { id: 'u1', customerId: 'C123', primaryEmail: 'one@example.test', name: { fullName: 'One' }, secret: 'provider-secret' },
        { id: 'u2', customerId: 'OTHER', primaryEmail: 'other@example.test' },
        { id: 'u3', customerId: 'C123', primaryEmail: 'secondary@other.test' },
      ], nextPageToken: 'next' }));
    const result = await oauthDirectory(row, 'users', null);
    expect(result).toMatchObject({ ok: true, nextPageToken: 'next', items: [{ id: 'u1', email: 'one@example.test' }] });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    expect(google.mock.calls[1][0].toString()).toContain('customer=C123');
    expect(decrypt).toHaveBeenCalledWith('cloudcommand_google_oauth_connections', 'refresh_token:org', 'encrypted');
  });
  it('rejects a cross-domain group before listing members', async () => {
    google.mockImplementation(async (url: string | URL) => String(url).includes('/token')
      ? response({ access_token: 'short-lived-token' }) : response({ id: 'g1', email: 'team@other.test' }));
    expect(await oauthMembers(row, 'g1', null)).toMatchObject({ ok: false, code: 'provider_failed' });
    expect(google.mock.calls).toHaveLength(2);
  });
  it('gates reports on the exact granted scope without refreshing a token', async () => {
    const noReports = { ...row, granted_scopes: base + 'admin.directory.user.readonly' };
    const date = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    expect(await oauthStorage(noReports, date, null)).toMatchObject({ ok: false, code: 'scope_required' });
    expect(await oauthActivity(noReports, 'login', 7, null, null)).toMatchObject({ ok: false, code: 'scope_required' });
    expect(google).not.toHaveBeenCalled();
  });
  it('filters usage by customer and returns only bounded metrics', async () => {
    google.mockImplementation(async (url: string | URL) => String(url).includes('/token')
      ? response({ access_token: 'short-lived-token' })
      : response({ usageReports: [
        { entity: { customerId: 'C123', userEmail: 'one@example.test' }, parameters: [
          { name: 'accounts:gmail_used_quota_in_mb', intValue: '12' },
          { name: 'accounts:drive_used_quota_in_mb', intValue: 'bad' },
          { name: 'accounts:used_quota_in_mb', intValue: '20' }], secret: 'provider-secret' },
        { entity: { customerId: 'OTHER', userEmail: 'two@example.test' }, parameters: [] },
      ] }));
    const date = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const result = await oauthStorage(row, date, null);
    expect(result).toMatchObject({ ok: true, partial: true, items: [{ email: 'one@example.test', gmailMb: 12,
      driveMb: null, totalMb: 20 }] });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    expect(JSON.stringify(result)).not.toContain('OTHER');
  });
});
