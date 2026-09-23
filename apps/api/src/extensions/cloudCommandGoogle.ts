import { eq } from 'drizzle-orm';
import type { GoogleActivitySource, GoogleProfileInput, GoogleRequest, GoogleSuspendInput, NativeGoogleServices } from '@cloudcom/ext-cloud-command';
import { db, withDbAccessContext } from '../db';
import { googleWorkspaceConnections } from '../db/schema/google';
import { dbAccessContextFromAuth, type AuthContext } from '../middleware/auth';
import { GOOGLE_WORKSPACE_ENABLED } from '../config/env';
import { decryptConnectionKey } from '../services/googleHelpers';
import { getAuditReportsClient, getDirectoryClient, getGmailClient, getUsageReportsClient } from '../services/googleClient';
import { createAuditLog } from '../services/auditService';
import { projectGoogleTrace } from './cloudCommandGoogleTrace';
import { loadGoogleOAuth, oauthActivity, oauthDirectory, oauthMembers, oauthStorage, oauthTrace } from './cloudCommandGoogleOAuthReads';

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
function projectMember(value: Record<string, unknown>): Record<string, string | boolean | null> {
  const role = scalar(value.role);
  return { id: scalar(value.id), email: scalar(value.email), role: role === 'OWNER' || role === 'MANAGER' || role === 'MEMBER' ? role : 'Unknown',
    type: scalar(value.type), status: scalar(value.status) };
}

export const nativeGoogleServices: NativeGoogleServices = {
  version: 1,
  async connection(input) {
    const auth = authorized(input);
    if (!auth) return { available: false, connected: false, enabled: false, canManage: false };
    const canManage = input.authorization.hasPermission('organizations', 'write') && input.authorization.mfaSatisfied;
    if (!GOOGLE_WORKSPACE_ENABLED) return { available: false, connected: false, enabled: false, canManage };
    const row = await load(auth, input.orgId);
    if (!row) {
      const oauth = await loadGoogleOAuth(auth, input.orgId);
      return oauth ? { available: true, connected: true, enabled: true, canManage: false,
        canReadReports: canManage && oauth.granted_scopes.split(/\s+/).includes('https://www.googleapis.com/auth/admin.reports.audit.readonly'),
        customerDomain: oauth.customer_domain, lastVerifiedAt: oauth.verified_at?.toISOString() ?? null }
        : { available: true, connected: false, enabled: false, canManage };
    }
    return row.orgId === input.orgId ? { available: true, connected: true, enabled: row.status === 'active', canManage,
      customerDomain: row.customerDomain, lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null }
      : { available: true, connected: false, enabled: false, canManage };
  },
  async directory(input, kind, pageToken) {
    const auth = authorized(input);
    if (!auth) return denied;
    if (!GOOGLE_WORKSPACE_ENABLED) return disconnected;
    const row = await load(auth, input.orgId);
    if (!row) {
      const oauth = await loadGoogleOAuth(auth, input.orgId);
      return oauth ? oauthDirectory(oauth, kind, pageToken) : disconnected;
    }
    if (row.orgId !== input.orgId || row.status !== 'active') return disconnected;
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
  async members(input, groupId, pageToken) {
    const auth = authorized(input);
    if (!auth) return denied;
    if (!GOOGLE_WORKSPACE_ENABLED) return disconnected;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(groupId)) return { ok: false, code: 'provider_failed', message: 'Invalid Google group.' };
    const row = await load(auth, input.orgId);
    if (!row) {
      const oauth = await loadGoogleOAuth(auth, input.orgId);
      return oauth ? oauthMembers(oauth, groupId, pageToken) : disconnected;
    }
    if (row.orgId !== input.orgId || row.status !== 'active') return disconnected;
    try {
      const client = getDirectoryClient(decryptConnectionKey(row), row.adminEmail);
      const group = (await client.groups.get({ groupKey: groupId, fields: 'id,email' })).data;
      if (group.id !== groupId || !group.email?.toLowerCase().endsWith(`@${row.customerDomain.toLowerCase()}`)) return denied;
      const response = await client.members.list({ groupKey: groupId, maxResults: 100, pageToken: pageToken ?? undefined,
        includeDerivedMembership: false, fields: 'nextPageToken,members(id,email,role,type,status)' });
      return { ok: true, items: (response.data.members ?? []).filter(member => !!member.id && !!member.email)
        .map(member => projectMember(member as Record<string, unknown>)), nextPageToken: response.data.nextPageToken ?? null };
    } catch {
      return { ok: false, code: 'provider_failed', message: 'Google group members could not be loaded. Check the connection and delegation scopes.' };
    }
  },
  async mailboxSettings(input, userId) {
    const auth = authorized(input);
    if (!auth || !input.authorization.hasPermission('organizations', 'write') || !input.authorization.mfaSatisfied) return denied;
    if (!GOOGLE_WORKSPACE_ENABLED) return disconnected;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return { ok: false, code: 'provider_failed', message: 'Invalid Google user.' };
    const row = await load(auth, input.orgId);
    if (!row || row.orgId !== input.orgId || row.status !== 'active') return disconnected;
    try {
      const key = decryptConnectionKey(row);
      const directory = getDirectoryClient(key, row.adminEmail);
      const user = (await directory.users.get({ userKey: userId, fields: 'id,primaryEmail,archived' })).data;
      const email = user.primaryEmail?.toLowerCase();
      if (user.id !== userId || !email?.endsWith(`@${row.customerDomain.toLowerCase()}`) || user.archived === true)
        return { ok: false, code: 'state_changed', message: 'The Google mailbox changed. Refresh the directory before retrying.' };
      const fresh = await load(auth, input.orgId);
      if (!fresh || fresh.id !== row.id || fresh.status !== 'active' || fresh.customerDomain !== row.customerDomain
        || fresh.adminEmail !== row.adminEmail || fresh.serviceAccountKey !== row.serviceAccountKey)
        return { ok: false, code: 'state_changed', message: 'The Google connection changed. Refresh before retrying.' };
      const gmail = getGmailClient(key, email);
      const [forward, vacation] = await Promise.all([
        gmail.users.settings.getAutoForwarding({ userId: 'me' }),
        gmail.users.settings.getVacation({ userId: 'me' }),
      ]);
      return { ok: true, email, forwardingEnabled: bool(forward.data.enabled), forwardingAddress: scalar(forward.data.emailAddress),
        forwardingDisposition: scalar(forward.data.disposition), vacationEnabled: bool(vacation.data.enableAutoReply),
        vacationSubject: scalar(vacation.data.responseSubject), vacationStartMs: scalar(vacation.data.startTime), vacationEndMs: scalar(vacation.data.endTime) };
    } catch {
      return { ok: false, code: 'provider_failed', message: 'Gmail settings could not be loaded. Check mailbox licensing and domain-wide delegation scopes.' };
    }
  },
  async storage(input, date, pageToken) {
    const auth = authorized(input);
    if (!auth) return denied;
    if (!GOOGLE_WORKSPACE_ENABLED) return disconnected;
    const time = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date || time > Date.now()
      || Date.now() - time > 180 * 86400000 || (pageToken !== null && (pageToken.length > 2048 || !/^[A-Za-z0-9_\-./+=]+$/.test(pageToken))))
      return { ok: false, code: 'provider_failed', message: 'Invalid storage report request.' };
    const row = await load(auth, input.orgId);
    if (!row) {
      const oauth = await loadGoogleOAuth(auth, input.orgId);
      return oauth ? oauthStorage(oauth, date, pageToken) : disconnected;
    }
    if (row.orgId !== input.orgId || row.status !== 'active') return disconnected;
    let key: string;
    let customerId: string | undefined;
    try {
      key = decryptConnectionKey(row);
      const admin = (await getDirectoryClient(key, row.adminEmail).users.get({ userKey: row.adminEmail,
        fields: 'customerId,primaryEmail' })).data;
      customerId = admin.customerId ?? undefined;
      if (!customerId || !/^[A-Za-z0-9_-]{1,128}$/.test(customerId)
        || admin.primaryEmail?.toLowerCase() !== row.adminEmail.toLowerCase())
        return { ok: false, code: 'provider_failed', message: 'Google customer ownership could not be verified.' };
      const fresh = await load(auth, input.orgId);
      if (!fresh || fresh.id !== row.id || fresh.status !== 'active' || fresh.customerDomain !== row.customerDomain
        || fresh.adminEmail !== row.adminEmail || fresh.serviceAccountKey !== row.serviceAccountKey) return disconnected;
    } catch {
      return { ok: false, code: 'provider_failed', message: 'Google customer ownership could not be verified.' };
    }
    let data;
    try {
      data = (await getUsageReportsClient(key, row.adminEmail).userUsageReport.get({ userKey: 'all', date,
        customerId, maxResults: 100, pageToken: pageToken ?? undefined,
        parameters: 'accounts:drive_used_quota_in_mb,accounts:gmail_used_quota_in_mb,accounts:used_quota_in_mb',
        fields: 'nextPageToken,warnings(code),usageReports(entity(customerId,userEmail),parameters(name,intValue))' })).data;
    } catch (error) {
      const status = (error as { response?: { status?: number }; status?: number; code?: number }).response?.status
        ?? (error as { status?: number; code?: number }).status ?? (error as { code?: number }).code;
      return status === 401 || status === 403
        ? { ok: false, code: 'scope_required', message: 'Google usage-report access is unavailable. Update the existing domain-wide delegation grant to include admin.reports.usage.readonly and verify the administrator reporting privilege.' }
        : { ok: false, code: 'provider_failed', message: 'Google usage report could not be loaded. The date may not be ready yet.' };
    }
    let omitted = false;
    let missing = false;
    const items = (data.usageReports ?? []).flatMap(report => {
      const email = report.entity?.userEmail?.toLowerCase();
      if (!email || report.entity?.customerId !== customerId || !email.endsWith(`@${row.customerDomain.toLowerCase()}`)) {
        omitted = true; return [];
      }
      const metric = (name: string): number | null => {
        const parameter = report.parameters?.find(item => item.name === name || item.name === `accounts:${name}`);
        if (!parameter || !/^(0|[1-9]\d*)$/.test(parameter.intValue ?? '')) return null;
        const value = Number(parameter.intValue);
        return Number.isSafeInteger(value) ? value : null;
      };
      const gmailMb = metric('gmail_used_quota_in_mb');
      const driveMb = metric('drive_used_quota_in_mb');
      const totalMb = metric('used_quota_in_mb');
      if (gmailMb === null || driveMb === null || totalMb === null) missing = true;
      return [{ email, gmailMb, driveMb, totalMb }];
    });
    const partial = !!data.warnings?.length || omitted || missing || (!items.length && !data.nextPageToken);
    const warning = omitted ? 'Only users in the configured Google domain are shown; other domains were omitted.'
      : data.warnings?.length || missing || !items.length ? 'Google returned incomplete or unavailable usage data for this date.' : null;
    return { ok: true, date, items, nextPageToken: data.nextPageToken ?? null, partial, warning };
  },
  async activity(input, source, days, pageToken, asOf) {
    const auth = authorized(input);
    if (!auth || !input.authorization.hasPermission('organizations', 'write') || !input.authorization.mfaSatisfied) return denied;
    if (!GOOGLE_WORKSPACE_ENABLED) return disconnected;
    if (!['login', 'admin', 'drive', 'token'].includes(source) || ![1, 7, 30].includes(days)
      || (pageToken !== null && (pageToken.length > 2048 || !/^[A-Za-z0-9_\-./+=]+$/.test(pageToken)))
      || !!pageToken !== !!asOf || (asOf !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(asOf)
        || !Number.isFinite(Date.parse(asOf)) || Date.parse(asOf) > Date.now() || Date.now() - Date.parse(asOf) > 3600000)))
      return { ok: false, code: 'provider_failed', message: 'Invalid activity report request.' };
    const row = await load(auth, input.orgId);
    if (!row) {
      const oauth = await loadGoogleOAuth(auth, input.orgId);
      return oauth ? oauthActivity(oauth, source, days, pageToken, asOf) : disconnected;
    }
    if (row.orgId !== input.orgId || row.status !== 'active') return disconnected;
    let key: string;
    let customerId: string;
    try {
      key = decryptConnectionKey(row);
      const admin = (await getDirectoryClient(key, row.adminEmail).users.get({ userKey: row.adminEmail,
        fields: 'customerId,primaryEmail' })).data;
      if (!admin.customerId || !/^[A-Za-z0-9_-]{1,128}$/.test(admin.customerId)
        || admin.primaryEmail?.toLowerCase() !== row.adminEmail.toLowerCase())
        return { ok: false, code: 'provider_failed', message: 'Google customer ownership could not be verified.' };
      customerId = admin.customerId;
      const fresh = await load(auth, input.orgId);
      if (!fresh || fresh.id !== row.id || fresh.status !== 'active' || fresh.customerDomain !== row.customerDomain
        || fresh.adminEmail !== row.adminEmail || fresh.serviceAccountKey !== row.serviceAccountKey) return disconnected;
    } catch {
      return { ok: false, code: 'provider_failed', message: 'Google customer ownership could not be verified.' };
    }
    const end = asOf ? new Date(asOf) : new Date();
    const start = new Date(end.getTime() - days * 86400000);
    let data;
    try {
      data = (await getAuditReportsClient(key, row.adminEmail).activities.list({ userKey: 'all', applicationName: source,
        customerId, startTime: start.toISOString(), endTime: end.toISOString(), maxResults: 100,
        pageToken: pageToken ?? undefined,
        fields: 'nextPageToken,items(id(time,uniqueQualifier,applicationName,customerId),actor(email),ipAddress,events(name,type))' })).data;
    } catch (error) {
      const status = (error as { response?: { status?: number }; status?: number; code?: number }).response?.status
        ?? (error as { status?: number; code?: number }).status ?? (error as { code?: number }).code;
      return status === 401 || status === 403
        ? { ok: false, code: 'scope_required', message: 'Google activity access is unavailable. Update the existing delegation grant with admin.reports.audit.readonly and verify the administrator reporting privilege.' }
        : { ok: false, code: 'provider_failed', message: 'Google activity report could not be loaded for this source and window.' };
    }
    let omitted = false;
    const items = (data.items ?? []).flatMap(item => {
      const id = item.id;
      const at = id?.time;
      const eventSource = id?.applicationName;
      const rawId = id?.uniqueQualifier;
      if (id?.customerId !== customerId || eventSource !== source || !at || !Number.isFinite(Date.parse(at))
        || Date.parse(at) < start.getTime() || Date.parse(at) > end.getTime()
        || !rawId || !/^[A-Za-z0-9_-]{1,128}$/.test(rawId) || item.events?.length === 0) {
        omitted = true; return [];
      }
      const names = (item.events ?? []).slice(0, 5).map(event => event.name ?? event.type).filter((name): name is string => !!name)
        .map(name => name.slice(0, 120));
      if (!names.length) { omitted = true; return []; }
      if ((item.events?.length ?? 0) > 5) omitted = true;
      return [{ id: rawId, at: new Date(at).toISOString(), source: eventSource as GoogleActivitySource,
        actor: scalar(item.actor?.email)?.slice(0, 320) ?? null, ip: scalar(item.ipAddress)?.slice(0, 64) ?? null,
        events: names }];
    });
    return { ok: true, source, days, asOf: end.toISOString(), items, nextPageToken: data.nextPageToken ?? null, partial: omitted,
      warning: omitted ? 'Some Google activity records were omitted or shortened because their tenant or fields could not be verified.' : null };
  },
  async trace(input, days, pageToken, asOf) {
    const auth = authorized(input);
    if (!auth || !input.authorization.hasPermission('organizations', 'write') || !input.authorization.mfaSatisfied) return denied;
    if (!GOOGLE_WORKSPACE_ENABLED) return disconnected;
    if (![1, 7, 30].includes(days)
      || (pageToken !== null && (pageToken.length > 2048 || !/^[A-Za-z0-9_\-./+=]+$/.test(pageToken)))
      || !!pageToken !== !!asOf || (asOf !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(asOf)
        || !Number.isFinite(Date.parse(asOf)) || Date.parse(asOf) > Date.now() || Date.now() - Date.parse(asOf) > 3600000)))
      return { ok: false, code: 'provider_failed', message: 'Invalid Gmail trace request.' };
    const row = await load(auth, input.orgId);
    if (!row) {
      const oauth = await loadGoogleOAuth(auth, input.orgId);
      return oauth ? oauthTrace(oauth, days, pageToken, asOf) : disconnected;
    }
    if (row.orgId !== input.orgId || row.status !== 'active') return disconnected;
    let key: string;
    let customerId: string;
    try {
      key = decryptConnectionKey(row);
      const admin = (await getDirectoryClient(key, row.adminEmail).users.get({ userKey: row.adminEmail,
        fields: 'customerId,primaryEmail' })).data;
      if (!admin.customerId || !/^[A-Za-z0-9_-]{1,128}$/.test(admin.customerId)
        || admin.primaryEmail?.toLowerCase() !== row.adminEmail.toLowerCase())
        return { ok: false, code: 'provider_failed', message: 'Google customer ownership could not be verified.' };
      customerId = admin.customerId;
      const fresh = await load(auth, input.orgId);
      if (!fresh || fresh.id !== row.id || fresh.status !== 'active' || fresh.customerDomain !== row.customerDomain
        || fresh.adminEmail !== row.adminEmail || fresh.serviceAccountKey !== row.serviceAccountKey) return disconnected;
    } catch {
      return { ok: false, code: 'provider_failed', message: 'Google customer ownership could not be verified.' };
    }
    const end = asOf ? new Date(asOf) : new Date();
    const start = new Date(end.getTime() - days * 86400000);
    let data;
    try {
      data = (await getAuditReportsClient(key, row.adminEmail).activities.list({ userKey: 'all', applicationName: 'gmail',
        customerId, startTime: start.toISOString(), endTime: end.toISOString(), maxResults: 100,
        pageToken: pageToken ?? undefined,
        fields: 'nextPageToken,items(id(time,uniqueQualifier,applicationName,customerId),events(name,parameters))' })).data;
    } catch (error) {
      const status = (error as { response?: { status?: number }; status?: number; code?: number }).response?.status
        ?? (error as { status?: number; code?: number }).status ?? (error as { code?: number }).code;
      return status === 401 || status === 403
        ? { ok: false, code: 'scope_required', message: 'Gmail audit access is unavailable. Update the existing delegation grant with admin.reports.audit.readonly and verify the administrator reporting privilege.' }
        : { ok: false, code: 'provider_failed', message: 'Gmail audit events could not be loaded for this window.' };
    }
    const { rows, partial } = projectGoogleTrace(data.items ?? [], customerId, start.getTime(), end.getTime());
    return { ok: true, days, asOf: end.toISOString(), items: rows, nextPageToken: data.nextPageToken ?? null, partial,
      warning: partial ? 'Some Gmail audit records were omitted or shortened because their tenant or fields could not be verified.' : null };
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
