import type { ExtensionRequestAuthorization } from '@breeze/extension-sdk';

export type GoogleRequest = {
  auth: unknown;
  authorization: ExtensionRequestAuthorization;
  orgId: string;
};
export type GoogleDirectoryKind = 'users' | 'groups' | 'archived';
export type GoogleDirectoryResult =
  | { ok: true; items: Record<string, string | boolean | null>[]; nextPageToken: string | null }
  | { ok: false; code: 'access_denied' | 'connection_not_ready' | 'provider_failed'; message: string };
export type GoogleMembersResult = GoogleDirectoryResult;
export type GoogleMailboxSettingsResult =
  | { ok: true; email: string; forwardingEnabled: boolean | null; forwardingAddress: string | null; forwardingDisposition: string | null;
      vacationEnabled: boolean | null; vacationSubject: string | null; vacationStartMs: string | null; vacationEndMs: string | null }
  | { ok: false; code: 'access_denied' | 'connection_not_ready' | 'provider_failed' | 'state_changed'; message: string };
export type GoogleStorageItem = { email: string; gmailMb: number | null; driveMb: number | null; totalMb: number | null };
export type GoogleStorageResult =
  | { ok: true; date: string; items: GoogleStorageItem[]; nextPageToken: string | null; partial: boolean; warning: string | null }
  | { ok: false; code: 'access_denied' | 'connection_not_ready' | 'scope_required' | 'provider_failed'; message: string };
export type GoogleSuspendInput = { userId: string; email: string; expectedSuspended: boolean; suspended: boolean; confirmation: string };
export type GoogleSuspendResult = { ok: true; userId: string; suspended: boolean }
  | { ok: false; code: 'access_denied' | 'connection_not_ready' | 'invalid_operation' | 'state_changed' | 'protected_account' | 'provider_failed' | 'unknown_write_outcome'; message: string };
export type GoogleProfileInput = { userId: string; email: string; expectedGivenName: string; expectedFamilyName: string; givenName: string; familyName: string };
export type GoogleProfileResult = { ok: true; userId: string; givenName: string; familyName: string }
  | { ok: false; code: 'access_denied' | 'connection_not_ready' | 'invalid_operation' | 'state_changed' | 'protected_account' | 'provider_failed' | 'unknown_write_outcome'; message: string };

/** The core owns the existing org-scoped DWD credential and all Google calls. */
export interface NativeGoogleServices {
  version: 1;
  connection(request: GoogleRequest): Promise<{
    available: boolean; connected: boolean; enabled: boolean; canManage: boolean;
    customerDomain?: string; lastVerifiedAt?: string | null;
  }>;
  directory(request: GoogleRequest, kind: GoogleDirectoryKind, pageToken: string | null): Promise<GoogleDirectoryResult>;
  members(request: GoogleRequest, groupId: string, pageToken: string | null): Promise<GoogleMembersResult>;
  mailboxSettings(request: GoogleRequest, userId: string): Promise<GoogleMailboxSettingsResult>;
  storage(request: GoogleRequest, date: string, pageToken: string | null): Promise<GoogleStorageResult>;
  auditSuspension(request: GoogleRequest, userId: string, stage: 'intent' | 'success' | 'failure'): Promise<void>;
  setSuspended(request: GoogleRequest, input: GoogleSuspendInput): Promise<GoogleSuspendResult>;
  auditProfile(request: GoogleRequest, userId: string, stage: 'intent' | 'success' | 'failure'): Promise<void>;
  updateProfile(request: GoogleRequest, input: GoogleProfileInput): Promise<GoogleProfileResult>;
}
