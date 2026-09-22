import { z } from 'zod';
import { randomInt } from 'node:crypto';
import type { GuardedFetch } from './transport';

const ORIGIN = 'https://graph.microsoft.com/v1.0';
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
const text = z.string().max(256);
const user = z.object({
  id: uuid, displayName: text.nullable().optional(), givenName: text.nullable().optional(),
  surname: text.nullable().optional(), department: text.nullable().optional(), jobTitle: text.nullable().optional(),
  officeLocation: text.nullable().optional(), userPrincipalName: text.nullable().optional(), accountEnabled: z.boolean().optional(),
});
const group = z.object({
  id: uuid, displayName: text.nullable().optional(), mail: text.nullable().optional(),
  securityEnabled: z.boolean(), mailEnabled: z.boolean(), groupTypes: z.array(text).max(10),
  onPremisesSyncEnabled: z.boolean().nullable(), isAssignableToRole: z.boolean().nullable().optional(),
});
const license = z.object({
  id: z.string().max(128), skuId: uuid, skuPartNumber: text, consumedUnits: z.number().int().nonnegative(),
  capabilityStatus: text, prepaidUnits: z.object({ enabled: z.number().int(), suspended: z.number().int(), warning: z.number().int() }),
});
export const adminUserUpdateSchema = z.object({
  displayName: text.min(1).optional(), givenName: text.nullable().optional(), surname: text.nullable().optional(),
  department: text.nullable().optional(), jobTitle: text.nullable().optional(), officeLocation: text.nullable().optional(),
  accountEnabled: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0);
export type AdminUserUpdate = z.infer<typeof adminUserUpdateSchema>;
export type AdminGraphErrorCode = 'invalid_input' | 'credential_unavailable' | 'tenant_identity_mismatch'
  | 'invalid_provider_response' | 'provider_access_denied' | 'provider_rate_limited' | 'provider_rejected'
  | 'provider_unreachable' | 'unknown_write_outcome' | 'unsupported_group';
export class AdminGraphError extends Error {
  constructor(public readonly code: AdminGraphErrorCode) { super(code); }
}
function parse<T>(schema: z.ZodType<T>, value: unknown, code: AdminGraphErrorCode): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AdminGraphError(code);
  return result.data;
}
const passwordClasses = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*-_+'];
function createTemporaryPassword(): string {
  const chars = passwordClasses.map(group => group[randomInt(group.length)]!);
  const alphabet = passwordClasses.join('');
  while (chars.length < 32) chars.push(alphabet[randomInt(alphabet.length)]!);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
function requireAppRole(token: string, role: string): void {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    if (!Array.isArray(payload.roles) || !payload.roles.includes(role)) throw new Error();
  } catch { throw new AdminGraphError('provider_access_denied'); }
}
const userSelect = Object.keys(user.shape).join(',');
const groupSelect = Object.keys(group.shape).join(',');
const licenseSelect = Object.keys(license.shape).join(',');

/** Provider transport only. The owning executor MUST authorize the actor and organization,
 * fence the connection/credential generation before writes and before returning results,
 * and audit outcomes. No tenant, token, path or arbitrary Graph body may come from a browser.
 * Mutation acceptance is not proof of subsequent propagation; unknown outcomes must be
 * reconciled through reads, never retried automatically. */
export function createAdminGraphProvider(options: {
  tenantId: string;
  fetch: GuardedFetch;
  acquireToken: (tenantId: string) => Promise<string>;
}) {
  const tenantId = parse(uuid, options.tenantId, 'invalid_input');
  async function request(token: string, path: string, method = 'GET', body?: unknown) {
    const mutation = method !== 'GET';
    try {
      const result = await options.fetch(`${ORIGIN}${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(15000), timeoutMs: 15000, maxBytes: 1024 * 1024,
      });
      if (result.status === 401 || result.status === 403) throw new AdminGraphError('provider_access_denied');
      if (result.status === 429) throw new AdminGraphError('provider_rate_limited');
      if (result.status >= 500 && mutation) throw new AdminGraphError('unknown_write_outcome');
      if (!result.ok || result.status >= 300) throw new AdminGraphError('provider_rejected');
      if (mutation) return undefined;
      return await result.json() as unknown;
    } catch (error) {
      if (error instanceof AdminGraphError) throw error;
      throw new AdminGraphError(mutation ? 'unknown_write_outcome' : 'provider_unreachable');
    }
  }
  async function session() {
    let token: string;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      token = await Promise.race([
        options.acquireToken(tenantId),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 15000); }),
      ]);
      if (typeof token !== 'string' || !token || token.length > 32768 || /[\r\n]/.test(token)) throw new Error();
    } catch { throw new AdminGraphError('credential_unavailable'); }
    finally { clearTimeout(timer); }
    const identity = parse(z.object({ value: z.array(z.object({ id: uuid })).length(1) }),
      await request(token, '/organization?$select=id'), 'tenant_identity_mismatch');
    if (identity.value[0]!.id !== tenantId) throw new AdminGraphError('tenant_identity_mismatch');
    return token;
  }
  async function collection<T>(path: string, schema: z.ZodType<T>) {
    const token = await session();
    const result = parse(z.object({ value: z.array(schema).max(100), '@odata.nextLink': z.string().optional() }),
      await request(token, path), 'invalid_provider_response');
    // Graph users does not support $skip. Return a bounded first page explicitly;
    // never follow a provider-supplied nextLink, even one with an apparent Graph origin.
    return { items: result.value, partial: Boolean(result['@odata.nextLink']) || result.value.length === 100 };
  }
  async function resource<T>(token: string, path: string, id: string, schema: z.ZodType<T>, select: string) {
    const result = parse(schema, await request(token, `${path}/${id}?$select=${select}`), 'invalid_provider_response');
    if ((result as { id: string }).id !== id) throw new AdminGraphError('invalid_provider_response');
    return result;
  }
  async function membership(groupId: string, userId: string, remove: boolean) {
    groupId = parse(uuid, groupId, 'invalid_input'); userId = parse(uuid, userId, 'invalid_input');
    const token = await session();
    const target = await resource(token, '/groups', groupId, group, groupSelect);
    if (target.groupTypes.includes('DynamicMembership') || target.onPremisesSyncEnabled === true
      // Graph returns explicit null for ordinary non-role-assignable groups.
      // Omission remains unknown and fails closed; true is always excluded.
      || (target.isAssignableToRole !== false && target.isAssignableToRole !== null)
      || (!target.securityEnabled && !target.groupTypes.includes('Unified'))
      || (target.mailEnabled && !target.groupTypes.includes('Unified'))) throw new AdminGraphError('unsupported_group');
    await resource(token, '/users', userId, user, userSelect);
    if (remove) await request(token, `/groups/${groupId}/members/${userId}/$ref`, 'DELETE');
    else await request(token, `/groups/${groupId}/members/$ref`, 'POST', { '@odata.id': `${ORIGIN}/directoryObjects/${userId}` });
    return { accepted: true as const };
  }
  return {
    listUsers: () => collection(`/users?$select=${userSelect}&$top=100`, user),
    listGroups: () => collection(`/groups?$select=${groupSelect}&$top=100`, group),
    listLicenses: () => collection(`/subscribedSkus?$select=${licenseSelect}`, license),
    async getUser(id: string) { id = parse(uuid, id, 'invalid_input'); return resource(await session(), '/users', id, user, userSelect); },
    async getGroup(id: string) { id = parse(uuid, id, 'invalid_input'); return resource(await session(), '/groups', id, group, groupSelect); },
    async updateUser(id: string, update: AdminUserUpdate) {
      id = parse(uuid, id, 'invalid_input');
      const body = parse(adminUserUpdateSchema, update, 'invalid_input');
      const token = await session();
      await request(token, `/users/${id}`, 'PATCH', body);
      return { accepted: true as const };
    },
    async resetUserPassword(id: string, authorize?: () => Promise<void>) {
      id = parse(uuid, id, 'invalid_input');
      const token = await session();
      requireAppRole(token, 'User-PasswordProfile.ReadWrite.All');
      await authorize?.();
      await resource(token, '/users', id, user, userSelect);
      const temporaryPassword = createTemporaryPassword();
      await authorize?.();
      await request(token, `/users/${id}`, 'PATCH', { passwordProfile: { password: temporaryPassword, forceChangePasswordNextSignIn: true } });
      return { accepted: true as const, temporaryPassword, forceChangePasswordNextSignIn: true as const };
    },
    async revokeUserSessions(id: string, authorize?: () => Promise<void>) {
      id = parse(uuid, id, 'invalid_input');
      const token = await session();
      requireAppRole(token, 'User.RevokeSessions.All');
      await authorize?.();
      await resource(token, '/users', id, user, userSelect);
      await authorize?.();
      await request(token, `/users/${id}/revokeSignInSessions`, 'POST');
      return { accepted: true as const };
    },
    addGroupMember: (groupId: string, userId: string) => membership(groupId, userId, false),
    removeGroupMember: (groupId: string, userId: string) => membership(groupId, userId, true),
  };
}
