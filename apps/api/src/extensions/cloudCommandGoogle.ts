import { eq } from 'drizzle-orm';
import type { GoogleRequest, NativeGoogleServices } from '@cloudcom/ext-cloud-command';
import { db, withDbAccessContext } from '../db';
import { googleWorkspaceConnections } from '../db/schema/google';
import { dbAccessContextFromAuth, type AuthContext } from '../middleware/auth';
import { GOOGLE_WORKSPACE_ENABLED } from '../config/env';
import { decryptConnectionKey } from '../services/googleHelpers';
import { getDirectoryClient } from '../services/googleClient';

const denied = { ok: false as const, code: 'access_denied' as const, message: 'Google Workspace access is not permitted for this organization.' };
const disconnected = { ok: false as const, code: 'connection_not_ready' as const, message: 'Connect Google Workspace for this organization in Extensions > Connect.' };
function authorized(input: GoogleRequest): AuthContext | null {
  const auth = input.auth as AuthContext | undefined;
  if (!auth?.user?.id || typeof auth.canAccessOrg !== 'function' || !auth.canAccessOrg(input.orgId)
    || (auth.scope === 'organization' && auth.orgId !== input.orgId)
    || (auth.scope === 'system' && !auth.user.isPlatformAdmin)
    || auth.allowedSiteIds !== undefined || input.authorization.allowedSiteIds !== undefined
    || !input.authorization.hasPermission('organizations', 'read')) return null;
  return auth;
}
async function load(auth: AuthContext, orgId: string) {
  return withDbAccessContext(dbAccessContextFromAuth(auth), async () => {
    const [row] = await db.select().from(googleWorkspaceConnections)
      .where(eq(googleWorkspaceConnections.orgId, orgId)).limit(1);
    return row ?? null;
  });
}
const scalar = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
/** A fixed, small browser projection; never return Google's full user or group object. */
function projectUser(value: Record<string, unknown>): Record<string, string | boolean | null> {
  const name = value.name && typeof value.name === 'object' ? value.name as Record<string, unknown> : {};
  return { id: scalar(value.id), name: scalar(name.fullName) ?? scalar(value.primaryEmail), email: scalar(value.primaryEmail),
    type: 'User', suspended: bool(value.suspended),
    admin: bool(value.isAdmin), orgUnitPath: scalar(value.orgUnitPath), lastLoginTime: scalar(value.lastLoginTime),
    twoStepVerificationEnrolled: bool(value.isEnrolledIn2Sv), twoStepVerificationEnforced: bool(value.isEnforcedIn2Sv) };
}
function projectGroup(value: Record<string, unknown>): Record<string, string | boolean | null> {
  const members = typeof value.directMembersCount === 'number' && Number.isSafeInteger(value.directMembersCount) && value.directMembersCount >= 0
    ? String(value.directMembersCount) : scalar(value.directMembersCount);
  return { id: scalar(value.id), name: scalar(value.name), email: scalar(value.email), description: scalar(value.description), members };
}

export const nativeGoogleServices: NativeGoogleServices = {
  version: 1,
  async connection(input) {
    const auth = authorized(input);
    if (!auth) return { available: false, connected: false, enabled: false, canManage: false };
    const canManage = input.authorization.hasPermission('organizations', 'write') && input.authorization.mfaSatisfied;
    if (!GOOGLE_WORKSPACE_ENABLED) return { available: false, connected: false, enabled: false, canManage };
    const row = await load(auth, input.orgId);
    return row?.orgId === input.orgId ? { available: true, connected: true, enabled: row.status === 'active', canManage,
      customerDomain: row.customerDomain, lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null }
      : { available: true, connected: false, enabled: false, canManage };
  },
  async directory(input, kind, pageToken) {
    const auth = authorized(input);
    if (!auth) return denied;
    if (!GOOGLE_WORKSPACE_ENABLED) return disconnected;
    const row = await load(auth, input.orgId);
    if (!row || row.orgId !== input.orgId || row.status !== 'active') return disconnected;
    try {
      const client = getDirectoryClient(decryptConnectionKey(row), row.adminEmail);
      if (kind === 'users') {
        const response = await client.users.list({ domain: row.customerDomain, maxResults: 100, pageToken: pageToken ?? undefined,
          projection: 'full', orderBy: 'email', fields: 'nextPageToken,users(id,name/fullName,primaryEmail,suspended,isAdmin,orgUnitPath,lastLoginTime,isEnrolledIn2Sv,isEnforcedIn2Sv)' });
        return { ok: true, items: (response.data.users ?? []).filter(user => !!user.id && !!user.primaryEmail).map(user => projectUser(user as Record<string, unknown>)), nextPageToken: response.data.nextPageToken ?? null };
      }
      const response = await client.groups.list({ domain: row.customerDomain, maxResults: 100, pageToken: pageToken ?? undefined,
        fields: 'nextPageToken,groups(id,name,email,description,directMembersCount)' });
      return { ok: true, items: (response.data.groups ?? []).filter(group => !!group.id && !!group.email).map(group => projectGroup(group as Record<string, unknown>)), nextPageToken: response.data.nextPageToken ?? null };
    } catch {
      // Do not forward upstream errors, response bodies, or credential details to the browser.
      return { ok: false, code: 'provider_failed', message: 'Google Workspace directory could not be loaded. Check the connection and delegation scopes.' };
    }
  },
};
