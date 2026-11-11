import { useMemo, useState } from 'react';
import { fetchWithAuth } from '@/stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { handleActionError } from '@/lib/runAction';
import { readStaffNativeAuthorizationRequest, validateStaffNativeAuthorizationResponse,
  type StaffNativeAuthorizationResponse } from './staffNativeAuthorization';

type Props = { navigate?: (url: string) => void };

export default function StaffNativeAuthorizationPage({ navigate = (url) => window.location.assign(url) }: Props = {}) {
  const unified = useMemo(() => new URLSearchParams(window.location.search).getAll('unified').length === 1
    && new URLSearchParams(window.location.search).get('unified') === '1', []);
  const request = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    if (unified) params.delete('unified');
    return readStaffNativeAuthorizationRequest(params.toString());
  }, [unified]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(request ? null : 'This authorization request is invalid or incomplete. Return to Remote Access and try again.');

  async function continueToRemoteAccess() {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runAction<StaffNativeAuthorizationResponse>({
        request: () => fetchWithAuth('/staff-native/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
        errorFallback: 'Unable to continue to Remote Access. Try again.',
        parseSuccess: (data) => {
          if (!data || typeof data !== 'object' || typeof (data as Record<string, unknown>).redirectUri !== 'string') {
            throw new Error('Invalid authorization response');
          }
          return data as StaffNativeAuthorizationResponse;
        },
      });
      const safeRedirect = validateStaffNativeAuthorizationResponse(result, request);
      if (!safeRedirect) {
        setError('Remote Access returned an invalid callback. Close this page and try again.');
        return;
      }
      navigate(unified ? `${safeRedirect}&authority=staff` : safeRedirect);
    } catch (cause) {
      if (cause instanceof ActionError && cause.status === 401) return;
      handleActionError(cause, 'Unable to continue to Remote Access. Try again.');
      setError(cause instanceof Error ? cause.message : 'Unable to continue to Remote Access. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return <main className="mx-auto max-w-lg space-y-5 p-6" data-testid="staff-native-authorization-page">
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Continue to Remote Access</h1>
      <p className="text-sm text-muted-foreground">Your signed-in account determines which computers you can access. Complete any required verification before authorizing this connection.</p>
    </div>
    {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" data-testid="staff-native-authorization-error">{error}</p>}
    <button type="button" disabled={!request || busy} onClick={() => void continueToRemoteAccess()}
      className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
      data-testid="staff-native-continue-button">
      {busy ? 'Continuing…' : 'Continue to Remote Access'}
    </button>
  </main>;
}
