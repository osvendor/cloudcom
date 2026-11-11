import { and, eq } from 'drizzle-orm';
import type { InheritableRemoteAccessSettings } from '@breeze/shared';
import { db } from '../../db';
import { portalNativeTargets } from '../../db/schema/portalNative';

/** Call only after the existing device org/site authorization. Uses request RLS
 * and an explicit composite identity; never writes duplicated custom fields. */
export async function readEnrolledRustDeskId(deviceId: string | undefined, orgId: string,
  settings: InheritableRemoteAccessSettings | undefined): Promise<string | null> {
  if (!deviceId || !settings?.providers?.some(p => p.enabled && /^rustdesk:\/\//i.test(p.urlTemplate))) return null;
  const [target] = await db.select({ rustdeskId: portalNativeTargets.rustdeskId })
    .from(portalNativeTargets).where(and(eq(portalNativeTargets.deviceId, deviceId),
      eq(portalNativeTargets.orgId, orgId), eq(portalNativeTargets.enabled, true))).limit(1);
  return typeof target?.rustdeskId === 'string' && /^\d+$/.test(target.rustdeskId) ? target.rustdeskId : null;
}
