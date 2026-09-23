import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const credentialVersion = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const inventoryParameters = z.object({ pageSize: z.number().int().min(1).max(200).default(100) }).strict();
const forwardingAddress = z.string().email().max(320).nullable();
const forwardingGetParameters = z.object({ mailboxId: uuid }).strict();
const forwardingSetParameters = z.object({ mailboxId: uuid, smtpAddress: forwardingAddress, keepCopy: z.boolean() }).strict();
const autoReplyState = z.enum(['Disabled', 'Enabled', 'Scheduled']);
const autoReplyGetParameters = z.object({ mailboxId: uuid }).strict();
const autoReplySetParameters = z.object({ mailboxId: uuid, state: autoReplyState,
  message: z.string().max(8192), start: z.string().datetime({ offset: true }).nullable(), end: z.string().datetime({ offset: true }).nullable() }).strict()
  .superRefine((value, issue) => {
    if (value.state === 'Scheduled' && (!value.start || !value.end || Date.parse(value.end) <= Date.parse(value.start)))
      issue.addIssue({ code: 'custom', message: 'A scheduled reply needs an end after its start.' });
    if (value.state !== 'Scheduled' && (value.start !== null || value.end !== null))
      issue.addIssue({ code: 'custom', message: 'Only scheduled replies may include dates.' });
  });
const bindingSchema = z.object({
  organizationId: uuid,
  tenantId: uuid,
  clientId: uuid,
  credentialVersion,
  connectionGeneration: z.number().int().positive(),
}).strict();
const inventoryRequest = z.object({
  requestId: uuid,
  ...bindingSchema.shape,
  operation: z.literal('mailbox.inventory'),
  parameters: inventoryParameters,
}).strict();
const forwardingGetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.forwarding.get'), parameters: forwardingGetParameters }).strict();
const forwardingSetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.forwarding.set'), parameters: forwardingSetParameters }).strict();
const autoReplyGetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.autoreply.get'), parameters: autoReplyGetParameters }).strict();
const autoReplySetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.autoreply.set'), parameters: autoReplySetParameters }).strict();
const request = z.discriminatedUnion('operation', [inventoryRequest, forwardingGetRequest, forwardingSetRequest, autoReplyGetRequest, autoReplySetRequest]);

const mailbox = z.object({
  id: uuid,
  primarySmtpAddress: z.string().email().max(320),
  recipientType: z.enum(['UserMailbox', 'SharedMailbox']),
  archiveEnabled: z.boolean(),
  mailboxBytes: z.number().int().nonnegative().nullable(),
  archiveBytes: z.number().int().nonnegative().nullable(),
  collectedAt: z.string().datetime({ offset: true }),
  // A single row may fail statistics collection while the inventory remains useful.
  statisticsUnavailable: z.boolean(),
});
const response = z.object({
  requestId: uuid,
  ok: z.literal(true),
  data: z.object({ records: z.array(mailbox).max(200), partial: z.boolean(), collectedAt: z.string().datetime({ offset: true }) }).strict(),
}).strict();
const failure = z.object({ requestId: uuid, ok: z.literal(false), code: z.enum([
  'access_denied', 'connection_mismatch', 'credential_unavailable', 'invalid_request',
  'provider_access_denied', 'provider_rejected', 'provider_unreachable', 'response_too_large', 'worker_busy', 'unknown_write_outcome',
]) }).strict();
const forwardingState = z.object({ mailboxId: uuid, smtpAddress: forwardingAddress, keepCopy: z.boolean(),
  internalRecipient: z.string().max(320).nullable() }).strict();
const forwardingGetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: forwardingState }).strict();
const forwardingSetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: forwardingState.extend({ accepted: z.literal(true), verified: z.boolean() }) }).strict();
const autoReplyStateSchema = z.object({ mailboxId: uuid, state: autoReplyState,
  internalMessage: z.string().max(16384), externalMessage: z.string().max(16384),
  externalAudience: z.enum(['None', 'Known', 'All']), start: z.string().datetime({ offset: true }).nullable(), end: z.string().datetime({ offset: true }).nullable() }).strict();
const autoReplyGetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: autoReplyStateSchema }).strict();
const autoReplySetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: autoReplyStateSchema.extend({ accepted: z.literal(true), verified: z.boolean() }) }).strict();

export type ExchangeConnectionBinding = z.infer<typeof bindingSchema>;
export type ExchangeMailboxInventory = z.infer<typeof mailbox>;
export type ExchangeWorkerRequest = z.infer<typeof request>;
export type ExchangeWorkerResponse = z.infer<typeof response>;
export type ExchangeWorkerFailure = z.infer<typeof failure>;
export type ExchangeForwardingState = z.infer<typeof forwardingState>;
export type ExchangeForwardingSet = z.infer<typeof forwardingSetParameters>;
export type ExchangeAutoReplySet = z.infer<typeof autoReplySetParameters>;

/** A host-only port for the Unix-socket sidecar. Do not implement this with HTTP or expose it to browsers. */
export interface ExchangeWorkerPort {
  dispatch(request: ExchangeWorkerRequest): Promise<unknown>;
}

export class ExchangeWorkerError extends Error {
  constructor(public readonly code: z.infer<typeof failure>['code']) { super(code); }
}
async function forwardingDispatch<T>(port: ExchangeWorkerPort, outbound: ExchangeWorkerRequest, schema: z.ZodType<{ requestId: string; ok: true; data: T }>): Promise<T> {
  let received: unknown;
  try { received = await port.dispatch(outbound); }
  catch { throw new ExchangeWorkerError(outbound.operation.endsWith('.set') ? 'unknown_write_outcome' : 'provider_unreachable'); }
  const rejected = failure.safeParse(received);
  if (rejected.success) {
    if (rejected.data.requestId !== outbound.requestId) throw new ExchangeWorkerError(outbound.operation.endsWith('.set') ? 'unknown_write_outcome' : 'provider_unreachable');
    throw new ExchangeWorkerError(rejected.data.code);
  }
  const parsed = schema.safeParse(received);
  if (!parsed.success || parsed.data.requestId !== outbound.requestId)
    throw new ExchangeWorkerError(outbound.operation.endsWith('.set') ? 'unknown_write_outcome' : 'provider_unreachable');
  return parsed.data.data;
}
/** One reply for internal and external recipients, as retained Cloud Command exposed. */
export function createExchangeAutoReplyClient(port: ExchangeWorkerPort) {
  return {
    async get(binding: ExchangeConnectionBinding, mailboxId: string) {
      const outbound = autoReplyGetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
        operation: 'mailbox.autoreply.get', parameters: autoReplyGetParameters.parse({ mailboxId }) });
      const data = await forwardingDispatch(port, outbound, autoReplyGetResponse);
      if (data.mailboxId !== outbound.parameters.mailboxId) throw new ExchangeWorkerError('provider_unreachable');
      return data;
    },
    async set(binding: ExchangeConnectionBinding, input: ExchangeAutoReplySet) {
      const outbound = autoReplySetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
        operation: 'mailbox.autoreply.set', parameters: autoReplySetParameters.parse(input) });
      const data = await forwardingDispatch(port, outbound, autoReplySetResponse);
      if (data.mailboxId !== outbound.parameters.mailboxId) throw new ExchangeWorkerError('unknown_write_outcome');
      return data;
    },
  };
}
/** Fixed mailbox forwarding operations; no PowerShell or identity string is accepted from a browser. */
export function createExchangeForwardingClient(port: ExchangeWorkerPort) {
  return {
    async get(binding: ExchangeConnectionBinding, mailboxId: string) {
      const outbound = forwardingGetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
        operation: 'mailbox.forwarding.get', parameters: forwardingGetParameters.parse({ mailboxId }) });
      const data = await forwardingDispatch(port, outbound, forwardingGetResponse);
      if (data.mailboxId !== outbound.parameters.mailboxId) throw new ExchangeWorkerError('provider_unreachable');
      return data;
    },
    async set(binding: ExchangeConnectionBinding, input: ExchangeForwardingSet) {
      const outbound = forwardingSetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
        operation: 'mailbox.forwarding.set', parameters: forwardingSetParameters.parse(input) });
      const data = await forwardingDispatch(port, outbound, forwardingSetResponse);
      if (data.mailboxId !== outbound.parameters.mailboxId) throw new ExchangeWorkerError('unknown_write_outcome');
      return data;
    },
  };
}

/**
 * Builds the only currently supported Exchange request. The caller must obtain the binding
 * from the organization-scoped administration connection after authorization and fence it
 * before dispatch and return. It intentionally has no cmdlet, certificate, path, or tenant
 * parameter supplied by a browser.
 */
export function createExchangeMailboxInventoryClient(port: ExchangeWorkerPort) {
  return async (binding: ExchangeConnectionBinding, input: { pageSize?: number } = {}) => {
    const bound = bindingSchema.parse(binding);
    const parameters = inventoryParameters.parse(input);
    const outbound = inventoryRequest.parse({ ...bound, requestId: randomUUID(), operation: 'mailbox.inventory', parameters });
    let received: unknown;
    try { received = await port.dispatch(outbound); }
    catch { throw new ExchangeWorkerError('provider_unreachable'); }
    const rejected = failure.safeParse(received);
    if (rejected.success) {
      if (rejected.data.requestId !== outbound.requestId) throw new ExchangeWorkerError('provider_unreachable');
      throw new ExchangeWorkerError(rejected.data.code);
    }
    const parsed = response.safeParse(received);
    if (!parsed.success || parsed.data.requestId !== outbound.requestId) throw new ExchangeWorkerError('provider_unreachable');
    return parsed.data.data;
  };
}
