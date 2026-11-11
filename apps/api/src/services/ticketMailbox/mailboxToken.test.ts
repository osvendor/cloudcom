import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../c2cM365', () => ({
  isM365TenantId: (x: string) => /^[0-9a-f-]{36}$/i.test(x),
  acquireClientCredentialsToken: vi.fn(async () => ({ accessToken: 'tok-1', expiresIn: 3600 })),
}));

vi.mock('../../extensions/cloudCommandAdminRuntime', () => ({
  cloudCommandAdminRuntime: { configuration: vi.fn(async () => null), acquireToken: vi.fn(async () => 'certificate-token') },
}));
import { cloudCommandAdminRuntime } from '../../extensions/cloudCommandAdminRuntime';

import { acquireClientCredentialsToken } from '../c2cM365';
import { getMailboxToken, _clearMailboxTokenCache } from './mailboxToken';

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('getMailboxToken', () => {
  beforeEach(() => {
    _clearMailboxTokenCache();
    vi.mocked(acquireClientCredentialsToken).mockClear();
    process.env.TICKET_MAILBOX_M365_CLIENT_ID = 'cid';
    process.env.TICKET_MAILBOX_M365_CLIENT_SECRET = 'csecret';
  });

  it('acquires once and caches within the freshness window', async () => {
    const a = await getMailboxToken(TENANT);
    const b = await getMailboxToken(TENANT);
    expect(a).toBe('tok-1');
    expect(b).toBe('tok-1');
    expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(1);
  });

  it('uses the existing Cloud Command certificate app when no explicit override exists', async () => {
    delete process.env.TICKET_MAILBOX_M365_CLIENT_ID;
    delete process.env.TICKET_MAILBOX_M365_CLIENT_SECRET;
    vi.mocked(cloudCommandAdminRuntime.configuration).mockResolvedValueOnce({ clientId: 'cloud-command-app', credentialVersion: 'cert-1', redirectUri: 'https://example.com/extensions/cloudcommand/connect' });
    expect(await getMailboxToken(TENANT)).toBe('certificate-token');
    expect(cloudCommandAdminRuntime.acquireToken).toHaveBeenCalledWith({ tenantId: TENANT, clientId: 'cloud-command-app', credentialVersion: 'cert-1' });
    expect(acquireClientCredentialsToken).not.toHaveBeenCalled();
  });

  it('does not reuse a legacy app token after its secret changes', async () => {
    await getMailboxToken(TENANT);
    process.env.TICKET_MAILBOX_M365_CLIENT_SECRET = 'rotated-secret';
    await getMailboxToken(TENANT);
    expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(2);
  });

  it('does not fall back from a partially configured explicit app', async () => {
    delete process.env.TICKET_MAILBOX_M365_CLIENT_SECRET;
    await expect(getMailboxToken(TENANT)).rejects.toThrow(/not configured/);
  });

  it('rejects a non-GUID tenant id', async () => {
    await expect(getMailboxToken('common')).rejects.toThrow(/tenant id/i);
  });

  it('throws when app creds are not configured', async () => {
    delete process.env.TICKET_MAILBOX_M365_CLIENT_ID;
    await expect(getMailboxToken(TENANT)).rejects.toThrow(/not configured/i);
  });
});
