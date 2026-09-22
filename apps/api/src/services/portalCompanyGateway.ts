import { z } from 'zod';
import { CfAccessJwksUnavailableError, verifyCfAccessJwt } from './cfAccessJwt';

// This proves a COMPANY, never an individual identity or permission to skip
// the individual password. Independent from technician Cloudflare SSO.
const configuration = z.object({
  teamDomain: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/),
  audience: z.string().min(1).max(256),
  companies: z.array(z.object({
    subject: z.string().min(1).max(256), orgId: z.string().uuid(), enabled: z.boolean(),
  }).strict()).min(1).max(10000),
}).strict().superRefine((value, ctx) => {
  const subjects = new Set<string>(); const organizations = new Set<string>();
  for (const company of value.companies) {
    if (subjects.has(company.subject) || organizations.has(company.orgId)) {
      ctx.addIssue({ code: 'custom', message: 'Company mappings must be unique' });
    }
    subjects.add(company.subject); organizations.add(company.orgId);
  }
});

export type CompanyGatewayDecision =
  | { ok: true; orgId: string | null }
  | { ok: false; status: 403 | 503 };

/** Rollout configuration, never customer-controlled issuer/JWKS/organization.
 * Re-read per check so disabling a mapping is not hidden by a claim cache.
 * The extension administration adapter must preserve this binding boundary.
 */
export async function verifyPortalCompanyGateway(assertion: string | undefined): Promise<CompanyGatewayDecision> {
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
    if (typeof claims.sub !== 'string' || !claims.sub
      || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now()) {
      return { ok: false, status: 403 };
    }
    const company = config.companies.find(item => item.enabled && item.subject === claims.sub);
    return company ? { ok: true, orgId: company.orgId } : { ok: false, status: 403 };
  } catch (error) {
    return { ok: false, status: error instanceof CfAccessJwksUnavailableError ? 503 : 403 };
  }
}

export async function checkPortalCompanyGateway(assertion: string | undefined, orgId: string): Promise<CompanyGatewayDecision> {
  const decision = await verifyPortalCompanyGateway(assertion);
  if (decision.ok && decision.orgId !== null && decision.orgId !== orgId) return { ok: false, status: 403 };
  return decision;
}
