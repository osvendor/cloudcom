import type { AdministrationConnection } from './admin-execution';
import type { MicrosoftRequest } from './native-microsoft';
import type { ExchangeDescriptorRegistry } from './exchange-services';
import type { ExchangeWorkerPort } from './exchange-contract';

export interface AdministrationRuntime {
  configuration(): Promise<{ clientId: string; credentialVersion: string; redirectUri: string } | null>;
  acquireToken(connection: Pick<AdministrationConnection, 'tenantId' | 'clientId' | 'credentialVersion'>): Promise<string>;
  verifyAuthorization(input: { tenantId: string; clientId: string; credentialVersion: string; code: string; codeVerifier: string; nonce: string }): Promise<{ tenantId: string; administratorObjectId: string }>;
  authorize(request: MicrosoftRequest, orgId: string, mutation: boolean): Promise<{ actorId: string } | null>;
  audit(event: { orgId: string; actorId: string; action: string; resourceId: string; details?: Record<string, unknown>; result: 'success' | 'failure' }): Promise<void>;
  /** Optional host-only Exchange sidecar bridge. Its absence keeps the single Microsoft
   * Connect flow usable for Graph while reporting Exchange as unavailable. */
  exchange?(): Promise<{ registry: ExchangeDescriptorRegistry; worker: ExchangeWorkerPort } | null>;
}
