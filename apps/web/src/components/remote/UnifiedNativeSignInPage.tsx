import { useEffect, useMemo, useState } from 'react';
import LoginPage from '../auth/LoginPage';
import { apiLogin } from '../../stores/auth';
import { bootstrapThenNavigate } from '../../lib/authNavigation';
import { resolveRemoteAccount, staffRemoteSignInUrl } from './remoteAccount';
import { readStaffNativeAuthorizationRequest } from './staffNativeAuthorization';
import { authenticateRemoteAccount } from './unifiedNativeSignIn';

const navigateToSignIn = (url: string) => window.location.assign(url);

export default function UnifiedNativeSignInPage({ navigate = navigateToSignIn }: {
  navigate?: (url: string) => void;
} = {}) {
  const request = useMemo(() => readStaffNativeAuthorizationRequest(window.location.search), []);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const query = request ? new URLSearchParams({ ...request, unified: '1' }).toString() : '';
  const staffPath = `/remote/native?${query}`;
  const customerPath = `/portal/remote/native?${query}`;

  useEffect(() => {
    if (!request) { setChecking(false); return; }
    let cancelled = false;
    void (async () => {
      try {
        const account = await resolveRemoteAccount();
        if (cancelled) return;
        if (account.kind === 'staff') navigate(staffPath);
        else if (account.kind === 'staff-sso') await bootstrapThenNavigate(staffRemoteSignInUrl(staffPath), navigate);
        else if (account.kind === 'customer') navigate(customerPath);
      } catch { if (!cancelled) setError('Sign-in could not be checked. Please reload and try again.'); }
      finally { if (!cancelled) setChecking(false); }
    })();
    return () => { cancelled = true; };
  }, [request, staffPath, customerPath, navigate]);

  if (!request) return <p role="alert">This sign-in request is invalid. Return to Remote Access and try again.</p>;
  if (checking) return <p role="status">Checking your sign-in…</p>;
  if (error) return <p role="alert">{error}</p>;
  return <LoginPage next={staffPath} skipAutomaticStaffSso authenticate={(email, password) => authenticateRemoteAccount(
    email, password, apiLogin, async (customerEmail, customerPassword) => {
      try {
        const response = await fetch('/api/v1/portal/auth/login', {
          method: 'POST', credentials: 'include', redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: customerEmail, password: customerPassword, unifiedNative: true }),
          signal: AbortSignal.timeout(15000),
        });
        if (response.status === 400) return { error: 'Sign in through your company portal first, then return to Remote Access and try again. Company context is required for this account.' };
        if (response.status === 403) return { error: 'Remote access or company authentication is required. Sign in through your company portal first, or contact your administrator.' };
        if (response.status === 429) return { error: 'Too many sign-in attempts. Please wait before trying again.' };
        if (response.status >= 500) return { error: 'Sign-in is temporarily unavailable. Please try again.' };
        if (!response.ok) return false;
        const body = await response.json();
        if (body.user?.accessMode !== 'remote_only') return false;
        navigate(customerPath);
        return true;
      } catch { return false; }
    },
  )} />;
}
