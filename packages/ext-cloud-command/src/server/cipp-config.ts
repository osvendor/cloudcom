import { createHash } from 'node:crypto';
import { z } from 'zod';

const schema = z.object({
  origin: z.string().url(),
  partnerId: z.string().uuid(),
  authTenantId: z.string().uuid(),
  clientId: z.string().uuid(),
  secret: z.string().min(1).max(8192),
  scope: z.string().min(1).max(1024),
});
export type CippDeployment = z.infer<typeof schema> & { identity: string };

/** Deployment-owned service identity. Organization users never supply a backend URL or token scope. */
export function readCippDeployment(env: Record<string, string | undefined>): CippDeployment | null {
  if (env.CLOUDCOM_CIPP_ENABLED !== 'true') return null;
  const value = schema.safeParse({
    origin: env.CLOUDCOM_CIPP_ORIGIN,
    partnerId: env.CLOUDCOM_CIPP_PARTNER_ID,
    authTenantId: env.CLOUDCOM_CIPP_AUTH_TENANT_ID,
    clientId: env.CLOUDCOM_CIPP_CLIENT_ID,
    secret: env.CLOUDCOM_CIPP_CLIENT_SECRET,
    scope: env.CLOUDCOM_CIPP_SCOPE,
  });
  if (!value.success) return null;
  const url = new URL(value.data.origin);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    return null;
  if (!/^api:\/\/[a-zA-Z0-9._/-]+\/\.default$/.test(value.data.scope)) return null;
  const config = { ...value.data, origin: url.origin };
  const identity = createHash('sha256')
    .update(
      JSON.stringify([config.origin, config.partnerId, config.authTenantId, config.clientId, config.scope]),
    )
    .digest('hex');
  return { ...config, identity };
}
