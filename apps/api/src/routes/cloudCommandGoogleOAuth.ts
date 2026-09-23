/** Cloud Command Google OAuth onboarding. DWD remains an independent credential mode. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { authMiddleware, requireMfa, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { canMutateOrgWideGovernance } from '../services/siteCeilingAccess';
import { resolveScopedOrgId } from './c2c/helpers';
import { encryptSecret, decryptSecret } from '../services/secretCrypto';
import { writeAuditEvent } from '../services/auditEvents';
import { GOOGLE_WORKSPACE_ENABLED } from '../config/env';

const cookieName = '__Host-cloudcom_google_oauth';
const aad = 'cloudcommand_google_oauth_attempts.verifier_ciphertext';
const refreshAad = 'cloudcommand_google_oauth_connections.refresh_token';
const required = [
  'openid', 'email',
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
];
const optional = [
  'https://www.googleapis.com/auth/admin.reports.usage.readonly',
  'https://www.googleapis.com/auth/admin.reports.audit.readonly',
];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const rows = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

function config() {
  const clientId = process.env.CLOUDCOMMAND_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.CLOUDCOMMAND_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = process.env.CLOUDCOMMAND_GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  let url: URL;
  try { url = new URL(redirectUri); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/api/v1/google/oauth/callback') return null;
  return { clientId, clientSecret, redirectUri };
}
function normalizeDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  return value.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(value)
    && !value.includes('..') ? value : null;
}
function cookie(value: string, age: number) {
  return `${cookieName}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
}
function browserCookie(header: string | undefined) {
  return header?.split(';').map(piece => piece.trim()).find(piece => piece.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1) ?? '';
}
type Attempt = { org_id: string; actor_id: string; browser_hash: string;
  verifier_ciphertext: string; expected_domain: string };
type TokenResponse = { access_token?: string; refresh_token?: string; scope?: string };
async function googleJson(url: string, accessToken: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20000) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

export const cloudCommandGoogleOAuthRoutes = new Hono();
cloudCommandGoogleOAuthRoutes.use('/oauth/start', authMiddleware);
cloudCommandGoogleOAuthRoutes.use('/oauth/connection', authMiddleware);
cloudCommandGoogleOAuthRoutes.get('/oauth/connection',
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async c => {
    if (!GOOGLE_WORKSPACE_ENABLED) return c.json({ error: 'Google Workspace is not enabled' }, 404);
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'Organization is required' }, 400);
    const row = rows<{ customer_domain: string; authorized_email: string; granted_scopes: string;
      verified_at: Date; status: string }>(await db.execute(sql`SELECT customer_domain, authorized_email,
        granted_scopes, verified_at, status FROM cloudcommand_google_oauth_connections
        WHERE org_id = ${orgId}::uuid LIMIT 1`))[0];
    return c.json(row ? { connected: true, customerDomain: row.customer_domain,
      authorizedEmail: row.authorized_email, grantedScopes: row.granted_scopes.split(/\s+/),
      verifiedAt: row.verified_at, status: row.status } : { connected: false });
  });
cloudCommandGoogleOAuthRoutes.delete('/oauth/connection',
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action), requireMfa(), async c => {
    const auth = c.get('auth');
    if (!canMutateOrgWideGovernance(auth)) return c.json({ error: 'Organization administrator access required' }, 403);
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'Organization is required' }, 400);
    const removed = rows(await db.execute(sql`DELETE FROM cloudcommand_google_oauth_connections
      WHERE org_id = ${orgId}::uuid RETURNING id`));
    if (!removed.length) return c.json({ error: 'No OAuth connection' }, 404);
    writeAuditEvent(c, { orgId, actorId: auth.user?.id, action: 'google.oauth.connection.delete',
      resourceType: 'cloudcommand_google_oauth_connection' });
    return c.json({ connected: false });
  });
cloudCommandGoogleOAuthRoutes.post('/oauth/start',
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action), requireMfa(), async c => {
    if (!GOOGLE_WORKSPACE_ENABLED) return c.json({ error: 'Google Workspace is not enabled' }, 404);
    const cfg = config();
    if (!cfg) return c.json({ error: 'Google OAuth is not configured' }, 503);
    const auth = c.get('auth');
    if (!canMutateOrgWideGovernance(auth) || !auth.user?.id) return c.json({ error: 'Organization administrator access required' }, 403);
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'Organization is required' }, 400);
    const payload = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const expectedDomain = normalizeDomain(payload?.customerDomain);
    if (!expectedDomain) return c.json({ error: 'Enter the Workspace customer domain' }, 400);
    const existingDwd = rows(await db.execute(sql`SELECT org_id FROM google_workspace_connections
      WHERE org_id = ${orgId}::uuid LIMIT 1`));
    if (existingDwd.length) return c.json({ error: 'Disconnect the existing service-account connection before switching credential modes' }, 409);
    const state = opaque(), browser = opaque(), verifier = opaque();
    const encrypted = encryptSecret(verifier, { aad: `${aad}:${orgId}` });
    if (!encrypted?.startsWith('enc:v3:')) return c.json({ error: 'Could not secure Google authorization' }, 503);
    await db.execute(sql`DELETE FROM cloudcommand_google_oauth_attempts WHERE expires_at < now()`);
    await db.execute(sql`INSERT INTO cloudcommand_google_oauth_attempts
      (state_hash, org_id, actor_id, browser_hash, verifier_ciphertext, expected_domain, expires_at)
      VALUES (${digest(state)}, ${orgId}::uuid, ${auth.user.id}::uuid, ${digest(browser)},
        ${encrypted}, ${expectedDomain}, now() + interval '10 minutes')`);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
      response_type: 'code', scope: [...required, ...optional].join(' '), access_type: 'offline',
      prompt: 'consent select_account', state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256' }).toString();
    c.header('Set-Cookie', cookie(browser, 600));
    return c.json({ url: url.toString() });
  });

// Public callback: a short-lived single-use DB attempt, random state, and a
// browser-bound HttpOnly cookie must all agree before any token exchange.
cloudCommandGoogleOAuthRoutes.get('/oauth/callback', async c => {
  c.header('Set-Cookie', cookie('', 0));
  const failure = () => c.redirect('/integrations?google=connect-failed#google');
  if (!GOOGLE_WORKSPACE_ENABLED) return failure();
  const cfg = config();
  const state = c.req.query('state') ?? '', code = c.req.query('code') ?? '';
  const browser = browserCookie(c.req.header('cookie'));
  if (!cfg || !/^[A-Za-z0-9_-]{32,128}$/.test(state) || !/^[A-Za-z0-9_-]{32,128}$/.test(browser)
    || !code || code.length > 4096 || c.req.query('error')) return failure();
  const attempt = await runOutsideDbContext(() => withSystemDbAccessContext(async () =>
    rows<Attempt>(await db.execute(sql`UPDATE cloudcommand_google_oauth_attempts SET status = 'processing'
      WHERE state_hash = ${digest(state)} AND browser_hash = ${digest(browser)} AND status = 'pending'
        AND expires_at > now() RETURNING org_id, actor_id, browser_hash, verifier_ciphertext, expected_domain`))[0] ?? null,
  'cloudcommand-google-oauth-claim'));
  if (!attempt || !safeEqual(attempt.browser_hash, digest(browser))) return failure();
  try {
    const verifier = decryptSecret(attempt.verifier_ciphertext, { aad: `${aad}:${attempt.org_id}` });
    if (!verifier) return failure();
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret,
        code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: cfg.redirectUri }),
      signal: AbortSignal.timeout(20000) });
    if (!tokenResponse.ok) return failure();
    const tokens = await tokenResponse.json() as TokenResponse;
    const scopes = new Set((tokens.scope ?? '').split(/\s+/));
    if (!tokens.access_token || !tokens.refresh_token || !required.every(scope => scopes.has(scope))) return failure();
    const who = await googleJson('https://openidconnect.googleapis.com/v1/userinfo', tokens.access_token);
    const email = who.body.email, domain = who.body.hd;
    if (who.status !== 200 || who.body.email_verified !== true || typeof email !== 'string'
      || normalizeDomain(domain) !== attempt.expected_domain || !email.toLowerCase().endsWith(`@${attempt.expected_domain}`)) return failure();
    const users = await googleJson('https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=1&fields=users(customerId)', tokens.access_token);
    const groups = await googleJson('https://admin.googleapis.com/admin/directory/v1/groups?customer=my_customer&maxResults=1&fields=groups(id)', tokens.access_token);
    const customerId = (users.body.users as Array<{ customerId?: unknown }> | undefined)?.[0]?.customerId;
    if (users.status !== 200 || groups.status !== 200 || typeof customerId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(customerId)) return failure();
    const encrypted = encryptSecret(tokens.refresh_token, { aad: `${refreshAad}:${attempt.org_id}` });
    if (!encrypted?.startsWith('enc:v3:')) return failure();
    const saved = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      // Keep one credential mode per org, including a DWD connection created
      // while the browser was at Google. A unique customer ID prevents binding
      // the same Google customer to two Breeze organizations.
      const dwd = rows(await db.execute(sql`SELECT org_id FROM google_workspace_connections
        WHERE org_id = ${attempt.org_id}::uuid LIMIT 1`));
      if (dwd.length) return false;
      const result = rows(await db.execute(sql`INSERT INTO cloudcommand_google_oauth_connections
        (org_id, customer_id, customer_domain, authorized_email, refresh_token,
          granted_scopes, created_by, verified_at)
        VALUES (${attempt.org_id}::uuid, ${customerId}, ${attempt.expected_domain}, ${email.toLowerCase()},
          ${encrypted}, ${[...scopes].sort().join(' ')}, ${attempt.actor_id}::uuid, now())
        ON CONFLICT (org_id) DO UPDATE SET customer_id = EXCLUDED.customer_id,
          customer_domain = EXCLUDED.customer_domain, authorized_email = EXCLUDED.authorized_email,
          refresh_token = EXCLUDED.refresh_token, granted_scopes = EXCLUDED.granted_scopes,
          status = 'active', verified_at = now(), updated_at = now()
        RETURNING id`));
      await db.execute(sql`DELETE FROM cloudcommand_google_oauth_attempts WHERE state_hash = ${digest(state)}`);
      return result.length === 1;
    }, 'cloudcommand-google-oauth-complete'));
    if (!saved) return failure();
    // This callback has no authenticated request context; the verified attempt
    // records the initiating actor and org for the route audit.
    writeAuditEvent(c, { orgId: attempt.org_id, actorId: attempt.actor_id,
      action: 'google.oauth.connection.upsert',
      resourceType: 'cloudcommand_google_oauth_connection', resourceId: customerId,
      resourceName: attempt.expected_domain, details: { scopes: [...scopes].sort() } });
    return c.redirect('/integrations?google=connected#google');
  } catch {
    return failure();
  }
});
