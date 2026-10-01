import { createHash } from 'node:crypto';
import { acquireClientCredentialsToken, isM365TenantId } from '../c2cM365';

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();
const FRESH_BUFFER_MS = 5 * 60 * 1000;

export function _clearMailboxTokenCache(): void {
  cache.clear();
}

export type MailboxPlatformConfig =
  | { clientId: string; clientSecret: string; credentialVersion?: never }
  | { clientId: string; credentialVersion: string; clientSecret?: never };

export async function getMailboxPlatformConfig(): Promise<MailboxPlatformConfig | null> {
  const clientId = process.env.TICKET_MAILBOX_M365_CLIENT_ID?.trim();
  const clientSecret = process.env.TICKET_MAILBOX_M365_CLIENT_SECRET?.trim();
  // An incomplete explicit override must not silently switch application identity.
  if (clientId || clientSecret) return clientId && clientSecret ? { clientId, clientSecret } : null;
  const { cloudCommandAdminRuntime } = await import('../../extensions/cloudCommandAdminRuntime');
  const config = await cloudCommandAdminRuntime.configuration();
  return config ? { clientId: config.clientId, credentialVersion: config.credentialVersion } : null;
}

export function getMailboxCallbackUri(): string {
  const base = (
    process.env.PUBLIC_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.DASHBOARD_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
  return `${base}/api/v1/tickets/mailbox/callback`;
}

/** App-only Graph token for a partner's tenant. Cached in-memory keyed by tenant. */
export async function getMailboxToken(tenantId: string): Promise<string> {
  if (!isM365TenantId(tenantId)) throw new Error('Invalid M365 tenant id');
  const cfg = await getMailboxPlatformConfig();
  if (!cfg) throw new Error('Microsoft ticket mailbox application not configured');
  if (cfg.credentialVersion !== undefined) {
    const { cloudCommandAdminRuntime } = await import('../../extensions/cloudCommandAdminRuntime');
    return cloudCommandAdminRuntime.acquireToken({ tenantId, clientId: cfg.clientId, credentialVersion: cfg.credentialVersion });
  }
  // Resolve current configuration before consulting the cache; credential rotation
  // or a switch back to Cloud Command must not reuse the previous app's token.
  const cacheKey = `${tenantId}:${cfg.clientId}:${createHash('sha256').update(cfg.clientSecret).digest('hex')}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > FRESH_BUFFER_MS) return cached.token;

  const res = await acquireClientCredentialsToken({
    tenantId: tenantId as Parameters<typeof acquireClientCredentialsToken>[0]['tenantId'],
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  });
  cache.set(cacheKey, { token: res.accessToken, expiresAt: Date.now() + res.expiresIn * 1000 });
  return res.accessToken;
}
