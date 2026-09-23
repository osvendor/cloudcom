import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const credentialVersion = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const inventoryParameters = z.object({ pageSize: z.number().int().min(1).max(200).default(100) }).strict();
const bindingSchema = z.object({
  organizationId: uuid,
  tenantId: uuid,
  clientId: uuid,
  credentialVersion,
  connectionGeneration: z.number().int().positive(),
}).strict();
const request = z.object({
  requestId: uuid,
  ...bindingSchema.shape,
  operation: z.literal('mailbox.inventory'),
  parameters: inventoryParameters,
}).strict();

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
  'provider_access_denied', 'provider_rejected', 'provider_unreachable', 'response_too_large', 'worker_busy',
]) }).strict();

export type ExchangeConnectionBinding = z.infer<typeof bindingSchema>;
export type ExchangeMailboxInventory = z.infer<typeof mailbox>;
export type ExchangeWorkerRequest = z.infer<typeof request>;
export type ExchangeWorkerResponse = z.infer<typeof response>;
export type ExchangeWorkerFailure = z.infer<typeof failure>;

/** A host-only port for the Unix-socket sidecar. Do not implement this with HTTP or expose it to browsers. */
export interface ExchangeWorkerPort {
  dispatch(request: ExchangeWorkerRequest): Promise<unknown>;
}

export class ExchangeWorkerError extends Error {
  constructor(public readonly code: z.infer<typeof failure>['code']) { super(code); }
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
    const outbound = request.parse({ ...bound, requestId: randomUUID(), operation: 'mailbox.inventory', parameters });
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
