import { z } from 'zod';
import type { GuardedFetch } from './transport';

const ORIGIN = 'https://graph.microsoft.com/v1.0';
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .transform(value => value.toLowerCase());
const removal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('phone'), methodId: uuid }).strict(),
  z.object({ kind: z.literal('microsoftAuthenticator'), methodId: uuid }).strict(),
]);

export type AuthenticationMethodRemoval = z.infer<typeof removal>;
export type AuthenticationMethodErrorCode = 'invalid_input' | 'credential_unavailable' | 'tenant_identity_mismatch'
  | 'provider_access_denied' | 'provider_rate_limited' | 'provider_rejected' | 'provider_unreachable'
  | 'invalid_provider_response' | 'method_not_removable' | 'unknown_write_outcome';
export class AuthenticationMethodError extends Error {
  constructor(public readonly code: AuthenticationMethodErrorCode) { super(code); }
}

function fail<T>(schema: z.ZodType<T>, value: unknown, code: AuthenticationMethodErrorCode): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AuthenticationMethodError(code);
  return parsed.data;
}
function appRoles(token: string): string[] {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    if (!Array.isArray(payload.roles) || !payload.roles.every((role: unknown) => typeof role === 'string')) throw new Error();
    return payload.roles;
  } catch { throw new AuthenticationMethodError('provider_access_denied'); }
}
function requireAppRole(token: string, accepted: readonly string[]) {
  if (!accepted.some(role => appRoles(token).includes(role))) throw new AuthenticationMethodError('provider_access_denied');
}
function shortText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 128 ? value.trim() : undefined;
}
function phoneDetail(item: Record<string, unknown>): string {
  const phoneType = shortText(item.phoneType);
  const number = shortText(item.phoneNumber);
  const suffix = number?.replace(/\D/g, '').slice(-4);
  return `${phoneType ?? 'phone'}${suffix ? ` ending ${suffix}` : ''}`;
}

type SanitizedMethod = {
  id?: string;
  type: 'phone' | 'microsoftAuthenticator' | 'email' | 'fido2' | 'password' | 'softwareOath' | 'temporaryAccessPass' | 'windowsHelloForBusiness' | 'platformCredential' | 'other';
  detail?: string;
  removable: boolean;
};
function sanitizeMethods(value: unknown): SanitizedMethod[] {
  const response = fail(z.object({ value: z.array(z.record(z.string(), z.unknown())).max(50) }).passthrough(), value, 'invalid_provider_response');
  return response.value.map(item => {
    const id = uuid.safeParse(item.id);
    switch (item['@odata.type']) {
      case '#microsoft.graph.phoneAuthenticationMethod':
        return { ...(id.success ? { id: id.data } : {}), type: 'phone' as const, detail: phoneDetail(item), removable: id.success };
      case '#microsoft.graph.microsoftAuthenticatorAuthenticationMethod':
        return { ...(id.success ? { id: id.data } : {}), type: 'microsoftAuthenticator' as const,
          ...(shortText(item.displayName) ? { detail: shortText(item.displayName) } : {}), removable: id.success };
      case '#microsoft.graph.emailAuthenticationMethod': return { type: 'email' as const, removable: false };
      case '#microsoft.graph.fido2AuthenticationMethod': return { type: 'fido2' as const, removable: false };
      case '#microsoft.graph.passwordAuthenticationMethod': return { type: 'password' as const, removable: false };
      case '#microsoft.graph.softwareOathAuthenticationMethod': return { type: 'softwareOath' as const, removable: false };
      case '#microsoft.graph.temporaryAccessPassAuthenticationMethod': return { type: 'temporaryAccessPass' as const, removable: false };
      case '#microsoft.graph.windowsHelloForBusinessAuthenticationMethod': return { type: 'windowsHelloForBusiness' as const, removable: false };
      case '#microsoft.graph.platformCredentialAuthenticationMethod': return { type: 'platformCredential' as const, removable: false };
      default: return { type: 'other' as const, removable: false };
    }
  });
}

/**
 * Tenant-bound provider for the Graph authentication-methods API. The caller
 * owns actor authorization, connection fencing, and audit; this provider only
 * accepts fixed user IDs and removal kinds, verifies the token's tenant and
 * app role, and never sends a caller-controlled path or request body.
 */
export function createAuthenticationMethodsProvider(options: {
  tenantId: string;
  fetch: GuardedFetch;
  acquireToken: (tenantId: string) => Promise<string>;
}) {
  const tenantId = fail(uuid, options.tenantId, 'invalid_input');
  async function request(token: string, path: string, method = 'GET') {
    const mutation = method !== 'GET';
    try {
      const result = await options.fetch(`${ORIGIN}${path}`, {
        method, headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
        signal: AbortSignal.timeout(15000), timeoutMs: 15000, maxBytes: 1024 * 1024,
      });
      if (result.status === 401 || result.status === 403) throw new AuthenticationMethodError('provider_access_denied');
      if (result.status === 429) throw new AuthenticationMethodError('provider_rate_limited');
      if (result.status >= 500 && mutation) throw new AuthenticationMethodError('unknown_write_outcome');
      if (!result.ok || result.status >= 300) throw new AuthenticationMethodError('provider_rejected');
      return mutation ? undefined : await result.json() as unknown;
    } catch (error) {
      if (error instanceof AuthenticationMethodError) throw error;
      throw new AuthenticationMethodError(mutation ? 'unknown_write_outcome' : 'provider_unreachable');
    }
  }
  async function session(forWrite: boolean) {
    let token: string;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      token = await Promise.race([
        options.acquireToken(tenantId),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 15000); }),
      ]);
      if (typeof token !== 'string' || !token || token.length > 32768 || /[\r\n]/.test(token)) throw new Error();
    } catch { throw new AuthenticationMethodError('credential_unavailable'); }
    finally { clearTimeout(timer); }
    requireAppRole(token, forWrite
      ? ['UserAuthenticationMethod.ReadWrite.All']
      : ['UserAuthenticationMethod.Read.All', 'UserAuthenticationMethod.ReadWrite.All']);
    const organization = fail(z.object({ value: z.array(z.object({ id: uuid })).length(1) }),
      await request(token, '/organization?$select=id'), 'tenant_identity_mismatch');
    if (organization.value[0]!.id !== tenantId) throw new AuthenticationMethodError('tenant_identity_mismatch');
    return token;
  }
  async function listWithToken(token: string, userId: string) {
    return sanitizeMethods(await request(token, `/users/${userId}/authentication/methods`));
  }
  return {
    async list(userId: string) {
      userId = fail(uuid, userId, 'invalid_input');
      return { items: await listWithToken(await session(false), userId) };
    },
    async remove(userId: string, input: AuthenticationMethodRemoval, guard?: () => Promise<void>) {
      userId = fail(uuid, userId, 'invalid_input');
      const target = fail(removal, input, 'invalid_input');
      const token = await session(true);
      await guard?.();
      const methods = await listWithToken(token, userId);
      if (!methods.some(method => method.id === target.methodId && method.type === target.kind && method.removable))
        throw new AuthenticationMethodError('method_not_removable');
      await guard?.();
      const collection = target.kind === 'phone' ? 'phoneMethods' : 'microsoftAuthenticatorMethods';
      await request(token, `/users/${userId}/authentication/${collection}/${target.methodId}`, 'DELETE');
      return { accepted: true as const };
    },
  };
}
