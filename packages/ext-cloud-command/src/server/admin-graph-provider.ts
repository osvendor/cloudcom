import { z } from 'zod';
import { randomInt } from 'node:crypto';
import type { GuardedFetch } from './transport';

const ORIGIN = 'https://graph.microsoft.com/v1.0';
// Microsoft Entra built-in Global Administrator role template. This is a fixed server-side
// constant so a browser cannot select another privileged directory role.
const GLOBAL_ADMINISTRATOR_ROLE_DEFINITION_ID = '62e90394-69f5-4237-9190-012177145e10';
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
const serviceHealthIssue = z.object({
  id: z.string().min(1).max(128), title: z.string().max(512).nullable().optional(),
  impactDescription: z.string().max(8192).nullable().optional(),
  status: z.string().max(128).nullable().optional(), lastModifiedDateTime: z.string().max(64).nullable().optional(),
});
const serviceHealth = z.object({
  id: z.string().min(1).max(256), service: z.string().min(1).max(256), status: z.string().max(128),
  issues: z.array(serviceHealthIssue).max(100).optional(),
});
const directoryRoleAssignment = z.object({
  id: uuid,
  principalId: uuid,
  roleDefinitionId: z.literal(GLOBAL_ADMINISTRATOR_ROLE_DEFINITION_ID),
  directoryScopeId: z.literal('/'),
});
export const adminUserUpdateSchema = z.object({
  displayName: text.min(1).optional(), givenName: text.nullable().optional(), surname: text.nullable().optional(),
  department: text.nullable().optional(), jobTitle: text.nullable().optional(), officeLocation: text.nullable().optional(),
  accountEnabled: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0);
export type AdminUserUpdate = z.infer<typeof adminUserUpdateSchema>;
export const adminUserCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(256),
  userPrincipalName: z.string().trim().min(3).max(320).regex(/^[A-Za-z0-9'.!#^~_-]+@[A-Za-z0-9.-]+$/),
  usageLocation: z.string().regex(/^[A-Z]{2}$/).optional(),
}).strict();
export type AdminUserCreate = z.infer<typeof adminUserCreateSchema>;
export const adminLicenseAssignSchema = z.object({ skuId: uuid }).strict();
export type AdminLicenseAssign = z.infer<typeof adminLicenseAssignSchema>;
export const adminGroupCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(256),
  mailNickname: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9'.!#^~_-]+$/),
  ownerId: uuid,
}).strict();
export type AdminGroupCreate = z.infer<typeof adminGroupCreateSchema>;
export const adminGroupUpdateSchema = z.object({ displayName: z.string().trim().min(1).max(256) }).strict();
export type AdminGroupUpdate = z.infer<typeof adminGroupUpdateSchema>;
export type AdminGraphErrorCode = 'invalid_input' | 'credential_unavailable' | 'tenant_identity_mismatch'
  | 'invalid_provider_response' | 'provider_access_denied' | 'provider_rate_limited' | 'provider_rejected'
  | 'provider_unreachable' | 'unknown_write_outcome' | 'unsupported_group'
  | 'role_assignment_state_unknown' | 'last_global_administrator' | 'usage_location_required' | 'license_not_available';
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
function requireAnyAppRole(token: string, roles: readonly string[]): void {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    if (!Array.isArray(payload.roles) || !roles.some(role => payload.roles.includes(role))) throw new Error();
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
  async function request(token: string, path: string, method = 'GET', body?: unknown, responseBody = false, allowNotFound = false) {
    const mutation = method !== 'GET';
    try {
      const result = await options.fetch(`${ORIGIN}${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(15000), timeoutMs: 15000, maxBytes: 1024 * 1024,
      });
      if (result.status === 401 || result.status === 403) throw new AdminGraphError('provider_access_denied');
      if (allowNotFound && method === 'GET' && result.status === 404) return null;
      if (result.status === 429) throw new AdminGraphError('provider_rate_limited');
      if (result.status >= 500 && mutation) throw new AdminGraphError('unknown_write_outcome');
      if (!result.ok || result.status >= 300) throw new AdminGraphError('provider_rejected');
      if (mutation && !responseBody) return undefined;
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
    const memberPath = `/groups/${groupId}/members/${userId}?$select=id`;
    const before = await request(token, memberPath, 'GET', undefined, false, true);
    if (before !== null && parse(z.object({ id: uuid }), before, 'invalid_provider_response').id !== userId)
      throw new AdminGraphError('invalid_provider_response');
    if ((before !== null) === !remove) return { accepted: true as const, changed: false as const, verified: true as const };
    if (remove) await request(token, `/groups/${groupId}/members/${userId}/$ref`, 'DELETE');
    else await request(token, `/groups/${groupId}/members/$ref`, 'POST', { '@odata.id': `${ORIGIN}/directoryObjects/${userId}` });
    let verified = false;
    try {
      const after = await request(token, memberPath, 'GET', undefined, false, true);
      verified = (after !== null) === !remove && (after === null || parse(z.object({ id: uuid }), after, 'invalid_provider_response').id === userId);
    } catch { /* accepted write; membership may not have converged */ }
    return { accepted: true as const, changed: true as const, verified };
  }
  async function globalAdministratorAssignments(token: string) {
    // Do not follow a provider-controlled nextLink here. Removing a role is only safe when
    // the complete tenant-scope assignment set is known; a partial response fails closed.
    const result = parse(z.object({ value: z.array(directoryRoleAssignment).max(100), '@odata.nextLink': z.string().optional() }),
      await request(token, `/roleManagement/directory/roleAssignments?$filter=roleDefinitionId%20eq%20${GLOBAL_ADMINISTRATOR_ROLE_DEFINITION_ID}&$select=id,principalId,roleDefinitionId,directoryScopeId&$top=100`),
      'invalid_provider_response');
    if (result['@odata.nextLink']) throw new AdminGraphError('role_assignment_state_unknown');
    return result.value;
  }
  return {
    async createGroup(input: AdminGroupCreate, authorize?: () => Promise<void>) {
      const value = parse(adminGroupCreateSchema, input, 'invalid_input');
      const token = await session();
      requireAppRole(token, 'Group.ReadWrite.All');
      requireAnyAppRole(token, ['User.Read.All', 'User.ReadWrite.All', 'Directory.Read.All', 'Directory.ReadWrite.All']);
      await resource(token, '/users', value.ownerId, user, userSelect);
      await authorize?.();
      const result = await request(token, '/groups', 'POST', {
        displayName: value.displayName, mailNickname: value.mailNickname,
        mailEnabled: true, securityEnabled: false, groupTypes: ['Unified'],
        'owners@odata.bind': [`${ORIGIN}/users/${value.ownerId}`],
      }, true);
      let createdId: string;
      try { createdId = z.object({ id: uuid }).parse(result).id; }
      catch { throw new AdminGraphError('unknown_write_outcome'); }
      let verified = false; let mail: string | null = null;
      try {
        const current = await resource(token, '/groups', createdId, group, groupSelect);
        const owners = parse(z.object({ value: z.array(z.object({ id: uuid })).max(100), '@odata.nextLink': z.string().optional() }),
          await request(token, `/groups/${createdId}/owners?$select=id&$top=100`), 'invalid_provider_response');
        verified = current.displayName === value.displayName && current.mailEnabled && current.groupTypes.includes('Unified')
          && !owners['@odata.nextLink'] && owners.value.some(owner => owner.id === value.ownerId);
        mail = current.mail ?? null;
      } catch { /* accepted write; read model may be delayed */ }
      return { accepted: true as const, id: createdId, verified, mail };
    },
    async updateGroup(id: string, input: AdminGroupUpdate, authorize?: () => Promise<void>) {
      id = parse(uuid, id, 'invalid_input');
      const { displayName } = parse(adminGroupUpdateSchema, input, 'invalid_input');
      const token = await session();
      requireAppRole(token, 'Group.ReadWrite.All');
      const current = await resource(token, '/groups', id, group, groupSelect);
      if (!current.groupTypes.includes('Unified') || current.onPremisesSyncEnabled === true || current.isAssignableToRole === true)
        throw new AdminGraphError('unsupported_group');
      if (current.displayName === displayName) return { accepted: true as const, changed: false as const, verified: true as const };
      await authorize?.();
      await request(token, `/groups/${id}`, 'PATCH', { displayName });
      let verified = false;
      try { verified = (await resource(token, '/groups', id, group, groupSelect)).displayName === displayName; }
      catch { /* accepted write; read model may be delayed */ }
      return { accepted: true as const, changed: true as const, verified };
    },
    async serviceHealth() {
      const token = await session();
      requireAppRole(token, 'ServiceHealth.Read.All');
      const result = parse(z.object({ value: z.array(serviceHealth).max(100), '@odata.nextLink': z.string().optional() }),
        await request(token, '/admin/serviceAnnouncement/healthOverviews?$expand=issues'), 'invalid_provider_response');
      // A page boundary or nextLink means the view is incomplete. Never fetch a provider-supplied URL.
      return { services: result.value, partial: Boolean(result['@odata.nextLink']) || result.value.length === 100,
        checkedAt: new Date().toISOString() };
    },
    async listVerifiedUserDomains() {
      const token = await session();
      const organization = parse(z.object({ value: z.array(z.object({
        id: uuid, verifiedDomains: z.array(z.object({ name: z.string().min(1).max(255), isVerified: z.boolean() })).max(256),
      })).length(1) }), await request(token, '/organization?$select=id,verifiedDomains'), 'invalid_provider_response');
      if (organization.value[0]!.id !== tenantId) throw new AdminGraphError('tenant_identity_mismatch');
      return { domains: organization.value[0]!.verifiedDomains.filter(domain => domain.isVerified).map(domain => domain.name.toLowerCase()) };
    },
    async createUser(input: AdminUserCreate, authorize?: () => Promise<void>) {
      const value = parse(adminUserCreateSchema, input, 'invalid_input');
      const [localPart, domain] = value.userPrincipalName.split('@');
      if (!localPart || localPart.length > 64 || !domain) throw new AdminGraphError('invalid_input');
      const token = await session();
      requireAppRole(token, 'User.ReadWrite.All');
      const organization = parse(z.object({ value: z.array(z.object({
        id: uuid, verifiedDomains: z.array(z.object({ name: z.string().min(1).max(255), isVerified: z.boolean() })).max(256),
      })).length(1) }), await request(token, '/organization?$select=id,verifiedDomains'), 'invalid_provider_response');
      if (organization.value[0]!.id !== tenantId) throw new AdminGraphError('tenant_identity_mismatch');
      if (!organization.value[0]!.verifiedDomains.some(entry => entry.isVerified && entry.name.toLowerCase() === domain.toLowerCase()))
        throw new AdminGraphError('invalid_input');
      await authorize?.();
      const temporaryPassword = createTemporaryPassword();
      const result = await request(token, '/users', 'POST', {
        accountEnabled: true, displayName: value.displayName, mailNickname: localPart,
        userPrincipalName: value.userPrincipalName,
        ...(value.usageLocation ? { usageLocation: value.usageLocation } : {}),
        passwordProfile: { password: temporaryPassword, forceChangePasswordNextSignIn: true },
      }, true);
      let created: { id: string; userPrincipalName: string };
      try { created = z.object({ id: uuid, userPrincipalName: z.string().min(3).max(320) }).parse(result); }
      catch { throw new AdminGraphError('unknown_write_outcome'); }
      if (created.userPrincipalName.toLowerCase() !== value.userPrincipalName.toLowerCase())
        throw new AdminGraphError('unknown_write_outcome');
      return { accepted: true as const, id: created.id, userPrincipalName: created.userPrincipalName,
        temporaryPassword, forceChangePasswordNextSignIn: true as const };
    },
    async assignUserLicense(id: string, input: AdminLicenseAssign, authorize?: () => Promise<void>) {
      id = parse(uuid, id, 'invalid_input');
      const { skuId } = parse(adminLicenseAssignSchema, input, 'invalid_input');
      const token = await session();
      requireAnyAppRole(token, ['LicenseAssignment.ReadWrite.All', 'User.ReadWrite.All', 'Directory.ReadWrite.All']);
      const current = parse(z.object({ id: uuid, usageLocation: z.string().nullable().optional(),
        assignedLicenses: z.array(z.object({ skuId: uuid })).max(256) }),
      await request(token, `/users/${id}?$select=id,usageLocation,assignedLicenses`), 'invalid_provider_response');
      if (current.id !== id) throw new AdminGraphError('invalid_provider_response');
      if (current.assignedLicenses.some(assigned => assigned.skuId === skuId))
        return { accepted: true as const, changed: false as const, verified: true as const };
      if (!current.usageLocation || !/^[A-Z]{2}$/.test(current.usageLocation)) throw new AdminGraphError('usage_location_required');
      const subscribed = parse(z.object({ value: z.array(license).max(100), '@odata.nextLink': z.string().optional() }),
        await request(token, `/subscribedSkus?$select=${licenseSelect}`), 'invalid_provider_response');
      if (subscribed['@odata.nextLink'] || subscribed.value.length === 100) throw new AdminGraphError('invalid_provider_response');
      const selected = subscribed.value.find(item => item.skuId === skuId);
      if (!selected || selected.capabilityStatus !== 'Enabled' || selected.prepaidUnits.enabled <= selected.consumedUnits)
        throw new AdminGraphError('license_not_available');
      await authorize?.();
      await request(token, `/users/${id}/assignLicense`, 'POST', { addLicenses: [{ skuId }], removeLicenses: [] });
      // Graph may accept the write before the user read model converges. Never resend
      // the mutation because a readback was late; report acceptance separately.
      let verified = false;
      try {
        const after = parse(z.object({ id: uuid, assignedLicenses: z.array(z.object({ skuId: uuid })).max(256) }),
          await request(token, `/users/${id}?$select=id,assignedLicenses`), 'invalid_provider_response');
        verified = after.id === id && after.assignedLicenses.some(item => item.skuId === skuId);
      } catch { /* accepted write; caller must refresh to reconcile */ }
      return { accepted: true as const, changed: true as const, verified };
    },
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
    async getGlobalAdministrator(id: string) {
      id = parse(uuid, id, 'invalid_input');
      const token = await session();
      await resource(token, '/users', id, user, userSelect);
      const assignments = await globalAdministratorAssignments(token);
      return { enabled: assignments.some(assignment => assignment.principalId === id) };
    },
    async setGlobalAdministrator(id: string, enabled: boolean, authorize?: () => Promise<void>) {
      id = parse(uuid, id, 'invalid_input');
      if (typeof enabled !== 'boolean') throw new AdminGraphError('invalid_input');
      const token = await session();
      requireAppRole(token, 'RoleManagement.ReadWrite.Directory');
      await authorize?.();
      await resource(token, '/users', id, user, userSelect);
      await authorize?.();
      const before = await globalAdministratorAssignments(token);
      const targetAssignments = before.filter(assignment => assignment.principalId === id);
      if (targetAssignments.length > 1) throw new AdminGraphError('role_assignment_state_unknown');
      if (enabled) {
        if (targetAssignments.length === 1) return { accepted: true as const, changed: false as const, enabled: true as const };
        await authorize?.();
        await request(token, '/roleManagement/directory/roleAssignments', 'POST', {
          principalId: id, roleDefinitionId: GLOBAL_ADMINISTRATOR_ROLE_DEFINITION_ID, directoryScopeId: '/',
        });
      } else {
        if (targetAssignments.length === 0) return { accepted: true as const, changed: false as const, enabled: false as const };
        // Count distinct principals so duplicate malformed rows cannot permit removal.
        if (new Set(before.map(assignment => assignment.principalId)).size <= 1)
          throw new AdminGraphError('last_global_administrator');
        await authorize?.();
        await request(token, `/roleManagement/directory/roleAssignments/${targetAssignments[0]!.id}`, 'DELETE');
      }
      const after = await globalAdministratorAssignments(token);
      const enabledAfter = after.some(assignment => assignment.principalId === id);
      if (enabledAfter !== enabled) throw new AdminGraphError('unknown_write_outcome');
      return { accepted: true as const, changed: true as const, enabled };
    },
    addGroupMember: (groupId: string, userId: string) => membership(groupId, userId, false),
    removeGroupMember: (groupId: string, userId: string) => membership(groupId, userId, true),
  };
}
