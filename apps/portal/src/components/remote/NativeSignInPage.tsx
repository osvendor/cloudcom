import { useRef, useState } from 'react';
import { apiPost } from '../../lib/api';
import { nativeCallbackUrl, type NativeLoginRequest } from '../../lib/nativeLogin';
import NativeSignInConsent from './NativeSignInConsent';

export default function NativeSignInPage({ accountName, request }: {
  accountName: string; request: NativeLoginRequest | null;
}) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(request ? null : 'This sign-in link is invalid. Start sign-in again from the remote app.');
  const approve = async () => {
    if (!request || inFlight.current) return;
    inFlight.current = true; setPending(true); setError(null);
    try {
      const result = await apiPost<{ redirectUri: string }>('/portal/remote/native/authorize', request);
      const callback = nativeCallbackUrl(result.data?.redirectUri, request);
      if (!callback) throw new Error(result.error ?? 'A secure sign-in response was not provided. Try again from the app.');
      window.location.assign(callback);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in is unavailable. Try again from the app.');
    } finally { inFlight.current = false; setPending(false); }
  };
  return <NativeSignInConsent accountName={accountName} pending={pending} error={error}
    available={request !== null} onApprove={approve} />;
}
