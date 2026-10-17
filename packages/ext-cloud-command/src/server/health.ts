import { Hono } from 'hono';
import type { ExtensionRequestAuthorization } from '@breeze/extension-sdk';

export type HealthCard = { id: string; title: string; status: 'healthy' | 'attention' | 'critical' | 'unknown'; value: string; detail: string };
export type OperationsHealth = { checkedAt: string; refreshSeconds: number; targetEndpoints: number; enrolled: number | null; cards: HealthCard[] };
export type HealthAuth = { user?: { id?: string; isPlatformAdmin?: boolean }; scope?: string; principal?: { kind?: string }; allowedSiteIds?: unknown };
export type HealthReader = (auth: HealthAuth) => Promise<OperationsHealth | null>;

/** A global view must never inherit an organization's ordinary read permission. */
export function mayReadOperationsHealth(auth: HealthAuth | undefined, permission: ExtensionRequestAuthorization | undefined): boolean {
  return !!auth?.user?.id && auth.user.isPlatformAdmin === true && (auth.scope === 'system' || auth.scope === 'partner')
    && auth.principal?.kind === 'user_session' && auth.allowedSiteIds === undefined
    && !!permission && permission.allowedSiteIds === undefined && permission.hasPermission('organizations', 'read');
}

export function healthRoutes(read?: HealthReader) {
  const app = new Hono<{ Variables: { auth: HealthAuth; extensionAuthorization: ExtensionRequestAuthorization } }>();
  app.get('/health', async c => {
    c.header('Cache-Control', 'no-store');
    if (!mayReadOperationsHealth(c.get('auth'), c.get('extensionAuthorization'))) return c.json({ error: 'Platform administrator access required' }, 403);
    if (!read) return c.json({ error: 'Operations health is not available' }, 503);
    try {
      const snapshot = await read(c.get('auth'));
      return snapshot ? c.json(snapshot) : c.json({ error: 'Operations health access is not assigned' }, 403);
    }
    catch { return c.json({ error: 'Operations health could not be read' }, 503); }
  });
  return app;
}
