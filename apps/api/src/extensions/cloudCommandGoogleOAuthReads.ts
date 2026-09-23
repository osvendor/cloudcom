/** Read-only Admin SDK adapter for per-customer OAuth grants. Gmail mailbox
 * settings and account writes still require the existing DWD mode. */
import { sql } from 'drizzle-orm';
import type { GoogleActivitySource, GoogleDirectoryKind, GoogleDirectoryResult, GoogleMembersResult,
  GoogleStorageResult, GoogleActivityResult, GoogleTraceResult } from '@cloudcom/ext-cloud-command';
import { db, withDbAccessContext } from '../db';
import { dbAccessContextFromAuth, type AuthContext } from '../middleware/auth';
import { decryptForColumn } from '../services/secretCrypto';
import { projectGoogleTrace } from './cloudCommandGoogleTrace';

export type GoogleOAuthConnection = { id: string; org_id: string; customer_id: string; customer_domain: string;
  authorized_email: string; refresh_token: string; granted_scopes: string; status: string; verified_at: Date };
const rows = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const base = 'https://www.googleapis.com/auth/';
const userScope = `${base}admin.directory.user.readonly`;
const groupScope = `${base}admin.directory.group.readonly`;
const usageScope = `${base}admin.reports.usage.readonly`;
const auditScope = `${base}admin.reports.audit.readonly`;
const failure = { ok: false as const, code: 'provider_failed' as const,
  message: 'Google Workspace request failed. Check the connection and authorized scopes.' };
const requiredScope = { ok: false as const, code: 'scope_required' as const,
  message: 'This Google report was not approved during Connect. Reconnect with reporting access.' };
const scalar = (value: unknown) => typeof value === 'string' && value ? value : null;

export async function loadGoogleOAuth(auth: AuthContext, orgId: string): Promise<GoogleOAuthConnection | null> {
  return withDbAccessContext(dbAccessContextFromAuth(auth), async () =>
    rows<GoogleOAuthConnection>(await db.execute(sql`SELECT id, org_id, customer_id, customer_domain,
      authorized_email, refresh_token, granted_scopes, status, verified_at
      FROM cloudcommand_google_oauth_connections WHERE org_id = ${orgId}::uuid AND status = 'active' LIMIT 1`))[0] ?? null);
}
function hasScope(row: GoogleOAuthConnection, scope: string) {
  return row.granted_scopes.split(/\s+/).includes(scope);
}
async function accessToken(row: GoogleOAuthConnection): Promise<string> {
  const clientId = process.env.CLOUDCOMMAND_GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.CLOUDCOMMAND_GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Google OAuth is not configured');
  const refreshToken = decryptForColumn('cloudcommand_google_oauth_connections', `refresh_token:${row.org_id}`, row.refresh_token);
  if (!refreshToken) throw new Error('Google OAuth grant is unavailable');
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Google OAuth refresh failed');
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error('Google OAuth refresh failed');
  return payload.access_token;
}
async function get(row: GoogleOAuthConnection, path: string, params: Record<string, string | undefined>) {
  const url = new URL(`https://admin.googleapis.com/admin/${path}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken(row)}` },
    signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error('Google API request failed');
  return response.json() as Promise<Record<string, unknown>>;
}
function page(value: unknown): string | null { return scalar(value); }
function allowedPage(value: string | null) { return value === null || value.length <= 2048 && /^[A-Za-z0-9_\-./+=]+$/.test(value); }

export async function oauthDirectory(row: GoogleOAuthConnection, kind: GoogleDirectoryKind,
  pageToken: string | null): Promise<GoogleDirectoryResult> {
  if (!allowedPage(pageToken)) return failure;
  if (!hasScope(row, kind === 'groups' ? groupScope : userScope)) return failure;
  try {
    if (kind === 'groups') {
      const data = await get(row, 'directory/v1/groups', { customer: row.customer_id, maxResults: '100',
        pageToken: pageToken ?? undefined, fields: 'nextPageToken,groups(id,name,email,description,directMembersCount)' });
      const items = ((data.groups ?? []) as Record<string, unknown>[]).flatMap(group => {
        const email = scalar(group.email)?.toLowerCase();
        if (!scalar(group.id) || !email?.endsWith(`@${row.customer_domain}`)) return [];
        return [{ id: scalar(group.id), name: scalar(group.name), email,
          description: scalar(group.description), members: scalar(group.directMembersCount) }];
      });
      return { ok: true, items, nextPageToken: page(data.nextPageToken) };
    }
    const data = await get(row, 'directory/v1/users', { customer: row.customer_id, maxResults: '100',
      pageToken: pageToken ?? undefined, projection: 'full', orderBy: 'email',
      query: `isArchived=${kind === 'archived'}`, fields: 'nextPageToken,users(id,customerId,name(fullName,givenName,familyName),primaryEmail,suspended,archived,isAdmin,orgUnitPath,lastLoginTime,isEnrolledIn2Sv,isEnforcedIn2Sv)' });
    const items = ((data.users ?? []) as Record<string, unknown>[]).flatMap(user => {
      const email = scalar(user.primaryEmail)?.toLowerCase();
      if (!scalar(user.id) || user.customerId !== row.customer_id || !email?.endsWith(`@${row.customer_domain}`)) return [];
      const name = user.name && typeof user.name === 'object' ? user.name as Record<string, unknown> : {};
      return [{ id: scalar(user.id), name: scalar(name.fullName) ?? email,
        givenName: scalar(name.givenName), familyName: scalar(name.familyName), email,
        type: 'User', suspended: user.suspended === true, admin: user.isAdmin === true,
        archived: user.archived === true, orgUnitPath: scalar(user.orgUnitPath),
        lastLoginTime: scalar(user.lastLoginTime), twoStepVerificationEnrolled: user.isEnrolledIn2Sv === true,
        twoStepVerificationEnforced: user.isEnforcedIn2Sv === true }];
    });
    return { ok: true, items, nextPageToken: page(data.nextPageToken) };
  } catch { return failure; }
}

export async function oauthMembers(row: GoogleOAuthConnection, groupId: string,
  pageToken: string | null): Promise<GoogleMembersResult> {
  if (!hasScope(row, groupScope) || !/^[A-Za-z0-9_-]{1,128}$/.test(groupId) || !allowedPage(pageToken)) return failure;
  try {
    const group = await get(row, `directory/v1/groups/${encodeURIComponent(groupId)}`,
      { fields: 'id,email' });
    if (group.id !== groupId || !scalar(group.email)?.toLowerCase().endsWith(`@${row.customer_domain}`)) return failure;
    const data = await get(row, `directory/v1/groups/${encodeURIComponent(groupId)}/members`,
      { maxResults: '100', pageToken: pageToken ?? undefined,
        fields: 'nextPageToken,members(id,email,role,type,status)' });
    const items = ((data.members ?? []) as Record<string, unknown>[]).flatMap(member =>
      scalar(member.id) && scalar(member.email) ? [{ id: scalar(member.id), email: scalar(member.email),
        role: ['OWNER', 'MANAGER', 'MEMBER'].includes(String(member.role)) ? String(member.role) : 'Unknown',
        type: scalar(member.type), status: scalar(member.status) }] : []);
    return { ok: true, items, nextPageToken: page(data.nextPageToken) };
  } catch { return failure; }
}

export async function oauthStorage(row: GoogleOAuthConnection, date: string,
  pageToken: string | null): Promise<GoogleStorageResult> {
  if (!hasScope(row, usageScope)) return requiredScope;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !allowedPage(pageToken)) return failure;
  try {
    const data = await get(row, `reports/v1/usage/users/all/dates/${date}`, {
      customerId: row.customer_id, maxResults: '100', pageToken: pageToken ?? undefined,
      parameters: 'accounts:drive_used_quota_in_mb,accounts:gmail_used_quota_in_mb,accounts:used_quota_in_mb',
      fields: 'nextPageToken,warnings(code),usageReports(entity(customerId,userEmail),parameters(name,intValue))' });
    let partial = false;
    const items = ((data.usageReports ?? []) as Record<string, unknown>[]).flatMap(report => {
      const entity = report.entity as Record<string, unknown> | undefined;
      const email = scalar(entity?.userEmail)?.toLowerCase();
      if (entity?.customerId !== row.customer_id || !email?.endsWith(`@${row.customer_domain}`)) { partial = true; return []; }
      const params = (report.parameters ?? []) as Array<{ name?: string; intValue?: string }>;
      const metric = (name: string) => {
        const value = params.find(p => p.name === name || p.name === `accounts:${name}`)?.intValue;
        const parsed = value && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
        if (!Number.isSafeInteger(parsed)) partial = true;
        return Number.isSafeInteger(parsed) ? parsed : null;
      };
      return [{ email, gmailMb: metric('gmail_used_quota_in_mb'),
        driveMb: metric('drive_used_quota_in_mb'), totalMb: metric('used_quota_in_mb') }];
    });
    partial ||= Array.isArray(data.warnings) && data.warnings.length > 0;
    return { ok: true, date, items, nextPageToken: page(data.nextPageToken), partial,
      warning: partial ? 'Google returned incomplete data or omitted records outside this customer domain.' : null };
  } catch { return failure; }
}

export async function oauthActivity(row: GoogleOAuthConnection, source: GoogleActivitySource,
  days: 1 | 7 | 30, pageToken: string | null, asOf: string | null): Promise<GoogleActivityResult> {
  if (!hasScope(row, auditScope)) return requiredScope;
  if (!['login', 'admin', 'drive', 'token'].includes(source) || !allowedPage(pageToken)
    || !!pageToken !== !!asOf || ![1, 7, 30].includes(days)) return failure;
  const end = asOf ? new Date(asOf) : new Date();
  if (!Number.isFinite(end.getTime()) || end.getTime() > Date.now() || Date.now() - end.getTime() > 3600000) return failure;
  const start = new Date(end.getTime() - days * 86400000);
  try {
    const data = await get(row, `reports/v1/activity/users/all/applications/${source}`, {
      customerId: row.customer_id, startTime: start.toISOString(), endTime: end.toISOString(),
      maxResults: '100', pageToken: pageToken ?? undefined,
      fields: 'nextPageToken,items(id(time,uniqueQualifier,applicationName,customerId),actor(email),ipAddress,events(name,type))' });
    let partial = false;
    const items = ((data.items ?? []) as Record<string, unknown>[]).flatMap(item => {
      const id = item.id as Record<string, unknown> | undefined;
      const at = scalar(id?.time), rawId = scalar(id?.uniqueQualifier);
      const events = (item.events ?? []) as Array<{ name?: string; type?: string }>;
      if (id?.customerId !== row.customer_id || id?.applicationName !== source || !at || !rawId
        || !Number.isFinite(Date.parse(at)) || Date.parse(at) < start.getTime() || Date.parse(at) > end.getTime()
        || !/^[A-Za-z0-9_-]{1,128}$/.test(rawId)) { partial = true; return []; }
      const names = events.slice(0, 5).map(e => e.name ?? e.type).filter((v): v is string => !!v).map(v => v.slice(0, 120));
      if (!names.length) { partial = true; return []; }
      if (events.length > 5) partial = true;
      const actor = item.actor as Record<string, unknown> | undefined;
      return [{ id: rawId, at: new Date(at).toISOString(), source,
        actor: scalar(actor?.email)?.slice(0, 320) ?? null, ip: scalar(item.ipAddress)?.slice(0, 64) ?? null,
        events: names }];
    });
    return { ok: true, source, days, asOf: end.toISOString(), items, nextPageToken: page(data.nextPageToken), partial,
      warning: partial ? 'Some Google activity records could not be verified for this customer.' : null };
  } catch { return failure; }
}

export async function oauthTrace(row: GoogleOAuthConnection, days: 1 | 7 | 30,
  pageToken: string | null, asOf: string | null): Promise<GoogleTraceResult> {
  if (!hasScope(row, auditScope)) return requiredScope;
  if (!allowedPage(pageToken) || !!pageToken !== !!asOf || ![1, 7, 30].includes(days)) return failure;
  const end = asOf ? new Date(asOf) : new Date();
  if (!Number.isFinite(end.getTime()) || end.getTime() > Date.now() || Date.now() - end.getTime() > 3600000) return failure;
  const start = new Date(end.getTime() - days * 86400000);
  try {
    const data = await get(row, 'reports/v1/activity/users/all/applications/gmail', {
      customerId: row.customer_id, startTime: start.toISOString(), endTime: end.toISOString(),
      maxResults: '100', pageToken: pageToken ?? undefined,
      fields: 'nextPageToken,items(id(time,uniqueQualifier,applicationName,customerId),events(name,parameters))' });
    const projected = projectGoogleTrace((data.items ?? []) as Parameters<typeof projectGoogleTrace>[0],
      row.customer_id, start.getTime(), end.getTime());
    return { ok: true, days, asOf: end.toISOString(), items: projected.rows,
      nextPageToken: page(data.nextPageToken), partial: projected.partial,
      warning: projected.partial ? 'Some Gmail audit records could not be verified for this customer.' : null };
  } catch { return failure; }
}
