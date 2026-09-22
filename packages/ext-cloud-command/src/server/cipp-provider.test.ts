import { describe, expect, it, vi } from 'vitest';
import { createCippProvider } from './cipp-provider';
import type { CippDeployment } from './cipp-config';

const config: CippDeployment = {
  origin: 'https://cipp.example.test',
  partnerId: '11111111-1111-4111-8111-111111111111',
  authTenantId: '22222222-2222-4222-8222-222222222222',
  clientId: '33333333-3333-4333-8333-333333333333',
  secret: 'synthetic-secret',
  scope: 'api://33333333-3333-4333-8333-333333333333/.default',
  identity: 'fixture',
};
const token = () => Response.json({ access_token: 'synthetic-token' });
const user = (over: Record<string, unknown> = {}) => ({
  id: '44444444-4444-4444-8444-444444444444',
  displayName: 'Ada',
  userPrincipalName: 'ada@example.test',
  accountEnabled: true,
  userType: 'Member',
  department: null,
  ...over,
});
const site = () => ({
  siteId: 'site-1',
  displayName: 'Site',
  webUrl: 'https://customer.example.test/sites/a',
  ownerDisplayName: null,
  storageUsedInGigabytes: 1,
  storageAllocatedInGigabytes: 2,
  reportRefreshDate: '2026-01-01',
});
function providerWith(body: unknown) {
  const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(Response.json(body));
  return { provider: createCippProvider(fetch, config), fetch };
}

describe('CIPP provider boundary', () => {
  it('uses a fixed token issuer and deployment-owned CIPP endpoint with guarded transport', async () => {
    const { provider, fetch } = providerWith([user()]);
    await provider.resource('users', 'customer.example.test');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe(
      `https://login.microsoftonline.com/${config.authTenantId}/oauth2/v2.0/token`,
    );
    expect(fetch.mock.calls[1][0]).toBe(
      'https://cipp.example.test/api/ListUsers?tenantFilter=customer.example.test',
    );
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({ redirect: 'error', timeoutMs: 60000, maxBytes: 8 * 1024 * 1024 });
    }
    expect(String(fetch.mock.calls[0][1].body)).toContain('client_secret=synthetic-secret');
    expect(new Headers(fetch.mock.calls[1][1].headers).get('authorization')).toBe('Bearer synthetic-token');
  });

  it('uses the stored tenant domain as the only tenant filter and fixed endpoint allowlist', async () => {
    const { provider, fetch } = providerWith([site()]);
    await provider.resource('sites', 'stored.example.test');
    const url = String(fetch.mock.calls[1][0]);
    expect(url).toContain('/api/ListSites?');
    expect(url).toContain('tenantFilter=stored.example.test');
    expect(url).toContain('Type=SharePointSiteUsage');
    await expect(provider.resource('users', 'AllTenants')).rejects.toMatchObject({
      code: 'invalid_tenant_binding',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('projects only declared fields and never follows a provider nextLink', async () => {
    const { provider, fetch } = providerWith([
      user({
        passwordProfile: 'secret',
        '@odata.nextLink': 'https://attacker.example/steal',
        extra: { token: 'secret' },
      }),
    ]);
    const result = await provider.resource('users', 'customer.example.test');
    expect(result.items).toEqual([
      {
        id: '44444444-4444-4444-8444-444444444444',
        values: {
          displayName: 'Ada',
          userPrincipalName: 'ada@example.test',
          accountEnabled: true,
          userType: 'Member',
          department: null,
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain('https://attacker.example/steal');
  });

  it.each([
    ['CIPP error sentinel returned with HTTP 200', { error: 'access denied' }, 'invalid_provider_response'],
    ['non-array resource response', { value: [] }, 'invalid_provider_response'],
    ['non-object resource item', ['bad'], 'invalid_provider_response'],
    [
      'non-primitive projected field',
      [user({ displayName: { injected: true } })],
      'invalid_provider_response',
    ],
    ['oversized resource response', Array.from({ length: 10001 }, () => user()), 'invalid_provider_response'],
    ['duplicate resource ids', [user(), user()], 'invalid_provider_response'],
  ])('rejects %s', async (_label, body, code) => {
    const { provider } = providerWith(body);
    await expect(provider.resource('users', 'customer.example.test')).rejects.toMatchObject({ code });
  });

  it('rejects malformed or duplicate tenant responses', async () => {
    for (const body of [
      [{ customerId: 'not-a-uuid', defaultDomainName: 'customer.example.test', displayName: 'Customer' }],
      [
        {
          customerId: '55555555-5555-4555-8555-555555555555',
          defaultDomainName: 'customer.example.test',
          displayName: 'Customer',
        },
        {
          customerId: '55555555-5555-4555-8555-555555555555',
          defaultDomainName: 'other.example.test',
          displayName: 'Duplicate',
        },
      ],
    ]) {
      const { provider } = providerWith(body);
      await expect(provider.tenants()).rejects.toMatchObject({ code: 'invalid_tenant_response' });
    }
  });

  it.each([
    ['rate limiting', 429, 'cipp_rate_limited'],
    ['redirect response', 302, 'cipp_request_failed'],
  ])('fails closed on %s', async (_label, status, code) => {
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response('', { status }));
    await expect(
      createCippProvider(fetch, config).resource('users', 'customer.example.test'),
    ).rejects.toMatchObject({ code });
  });
});
