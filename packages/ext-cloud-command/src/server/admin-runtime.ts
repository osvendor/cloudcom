import type { AdministrationConnection } from './admin-execution';
import type { MicrosoftRequest } from './native-microsoft';
import type { ExchangeDescriptorRegistry } from './exchange-services';
import type { ExchangeWorkerPort } from './exchange-contract';

export type AdministrationCredentialPreparation = {
  executionId: string; connectionId: string; tenantId: string; username: string;
  password: string; temporaryPassword: boolean;
};
export type AdministrationCredentialCompletion = {
  executionId: string; connectionId: string; tenantId: string; username: string; providerUserId: string;
};
export type AdministrationCredentialFailure = {
  executionId: string; connectionId: string; tenantId: string; username: string; state: 'rejected' | 'unknown';
};
/** Host-owned vault bridge. Each write must commit in a fresh caller-scoped
 * transaction; the external Microsoft write must never share its transaction. */
export interface AdministrationCredentialCapture<Request> {
  generatePassword(): string;
  prepare(request: Request, input: AdministrationCredentialPreparation): Promise<void>;
  complete(request: Request, input: AdministrationCredentialCompletion): Promise<void>;
  fail?(request: Request, input: AdministrationCredentialFailure): Promise<void>;
}

export interface AdministrationRuntime {
  targetedReadCache?: import('./exchange-read-cache').ExchangeReadCachePort;
  /** Required for user creation. Missing capture fails closed before dispatch. */
  credentialCapture?: AdministrationCredentialCapture<MicrosoftRequest>;
  configuration(): Promise<{ clientId: string; credentialVersion: string; redirectUri: string } | null>;
  acquireToken(connection: Pick<AdministrationConnection, 'tenantId' | 'clientId' | 'credentialVersion'>): Promise<string>;
  verifyAuthorization(input: { tenantId: string; clientId: string; credentialVersion: string; code: string; codeVerifier: string; nonce: string }): Promise<{ tenantId: string; administratorObjectId: string }>;
  authorize(request: MicrosoftRequest, orgId: string, mutation: boolean): Promise<{ actorId: string } | null>;
  audit(event: { orgId: string; actorId: string; action: string; resourceId: string; details?: Record<string, unknown>; result: 'success' | 'failure' }): Promise<void>;
  /** Optional host-only Exchange sidecar bridge. Its absence keeps the single Microsoft
   * Connect flow usable for Graph while reporting Exchange as unavailable. */
  exchange?(): Promise<{ registry: ExchangeDescriptorRegistry; worker: ExchangeWorkerPort } | null>;
}
