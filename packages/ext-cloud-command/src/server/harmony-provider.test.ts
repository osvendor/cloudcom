import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarmonyProvider } from './harmony-provider';
import { HARMONY_REGIONS, type HarmonyCredentials } from './harmony-contract';
import type { GuardedFetch } from './transport';

const credentials: HarmonyCredentials = { region: 'us', clientId: 'synthetic-client', accessKey: 'synthetic-secret' };
const group = { id: 'client-a', name: 'Our client', type: 'GROUP' };
const other = { id: 'client-b', name: 'Other client', type: 'GROUP' };
function computer(id = 'endpoint-a', membership = [group]) { return { computerId: id, computerName: id, computerGroups: membership }; }
function page(computers: unknown[], totalCount = computers.length, pageOffset = 0) { return { computers, totalCount, pageOffset, pageSize: 250 }; }
function done(data: unknown) { return { status: 'DONE', statusCode: 200, statusType: 2, data }; }
function harness(options: {
  groups?: unknown; computerPage?: unknown; job?: unknown; login?: unknown; loginHeaders?: Record<string, string>;
  handler?: (url: string, init: Parameters<GuardedFetch>[1]) => Response | Promise<Response> | undefined;
} = {}) {
  const fetch = vi.fn<GuardedFetch>(async (url, init) => {
    const custom = options.handler?.(url, init);
    if (custom !== undefined) return custom;
    if (url.endsWith('/auth/external')) return Response.json({ data: { token: 'synthetic-ci-token' } });
    if (url.includes('/session/login/cloud')) return Response.json(options.login ?? { apiToken: 'synthetic-api-token' }, { status: 201, headers: options.loginHeaders });
    if (url.endsWith('/organization/tree/search')) return Response.json(options.groups ?? [group, other]);
    if (url.includes('/computers/filtered')) return Response.json({ jobId: 'job-1' });
    if (url.includes('/jobs/')) return Response.json(options.job ?? done(options.computerPage ?? page([computer(), computer('other-endpoint', [other])])));
    throw new Error('Unexpected request');
  });
  return { fetch, provider: createHarmonyProvider(fetch) };
}
afterEach(() => vi.useRealTimers());

describe('Harmony guarded sessions', () => {
  it.each(Object.entries(HARMONY_REGIONS))('uses fixed %s origin and both auth tokens without redirects', async (region, origin) => {
    const h = harness(); await h.provider.inventory({ ...credentials, region: region as HarmonyCredentials['region'] }, ['client-a']);
    expect(h.fetch.mock.calls).toHaveLength(5);
    const [url, auth] = h.fetch.mock.calls[0];
    expect(url).toBe(origin + '/auth/external');
    expect(JSON.parse(auth.body as string)).toEqual({ clientId: 'synthetic-client', accessKey: 'synthetic-secret' });
    for (const [target, init] of h.fetch.mock.calls) {
      expect(new URL(target).origin).toBe(origin);
      expect(init).toMatchObject({ redirect: 'error', timeoutMs: 15000, maxBytes: 4194304 });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (target.includes('/organization/') || target.includes('/computers/') || target.includes('/jobs/')) {
        expect(init.headers).toMatchObject({ Authorization: 'Bearer synthetic-ci-token', 'x-mgmt-api-token': 'synthetic-api-token' });
      }
    }
    expect(h.fetch.mock.calls[3][1].headers).toMatchObject({ 'x-mgmt-run-as-job': 'on' });
    expect(h.fetch.mock.calls[4][1]).toMatchObject({ method: 'GET', headers: { 'x-mgmt-run-as-job': 'off' } });
  });
  it('accepts the documented API token response header', async () => {
    const h = harness({ login: {}, loginHeaders: { 'x-mgmt-api-token': 'header-api-token' } });
    await h.provider.groups(credentials);
    expect(h.fetch.mock.calls[2][1].headers).toMatchObject({ 'x-mgmt-api-token': 'header-api-token' });
  });
  it.each(['https://attacker.invalid', 'constructor', '__proto__', ''])('rejects an invalid region before egress: %s', region => {
    const h = harness();
    return expect(h.provider.groups({ ...credentials, region: region as HarmonyCredentials['region'] })).rejects.toMatchObject({ code: 'harmony_invalid_region' }).then(() => expect(h.fetch).not.toHaveBeenCalled());
  });
  it('rejects control characters in credentials before egress', async () => {
    const h = harness(); await expect(h.provider.groups({ ...credentials, accessKey: 'bad\nsecret' })).rejects.toMatchObject({ code: 'harmony_invalid_credentials' });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('rejects a missing or malformed authorization token before opening a management session', async () => {
    for (const token of [undefined, '', 'token\nInjected: header']) {
      const fetch = vi.fn<GuardedFetch>(async () => Response.json({ data: { token } }));
      await expect(createHarmonyProvider(fetch).groups(credentials)).rejects.toThrow('harmony_invalid_response');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('keeps credentials and sessions separate during concurrent client requests', async () => {
    const fetch = vi.fn<GuardedFetch>(async (url, init) => {
      const headers = init.headers as Record<string, string>;
      if (url.endsWith('/auth/external')) return Response.json({ token: `ci-${JSON.parse(init.body as string).clientId}` });
      if (url.includes('/session/login/')) return Response.json({ apiToken: `api-${headers.Authorization.slice(7)}` });
      expect(headers['x-mgmt-api-token']).toBe(`api-${headers.Authorization.slice(7)}`);
      return Response.json([{ ...group, id: headers.Authorization.slice(7) }]);
    });
    const provider = createHarmonyProvider(fetch);
    const [a, b] = await Promise.all([provider.groups({ ...credentials, clientId: 'a' }), provider.groups({ ...credentials, clientId: 'b' })]);
    expect(a[0].id).toBe('ci-a'); expect(b[0].id).toBe('ci-b');
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it.each([[302, 'harmony_redirect_refused'], [401, 'harmony_access_denied'], [403, 'harmony_access_denied'], [429, 'harmony_rate_limited'], [500, 'harmony_request_failed']] as const)('redacts %s failures', async (status, code) => {
    const fetch = vi.fn<GuardedFetch>(async () => new Response('provider secret and client identities', { status, headers: { Location: 'https://attacker.invalid' } }));
    await expect(createHarmonyProvider(fetch).groups(credentials)).rejects.toMatchObject({ code, message: code });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('redacts underlying transport errors and malformed JSON', async () => {
    await expect(createHarmonyProvider(vi.fn().mockRejectedValue(new Error('secret in transport URL'))).groups(credentials)).rejects.toThrow('harmony_unavailable');
    await expect(createHarmonyProvider(vi.fn().mockResolvedValue(new Response('private not-json'))).groups(credentials)).rejects.toThrow('harmony_invalid_response');
  });
  it('bounds the body even when an injected transport does not enforce maxBytes', async () => {
    const fetch = vi.fn<GuardedFetch>(async () => new Response('x'.repeat(4194305)));
    await expect(createHarmonyProvider(fetch).groups(credentials)).rejects.toThrow('harmony_response_too_large');
  });
  it('bounds a hung request and aborts its transport', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<GuardedFetch>(() => new Promise(() => {}));
    const assertion = expect(createHarmonyProvider(fetch).groups(credentials)).rejects.toThrow('harmony_timeout');
    await vi.advanceTimersByTimeAsync(15000); await assertion;
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds the whole operation even when each individual page responds on time', async () => {
    vi.useFakeTimers();
    const h = harness({ handler: (url, init) => new Promise(resolve => setTimeout(() => {
      if (url.endsWith('/auth/external')) resolve(Response.json({ token: 'ci' }));
      else if (url.includes('/session/')) resolve(Response.json({ apiToken: 'api' }));
      else { const offset = JSON.parse(init.body as string).paging.offset; resolve(Response.json(Array.from({ length: 100 }, (_, n) => ({ ...group, id: `group-${offset + n}` })))); }
    }, 14000)) });
    const assertion = expect(h.provider.groups(credentials)).rejects.toThrow('harmony_timeout');
    await vi.advanceTimersByTimeAsync(120000); await assertion;
    expect(h.fetch.mock.calls.length).toBeLessThan(12);
  });
});

describe('Harmony complete, client-scoped inventory', () => {
  it('returns only selected client evidence and no other group identities', async () => {
    const h = harness(); const result = await h.provider.inventory(credentials, ['client-a']);
    expect(result.computers.map(row => row.id)).toEqual(['endpoint-a']);
    expect(result.groups).toEqual([group]); expect(result.computers[0].realTimeProtection).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/client-b|Other client|other-endpoint|synthetic-/);
    expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true);
  });
  it('fails missing scope before authentication and missing mapping before fetching computers', async () => {
    const h = harness(); expect(() => h.provider.inventory(credentials, [])).toThrow('harmony_group_scope_required');
    expect(h.fetch).not.toHaveBeenCalled();
    await expect(h.provider.inventory(credentials, ['gone'])).rejects.toThrow('harmony_group_unavailable');
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });
  it.each(['VIRTUAL_GROUP', 'OFFLINE_GROUP'])('keeps %s discoverable but rejects it before fetching any computers for a client', async type => {
    const h = harness({ groups: [{ ...group, type }] });
    expect(await h.provider.groups(credentials)).toEqual([{ ...group, type }]);
    h.fetch.mockClear();
    await expect(h.provider.inventory(credentials, [group.id])).rejects.toThrow('harmony_group_scope_not_custom');
    expect(h.fetch).toHaveBeenCalledTimes(3); // Auth + login + discovery; no computer request.
    expect(h.fetch.mock.calls.some(([url]) => /\/computers\/|\/jobs\//.test(url))).toBe(false);
  });
  it('paginates discovery by offsets without following upstream links', async () => {
    const h = harness({ handler: (url, init) => {
      if (!url.endsWith('/organization/tree/search')) return undefined;
      const offset = JSON.parse(init.body as string).paging.offset;
      return Response.json(offset === 0 ? Array.from({ length: 100 }, (_, n) => ({ ...group, id: `g-${n}` })) : [group]);
    } });
    expect(await h.provider.groups(credentials)).toHaveLength(101);
    expect(JSON.parse(h.fetch.mock.calls[3][1].body as string).paging.offset).toBe(100);
  });
  it('retrieves every computer page before returning a complete snapshot', async () => {
    let offset = 0;
    const h = harness({ handler: (url, init) => {
      if (url.includes('/computers/filtered')) { offset = JSON.parse(init.body as string).paging.offset; return Response.json({ jobId: `job-${offset}` }); }
      if (url.includes('/jobs/')) return Response.json(done(page(Array.from({ length: offset === 0 ? 250 : 1 }, (_, n) => computer(`device-${offset + n}`)), 251, offset)));
      return undefined;
    } });
    expect((await h.provider.inventory(credentials, ['client-a'])).computers).toHaveLength(251);
    expect(h.fetch).toHaveBeenCalledTimes(7);
  });
  it.each([
    page([], 1), { ...page([computer()]), pageOffset: 1 }, { ...page([computer()]), pageSize: 100 },
    page([computer(), computer()]), page([], 10001), { ...page([]), totalCount: '0' },
  ])('rejects partial, invalid or repeated inventory %j', async computerPage => {
    await expect(harness({ computerPage }).provider.inventory(credentials, ['client-a'])).rejects.toThrow();
  });
  it('rejects a changed total between pages without returning the first page', async () => {
    let polls = 0;
    const h = harness({ handler: url => url.includes('/jobs/') ? Response.json(done(++polls === 1
      ? page(Array.from({ length: 250 }, (_, n) => computer(`device-${n}`)), 251)
      : page([], 250, 250))) : undefined });
    await expect(h.provider.inventory(credentials, ['client-a'])).rejects.toThrow('harmony_snapshot_changed');
  });
  it('returns a genuinely empty scoped snapshot', async () => {
    expect((await harness({ computerPage: page([]) }).provider.inventory(credentials, ['client-a'])).computers).toEqual([]);
  });
  it('rejects repeated group pages rather than silently truncate discovery', async () => {
    const groups = Array.from({ length: 100 }, (_, n) => ({ ...group, id: `g-${n}` }));
    await expect(harness({ groups }).provider.groups(credentials)).rejects.toThrow('harmony_snapshot_changed');
  });
  it('enforces the group discovery bound', async () => {
    const h = harness({ handler: (url, init) => {
      if (!url.endsWith('/organization/tree/search')) return undefined;
      const offset = JSON.parse(init.body as string).paging.offset;
      return Response.json(Array.from({ length: 100 }, (_, n) => ({ ...group, id: `g-${offset + n}` })));
    } });
    await expect(h.provider.groups(credentials)).rejects.toThrow('harmony_inventory_limit');
    expect(h.fetch).toHaveBeenCalledTimes(53);
  });
});

describe('Harmony administrative complete inventory', () => {
  it('returns all normalized groups and endpoints for host partitioning without exposing raw fields or tokens', async () => {
    const groups = [group, other, { id: 'desktops', name: 'Desktops', type: 'VIRTUAL_GROUP' }, { id: 'offline', name: 'Offline', type: 'OFFLINE_GROUP' }];
    const h = harness({ groups, computerPage: page([
      { ...computer(), privateRecoveryData: 'private recovery material' }, computer('other-endpoint', [other]),
      computer('ungrouped', []), { ...computer('deleted'), isDeleted: true },
    ]) });
    const result = await h.provider.administrativeInventory(credentials);
    expect(result.groups).toEqual(groups);
    expect(result.computers.map(row => row.id)).toEqual(['endpoint-a', 'other-endpoint', 'ungrouped', 'deleted']);
    expect(result.computers[3].deleted).toBe(true); // Withheld later by the partition, not hidden from administrative evidence.
    expect(result.computers.every(row => row.realTimeProtection === null)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private recovery|privateRecovery|synthetic-/);
    expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(5);
  });
  it('accepts a complete empty tenant snapshot without requiring client mappings', async () => {
    const result = await harness({ groups: [], computerPage: page([]) }).provider.administrativeInventory(credentials);
    expect(result.groups).toEqual([]); expect(result.computers).toEqual([]);
  });
  it('waits for every endpoint page before returning the administrative snapshot', async () => {
    let offset = 0;
    const h = harness({ handler: (url, init) => {
      if (url.includes('/computers/filtered')) { offset = JSON.parse(init.body as string).paging.offset; return Response.json({ jobId: `job-${offset}` }); }
      if (url.includes('/jobs/')) return Response.json(done(page(Array.from({ length: offset === 0 ? 250 : 1 }, (_, n) => computer(`device-${offset + n}`)), 251, offset)));
      return undefined;
    } });
    expect((await h.provider.administrativeInventory(credentials)).computers).toHaveLength(251);
    expect(h.fetch).toHaveBeenCalledTimes(7);
  });
  it('rejects a later-page failure instead of returning a partial administrative snapshot', async () => {
    let polls = 0;
    const h = harness({ handler: url => url.includes('/jobs/') ? ++polls === 1
      ? Response.json(done(page(Array.from({ length: 250 }, (_, n) => computer(`device-${n}`)), 251)))
      : new Response('private upstream failure', { status: 500 }) : undefined });
    await expect(h.provider.administrativeInventory(credentials)).rejects.toMatchObject({ code: 'harmony_request_failed', message: 'harmony_request_failed' });
    expect(polls).toBe(2);
  });
  it('retains the malformed-membership failure when reading complete administrative evidence', async () => {
    const h = harness({ computerPage: page([{ computerId: 'a', computerName: 'a' }]) });
    await expect(h.provider.administrativeInventory(credentials)).rejects.toThrow('harmony_membership_unavailable');
  });
});

describe('Harmony asynchronous jobs', () => {
  it('waits for IN_PROGRESS before using DONE data', async () => {
    vi.useFakeTimers(); let polls = 0;
    const h = harness({ handler: url => url.includes('/jobs/') ? Response.json(++polls === 1
      ? { status: 'IN_PROGRESS', statusCode: 202, statusType: 2 } : done(page([computer()]))) : undefined });
    const result = h.provider.inventory(credentials, ['client-a']);
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).computers).toHaveLength(1); expect(polls).toBe(2);
  });
  it.each([
    { status: 'FAILED', data: 'secret error' }, { status: 'NOT_FOUND' }, { status: 'DONE', statusCode: 403, statusType: 4 },
    { status: 'DONE', statusCode: 200 }, { status: 'UNKNOWN' },
  ])('rejects failed or malformed job %j', async job => {
    await expect(harness({ job }).provider.inventory(credentials, ['client-a'])).rejects.toThrow();
  });
  it('does not use a provider-supplied URL as a job ID', async () => {
    const h = harness({ handler: url => url.includes('/computers/filtered') ? Response.json({ jobId: 'https://attacker.invalid/steal' }) : undefined });
    await expect(h.provider.inventory(credentials, ['client-a'])).rejects.toThrow('harmony_invalid_response');
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });
  it('stops polling a job that never finishes', async () => {
    vi.useFakeTimers(); const h = harness({ job: { status: 'IN_PROGRESS', statusCode: 202, statusType: 2 } });
    const assertion = expect(h.provider.inventory(credentials, ['client-a'])).rejects.toThrow('harmony_job_timeout');
    await vi.advanceTimersByTimeAsync(10000); await assertion;
    expect(h.fetch.mock.calls.filter(([url]) => url.includes('/jobs/'))).toHaveLength(20);
    expect(vi.getTimerCount()).toBe(0);
  });
});
