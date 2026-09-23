import { z } from 'zod';
import { CfAccessJwksUnavailableError, verifyCfAccessJwt } from './cfAccessJwt';

// This proves a COMPANY, never an individual identity or permission to skip
// the individual password. Independent from technician Cloudflare SSO.
const commonConfiguration = {
  teamDomain: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/),
  audience: z.string().min(1).max(256),
};
const configuration = z.union([
  z.object({
    ...commonConfiguration,
    mode: z.literal('subject').optional(),
    companies: z.array(z.object({
      subject: z.string().trim().min(1).max(256), orgId: z.string().uuid(), enabled: z.boolean(),
    }).strict()).min(1).max(10000),
  }).strict(),
  z.object({
    ...commonConfiguration,
    mode: z.literal('custom-claims'),
    organizations: z.array(z.object({
      orgId: z.string().uuid(), enabled: z.boolean(),
    }).strict()).min(1).max(10000),
  }).strict(),
]).superRefine((value, ctx) => {
  const organizations = new Set<string>();
  const subjects = new Set<string>();
  const entries = value.mode === 'custom-claims' ? value.organizations : value.companies;
  for (const entry of entries) {
    if (organizations.has(entry.orgId)
      || ('subject' in entry && typeof entry.subject === 'string' && subjects.has(entry.subject))) {
      ctx.addIssue({ code: 'custom', message: 'Company mappings must be unique' });
    }
    organizations.add(entry.orgId);
    if ('subject' in entry && typeof entry.subject === 'string') subjects.add(entry.subject);
  }
});

// Only this explicit shape is supported. Cloudflare documents the signed `custom`
// claim and best-effort trimming, but not the OIDC inner shape. Verify a live
// application token before enabling this mode; never guess alternate wrappers.
// Access must require the intended company IdP for this application audience.
const companyClaims = z.object({
  cloudcom_org_id: z.string().uuid(),
  cloudcom_account_kind: z.literal('company_gateway'),
}).strict();

export type CompanyGatewayDecision =
  | { ok: true; orgId: string | null; expiresAt?: number }
  | { ok: false; status: 403 | 503 };

/** Rollout configuration, never customer-controlled issuer/JWKS/organization.
 * Re-read per check so disabling a mapping is not hidden by a claim cache.
 * The extension administration adapter must preserve this binding boundary.
 */
export async function verifyPortalCompanyGateway(assertion: string | undefined, includeExpiry = false): Promise<CompanyGatewayDecision> {
  const enabled = process.env.CLOUDCOM_COMPANY_GATEWAY_ENABLED;
  if (enabled === undefined || enabled === 'false') return { ok: true, orgId: null };
  if (enabled !== 'true') return { ok: false, status: 503 };
  let config: z.infer<typeof configuration>;
  try {
    const raw = process.env.CLOUDCOM_COMPANY_GATEWAY_CONFIG ?? '';
    if (raw.length > 2_000_000) return { ok: false, status: 503 };
    config = configuration.parse(JSON.parse(raw));
  } catch { return { ok: false, status: 503 }; }
  if (!assertion || assertion.length > 16384) return { ok: false, status: 403 };
  try {
    const claims = await verifyCfAccessJwt(assertion, config);
    if (typeof claims.sub !== 'string' || !claims.sub.trim() || claims.type !== 'app'
      || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now()) {
      return { ok: false, status: 403 };
    }
    if (config.mode === 'custom-claims') {
      const custom = companyClaims.safeParse(claims.custom);
      if (!custom.success) return { ok: false, status: 403 };
      const company = config.organizations.find(item => item.enabled && item.orgId === custom.data.cloudcom_org_id);
      return company ? { ok: true, orgId: company.orgId, ...(includeExpiry ? { expiresAt: claims.exp * 1000 } : {}) } : { ok: false, status: 403 };
    }
    const company = config.companies.find(item => item.enabled && item.subject === claims.sub);
    return company ? { ok: true, orgId: company.orgId, ...(includeExpiry ? { expiresAt: claims.exp * 1000 } : {}) } : { ok: false, status: 403 };
  } catch (error) {
    return { ok: false, status: error instanceof CfAccessJwksUnavailableError ? 503 : 403 };
  }
}

export async function checkPortalCompanyGateway(assertion: string | undefined, orgId: string): Promise<CompanyGatewayDecision> {
  const decision = await verifyPortalCompanyGateway(assertion);
  if (decision.ok && decision.orgId !== null && decision.orgId !== orgId) return { ok: false, status: 403 };
  return decision;
}
