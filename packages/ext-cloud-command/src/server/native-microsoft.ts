import type { ExtensionRequestAuthorization } from '@breeze/extension-sdk';

export const microsoftResources = {
  users: { displayName: 'Name', userPrincipalName: 'Sign-in name', accountEnabled: 'Enabled', department: 'Department', jobTitle: 'Job title' },
  groups: { displayName: 'Name', mail: 'Email', securityEnabled: 'Security group', membershipRule: 'Membership rule' },
  licenses: { skuPartNumber: 'SKU', consumedUnits: 'Assigned', capabilityStatus: 'Status' },
  sites: { displayName: 'Name', name: 'Site name', webUrl: 'Site URL', lastModifiedDateTime: 'Last modified' },
} as const;
export type MicrosoftResource = keyof typeof microsoftResources;
export type MicrosoftRequest = {
  /** The host middleware's auth object, never a request body or reconstructed principal. */
  auth: unknown;
  authorization: ExtensionRequestAuthorization;
  orgId: string;
};
export type MicrosoftFailure = { ok: false; code: string; message: string; retryAfterSeconds?: number };
export interface NativeMicrosoftServices {
  version: 1;
  connection(request: MicrosoftRequest): Promise<{
    available: boolean; connected: boolean; enabled: boolean; canManage: boolean;
    tenantId?: string; tenantName?: string; status?: string; reason?: string;
  }>;
  read(request: MicrosoftRequest, resource: MicrosoftResource): Promise<
    { ok: true; items: Record<string, unknown>[]; truncated: boolean } | MicrosoftFailure
  >;
}

/** Re-project native results so additions to the host do not expand extension disclosure. */
export function projectMicrosoftResource(resource: MicrosoftResource, items: Record<string, unknown>[], truncated: boolean) {
  const fields = microsoftResources[resource];
  return {
    columns: Object.entries(fields).map(([key, label]) => ({ key, label })),
    items: items.map(item => {
      if (typeof item.id !== 'string' || !item.id) throw new Error('Invalid Microsoft resource identity');
      return {
        id: item.id,
        values: Object.fromEntries(Object.keys(fields).map(key => {
          const value = item[key];
          return [key, typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? value : null];
        })),
      };
    }),
    complete: !truncated,
    checkedAt: new Date().toISOString(),
  };
}
