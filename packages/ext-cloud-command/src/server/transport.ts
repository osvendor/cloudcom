import { normalizePbxOrigin } from '../threecx/read-service.mjs';

export class ProviderError extends Error {
  constructor(public code: string) { super(code); }
}
export type GuardedFetch = (url: string, init: RequestInit & { timeoutMs: number; maxBytes: number }) => Promise<Response>;
export interface Credentials { origin: string; clientId: string; secret: string }

/** The host supplies DNS-pinned public-only HTTPS transport. Never use global fetch. */
export function createProvider(fetch: GuardedFetch) {
  function callLogNextSkip(nextLink: unknown, requestUrl: string, skip: number): number | null {
    if (typeof nextLink !== 'string' || nextLink.length > 4096) return null;
    let next: URL;
    try { next = new URL(nextLink, requestUrl); } catch { return null; }
    const current = new URL(requestUrl);
    if (next.origin !== current.origin || next.pathname !== current.pathname || next.username || next.password || next.hash) return null;
    const expected = new URLSearchParams(current.search);
    const actual = new URLSearchParams(next.search);
    if (actual.size !== expected.size || actual.getAll('$skip').length !== 1) return null;
    for (const [key, value] of expected) {
      if (key === '$skip') continue;
      if (actual.getAll(key).length !== 1 || actual.get(key) !== value) return null;
    }
    const offset = actual.get('$skip');
    return offset === String(skip + 100) && skip < 100000 ? skip + 100 : null;
  }
  async function json(url: string, init: RequestInit, signal: AbortSignal) {
    try {
      const response = await fetch(url, { ...init, signal, redirect: 'error', timeoutMs: 15000, maxBytes: 2 * 1024 * 1024 });
      if (response.status === 401 || response.status === 403) throw new ProviderError('provider_access_denied');
      if (response.status === 429) throw new ProviderError('provider_rate_limited');
      if (response.status === 404) throw new ProviderError('provider_not_found');
      if (response.status === 409 || response.status === 412) throw new ProviderError('provider_conflict');
      if (!response.ok || response.status >= 300) throw new ProviderError('provider_request_failed');
      if (response.status === 204) return {};
      return await response.json() as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('provider_unreachable');
    }
  }
  async function session(credentials: Credentials, signal: AbortSignal) {
    const origin = normalizePbxOrigin(credentials.origin);
    const result = await json(`${origin}/connect/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: credentials.clientId, client_secret: credentials.secret }).toString(),
    }, signal);
    if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 32768) throw new ProviderError('invalid_provider_response');
    return { origin, headers: { Authorization: `Bearer ${result.access_token}` } };
  }
  return {
    async callLog(credentials: Credentials, start: string, end: string, skip: number) {
      const signal = AbortSignal.timeout(30000);
      const { origin, headers } = await session(credentials, signal);
      // This fixed XAPI function is not a general OData path supplied by the browser.
      const period = (value: string) => value.replace(/\.000Z$/, 'Z');
      const path = `ReportCallLogData/Pbx.GetCallLogData(periodFrom=${period(start)},periodTo=${period(end)},sourceType=0,sourceFilter='',destinationType=0,destinationFilter='',callsType=0,callTimeFilterType=0,callTimeFilterFrom='0:00:0',callTimeFilterTo='0:00:0',hidePcalls=true)`;
      const query = new URLSearchParams({ '$top': '100', '$skip': String(skip) });
      const url = `${origin}/xapi/v1/${path}?${query}`;
      const result = await json(url, { headers }, signal);
      return Object.assign(result, { verifiedNextSkip: callLogNextSkip(result['@odata.nextLink'], url, skip) });
    },
    async systemStatus(credentials: Credentials) {
      const signal = AbortSignal.timeout(30000);
      const { origin, headers } = await session(credentials, signal);
      const query = new URLSearchParams({ '$select': 'Version,CallsActive,MaxSimCalls,ExtensionsRegistered,ExtensionsTotal,TrunksRegistered,TrunksTotal,HasNotRunningServices,BackupScheduled,LastBackupDateTime,FreeDiskSpace,TotalDiskSpace' });
      return json(`${origin}/xapi/v1/SystemStatus?${query}`, { headers }, signal);
    },
    async groups(credentials: Credentials) {
      const signal = AbortSignal.timeout(30000);
      const { origin, headers } = await session(credentials, signal);
      const groups: { id: number; name: string }[] = [];
      for (let skip = 0; skip < 1000; skip += 100) {
        const query = new URLSearchParams({ '$select': 'Id,Name', '$top': '100', '$skip': String(skip), '$orderby': 'Id' });
        const result = await json(`${origin}/xapi/v1/Groups?${query}`, { headers }, signal);
        if (!Array.isArray(result.value) || result.value.length > 100) throw new ProviderError('invalid_provider_response');
        for (const row of result.value) {
          if (!row || !Number.isSafeInteger(row.Id) || row.Id < 0 || typeof row.Name !== 'string' || row.Name.length > 1024) throw new ProviderError('invalid_provider_response');
          groups.push({ id: row.Id, name: row.Name });
        }
        if (result.value.length < 100 && !result['@odata.nextLink']) return groups;
        // Never follow a server-supplied URL carrying a bearer credential.
      }
      throw new ProviderError('department_limit_exceeded');
    },
    async users(credentials: Credentials, query: Record<string, string | number>) {
      const signal = AbortSignal.timeout(30000);
      const { origin, headers } = await session(credentials, signal);
      const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
      return json(`${origin}/xapi/v1/Users?${params}`, { headers }, signal);
    },
    async user(credentials: Credentials, id: number, query: Record<string, string>) {
      if (!Number.isSafeInteger(id) || id < 0 || id > 2147483647) throw new ProviderError('invalid_user');
      const signal = AbortSignal.timeout(30000);
      const { origin, headers } = await session(credentials, signal);
      const params = new URLSearchParams(query);
      return json(`${origin}/xapi/v1/Users(${id})?${params}`, { headers }, signal);
    },
    async updateUser(credentials: Credentials, id: number, changes: Record<string, unknown>) {
      if (!Number.isSafeInteger(id) || id < 0 || id > 2147483647) throw new ProviderError('invalid_user');
      const signal = AbortSignal.timeout(30000);
      const { origin, headers } = await session(credentials, signal);
      await json(`${origin}/xapi/v1/Users(${id})`, {
        method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
      }, signal);
    },
    async updateForwarding(credentials: Credentials, id: number, profiles: Record<string, unknown>[]) {
      if (!Number.isSafeInteger(id) || id < 0 || id > 2147483647) throw new ProviderError('invalid_user');
      const signal = AbortSignal.timeout(30000);
      const { origin, headers } = await session(credentials, signal);
      await json(`${origin}/xapi/v1/Users/Pbx.MultiUserUpdate`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], user: { ForwardingProfiles: profiles } }),
      }, signal);
    },
  };
}
