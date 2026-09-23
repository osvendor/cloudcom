import type { ExtensionRequestAuthorization } from '@breeze/extension-sdk';

export type GoogleRequest = {
  auth: unknown;
  authorization: ExtensionRequestAuthorization;
  orgId: string;
};
export type GoogleDirectoryKind = 'users' | 'groups';
export type GoogleDirectoryResult =
  | { ok: true; items: Record<string, string | boolean | null>[]; nextPageToken: string | null }
  | { ok: false; code: 'access_denied' | 'connection_not_ready' | 'provider_failed'; message: string };

/** The core owns the existing org-scoped DWD credential and all Google calls. */
export interface NativeGoogleServices {
  version: 1;
  connection(request: GoogleRequest): Promise<{
    available: boolean; connected: boolean; enabled: boolean; canManage: boolean;
    customerDomain?: string; lastVerifiedAt?: string | null;
  }>;
  directory(request: GoogleRequest, kind: GoogleDirectoryKind, pageToken: string | null): Promise<GoogleDirectoryResult>;
}
