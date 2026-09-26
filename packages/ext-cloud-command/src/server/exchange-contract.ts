import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const credentialVersion = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const inventoryCursor = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:[1-9][0-9]{0,4}$/);
const inventoryParameters = z.object({ pageSize: z.number().int().min(1).max(200).default(200), cursor: inventoryCursor.optional() }).strict();
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
const addressesGetParameters = z.object({ mailboxId: uuid }).strict();
const addressWriteParameters = z.object({ mailboxId: uuid, address: z.string().email().max(320) }).strict();
const delegationGetParameters = z.object({ mailboxId: uuid, delegateId: uuid }).strict();
const delegationSetParameters = z.object({ mailboxId: uuid, delegateId: uuid,
  right: z.enum(['FullAccess', 'SendAs', 'SendOnBehalf']), enabled: z.boolean() }).strict().refine(value => value.mailboxId !== value.delegateId);
const distributionCreateParameters = z.object({ name: z.string().trim().min(1).max(256),
  primarySmtpAddress: z.string().trim().email().max(320) }).strict();
const distributionMemberParameters = z.object({ groupId: uuid, memberId: uuid, enabled: z.boolean() }).strict()
  .refine(value => value.groupId !== value.memberId);
const distributionMembersGetParameters = z.object({ groupId: uuid }).strict();
const groupSettingsGetParameters = z.object({ groupId: uuid }).strict();
const groupExternalSetParameters = z.object({ groupId: uuid, allowExternalSenders: z.boolean() }).strict();
const distributionNameSetParameters = z.object({ groupId: uuid, displayName: z.string().trim().min(1).max(256) }).strict();
const groupPrimarySetParameters = z.object({ groupId: uuid, address: z.string().trim().email().max(320) }).strict();
const traceStatus = z.enum(['Delivered', 'Expanded', 'Failed', 'FilteredAsSpam', 'GettingStatus', 'Pending', 'Quarantined']);
const traceCursor = z.object({ received: z.string().datetime({ offset: true }), recipient: z.string().email().max(320) }).strict();
const traceSearchParameters = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }),
  sender: z.string().email().max(320).nullable(), recipient: z.string().email().max(320).nullable(),
  status: traceStatus.nullable(), cursor: traceCursor.nullable() }).strict();
const traceDetailParameters = z.object({ messageTraceId: uuid, recipient: z.string().email().max(320) }).strict();
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
const statisticsGetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.statistics.get'), parameters: forwardingGetParameters }).strict();
const preservationGetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.preservation.get'), parameters: forwardingGetParameters }).strict();
const convertSharedRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.convert.shared'), parameters: forwardingGetParameters }).strict();
const forwardingGetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.forwarding.get'), parameters: forwardingGetParameters }).strict();
const forwardingSetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.forwarding.set'), parameters: forwardingSetParameters }).strict();
const autoReplyGetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.autoreply.get'), parameters: autoReplyGetParameters }).strict();
const autoReplySetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.autoreply.set'), parameters: autoReplySetParameters }).strict();
const addressesGetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.addresses.get'), parameters: addressesGetParameters }).strict();
const primarySetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.primary.set'), parameters: addressWriteParameters }).strict();
const aliasAddRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.alias.add'), parameters: addressWriteParameters }).strict();
const aliasRemoveRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.alias.remove'), parameters: addressWriteParameters }).strict();
const delegationGetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.delegation.get'), parameters: delegationGetParameters }).strict();
const delegationListRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.delegation.list'), parameters: forwardingGetParameters }).strict();
const delegationSetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('mailbox.delegation.set'), parameters: delegationSetParameters }).strict();
const distributionCreateRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('distribution.create'), parameters: distributionCreateParameters }).strict();
const sharedCreateRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('shared.create'), parameters: distributionCreateParameters }).strict();
const distributionMemberSetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('distribution.member.set'), parameters: distributionMemberParameters }).strict();
const distributionMembersGetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('distribution.members.get'), parameters: distributionMembersGetParameters }).strict();
const groupSettingsGetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('group.settings.get'), parameters: groupSettingsGetParameters }).strict();
const groupExternalSetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('group.external.set'), parameters: groupExternalSetParameters }).strict();
const distributionNameSetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('distribution.name.set'), parameters: distributionNameSetParameters }).strict();
const groupPrimarySetRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('group.primary.set'), parameters: groupPrimarySetParameters }).strict();
const traceSearchRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('trace.search'), parameters: traceSearchParameters }).strict();
const traceDetailRequest = z.object({ requestId: uuid, ...bindingSchema.shape,
  operation: z.literal('trace.detail'), parameters: traceDetailParameters }).strict();
const request = z.discriminatedUnion('operation', [inventoryRequest, statisticsGetRequest, preservationGetRequest, convertSharedRequest, forwardingGetRequest, forwardingSetRequest, autoReplyGetRequest, autoReplySetRequest,
  addressesGetRequest, primarySetRequest, aliasAddRequest, aliasRemoveRequest, delegationGetRequest, delegationListRequest, delegationSetRequest,
  distributionCreateRequest, sharedCreateRequest, distributionMemberSetRequest, distributionMembersGetRequest, groupSettingsGetRequest, groupExternalSetRequest, distributionNameSetRequest, groupPrimarySetRequest, traceSearchRequest, traceDetailRequest]);

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
const statisticAvailability = z.enum(['available', 'unavailable', 'not_enabled']);
const inventorySummary = z.object({
  userMailboxCount: z.number().int().nonnegative(),
  sharedMailboxCount: z.number().int().nonnegative(),
  mailboxStatisticsUnavailableCount: z.number().int().nonnegative(),
  archiveStatisticsUnavailableCount: z.number().int().nonnegative(),
}).strict();
const response = z.object({
  requestId: uuid,
  ok: z.literal(true),
  data: z.object({ records: z.array(mailbox).max(200), partial: z.boolean(), collectedAt: z.string().datetime({ offset: true }), next: inventoryCursor.nullable().optional() }).strict(),
}).strict();
const statisticsGetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: mailbox }).strict();
const preservationState = z.object({ mailboxId: uuid, primarySmtpAddress: z.string().email().max(320),
  recipientType: z.enum(['UserMailbox', 'SharedMailbox']), mailboxBytes: z.number().int().nonnegative().nullable(),
  archiveEnabled: z.boolean(), directorySynced: z.boolean().nullable(), litigationHoldEnabled: z.boolean().nullable(),
  inPlaceHolds: z.array(z.string().min(1).max(256)).max(100).nullable(),
  licenseRemovalEligible: z.boolean(), checkedAt: z.string().datetime({ offset: true }) }).strict();
const preservationGetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: preservationState }).strict();
const convertSharedResponse = z.object({ requestId: uuid, ok: z.literal(true), data: z.object({
  mailboxId: uuid, primarySmtpAddress: z.string().email().max(320), recipientType: z.literal('SharedMailbox'),
  accepted: z.literal(true), verified: z.literal(true), changed: z.boolean(),
}).strict() }).strict();
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
const addressesState = z.object({ mailboxId: uuid, primarySmtpAddress: z.string().email().max(320),
  aliases: z.array(z.string().email().max(320)).max(500), policyEnabled: z.boolean() }).strict();
const addressesGetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: addressesState }).strict();
const addressWriteResponse = z.object({ requestId: uuid, ok: z.literal(true), data: addressesState.extend({ accepted: z.literal(true), verified: z.boolean() }) }).strict();
const delegationState = z.object({ mailboxId: uuid, delegateId: uuid, delegateAddress: z.string().email().max(320),
  fullAccess: z.boolean(), sendAs: z.boolean(), sendOnBehalf: z.boolean() }).strict();
const delegationGetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: delegationState }).strict();
const delegationListResponse = z.object({ requestId: uuid, ok: z.literal(true), data: z.object({ mailboxId: uuid,
  entries: z.array(z.object({ delegateAddress: z.string().email().max(320), fullAccess: z.boolean(), sendAs: z.boolean(), sendOnBehalf: z.boolean() }).strict()).max(200),
  partial: z.boolean(), checkedAt: z.string().datetime({ offset: true }),
}).strict() }).strict();
const delegationSetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: delegationState.extend({ accepted: z.literal(true), verified: z.boolean() }) }).strict();
const distributionCreateResponse = z.object({ requestId: uuid, ok: z.literal(true), data: z.object({
  accepted: z.literal(true), verified: z.boolean(), id: uuid.nullable(),
  primarySmtpAddress: z.string().email().max(320),
}).strict() }).strict();
const sharedCreateResponse = distributionCreateResponse;
const distributionMemberResponse = z.object({ requestId: uuid, ok: z.literal(true), data: z.object({
  groupId: uuid, memberId: uuid, enabled: z.boolean(), accepted: z.literal(true), verified: z.boolean(), changed: z.boolean(),
}).strict() }).strict();
const distributionMembersGetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: z.object({
  groupId: uuid, members: z.array(z.object({ id: uuid, displayName: z.string().max(256),
    primarySmtpAddress: z.string().email().max(320) }).strict()).max(500), complete: z.boolean(),
}).strict() }).strict();
const groupSettingsGetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: z.object({
  groupId: uuid, kind: z.enum(['distribution', 'microsoft365']), displayName: z.string().max(256),
  primarySmtpAddress: z.string().email().max(320), requireSenderAuthenticationEnabled: z.boolean(),
  emailAddressPolicyEnabled: z.boolean().nullable(), aliases: z.array(z.string().email().max(320)).max(500),
}).strict() }).strict();
const groupExternalSetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: z.object({
  groupId: uuid, allowExternalSenders: z.boolean(), accepted: z.literal(true), verified: z.boolean(), changed: z.boolean(),
}).strict() }).strict();
const distributionNameSetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: z.object({
  groupId: uuid, displayName: z.string().min(1).max(256), accepted: z.literal(true), verified: z.boolean(), changed: z.boolean(),
}).strict() }).strict();
const groupPrimarySetResponse = z.object({ requestId: uuid, ok: z.literal(true), data: z.object({
  groupId: uuid, primarySmtpAddress: z.string().email().max(320), accepted: z.literal(true), verified: z.boolean(), changed: z.boolean(),
}).strict() }).strict();
const traceRecord = z.object({ messageTraceId: uuid, received: z.string().datetime({ offset: true }),
  sender: z.string().max(320), recipient: z.string().email().max(320), subject: z.string().max(1000), status: z.string().max(80) }).strict();
const traceEvent = z.object({ date: z.string().datetime({ offset: true }).nullable(), event: z.string().max(120), detail: z.string().max(4000) }).strict();
const traceSearchResponse = z.object({ requestId: uuid, ok: z.literal(true), data: z.object({
  rows: z.array(traceRecord).max(1000), next: traceCursor.nullable(), partial: z.boolean(), checkedAt: z.string().datetime({ offset: true }),
}).strict() }).strict();
const traceDetailResponse = z.object({ requestId: uuid, ok: z.literal(true), data: z.object({
  messageTraceId: uuid, recipient: z.string().email().max(320), events: z.array(traceEvent).max(1000), partial: z.boolean(),
}).strict() }).strict();

export type ExchangeConnectionBinding = z.infer<typeof bindingSchema>;
export type ExchangeMailboxInventory = z.infer<typeof mailbox>;
export type ExchangeMailboxStatistics = { mailbox: z.infer<typeof statisticAvailability>; archive: z.infer<typeof statisticAvailability> };
export type ExchangeMailboxInventoryResult = {
  records: Array<ExchangeMailboxInventory & { statistics: ExchangeMailboxStatistics }>;
  /** `partial` means the bounded Exchange inventory did not establish a complete mailbox set. */
  partial: boolean;
  collectedAt: string;
  /** Counts are based only on `records`, and must not be treated as tenant totals when partial. */
  summary: z.infer<typeof inventorySummary>;
};
export type ExchangeWorkerRequest = z.infer<typeof request>;
export type ExchangeWorkerResponse = z.infer<typeof response>;
export type ExchangeWorkerFailure = z.infer<typeof failure>;
export type ExchangeForwardingState = z.infer<typeof forwardingState>;
export type ExchangeForwardingSet = z.infer<typeof forwardingSetParameters>;
export type ExchangeAutoReplySet = z.infer<typeof autoReplySetParameters>;
export type ExchangeAddressWrite = z.infer<typeof addressWriteParameters>;
export type ExchangeAddressAction = 'mailbox.primary.set' | 'mailbox.alias.add' | 'mailbox.alias.remove';
export type ExchangeDelegationSet = z.infer<typeof delegationSetParameters>;
export type ExchangeDistributionCreate = z.infer<typeof distributionCreateParameters>;
export type ExchangeSharedCreate = ExchangeDistributionCreate;
export type ExchangeDistributionMemberSet = z.infer<typeof distributionMemberParameters>;
export type ExchangeGroupExternalSet = z.infer<typeof groupExternalSetParameters>;
export type ExchangeDistributionNameSet = z.infer<typeof distributionNameSetParameters>;
export type ExchangeGroupPrimarySet = z.infer<typeof groupPrimarySetParameters>;
export type ExchangeTraceSearch = z.infer<typeof traceSearchParameters>;
export type ExchangeTraceDetail = z.infer<typeof traceDetailParameters>;

/** A host-only port for the Unix-socket sidecar. Do not implement this with HTTP or expose it to browsers. */
export interface ExchangeWorkerPort {
  dispatch(request: ExchangeWorkerRequest): Promise<unknown>;
}
/** One right per write avoids partial multi-right outcomes from the retained Cloud Command batch operation. */
export function createExchangeDelegationClient(port: ExchangeWorkerPort) {
  return {
    async list(binding: ExchangeConnectionBinding, mailboxId: string) {
      const outbound = delegationListRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
        operation: 'mailbox.delegation.list', parameters: forwardingGetParameters.parse({ mailboxId }) });
      const data = await forwardingDispatch(port, outbound, delegationListResponse);
      if (data.mailboxId !== outbound.parameters.mailboxId) throw new ExchangeWorkerError('provider_unreachable');
      return data;
    },
    async get(binding: ExchangeConnectionBinding, mailboxId: string, delegateId: string) {
      const outbound = delegationGetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
        operation: 'mailbox.delegation.get', parameters: delegationGetParameters.parse({ mailboxId, delegateId }) });
      const data = await forwardingDispatch(port, outbound, delegationGetResponse);
      if (data.mailboxId !== outbound.parameters.mailboxId || data.delegateId !== outbound.parameters.delegateId)
        throw new ExchangeWorkerError('provider_unreachable');
      return data;
    },
    async set(binding: ExchangeConnectionBinding, input: ExchangeDelegationSet) {
      const outbound = delegationSetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
        operation: 'mailbox.delegation.set', parameters: delegationSetParameters.parse(input) });
      const data = await forwardingDispatch(port, outbound, delegationSetResponse);
      if (data.mailboxId !== outbound.parameters.mailboxId || data.delegateId !== outbound.parameters.delegateId)
        throw new ExchangeWorkerError('unknown_write_outcome');
      return data;
    },
  };
}
export function createExchangeTraceClient(port: ExchangeWorkerPort) {
  return {
    async search(binding: ExchangeConnectionBinding, input: ExchangeTraceSearch) {
      const outbound = traceSearchRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(), operation: 'trace.search', parameters: input });
      const data = await forwardingDispatch(port, outbound, traceSearchResponse);
      if (data.next && !data.rows.some(row => row.received === data.next?.received && row.recipient.toLowerCase() === data.next?.recipient.toLowerCase()))
        throw new ExchangeWorkerError('provider_unreachable');
      return data;
    },
    async detail(binding: ExchangeConnectionBinding, input: ExchangeTraceDetail) {
      const outbound = traceDetailRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(), operation: 'trace.detail', parameters: input });
      const data = await forwardingDispatch(port, outbound, traceDetailResponse);
      if (data.messageTraceId !== outbound.parameters.messageTraceId || data.recipient.toLowerCase() !== outbound.parameters.recipient.toLowerCase())
        throw new ExchangeWorkerError('provider_unreachable');
      return data;
    },
  };
}

export class ExchangeWorkerError extends Error {
  constructor(public readonly code: z.infer<typeof failure>['code']) { super(code); }
}
async function forwardingDispatch<T>(port: ExchangeWorkerPort, outbound: ExchangeWorkerRequest, schema: z.ZodType<{ requestId: string; ok: true; data: T }>): Promise<T> {
  let received: unknown;
  try { received = await port.dispatch(outbound); }
  catch { throw new ExchangeWorkerError(outbound.operation.endsWith('.set') || outbound.operation.endsWith('.add') || outbound.operation.endsWith('.remove') || outbound.operation.endsWith('.create') ? 'unknown_write_outcome' : 'provider_unreachable'); }
  const rejected = failure.safeParse(received);
  if (rejected.success) {
    if (rejected.data.requestId !== outbound.requestId) throw new ExchangeWorkerError(outbound.operation.endsWith('.set') || outbound.operation.endsWith('.add') || outbound.operation.endsWith('.remove') || outbound.operation.endsWith('.create') ? 'unknown_write_outcome' : 'provider_unreachable');
    throw new ExchangeWorkerError(rejected.data.code);
  }
  const parsed = schema.safeParse(received);
  if (!parsed.success || parsed.data.requestId !== outbound.requestId)
    throw new ExchangeWorkerError(outbound.operation.endsWith('.set') || outbound.operation.endsWith('.add') || outbound.operation.endsWith('.remove') || outbound.operation.endsWith('.create') ? 'unknown_write_outcome' : 'provider_unreachable');
  return parsed.data.data;
}
export function createExchangeDistributionClient(port: ExchangeWorkerPort) {
  return async (binding: ExchangeConnectionBinding, input: ExchangeDistributionCreate) => {
    const outbound = distributionCreateRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
      operation: 'distribution.create', parameters: distributionCreateParameters.parse(input) });
    const data = await forwardingDispatch(port, outbound, distributionCreateResponse);
    if (data.primarySmtpAddress.toLowerCase() !== outbound.parameters.primarySmtpAddress.toLowerCase())
      throw new ExchangeWorkerError('unknown_write_outcome');
    return data;
  };
}
export function createExchangeSharedClient(port: ExchangeWorkerPort) {
  return async (binding: ExchangeConnectionBinding, input: ExchangeSharedCreate) => {
    const outbound = sharedCreateRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
      operation: 'shared.create', parameters: distributionCreateParameters.parse(input) });
    const data = await forwardingDispatch(port, outbound, sharedCreateResponse);
    if (data.primarySmtpAddress.toLowerCase() !== outbound.parameters.primarySmtpAddress.toLowerCase())
      throw new ExchangeWorkerError('unknown_write_outcome');
    return data;
  };
}
export function createExchangeDistributionMemberClient(port: ExchangeWorkerPort) {
  return async (binding: ExchangeConnectionBinding, input: ExchangeDistributionMemberSet) => {
    const outbound = distributionMemberSetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
      operation: 'distribution.member.set', parameters: distributionMemberParameters.parse(input) });
    const data = await forwardingDispatch(port, outbound, distributionMemberResponse);
    if (data.groupId !== outbound.parameters.groupId || data.memberId !== outbound.parameters.memberId ||
      data.enabled !== outbound.parameters.enabled || !data.verified) throw new ExchangeWorkerError('unknown_write_outcome');
    return data;
  };
}
export function createExchangeDistributionMembersClient(port: ExchangeWorkerPort) {
  return async (binding: ExchangeConnectionBinding, groupId: string) => {
    const outbound = distributionMembersGetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
      operation: 'distribution.members.get', parameters: distributionMembersGetParameters.parse({ groupId }) });
    const data = await forwardingDispatch(port, outbound, distributionMembersGetResponse);
    if (data.groupId !== outbound.parameters.groupId) throw new ExchangeWorkerError('provider_unreachable');
    return data;
  };
}
export function createExchangeGroupSettingsClient(port: ExchangeWorkerPort) {
  return async (binding: ExchangeConnectionBinding, groupId: string) => {
    const outbound = groupSettingsGetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
      operation: 'group.settings.get', parameters: groupSettingsGetParameters.parse({ groupId }) });
    const data = await forwardingDispatch(port, outbound, groupSettingsGetResponse);
    if (data.groupId !== outbound.parameters.groupId) throw new ExchangeWorkerError('provider_unreachable');
    return data;
  };
}
export function createExchangeGroupExternalClient(port: ExchangeWorkerPort) {
  return async (binding: ExchangeConnectionBinding, input: z.infer<typeof groupExternalSetParameters>) => {
    const outbound = groupExternalSetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
      operation: 'group.external.set', parameters: groupExternalSetParameters.parse(input) });
    const data = await forwardingDispatch(port, outbound, groupExternalSetResponse);
    if (data.groupId !== outbound.parameters.groupId || data.allowExternalSenders !== outbound.parameters.allowExternalSenders || !data.verified)
      throw new ExchangeWorkerError('unknown_write_outcome');
    return data;
  };
}
export function createExchangeDistributionNameClient(port: ExchangeWorkerPort) {
  return async (binding: ExchangeConnectionBinding, input: z.infer<typeof distributionNameSetParameters>) => {
    const outbound = distributionNameSetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
      operation: 'distribution.name.set', parameters: distributionNameSetParameters.parse(input) });
    const data = await forwardingDispatch(port, outbound, distributionNameSetResponse);
    if (data.groupId !== outbound.parameters.groupId || data.displayName !== outbound.parameters.displayName || !data.verified)
      throw new ExchangeWorkerError('unknown_write_outcome');
    return data;
  };
}
export function createExchangeGroupPrimaryClient(port: ExchangeWorkerPort) {
  return async (binding: ExchangeConnectionBinding, input: z.infer<typeof groupPrimarySetParameters>) => {
    const outbound = groupPrimarySetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
      operation: 'group.primary.set', parameters: groupPrimarySetParameters.parse(input) });
    const data = await forwardingDispatch(port, outbound, groupPrimarySetResponse);
    if (data.groupId !== outbound.parameters.groupId || data.primarySmtpAddress.toLowerCase() !== outbound.parameters.address.toLowerCase() || !data.verified)
      throw new ExchangeWorkerError('unknown_write_outcome');
    return data;
  };
}
/** Address changes are fixed Exchange operations against a bound Entra mailbox ID. */
export function createExchangeAddressesClient(port: ExchangeWorkerPort) {
  return {
    async get(binding: ExchangeConnectionBinding, mailboxId: string) {
      const outbound = addressesGetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
        operation: 'mailbox.addresses.get', parameters: addressesGetParameters.parse({ mailboxId }) });
      const data = await forwardingDispatch(port, outbound, addressesGetResponse);
      if (data.mailboxId !== outbound.parameters.mailboxId) throw new ExchangeWorkerError('provider_unreachable');
      return data;
    },
    async write(binding: ExchangeConnectionBinding, action: ExchangeAddressAction, input: ExchangeAddressWrite) {
      const parameters = addressWriteParameters.parse(input);
      const header = { ...bindingSchema.parse(binding), requestId: randomUUID(), parameters };
      const outbound = action === 'mailbox.primary.set' ? primarySetRequest.parse({ ...header, operation: action })
        : action === 'mailbox.alias.add' ? aliasAddRequest.parse({ ...header, operation: action })
        : aliasRemoveRequest.parse({ ...header, operation: action });
      const data = await forwardingDispatch(port, outbound, addressWriteResponse);
      if (data.mailboxId !== outbound.parameters.mailboxId) throw new ExchangeWorkerError('unknown_write_outcome');
      return data;
    },
  };
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
    const pageSize = inventoryParameters.parse(input).pageSize;
    const records: z.infer<typeof mailbox>[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let collectedAt: string | undefined;
    let partial = false;
    // At most 10,000 records and 50 local pages per read. A tenant beyond
    // either bound is explicitly partial; no page is silently treated as full.
    for (let page = 0; page < 50 && records.length < 10_000; page += 1) {
      const parameters = inventoryParameters.parse({ pageSize, ...(cursor ? { cursor } : {}) });
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
      const data = parsed.data.data;
      if (collectedAt && data.collectedAt !== collectedAt || data.next && (!data.partial || !data.records.length || cursors.has(data.next)))
        throw new ExchangeWorkerError('provider_unreachable');
      collectedAt = data.collectedAt;
      for (const record of data.records) {
        if (ids.has(record.id)) throw new ExchangeWorkerError('provider_unreachable');
        ids.add(record.id); records.push(record);
      }
      partial = data.partial;
      if (!data.next) break;
      cursors.add(data.next);
      cursor = data.next;
      if (page === 49 || records.length >= 10_000) partial = true;
    }
    return projectMailboxInventory({ records, partial, collectedAt: collectedAt ?? new Date().toISOString() });
  };
}

export function createExchangeMailboxStatisticsClient(port: ExchangeWorkerPort) {
  return async (binding: ExchangeConnectionBinding, mailboxId: string): Promise<ExchangeMailboxInventory> => {
    const outbound = statisticsGetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
      operation: 'mailbox.statistics.get', parameters: forwardingGetParameters.parse({ mailboxId }) });
    const record = await forwardingDispatch(port, outbound, statisticsGetResponse);
    if (record.id !== outbound.parameters.mailboxId) throw new ExchangeWorkerError('provider_unreachable');
    return record;
  };
}

/** Read-only preservation preflight. Unknown size or hold state must never
 * authorize license removal, even if a conversion has already succeeded. */
export function createExchangePreservationInspectClient(port: ExchangeWorkerPort) {
  return async (binding: ExchangeConnectionBinding, mailboxId: string): Promise<z.infer<typeof preservationState>> => {
    const outbound = preservationGetRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
      operation: 'mailbox.preservation.get', parameters: forwardingGetParameters.parse({ mailboxId }) });
    const state = await forwardingDispatch(port, outbound, preservationGetResponse);
    if (state.mailboxId !== outbound.parameters.mailboxId
      || state.licenseRemovalEligible && (state.recipientType !== 'SharedMailbox' || state.directorySynced !== false || state.mailboxBytes === null
        || state.mailboxBytes >= 50 * 1024 ** 3 || state.archiveEnabled || state.litigationHoldEnabled !== false
        || state.inPlaceHolds === null || state.inPlaceHolds.length !== 0))
      throw new ExchangeWorkerError('provider_unreachable');
    return state;
  };
}

/** Fixed Exchange conversion step for a durable preservation workflow. This
 * client is not exposed as a standalone browser action. A resume must inspect
 * current mailbox state before deciding whether to call it again. */
export function createExchangeConvertSharedClient(port: ExchangeWorkerPort) {
  return async (binding: ExchangeConnectionBinding, mailboxId: string) => {
    const outbound = convertSharedRequest.parse({ ...bindingSchema.parse(binding), requestId: randomUUID(),
      operation: 'mailbox.convert.shared', parameters: forwardingGetParameters.parse({ mailboxId }) });
    const state = await forwardingDispatch(port, outbound, convertSharedResponse);
    if (state.mailboxId !== outbound.parameters.mailboxId) throw new ExchangeWorkerError('unknown_write_outcome');
    return state;
  };
}

/**
 * Exchange can enumerate a mailbox even when one of its statistics cmdlets is denied or
 * temporarily fails.  Preserve that distinction for the UI: an archive that is not enabled
 * is not an unavailable archive statistic, and a usable mailbox statistic remains usable if
 * only the archive query failed.
 */
function projectMailboxInventory(data: z.infer<typeof response>['data']): ExchangeMailboxInventoryResult {
  let userMailboxCount = 0;
  let sharedMailboxCount = 0;
  let mailboxStatisticsUnavailableCount = 0;
  let archiveStatisticsUnavailableCount = 0;
  const records = data.records.map(record => {
    if (record.recipientType === 'UserMailbox') userMailboxCount += 1;
    else sharedMailboxCount += 1;
    const statistics: ExchangeMailboxStatistics = {
      mailbox: record.mailboxBytes === null ? 'unavailable' : 'available',
      archive: !record.archiveEnabled ? 'not_enabled' : record.archiveBytes === null ? 'unavailable' : 'available',
    };
    if (statistics.mailbox === 'unavailable') mailboxStatisticsUnavailableCount += 1;
    if (statistics.archive === 'unavailable') archiveStatisticsUnavailableCount += 1;
    return { ...record, statistics };
  });
  return { records, partial: data.partial, collectedAt: data.collectedAt,
    summary: { userMailboxCount, sharedMailboxCount, mailboxStatisticsUnavailableCount, archiveStatisticsUnavailableCount } };
}
