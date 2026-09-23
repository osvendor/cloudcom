import { eq } from 'drizzle-orm';
import type { GoogleProfileInput, GoogleRequest, GoogleSuspendInput, NativeGoogleServices } from '@cloudcom/ext-cloud-command';
import { db, withDbAccessContext } from '../db';
import { googleWorkspaceConnections } from '../db/schema/google';
import { dbAccessContextFromAuth, type AuthContext } from '../middleware/auth';
import { GOOGLE_WORKSPACE_ENABLED } from '../config/env';
import { decryptConnectionKey } from '../services/googleHelpers';
import { getDirectoryClient } from '../services/googleClient';
import { createAuditLog } from '../services/auditService';

const denied = { ok: false as const, code: 'access_denied' as const, message: 'Google Workspace access is not permitted for this organization.' };
const disconnected = { ok: false as const, code: 'connection_not_ready' as const, message: 'Connect Google Workspace for this organization in Extensions > Connect.' };
const changed = { ok: false as const, code: 'state_changed' as const, message: 'The Google account or connection changed. Refresh before retrying.' };
const protectedAccount = { ok: false as const, code: 'protected_account' as const, message: 'This account cannot be changed from this action.' };
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
  return { id: scalar(value.id), name: scalar(name.fullName) ?? scalar(value.primaryEmail),
    givenName: scalar(name.givenName), familyName: scalar(name.familyName), email: scalar(value.primaryEmail),
    type: 'User', suspended: bool(value.suspended),
    admin: bool(value.isAdmin), orgUnitPath: scalar(value.orgUnitPath), lastLoginTime: scalar(value.lastLoginTime),
    archived: bool(value.archived), twoStepVerificationEnrolled: bool(value.isEnrolledIn2Sv), twoStepVerificationEnforced: bool(value.isEnforcedIn2Sv) };
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
          projection: 'full', orderBy: 'email', query: 'isArchived=false', fields: 'nextPageToken,users(id,name(fullName,givenName,familyName),primaryEmail,suspended,archived,isAdmin,orgUnitPath,lastLoginTime,isEnrolledIn2Sv,isEnforcedIn2Sv)' });
        return { ok: true, items: (response.data.users ?? []).filter(user => !!user.id && !!user.primaryEmail).map(user => projectUser(user as Record<string, unknown>)), nextPageToken: response.data.nextPageToken ?? null };
      }
      if (kind === 'archived') {
        const response = await client.users.list({ domain: row.customerDomain, maxResults: 100, pageToken: pageToken ?? undefined,
          projection: 'full', orderBy: 'email', query: 'isArchived=true', fields: 'nextPageToken,users(id,name(fullName,givenName,familyName),primaryEmail,suspended,archived,isAdmin,orgUnitPath,lastLoginTime,isEnrolledIn2Sv,isEnforcedIn2Sv)' });
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
  async auditSuspension(input, userId, stage) {
    const auth = authorized(input);
    if (!auth || !input.authorization.hasPermission('organizations', 'write') || !input.authorization.mfaSatisfied
      || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error('google_audit_access_denied');
    await createAuditLog({
      orgId: input.orgId,
      actorId: auth.user.id,
      actorType: 'user',
      action: stage === 'intent' ? 'cloudcommand.google.user.suspension.intent' : 'cloudcommand.google.user.suspension',
      resourceType: 'google_user', resourceId: userId,
      result: stage === 'failure' ? 'failure' : 'success', initiatedBy: 'manual',
    });
  },
  async auditProfile(input, userId, stage) {
    const auth = authorized(input);
    if (!auth || !input.authorization.hasPermission('organizations', 'write') || !input.authorization.mfaSatisfied
      || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error('google_audit_access_denied');
    await createAuditLog({
      orgId: input.orgId, actorId: auth.user.id, actorType: 'user',
      action: stage === 'intent' ? 'cloudcommand.google.user.profile.intent' : 'cloudcommand.google.user.profile',
      resourceType: 'google_user', resourceId: userId,
      result: stage === 'failure' ? 'failure' : 'success', initiatedBy: 'manual',
    });
  },
  async setSuspended(input, change: GoogleSuspendInput) {
    const auth = authorized(input);
    if (!auth || !input.authorization.hasPermission('organizations', 'write') || !input.authorization.mfaSatisfied) return denied;
    if (!GOOGLE_WORKSPACE_ENABLED) return disconnected;
    if (typeof change.userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(change.userId)
      || typeof change.email !== 'string' || change.email.length > 320 || change.confirmation !== change.email
      || change.suspended === change.expectedSuspended) return { ok: false, code: 'invalid_operation', message: 'Invalid account request.' };
    const row = await load(auth, input.orgId);
    if (!row || row.orgId !== input.orgId || row.status !== 'active') return disconnected;
    const email = change.email.toLowerCase();
    if (!email.endsWith(`@${row.customerDomain.toLowerCase()}`) || email === row.adminEmail.toLowerCase()
      || (typeof auth.user.email === 'string' && email === auth.user.email.toLowerCase())) return protectedAccount;
    let client;
    try { client = getDirectoryClient(decryptConnectionKey(row), row.adminEmail); }
    catch { return disconnected; }
    let current;
    try { current = (await client.users.get({ userKey: change.userId, projection: 'full' })).data; }
    catch { return { ok: false, code: 'provider_failed', message: 'Google account could not be checked. No change was sent.' }; }
    if (current.id !== change.userId || current.primaryEmail?.toLowerCase() !== email || current.archived === true
      || current.suspended !== change.expectedSuspended) return changed;
    if (current.isAdmin === true) return protectedAccount;
    const fresh = await load(auth, input.orgId);
    if (!fresh || fresh.id !== row.id || fresh.status !== 'active' || fresh.customerDomain !== row.customerDomain
      || fresh.adminEmail !== row.adminEmail || fresh.serviceAccountKey !== row.serviceAccountKey) return changed;
    try { await client.users.update({ userKey: change.userId, requestBody: { suspended: change.suspended } }); }
    catch { return { ok: false, code: 'unknown_write_outcome', message: 'The change may have been applied. Refresh before retrying.' }; }
    try {
      const verified = (await client.users.get({ userKey: change.userId, projection: 'full' })).data;
      if (verified.id === change.userId && verified.primaryEmail?.toLowerCase() === email && verified.suspended === change.suspended)
        return { ok: true, userId: change.userId, suspended: change.suspended };
    } catch { /* A failed readback cannot prove the write failed. */ }
    return { ok: false, code: 'unknown_write_outcome', message: 'The change may have been applied. Refresh before retrying.' };
  },
  async updateProfile(input, change: GoogleProfileInput) {
    const auth = authorized(input);
    if (!auth || !input.authorization.hasPermission('organizations', 'write') || !input.authorization.mfaSatisfied) return denied;
    if (!GOOGLE_WORKSPACE_ENABLED) return disconnected;
    const validName = (name: unknown) => typeof name === 'string' && name.trim() === name && name.length >= 1 && name.length <= 100 && !/[\x00-\x1f\x7f]/.test(name);
    if (typeof change.userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(change.userId)
      || typeof change.email !== 'string' || change.email.length > 320
      || !validName(change.givenName) || !validName(change.familyName) || !validName(change.expectedGivenName) || !validName(change.expectedFamilyName)
      || (change.givenName === change.expectedGivenName && change.familyName === change.expectedFamilyName))
      return { ok: false, code: 'invalid_operation', message: 'Invalid account request.' };
    const row = await load(auth, input.orgId);
    if (!row || row.orgId !== input.orgId || row.status !== 'active') return disconnected;
    const email = change.email.toLowerCase();
    if (!email.endsWith(`@${row.customerDomain.toLowerCase()}`) || email === row.adminEmail.toLowerCase()
      || (typeof auth.user.email === 'string' && email === auth.user.email.toLowerCase())) return protectedAccount;
    let client;
    try { client = getDirectoryClient(decryptConnectionKey(row), row.adminEmail); }
    catch { return disconnected; }
    let current;
    try { current = (await client.users.get({ userKey: change.userId, projection: 'full' })).data; }
    catch { return { ok: false, code: 'provider_failed', message: 'Google account could not be checked. No change was sent.' }; }
    if (current.id !== change.userId || current.primaryEmail?.toLowerCase() !== email || current.archived === true
      || current.name?.givenName !== change.expectedGivenName || current.name?.familyName !== change.expectedFamilyName) return changed;
    if (current.isAdmin === true) return protectedAccount;
    const fresh = await load(auth, input.orgId);
    if (!fresh || fresh.id !== row.id || fresh.status !== 'active' || fresh.customerDomain !== row.customerDomain
      || fresh.adminEmail !== row.adminEmail || fresh.serviceAccountKey !== row.serviceAccountKey) return changed;
    try { await client.users.update({ userKey: change.userId, requestBody: { name: { givenName: change.givenName, familyName: change.familyName } } }); }
    catch { return { ok: false, code: 'unknown_write_outcome', message: 'The change may have been applied. Refresh before retrying.' }; }
    try {
      const verified = (await client.users.get({ userKey: change.userId, projection: 'full' })).data;
      if (verified.id === change.userId && verified.primaryEmail?.toLowerCase() === email
        && verified.name?.givenName === change.givenName && verified.name?.familyName === change.familyName)
        return { ok: true, userId: change.userId, givenName: change.givenName, familyName: change.familyName };
    } catch { /* A failed readback cannot prove the write failed. */ }
    return { ok: false, code: 'unknown_write_outcome', message: 'The change may have been applied. Refresh before retrying.' };
  },
};
