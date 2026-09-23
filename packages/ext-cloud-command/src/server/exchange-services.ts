import { z } from 'zod';
import type { AdministrationConnection } from './admin-execution';
import { createExchangeMailboxInventoryClient, type ExchangeConnectionBinding, type ExchangeWorkerPort, ExchangeWorkerError } from './exchange-contract';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const inventoryInput = z.object({ pageSize: z.number().int().min(1).max(200).optional() }).strict();
const connection = z.object({
  id: uuid, orgId: uuid, tenantId: uuid, clientId: uuid, enabled: z.literal(true), generation: z.number().int().positive(),
  credentialVersion: z.string().min(1).max(128), permissionManifestVersion: z.string().min(1).max(128),
}).strict();
export class ExchangeServiceError extends Error {
  constructor(public readonly code: 'invalid_operation' | 'access_denied' | 'connection_not_ready' | 'connection_changed' | 'audit_unavailable' | 'provider_unreachable' | 'provider_access_denied' | 'provider_rejected' | 'worker_busy') { super(code); }
}
export interface ExchangeDescriptorRegistry {
  /** Host-only. It creates or replaces the local descriptor for this exact connection generation;
   * it never receives certificate data or a browser supplied tenant. */
  provision(binding: ExchangeConnectionBinding): Promise<void>;
  /** Remove every worker descriptor for an organization after its connection is disabled. */
  revoke(organizationId: string): Promise<void>;
}

function bindingOf(value: AdministrationConnection): ExchangeConnectionBinding {
  return { organizationId: value.orgId, tenantId: value.tenantId, clientId: value.clientId,
    credentialVersion: value.credentialVersion, connectionGeneration: value.generation };
}
function sameConnection(left: AdministrationConnection, right: AdministrationConnection | null): boolean {
  const parsed = connection.safeParse(right);
  return parsed.success && Object.keys(connection.shape).every(key => parsed.data[key as keyof AdministrationConnection] === left[key as keyof AdministrationConnection]);
}

/**
 * Organization-bound read-only Exchange attachment. The existing Connect lifecycle owns the
 * connection. Provisioning is deliberately lazy and server-driven: no second tenant screen,
 * certificate, PowerShell or Exchange organization value ever crosses the browser boundary.
 */
export function createExchangeMailboxInventoryService<Request>(ports: {
  authorize(request: Request, organizationId: string): Promise<{ actorId: string } | null>;
  loadConnection(request: Request, organizationId: string): Promise<AdministrationConnection | null>;
  registry: ExchangeDescriptorRegistry;
  worker: ExchangeWorkerPort;
  audit(event: { organizationId: string; actorId: string; action: string; result: 'success' | 'failure'; details: Record<string, unknown> }): Promise<void>;
}) {
  const inventory = createExchangeMailboxInventoryClient(ports.worker);
  async function fence(request: Request, organizationId: string, actorId: string, snapshot: AdministrationConnection) {
    const principal = await ports.authorize(request, organizationId);
    if (!principal || principal.actorId !== actorId) throw new ExchangeServiceError('access_denied');
    if (!sameConnection(snapshot, await ports.loadConnection(request, organizationId))) throw new ExchangeServiceError('connection_changed');
  }
  async function audit(event: Parameters<typeof ports.audit>[0]) {
    try { await ports.audit(event); }
    catch { throw new ExchangeServiceError('audit_unavailable'); }
  }
  return {
    /** Internal Connect lifecycle hook: invoke immediately after the existing store.save()
     * succeeds and the saved row has been reloaded. Never expose this as a browser route. */
    async provision(connectionInput: AdministrationConnection) {
      const parsed = connection.safeParse(connectionInput);
      if (!parsed.success) throw new ExchangeServiceError('connection_not_ready');
      try { await ports.registry.provision(bindingOf(parsed.data)); }
      catch { throw new ExchangeServiceError('provider_unreachable'); }
    },
    async inventory(request: Request, organizationId: string, input: unknown) {
      const parsedInput = inventoryInput.safeParse(input);
      if (!uuid.safeParse(organizationId).success || !parsedInput.success) throw new ExchangeServiceError('invalid_operation');
      organizationId = uuid.parse(organizationId);
      const principal = await ports.authorize(request, organizationId);
      if (!principal || !uuid.safeParse(principal.actorId).success) throw new ExchangeServiceError('access_denied');
      const loaded = connection.safeParse(await ports.loadConnection(request, organizationId));
      if (!loaded.success || loaded.data.orgId !== organizationId) throw new ExchangeServiceError('connection_not_ready');
      const snapshot = loaded.data;
      const details = { connectionId: snapshot.id, generation: snapshot.generation, operation: 'mailbox.inventory' };
      // An intent record comes before descriptor/worker contact. It contains no recipient,
      // certificate, worker path or PowerShell information.
      await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.inventory.intent', result: 'success', details });
      try {
        // This makes a just-restored descriptor safe even if a host restart occurred after
        // Connect completed. It is idempotent for the exact generation.
        await this.provision(snapshot);
        await fence(request, organizationId, principal.actorId, snapshot);
        const result = await inventory(bindingOf(snapshot), parsedInput.data);
        await fence(request, organizationId, principal.actorId, snapshot);
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.inventory.outcome', result: 'success', details });
        return result;
      } catch (error) {
        const code = error instanceof ExchangeServiceError ? error.code
          : error instanceof ExchangeWorkerError ? error.code : 'provider_unreachable';
        // A failed read may be retried, but failure audit itself must never disclose provider data.
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.inventory.outcome', result: 'failure', details: { ...details, code } });
        if (error instanceof ExchangeServiceError) throw error;
        if (error instanceof ExchangeWorkerError &&
          (error.code === 'provider_access_denied' || error.code === 'provider_rejected' || error.code === 'worker_busy'))
          throw new ExchangeServiceError(error.code);
        throw new ExchangeServiceError('provider_unreachable');
      }
    },
    /** Call after the existing connection store atomically disables/replaces an organization.
     * A revoke failure cannot re-enable use: all request paths also fence against enabled/generation. */
    async revoke(organizationId: string) {
      if (!uuid.safeParse(organizationId).success) throw new ExchangeServiceError('invalid_operation');
      try { await ports.registry.revoke(uuid.parse(organizationId)); }
      catch { throw new ExchangeServiceError('provider_unreachable'); }
    },
  };
}
