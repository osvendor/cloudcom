import { z } from 'zod';
import type { CippDeployment } from './cipp-config';
import type { GuardedFetch } from './transport';

export class CippError extends Error {
  constructor(public code: string) { super(code); }
}
const domain = z.string().min(3).max(253).regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/);
const tenantSchema = z.object({ customerId: z.string().uuid(), defaultDomainName: domain, displayName: z.string().min(1).max(512) });
export const cippResources = {
  users: { endpoint: 'ListUsers', id: 'id', fields: { displayName: 'Name', userPrincipalName: 'Sign-in name', accountEnabled: 'Enabled', userType: 'Type', department: 'Department' } },
  groups: { endpoint: 'ListGroups', id: 'id', fields: { displayName: 'Name', mail: 'Email', mailEnabled: 'Mail enabled', securityEnabled: 'Security group', membershipRule: 'Membership rule' } },
  licenses: { endpoint: 'ListLicenses', id: 'skuId', fields: { License: 'License', CountUsed: 'Assigned', CountAvailable: 'Available', TotalLicenses: 'Total', skuPartNumber: 'SKU' } },
  sites: { endpoint: 'ListSites', id: 'siteId', fields: { displayName: 'Name', webUrl: 'Site URL', ownerDisplayName: 'Owner', storageUsedInGigabytes: 'Used (GB)', storageAllocatedInGigabytes: 'Allocated (GB)', reportRefreshDate: 'Report date' } },
} as const;
export type CippResource = keyof typeof cippResources;
type Scalar = string | number | boolean | null;
function array(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10000 || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new CippError('invalid_provider_response');
  return value;
}
export function createCippProvider(fetch: GuardedFetch, config: CippDeployment) {
  async function json(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    try {
      const res = await fetch(url, { ...init, signal, redirect: 'error', timeoutMs: 60000, maxBytes: 8 * 1024 * 1024 });
      if (res.status === 401 || res.status === 403) throw new CippError('cipp_access_denied');
      if (res.status === 429) throw new CippError('cipp_rate_limited');
      if (!res.ok || res.status >= 300) throw new CippError('cipp_request_failed');
      return await res.json();
    } catch (error) {
      if (error instanceof CippError) throw error;
      throw new CippError('cipp_unreachable');
    }
  }
  async function read(endpoint: string, query: Record<string, string> = {}) {
    const signal = AbortSignal.timeout(65000);
    const token = z.object({ access_token: z.string().min(1).max(32768) }).safeParse(await json(
      `https://login.microsoftonline.com/${config.authTenantId}/oauth2/v2.0/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.secret, grant_type: 'client_credentials', scope: config.scope }).toString(),
      }, signal));
    if (!token.success) throw new CippError('invalid_token_response');
    return json(`${config.origin}/api/${endpoint}?${new URLSearchParams(query)}`, {
      headers: { Authorization: `Bearer ${token.data.access_token}` },
    }, signal);
  }
  return {
    async tenants() {
      const result = array(await read('ListTenants'));
      const seen = new Set<string>();
      return result.map(row => {
        const parsed = tenantSchema.safeParse(row);
        if (!parsed.success || seen.has(parsed.data.customerId.toLowerCase())) throw new CippError('invalid_tenant_response');
        seen.add(parsed.data.customerId.toLowerCase());
        return { id: parsed.data.customerId.toLowerCase(), name: parsed.data.displayName, domain: parsed.data.defaultDomainName.toLowerCase() };
      });
    },
    async resource(resource: CippResource, tenantDomain: string) {
      if (!domain.safeParse(tenantDomain).success) throw new CippError('invalid_tenant_binding');
      const spec = cippResources[resource];
      const result = array(await read(spec.endpoint, { tenantFilter: tenantDomain, ...(resource === 'sites' ? { Type: 'SharePointSiteUsage' } : {}) }));
      const seen = new Set<string>();
      const items = result.map(row => {
        const id = row[spec.id];
        if (typeof id !== 'string' || !id || id.length > 512 || seen.has(id)) throw new CippError('invalid_provider_response');
        if (resource !== 'sites' && !z.string().uuid().safeParse(id).success) throw new CippError('invalid_provider_response');
        seen.add(id);
        const values: Record<string, Scalar> = {};
        for (const key of Object.keys(spec.fields)) {
          const value = row[key];
          if (value == null) values[key] = null;
          else if ((typeof value === 'string' && value.length <= 4096) || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) values[key] = value;
          else throw new CippError('invalid_provider_response');
        }
        return { id, values };
      });
      return { items, columns: Object.entries(spec.fields).map(([key, label]) => ({ key, label })), complete: true, checkedAt: new Date().toISOString() };
    },
  };
}
