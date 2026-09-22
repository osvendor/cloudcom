import React from 'react';
import { cn } from '@/lib/utils';
import { BTN_PRIMARY } from '../portal/ui';

export interface NativeSignInConsentProps {
  accountName: string;
  pending: boolean;
  error: string | null;
  available: boolean;
  onApprove: () => void;
}

/** A small consent surface for handing an approved session to the remote app. */
export function NativeSignInConsent({
  accountName,
  pending,
  error,
  available,
  onApprove
}: NativeSignInConsentProps) {
  const disabled = pending || !available;

  return (
    <section className="space-y-6 rounded-lg border border-border/70 bg-card p-6 sm:p-8" aria-labelledby="native-sign-in-consent-heading">
      <div className="space-y-2">
        <h2
          id="native-sign-in-consent-heading"
          className="font-display text-xl font-semibold tracking-tight text-foreground"
        >
          Sign in to the remote app
        </h2>
        <p className="text-sm text-muted-foreground">
          Continue as <span className="font-medium text-foreground">{accountName}</span>.
        </p>
        <p className="text-sm text-muted-foreground">
          You can connect only to computers approved for your account.
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive-on-tint">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={onApprove}
        disabled={disabled}
        className={cn(BTN_PRIMARY, 'w-full')}
      >
        {pending ? 'Connecting…' : 'Continue to app'}
      </button>
    </section>
  );
}

export default NativeSignInConsent;
