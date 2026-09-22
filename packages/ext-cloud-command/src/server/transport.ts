import { normalizePbxOrigin } from '../threecx/read-service.mjs';

export class ProviderError extends Error {
  constructor(public code: string) { super(code); }
}
export type GuardedFetch = (url: string, init: RequestInit & { timeoutMs: number; maxBytes: number }) => Promise<Response>;
export interface Credentials { origin: string; clientId: string; secret: string }

/** The host supplies DNS-pinned public-only HTTPS transport. Never use global fetch. */
export function createProvider(fetch: GuardedFetch) {
  async function json(url: string, init: RequestInit, signal: AbortSignal) {
    try {
      const response = await fetch(url, { ...init, signal, redirect: 'error', timeoutMs: 15000, maxBytes: 2 * 1024 * 1024 });
      if (response.status === 401 || response.status === 403) throw new ProviderError('provider_access_denied');
      if (response.status === 429) throw new ProviderError('provider_rate_limited');
      if (!response.ok || response.status >= 300) throw new ProviderError('provider_request_failed');
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
  };
}
