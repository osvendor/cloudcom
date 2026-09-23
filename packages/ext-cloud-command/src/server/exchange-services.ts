import { z } from 'zod';
import type { AdministrationConnection } from './admin-execution';
import { createExchangeAddressesClient, createExchangeAutoReplyClient, createExchangeDelegationClient, createExchangeForwardingClient, createExchangeMailboxInventoryClient, createExchangeTraceClient, type ExchangeTraceSearch, type ExchangeTraceDetail, type ExchangeAddressAction, type ExchangeAddressWrite, type ExchangeAutoReplySet, type ExchangeConnectionBinding, type ExchangeDelegationSet, type ExchangeForwardingSet, type ExchangeWorkerPort, ExchangeWorkerError } from './exchange-contract';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const inventoryInput = z.object({ pageSize: z.number().int().min(1).max(200).optional() }).strict();
const traceStatus = z.enum(['Delivered', 'Expanded', 'Failed', 'FilteredAsSpam', 'GettingStatus', 'Pending', 'Quarantined']);
const traceCursor = z.object({ received: z.string().datetime({ offset: true }), recipient: z.string().email().max(320) }).strict();
const traceSearchInput = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }),
  sender: z.string().email().max(320).nullable(), recipient: z.string().email().max(320).nullable(),
  status: traceStatus.nullable(), cursor: traceCursor.nullable() }).strict();
const traceDetailInput = z.object({ messageTraceId: uuid, recipient: z.string().email().max(320) }).strict();
const connection = z.object({
  id: uuid, orgId: uuid, tenantId: uuid, clientId: uuid, enabled: z.literal(true), generation: z.number().int().positive(),
  credentialVersion: z.string().min(1).max(128), permissionManifestVersion: z.string().min(1).max(128),
}).strict();
export class ExchangeServiceError extends Error {
  constructor(public readonly code: 'invalid_operation' | 'access_denied' | 'connection_not_ready' | 'connection_changed' | 'audit_unavailable' | 'provider_unreachable' | 'provider_access_denied' | 'provider_rejected' | 'worker_busy' | 'unknown_write_outcome') { super(code); }
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
  authorize(request: Request, organizationId: string, mutation?: boolean): Promise<{ actorId: string } | null>;
  loadConnection(request: Request, organizationId: string): Promise<AdministrationConnection | null>;
  registry: ExchangeDescriptorRegistry;
  worker: ExchangeWorkerPort;
  audit(event: { organizationId: string; actorId: string; action: string; result: 'success' | 'failure'; details: Record<string, unknown> }): Promise<void>;
}) {
  const inventory = createExchangeMailboxInventoryClient(ports.worker);
  const forwarding = createExchangeForwardingClient(ports.worker);
  const autoReply = createExchangeAutoReplyClient(ports.worker);
  const addresses = createExchangeAddressesClient(ports.worker);
  const delegation = createExchangeDelegationClient(ports.worker);
  const trace = createExchangeTraceClient(ports.worker);
  async function fence(request: Request, organizationId: string, actorId: string, snapshot: AdministrationConnection, mutation = false) {
    const principal = await ports.authorize(request, organizationId, mutation);
    if (!principal || principal.actorId !== actorId) throw new ExchangeServiceError('access_denied');
    if (!sameConnection(snapshot, await ports.loadConnection(request, organizationId))) throw new ExchangeServiceError('connection_changed');
  }
  async function audit(event: Parameters<typeof ports.audit>[0]) {
    try { await ports.audit(event); }
    catch { throw new ExchangeServiceError('audit_unavailable'); }
  }
  return {
    async traceSearch(request: Request, organizationId: string, input: ExchangeTraceSearch) {
      if (!uuid.safeParse(organizationId).success) throw new ExchangeServiceError('invalid_operation');
      organizationId = uuid.parse(organizationId);
      const parsed = traceSearchInput.safeParse(input);
      if (!parsed.success) throw new ExchangeServiceError('invalid_operation');
      const start = Date.parse(parsed.data.start), end = Date.parse(parsed.data.end), now = Date.now();
      const cursor = parsed.data.cursor;
      if (start >= end || end - start > 10 * 86400000 || start < now - 90 * 86400000 || end > now + 5 * 60000 ||
        (cursor && (Date.parse(cursor.received) < start || Date.parse(cursor.received) > end))) throw new ExchangeServiceError('invalid_operation');
      const principal = await ports.authorize(request, organizationId, false);
      if (!principal || !uuid.safeParse(principal.actorId).success) throw new ExchangeServiceError('access_denied');
      const loaded = connection.safeParse(await ports.loadConnection(request, organizationId));
      if (!loaded.success || loaded.data.orgId !== organizationId) throw new ExchangeServiceError('connection_not_ready');
      const snapshot = loaded.data;
      const details = { connectionId: snapshot.id, generation: snapshot.generation, operation: 'trace.search',
        hasSender: !!parsed.data.sender, hasRecipient: !!parsed.data.recipient, status: parsed.data.status, continuation: !!cursor };
      await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.trace.search.intent', result: 'success', details });
      try {
        await this.provision(snapshot);
        await fence(request, organizationId, principal.actorId, snapshot);
        const result = await trace.search(bindingOf(snapshot), parsed.data);
        await fence(request, organizationId, principal.actorId, snapshot);
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.trace.search.outcome', result: 'success', details: { ...details, count: result.rows.length, partial: result.partial } });
        return result;
      } catch (error) {
        const code = error instanceof ExchangeServiceError || error instanceof ExchangeWorkerError ? error.code : 'provider_unreachable';
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.trace.search.outcome', result: 'failure', details: { ...details, code } });
        throw new ExchangeServiceError(code === 'provider_access_denied' || code === 'provider_rejected' || code === 'worker_busy' || code === 'connection_changed' || code === 'access_denied' ? code : 'provider_unreachable');
      }
    },
    async traceDetail(request: Request, organizationId: string, input: ExchangeTraceDetail) {
      if (!uuid.safeParse(organizationId).success) throw new ExchangeServiceError('invalid_operation');
      organizationId = uuid.parse(organizationId);
      const parsed = traceDetailInput.safeParse(input);
      if (!parsed.success) throw new ExchangeServiceError('invalid_operation');
      const principal = await ports.authorize(request, organizationId, false);
      if (!principal || !uuid.safeParse(principal.actorId).success) throw new ExchangeServiceError('access_denied');
      const loaded = connection.safeParse(await ports.loadConnection(request, organizationId));
      if (!loaded.success || loaded.data.orgId !== organizationId) throw new ExchangeServiceError('connection_not_ready');
      const snapshot = loaded.data;
      const details = { connectionId: snapshot.id, generation: snapshot.generation, operation: 'trace.detail', messageTraceId: parsed.data.messageTraceId };
      await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.trace.detail.intent', result: 'success', details });
      try {
        await this.provision(snapshot);
        await fence(request, organizationId, principal.actorId, snapshot);
        const result = await trace.detail(bindingOf(snapshot), parsed.data);
        await fence(request, organizationId, principal.actorId, snapshot);
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.trace.detail.outcome', result: 'success', details: { ...details, count: result.events.length, partial: result.partial } });
        return result;
      } catch (error) {
        const code = error instanceof ExchangeServiceError || error instanceof ExchangeWorkerError ? error.code : 'provider_unreachable';
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.trace.detail.outcome', result: 'failure', details: { ...details, code } });
        throw new ExchangeServiceError(code === 'provider_access_denied' || code === 'provider_rejected' || code === 'worker_busy' || code === 'connection_changed' || code === 'access_denied' ? code : 'provider_unreachable');
      }
    },
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
    async forwardingGet(request: Request, organizationId: string, mailboxId: string) {
      if (!uuid.safeParse(organizationId).success || !uuid.safeParse(mailboxId).success) throw new ExchangeServiceError('invalid_operation');
      organizationId = uuid.parse(organizationId); mailboxId = uuid.parse(mailboxId);
      const principal = await ports.authorize(request, organizationId, false);
      if (!principal || !uuid.safeParse(principal.actorId).success) throw new ExchangeServiceError('access_denied');
      const loaded = connection.safeParse(await ports.loadConnection(request, organizationId));
      if (!loaded.success || loaded.data.orgId !== organizationId) throw new ExchangeServiceError('connection_not_ready');
      const snapshot = loaded.data;
      const details = { connectionId: snapshot.id, generation: snapshot.generation, operation: 'mailbox.forwarding.get', mailboxId };
      await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.forwarding.get.intent', result: 'success', details });
      try {
        await this.provision(snapshot);
        await fence(request, organizationId, principal.actorId, snapshot);
        const result = await forwarding.get(bindingOf(snapshot), mailboxId);
        await fence(request, organizationId, principal.actorId, snapshot);
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.forwarding.get.outcome', result: 'success', details });
        return result;
      } catch (error) {
        const code = error instanceof ExchangeServiceError || error instanceof ExchangeWorkerError ? error.code : 'provider_unreachable';
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.forwarding.get.outcome', result: 'failure', details: { ...details, code } });
        throw new ExchangeServiceError(code === 'unknown_write_outcome' ? 'provider_unreachable' : code === 'invalid_request' || code === 'connection_mismatch' || code === 'credential_unavailable' || code === 'response_too_large' ? 'provider_unreachable' : code);
      }
    },
    async forwardingSet(request: Request, organizationId: string, input: ExchangeForwardingSet) {
      if (!uuid.safeParse(organizationId).success) throw new ExchangeServiceError('invalid_operation');
      organizationId = uuid.parse(organizationId);
      const parsed = z.object({ mailboxId: uuid, smtpAddress: z.string().email().max(320).nullable(), keepCopy: z.boolean() }).strict().safeParse(input);
      if (!parsed.success) throw new ExchangeServiceError('invalid_operation');
      const principal = await ports.authorize(request, organizationId, true);
      if (!principal || !uuid.safeParse(principal.actorId).success) throw new ExchangeServiceError('access_denied');
      const loaded = connection.safeParse(await ports.loadConnection(request, organizationId));
      if (!loaded.success || loaded.data.orgId !== organizationId) throw new ExchangeServiceError('connection_not_ready');
      const snapshot = loaded.data;
      const details = { connectionId: snapshot.id, generation: snapshot.generation, operation: 'mailbox.forwarding.set', mailboxId: parsed.data.mailboxId,
        changedFields: ['ForwardingSmtpAddress', 'DeliverToMailboxAndForward'] };
      await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.forwarding.set.intent', result: 'success', details });
      let dispatched = false;
      try {
        await this.provision(snapshot);
        await fence(request, organizationId, principal.actorId, snapshot, true);
        dispatched = true;
        const result = await forwarding.set(bindingOf(snapshot), parsed.data);
        await fence(request, organizationId, principal.actorId, snapshot, true);
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.forwarding.set.outcome',
          result: result.verified ? 'success' : 'failure', details: { ...details, outcome: result.verified ? 'verified' : 'readback_pending' } });
        return result;
      } catch (error) {
        const rawCode = error instanceof ExchangeServiceError || error instanceof ExchangeWorkerError ? error.code : 'provider_unreachable';
        const code = dispatched && (rawCode === 'connection_changed' || rawCode === 'access_denied' || rawCode === 'audit_unavailable' || rawCode === 'provider_unreachable')
          ? 'unknown_write_outcome' : rawCode;
        try { await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.forwarding.set.outcome', result: 'failure', details: { ...details, code } }); }
        catch { throw new ExchangeServiceError(dispatched ? 'unknown_write_outcome' : 'audit_unavailable'); }
        throw new ExchangeServiceError(code === 'invalid_request' || code === 'connection_mismatch' || code === 'credential_unavailable' || code === 'response_too_large' ? 'provider_unreachable' : code);
      }
    },
    async autoReplyGet(request: Request, organizationId: string, mailboxId: string) {
      if (!uuid.safeParse(organizationId).success || !uuid.safeParse(mailboxId).success) throw new ExchangeServiceError('invalid_operation');
      organizationId = uuid.parse(organizationId); mailboxId = uuid.parse(mailboxId);
      const principal = await ports.authorize(request, organizationId, false);
      if (!principal || !uuid.safeParse(principal.actorId).success) throw new ExchangeServiceError('access_denied');
      const loaded = connection.safeParse(await ports.loadConnection(request, organizationId));
      if (!loaded.success || loaded.data.orgId !== organizationId) throw new ExchangeServiceError('connection_not_ready');
      const snapshot = loaded.data;
      const details = { connectionId: snapshot.id, generation: snapshot.generation, operation: 'mailbox.autoreply.get', mailboxId };
      await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.autoreply.get.intent', result: 'success', details });
      try {
        await this.provision(snapshot);
        await fence(request, organizationId, principal.actorId, snapshot);
        const result = await autoReply.get(bindingOf(snapshot), mailboxId);
        await fence(request, organizationId, principal.actorId, snapshot);
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.autoreply.get.outcome', result: 'success', details });
        return result;
      } catch (error) {
        const code = error instanceof ExchangeServiceError || error instanceof ExchangeWorkerError ? error.code : 'provider_unreachable';
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.autoreply.get.outcome', result: 'failure', details: { ...details, code } });
        throw new ExchangeServiceError(code === 'invalid_request' || code === 'connection_mismatch' || code === 'credential_unavailable' || code === 'response_too_large' || code === 'unknown_write_outcome' ? 'provider_unreachable' : code);
      }
    },
    async autoReplySet(request: Request, organizationId: string, input: ExchangeAutoReplySet) {
      if (!uuid.safeParse(organizationId).success) throw new ExchangeServiceError('invalid_operation');
      organizationId = uuid.parse(organizationId);
      const parsed = z.object({ mailboxId: uuid, state: z.enum(['Disabled', 'Enabled', 'Scheduled']), message: z.string().max(8192),
        start: z.string().datetime({ offset: true }).nullable(), end: z.string().datetime({ offset: true }).nullable() }).strict().safeParse(input);
      if (!parsed.success || (parsed.data.state === 'Scheduled' ? !parsed.data.start || !parsed.data.end || Date.parse(parsed.data.end) <= Date.parse(parsed.data.start) : parsed.data.start !== null || parsed.data.end !== null))
        throw new ExchangeServiceError('invalid_operation');
      const principal = await ports.authorize(request, organizationId, true);
      if (!principal || !uuid.safeParse(principal.actorId).success) throw new ExchangeServiceError('access_denied');
      const loaded = connection.safeParse(await ports.loadConnection(request, organizationId));
      if (!loaded.success || loaded.data.orgId !== organizationId) throw new ExchangeServiceError('connection_not_ready');
      const snapshot = loaded.data;
      const details = { connectionId: snapshot.id, generation: snapshot.generation, operation: 'mailbox.autoreply.set', mailboxId: parsed.data.mailboxId,
        changedFields: ['AutoReplyState', 'InternalMessage', 'ExternalMessage', 'ExternalAudience', 'StartTime', 'EndTime'] };
      await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.autoreply.set.intent', result: 'success', details });
      let dispatched = false;
      try {
        await this.provision(snapshot);
        await fence(request, organizationId, principal.actorId, snapshot, true);
        dispatched = true;
        const result = await autoReply.set(bindingOf(snapshot), parsed.data);
        await fence(request, organizationId, principal.actorId, snapshot, true);
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.autoreply.set.outcome',
          result: result.verified ? 'success' : 'failure', details: { ...details, outcome: result.verified ? 'verified' : 'readback_pending' } });
        return result;
      } catch (error) {
        const rawCode = error instanceof ExchangeServiceError || error instanceof ExchangeWorkerError ? error.code : 'provider_unreachable';
        const code = dispatched && (rawCode === 'connection_changed' || rawCode === 'access_denied' || rawCode === 'audit_unavailable' || rawCode === 'provider_unreachable')
          ? 'unknown_write_outcome' : rawCode;
        try { await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.autoreply.set.outcome', result: 'failure', details: { ...details, code } }); }
        catch { throw new ExchangeServiceError(dispatched ? 'unknown_write_outcome' : 'audit_unavailable'); }
        throw new ExchangeServiceError(code === 'invalid_request' || code === 'connection_mismatch' || code === 'credential_unavailable' || code === 'response_too_large' ? 'provider_unreachable' : code);
      }
    },
    async addressesGet(request: Request, organizationId: string, mailboxId: string) {
      if (!uuid.safeParse(organizationId).success || !uuid.safeParse(mailboxId).success) throw new ExchangeServiceError('invalid_operation');
      organizationId = uuid.parse(organizationId); mailboxId = uuid.parse(mailboxId);
      const principal = await ports.authorize(request, organizationId, false);
      if (!principal || !uuid.safeParse(principal.actorId).success) throw new ExchangeServiceError('access_denied');
      const loaded = connection.safeParse(await ports.loadConnection(request, organizationId));
      if (!loaded.success || loaded.data.orgId !== organizationId) throw new ExchangeServiceError('connection_not_ready');
      const snapshot = loaded.data;
      const details = { connectionId: snapshot.id, generation: snapshot.generation, operation: 'mailbox.addresses.get', mailboxId };
      await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.addresses.get.intent', result: 'success', details });
      try {
        await this.provision(snapshot);
        await fence(request, organizationId, principal.actorId, snapshot);
        const result = await addresses.get(bindingOf(snapshot), mailboxId);
        await fence(request, organizationId, principal.actorId, snapshot);
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.addresses.get.outcome', result: 'success', details });
        return result;
      } catch (error) {
        const code = error instanceof ExchangeServiceError || error instanceof ExchangeWorkerError ? error.code : 'provider_unreachable';
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.addresses.get.outcome', result: 'failure', details: { ...details, code } });
        throw new ExchangeServiceError(code === 'invalid_request' || code === 'connection_mismatch' || code === 'credential_unavailable' || code === 'response_too_large' || code === 'unknown_write_outcome' ? 'provider_unreachable' : code);
      }
    },
    async addressWrite(request: Request, organizationId: string, action: ExchangeAddressAction, input: ExchangeAddressWrite) {
      if (!uuid.safeParse(organizationId).success || !['mailbox.primary.set', 'mailbox.alias.add', 'mailbox.alias.remove'].includes(action)) throw new ExchangeServiceError('invalid_operation');
      organizationId = uuid.parse(organizationId);
      const parsed = z.object({ mailboxId: uuid, address: z.string().email().max(320) }).strict().safeParse(input);
      if (!parsed.success) throw new ExchangeServiceError('invalid_operation');
      const principal = await ports.authorize(request, organizationId, true);
      if (!principal || !uuid.safeParse(principal.actorId).success) throw new ExchangeServiceError('access_denied');
      const loaded = connection.safeParse(await ports.loadConnection(request, organizationId));
      if (!loaded.success || loaded.data.orgId !== organizationId) throw new ExchangeServiceError('connection_not_ready');
      const snapshot = loaded.data;
      const details = { connectionId: snapshot.id, generation: snapshot.generation, operation: action,
        mailboxId: parsed.data.mailboxId, changedFields: action === 'mailbox.primary.set' ? ['WindowsEmailAddress'] : ['EmailAddresses'] };
      await audit({ organizationId, actorId: principal.actorId, action: `cloudcommand.microsoft.exchange.${action}.intent`, result: 'success', details });
      let dispatched = false;
      try {
        await this.provision(snapshot);
        await fence(request, organizationId, principal.actorId, snapshot, true);
        dispatched = true;
        const result = await addresses.write(bindingOf(snapshot), action, parsed.data);
        await fence(request, organizationId, principal.actorId, snapshot, true);
        await audit({ organizationId, actorId: principal.actorId, action: `cloudcommand.microsoft.exchange.${action}.outcome`,
          result: result.verified ? 'success' : 'failure', details: { ...details, outcome: result.verified ? 'verified' : 'readback_pending' } });
        return result;
      } catch (error) {
        const rawCode = error instanceof ExchangeServiceError || error instanceof ExchangeWorkerError ? error.code : 'provider_unreachable';
        const code = dispatched && (rawCode === 'connection_changed' || rawCode === 'access_denied' || rawCode === 'audit_unavailable' || rawCode === 'provider_unreachable')
          ? 'unknown_write_outcome' : rawCode;
        try { await audit({ organizationId, actorId: principal.actorId, action: `cloudcommand.microsoft.exchange.${action}.outcome`, result: 'failure', details: { ...details, code } }); }
        catch { throw new ExchangeServiceError(dispatched ? 'unknown_write_outcome' : 'audit_unavailable'); }
        throw new ExchangeServiceError(code === 'invalid_request' || code === 'connection_mismatch' || code === 'credential_unavailable' || code === 'response_too_large' ? 'provider_unreachable' : code);
      }
    },
    async delegationGet(request: Request, organizationId: string, mailboxId: string, delegateId: string) {
      if (!uuid.safeParse(organizationId).success || !uuid.safeParse(mailboxId).success || !uuid.safeParse(delegateId).success || mailboxId === delegateId)
        throw new ExchangeServiceError('invalid_operation');
      organizationId = uuid.parse(organizationId); mailboxId = uuid.parse(mailboxId); delegateId = uuid.parse(delegateId);
      const principal = await ports.authorize(request, organizationId, false);
      if (!principal || !uuid.safeParse(principal.actorId).success) throw new ExchangeServiceError('access_denied');
      const loaded = connection.safeParse(await ports.loadConnection(request, organizationId));
      if (!loaded.success || loaded.data.orgId !== organizationId) throw new ExchangeServiceError('connection_not_ready');
      const snapshot = loaded.data;
      const details = { connectionId: snapshot.id, generation: snapshot.generation, operation: 'mailbox.delegation.get', mailboxId, delegateId };
      await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.delegation.get.intent', result: 'success', details });
      try {
        await this.provision(snapshot);
        await fence(request, organizationId, principal.actorId, snapshot);
        const result = await delegation.get(bindingOf(snapshot), mailboxId, delegateId);
        await fence(request, organizationId, principal.actorId, snapshot);
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.delegation.get.outcome', result: 'success', details });
        return result;
      } catch (error) {
        const code = error instanceof ExchangeServiceError || error instanceof ExchangeWorkerError ? error.code : 'provider_unreachable';
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.delegation.get.outcome', result: 'failure', details: { ...details, code } });
        throw new ExchangeServiceError(code === 'invalid_request' || code === 'connection_mismatch' || code === 'credential_unavailable' || code === 'response_too_large' || code === 'unknown_write_outcome' ? 'provider_unreachable' : code);
      }
    },
    async delegationSet(request: Request, organizationId: string, input: ExchangeDelegationSet) {
      if (!uuid.safeParse(organizationId).success) throw new ExchangeServiceError('invalid_operation');
      organizationId = uuid.parse(organizationId);
      const parsed = z.object({ mailboxId: uuid, delegateId: uuid,
        right: z.enum(['FullAccess', 'SendAs', 'SendOnBehalf']), enabled: z.boolean() }).strict().safeParse(input);
      if (!parsed.success || parsed.data.mailboxId === parsed.data.delegateId) throw new ExchangeServiceError('invalid_operation');
      const principal = await ports.authorize(request, organizationId, true);
      if (!principal || !uuid.safeParse(principal.actorId).success) throw new ExchangeServiceError('access_denied');
      const loaded = connection.safeParse(await ports.loadConnection(request, organizationId));
      if (!loaded.success || loaded.data.orgId !== organizationId) throw new ExchangeServiceError('connection_not_ready');
      const snapshot = loaded.data;
      const details = { connectionId: snapshot.id, generation: snapshot.generation, operation: 'mailbox.delegation.set',
        mailboxId: parsed.data.mailboxId, delegateId: parsed.data.delegateId, changedFields: [parsed.data.right] };
      await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.delegation.set.intent', result: 'success', details });
      let dispatched = false;
      try {
        await this.provision(snapshot);
        await fence(request, organizationId, principal.actorId, snapshot, true);
        dispatched = true;
        const result = await delegation.set(bindingOf(snapshot), parsed.data);
        await fence(request, organizationId, principal.actorId, snapshot, true);
        await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.delegation.set.outcome',
          result: result.verified ? 'success' : 'failure', details: { ...details, outcome: result.verified ? 'verified' : 'readback_pending' } });
        return result;
      } catch (error) {
        const rawCode = error instanceof ExchangeServiceError || error instanceof ExchangeWorkerError ? error.code : 'provider_unreachable';
        const code = dispatched && (rawCode === 'connection_changed' || rawCode === 'access_denied' || rawCode === 'audit_unavailable' || rawCode === 'provider_unreachable')
          ? 'unknown_write_outcome' : rawCode;
        try { await audit({ organizationId, actorId: principal.actorId, action: 'cloudcommand.microsoft.exchange.delegation.set.outcome', result: 'failure', details: { ...details, code } }); }
        catch { throw new ExchangeServiceError(dispatched ? 'unknown_write_outcome' : 'audit_unavailable'); }
        throw new ExchangeServiceError(code === 'invalid_request' || code === 'connection_mismatch' || code === 'credential_unavailable' || code === 'response_too_large' ? 'provider_unreachable' : code);
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
