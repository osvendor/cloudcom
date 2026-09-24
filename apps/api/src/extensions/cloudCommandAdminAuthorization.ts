import { and, eq, isNull, inArray } from 'drizzle-orm';
import type { MicrosoftRequest } from '@cloudcom/ext-cloud-command';
import { db } from '../db';
import { organizations, users } from '../db/schema';
import { hasSatisfiedMfa, withAuthDbAccessContext, type AuthContext } from '../middleware/auth';
import { getUserPermissions, hasPermission } from '../services/permissions';

/** Interactive administration only. AI/API-key automation must use its own approval pipeline. */
export async function authorizeCloudCommandAdministration(request: MicrosoftRequest, orgId: string, mutation: boolean) {
  const auth = request.auth as AuthContext | undefined;
  if (!auth?.user?.id || auth.principal?.kind !== 'user_session' || typeof auth.canAccessOrg !== 'function'
    || request.orgId !== orgId || !auth.canAccessOrg(orgId) || auth.allowedSiteIds !== undefined
    || request.authorization.allowedSiteIds !== undefined || (mutation && !hasSatisfiedMfa(auth))) return null;
  return withAuthDbAccessContext(auth, async () => {
    const [user] = await db.select({ status: users.status, isPlatformAdmin: users.isPlatformAdmin }).from(users).where(eq(users.id, auth.user.id)).limit(1);
    const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(and(
      eq(organizations.id, orgId), isNull(organizations.deletedAt), inArray(organizations.status, ['active', 'trial']),
    )).limit(1);
    if (!user || user.status !== 'active' || !org || (auth.partnerId && auth.partnerId !== org.partnerId)
      || (auth.scope === 'organization' && auth.orgId !== orgId) || (auth.scope === 'system' && !user.isPlatformAdmin)) return null;
    const permissions = await getUserPermissions(auth.user.id, { scope: auth.scope,
      partnerId: auth.partnerId ?? undefined, orgId: auth.orgId ?? undefined }, { bypassCache: true });
    if (!permissions || permissions.allowedSiteIds !== undefined
      || !hasPermission(permissions, 'organizations', mutation ? 'write' : 'read')) return null;
    if (permissions.scope === 'organization' && permissions.orgId !== orgId) return null;
    if (permissions.scope === 'partner' && permissions.orgAccess !== 'all'
      && !(permissions.orgAccess === 'selected' && permissions.allowedOrgIds?.includes(orgId))) return null;
    return { actorId: auth.user.id };
  });
}
