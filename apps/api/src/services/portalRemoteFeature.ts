import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { installedExtensions } from '../db/schema';

/** Durable disable is checked by portal ingress AND every agent lease renew. */
export async function isPortalRemoteFeatureEnabled(): Promise<boolean> {
  if (process.env.CLOUDCOM_REMOTE_ACCESS_ENABLED !== 'true') return false;
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [extension] = await db.select({ enabled: installedExtensions.enabled, state: installedExtensions.lifecycleState })
      .from(installedExtensions).where(eq(installedExtensions.name, 'rustdeskaccess')).limit(1);
    return extension?.enabled === true && extension.state === 'active';
  }, 'portalRemoteFeature'));
}
