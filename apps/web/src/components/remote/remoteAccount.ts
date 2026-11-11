import { bootstrapFromCfAccessRedirect, restoreAccessTokenFromCookieDetailed, useAuthStore } from '../../stores/auth';

export type RemoteCustomer = { id: string; email: string; accessMode: string;
  orgId: string; organizationId?: string; orgName?: string; organizationName?: string };
export type RemoteAccount = { kind: 'staff' } | { kind: 'staff-sso' } | { kind: 'sign-in' }
  | { kind: 'customer'; user: RemoteCustomer };

/** Shared browser/native account selection. A matching portal email never
 * establishes staff authority. Staff SSO selection requires a verified Access
 * assertion and still goes through the normal full login/permission checks. */
export async function resolveRemoteAccount(): Promise<RemoteAccount> {
  const restored = useAuthStore.getState().tokens?.accessToken
    ? 'restored' : await restoreAccessTokenFromCookieDetailed();
  if (restored === 'restored') {
    if (!useAuthStore.getState().isAuthenticated && !await bootstrapFromCfAccessRedirect()) {
      throw new Error('Your staff sign-in could not be verified. Please retry.');
    }
    return { kind: 'staff' };
  }
  if (restored !== 'auth-failed') throw new Error('Sign-in is temporarily unavailable. Please retry.');
  const identity = await fetch('/api/v1/auth/cf-access-login?remoteIdentity=1', {
    credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!identity.ok) throw new Error('Your company sign-in could not be verified. Please retry.');
  const discovery = await identity.json();
  if (discovery.kind === 'staff') return { kind: 'staff-sso' };
  if (!['customer', 'none'].includes(discovery.kind)) throw new Error('Invalid sign-in response.');
  const profile = await fetch('/api/v1/portal/profile', {
    credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (profile.ok) {
    const body = await profile.json();
    if (body.user?.accessMode === 'remote_only') return { kind: 'customer', user: body.user };
    return { kind: 'sign-in' };
  }
  if (![401, 403].includes(profile.status)) throw new Error('Your customer sign-in could not be checked. Please retry.');
  return { kind: 'sign-in' };
}

export const staffRemoteSignInUrl = (next: string) => `/api/v1/auth/cf-access-login?next=${encodeURIComponent(next)}`;
