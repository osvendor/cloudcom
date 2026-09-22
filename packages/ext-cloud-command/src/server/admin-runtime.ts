import type { AdministrationConnection } from './admin-execution';
import type { MicrosoftRequest } from './native-microsoft';

export interface AdministrationRuntime {
  configuration(): Promise<{ clientId: string; credentialVersion: string; redirectUri: string } | null>;
  acquireToken(connection: Pick<AdministrationConnection, 'tenantId' | 'clientId' | 'credentialVersion'>): Promise<string>;
  verifyAuthorization(input: { tenantId: string; clientId: string; credentialVersion: string; code: string; codeVerifier: string; nonce: string }): Promise<{ tenantId: string; administratorObjectId: string }>;
  authorize(request: MicrosoftRequest, orgId: string, mutation: boolean): Promise<{ actorId: string } | null>;
  audit(event: { orgId: string; actorId: string; action: string; resourceId: string; details?: Record<string, unknown>; result: 'success' | 'failure' }): Promise<void>;
}
