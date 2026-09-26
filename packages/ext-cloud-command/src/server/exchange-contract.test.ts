import { describe, expect, it, vi } from 'vitest';
import { createExchangeAddressesClient, createExchangeAutoReplyClient, createExchangeConvertSharedClient, createExchangeDelegationClient, createExchangeDistributionClient, createExchangeDistributionMemberClient, createExchangeDistributionMembersClient, createExchangeDistributionNameClient, createExchangeGroupPrimaryClient, createExchangeGroupSettingsClient, createExchangeGroupExternalClient, createExchangeForwardingClient, createExchangeMailboxInventoryClient, createExchangeMailboxStatisticsClient, createExchangePreservationInspectClient, createExchangeSharedClient, createExchangeTraceClient, ExchangeWorkerError } from './exchange-contract';

describe('Exchange group primary SMTP contract', () => {
  const input = { groupId: '44444444-4444-4444-8444-444444444444', address: 'new@example.test' };
  it('dispatches only the typed address write and requires exact readback', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: {
      groupId: input.groupId, primarySmtpAddress: input.address, accepted: true, verified: true, changed: true } }));
    await expect(createExchangeGroupPrimaryClient({ dispatch })(binding, input)).resolves.toMatchObject({ verified: true });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'group.primary.set', parameters: input }));
    await expect(createExchangeGroupPrimaryClient({ dispatch })(binding, { ...input, command: 'Remove-DistributionGroup' } as never)).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    dispatch.mockImplementation(async request => ({ requestId: request.requestId, ok: true, data: {
      groupId: input.groupId, primarySmtpAddress: 'wrong@example.test', accepted: true, verified: true, changed: true } }));
    await expect(createExchangeGroupPrimaryClient({ dispatch })(binding, input)).rejects.toMatchObject({ code: 'unknown_write_outcome' });
  });
});

describe('Exchange distribution name contract', () => {
  const input = { groupId: '44444444-4444-4444-8444-444444444444', displayName: 'QA Renamed' };
  it('dispatches only the typed name write and verifies exact readback', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: {
      ...input, accepted: true, verified: true, changed: true } }));
    await expect(createExchangeDistributionNameClient({ dispatch })(binding, input)).resolves.toMatchObject({ verified: true });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'distribution.name.set', parameters: input }));
    await expect(createExchangeDistributionNameClient({ dispatch })(binding, { ...input, command: 'Remove-DistributionGroup' } as never)).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    dispatch.mockImplementation(async request => ({ requestId: request.requestId, ok: true, data: {
      ...input, displayName: 'Wrong', accepted: true, verified: true, changed: true } }));
    await expect(createExchangeDistributionNameClient({ dispatch })(binding, input)).rejects.toMatchObject({ code: 'unknown_write_outcome' });
  });
});

describe('Exchange external-sender setting contract', () => {
  const input = { groupId: '44444444-4444-4444-8444-444444444444', allowExternalSenders: true };
  it('dispatches one typed write and requires matching verified readback', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: {
      ...input, accepted: true, verified: true, changed: true } }));
    await expect(createExchangeGroupExternalClient({ dispatch })(binding, input)).resolves.toMatchObject({ verified: true });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'group.external.set', parameters: input }));
    await expect(createExchangeGroupExternalClient({ dispatch })(binding, { ...input, command: 'Remove-UnifiedGroup' } as never)).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    dispatch.mockImplementation(async request => ({ requestId: request.requestId, ok: true, data: {
      ...input, allowExternalSenders: false, accepted: true, verified: true, changed: true } }));
    await expect(createExchangeGroupExternalClient({ dispatch })(binding, input)).rejects.toMatchObject({ code: 'unknown_write_outcome' });
  });
});

describe('Exchange group settings read contract', () => {
  const groupId = '44444444-4444-4444-8444-444444444444';
  it('requires exact group identity and a typed settings response', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: {
      groupId, kind: 'distribution', displayName: 'QA', primarySmtpAddress: 'qa@example.com', requireSenderAuthenticationEnabled: true,
      emailAddressPolicyEnabled: false, aliases: ['old@example.com'] } }));
    await expect(createExchangeGroupSettingsClient({ dispatch })(binding, groupId)).resolves.toMatchObject({ kind: 'distribution' });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'group.settings.get', parameters: { groupId } }));
    dispatch.mockImplementation(async request => ({ requestId: request.requestId, ok: true, data: {
      groupId: '66666666-6666-4666-8666-666666666666', kind: 'distribution', displayName: 'QA',
      primarySmtpAddress: 'qa@example.com', requireSenderAuthenticationEnabled: true,
      emailAddressPolicyEnabled: false, aliases: [] } }));
    await expect(createExchangeGroupSettingsClient({ dispatch })(binding, groupId)).rejects.toMatchObject({ code: 'provider_unreachable' });
  });
});

describe('Exchange distribution members read contract', () => {
  const groupId = '44444444-4444-4444-8444-444444444444';
  it('uses a fixed group ID and rejects mismatched or injected responses', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: {
      groupId, members: [{ id: '55555555-5555-4555-8555-555555555555', displayName: 'QA', primarySmtpAddress: 'qa@example.com' }], complete: true } }));
    await expect(createExchangeDistributionMembersClient({ dispatch })(binding, groupId)).resolves.toMatchObject({ complete: true });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'distribution.members.get', parameters: { groupId } }));
    await expect(createExchangeDistributionMembersClient({ dispatch })(binding, { groupId, command: 'Remove-DistributionGroup' } as never)).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    dispatch.mockImplementation(async request => ({ requestId: request.requestId, ok: true, data: { groupId: '66666666-6666-4666-8666-666666666666', members: [], complete: true } }));
    await expect(createExchangeDistributionMembersClient({ dispatch })(binding, groupId)).rejects.toMatchObject({ code: 'provider_unreachable' });
  });
});

describe('Exchange distribution membership contract', () => {
  const input = { groupId: '44444444-4444-4444-8444-444444444444', memberId: '55555555-5555-4555-8555-555555555555', enabled: true };
  it('dispatches a fixed bound change and verifies both identities', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: {
      ...input, accepted: true, verified: true, changed: true } }));
    await expect(createExchangeDistributionMemberClient({ dispatch })(binding, input)).resolves.toMatchObject({ changed: true });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'distribution.member.set', parameters: input }));
  });
  it('blocks injected input and a mismatched readback', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: {
      ...input, memberId: '66666666-6666-4666-8666-666666666666', accepted: true, verified: true, changed: true } }));
    const client = createExchangeDistributionMemberClient({ dispatch });
    await expect(client(binding, { ...input, command: 'Remove-DistributionGroup' } as never)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    await expect(client(binding, input)).rejects.toMatchObject({ code: 'unknown_write_outcome' });
  });
});

describe('Exchange distribution creation contract', () => {
  const input = { name: 'QA Distribution', primarySmtpAddress: 'qa@example.com' };
  it('accepts one fixed request and matching verified readback', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: {
      accepted: true, verified: true, id: null, primarySmtpAddress: input.primarySmtpAddress } }));
    await expect(createExchangeDistributionClient({ dispatch })(binding, input)).resolves.toMatchObject({ verified: true });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'distribution.create', parameters: input }));
  });
  it('blocks injected parameters and treats a mismatched address as an unknown write outcome', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: {
      accepted: true, verified: true, id: null, primarySmtpAddress: 'other@example.com' } }));
    const client = createExchangeDistributionClient({ dispatch });
    await expect(client(binding, { ...input, command: 'Remove-DistributionGroup' } as never)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    await expect(client(binding, input)).rejects.toMatchObject({ code: 'unknown_write_outcome' });
  });
});

describe('Exchange shared mailbox creation contract', () => {
  const input = { name: 'QA Shared', primarySmtpAddress: 'shared@example.com' };
  it('dispatches a fixed shared operation with matching recipient readback', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: {
      accepted: true, verified: true, id: '44444444-4444-4444-8444-444444444444', primarySmtpAddress: input.primarySmtpAddress } }));
    await expect(createExchangeSharedClient({ dispatch })(binding, input)).resolves.toMatchObject({ verified: true });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'shared.create', parameters: input }));
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain('certificate');
  });
  it('rejects extra inputs and treats mismatched readback as uncertain', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: {
      accepted: true, verified: true, id: null, primarySmtpAddress: 'other@example.com' } }));
    const client = createExchangeSharedClient({ dispatch });
    await expect(client(binding, { ...input, command: 'Remove-Mailbox' } as never)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    await expect(client(binding, input)).rejects.toMatchObject({ code: 'unknown_write_outcome' });
  });
});

const binding = {
  organizationId: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222',
  clientId: '33333333-3333-4333-8333-333333333333', credentialVersion: 'cert-2026-09', connectionGeneration: 7,
};
const mailbox = {
  id: '44444444-4444-4444-8444-444444444444', primarySmtpAddress: 'test@example.com', recipientType: 'UserMailbox',
  archiveEnabled: false, mailboxBytes: 12, archiveBytes: null, collectedAt: '2026-09-22T00:00:00.000Z', statisticsUnavailable: false,
};
describe('Exchange preservation inspection contract', () => {
  const data = { mailboxId: mailbox.id, primarySmtpAddress: mailbox.primarySmtpAddress,
    recipientType: 'SharedMailbox', mailboxBytes: 12, archiveEnabled: false, directorySynced: false,
    litigationHoldEnabled: false, inPlaceHolds: [], licenseRemovalEligible: true,
    checkedAt: '2026-09-25T00:00:00Z' };
  it('returns a fixed read-only preflight for an exact mailbox ID', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data }));
    await expect(createExchangePreservationInspectClient({ dispatch })(binding, mailbox.id)).resolves.toEqual(data);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'mailbox.preservation.get', parameters: { mailboxId: mailbox.id } }));
  });
  it('rejects an eligibility claim when a hold or archive is present', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: { ...data, inPlaceHolds: ['hold-1'] } }));
    await expect(createExchangePreservationInspectClient({ dispatch })(binding, mailbox.id)).rejects.toMatchObject({ code: 'provider_unreachable' });
    dispatch.mockImplementation(async request => ({ requestId: request.requestId, ok: true, data: { ...data, directorySynced: true } }));
    await expect(createExchangePreservationInspectClient({ dispatch })(binding, mailbox.id)).rejects.toMatchObject({ code: 'provider_unreachable' });
  });
});
describe('Exchange shared-mailbox conversion contract', () => {
  it('accepts only an exact verified same-mailbox conversion outcome', async () => {
    const data = { mailboxId: mailbox.id, primarySmtpAddress: mailbox.primarySmtpAddress,
      recipientType: 'SharedMailbox', accepted: true, verified: true, changed: true };
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data }));
    await expect(createExchangeConvertSharedClient({ dispatch })(binding, mailbox.id)).resolves.toEqual(data);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'mailbox.convert.shared', parameters: { mailboxId: mailbox.id } }));
    await expect(createExchangeConvertSharedClient({ dispatch })(binding, 'bad-id')).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    dispatch.mockImplementation(async request => ({ requestId: request.requestId, ok: true,
      data: { ...data, mailboxId: binding.organizationId } }));
    await expect(createExchangeConvertSharedClient({ dispatch })(binding, mailbox.id)).rejects.toMatchObject({ code: 'unknown_write_outcome' });
  });
});
describe('Exchange worker contract', () => {
  it('retrieves statistics for one authorized mailbox ID and rejects a substituted record', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: mailbox }));
    await expect(createExchangeMailboxStatisticsClient({ dispatch })(binding, mailbox.id)).resolves.toEqual(mailbox);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'mailbox.statistics.get', parameters: { mailboxId: mailbox.id } }));
    await expect(createExchangeMailboxStatisticsClient({ dispatch })(binding, 'bad id')).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    dispatch.mockImplementation(async request => ({ requestId: request.requestId, ok: true, data: { ...mailbox, id: binding.organizationId } }));
    await expect(createExchangeMailboxStatisticsClient({ dispatch })(binding, mailbox.id)).rejects.toMatchObject({ code: 'provider_unreachable' });
  });
  it('dispatches only the fixed bounded mailbox inventory operation', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: { records: [mailbox], partial: false, collectedAt: mailbox.collectedAt } }));
    const result = await createExchangeMailboxInventoryClient({ dispatch })(binding, { pageSize: 25 });
    expect(result.records).toEqual([{ ...mailbox, statistics: { mailbox: 'available', archive: 'not_enabled' } }]);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ ...binding, operation: 'mailbox.inventory', parameters: { pageSize: 25 }, requestId: expect.any(String) }));
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain('certificate');
  });
  it('assembles a stable Exchange snapshot across bounded continuation pages', async () => {
    const second = { ...mailbox, id: '55555555-5555-4555-8555-555555555555', primarySmtpAddress: 'second@example.com' };
    const cursor = '66666666-6666-4666-8666-666666666666:1';
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: request.parameters.cursor
      ? { records: [second], partial: false, collectedAt: mailbox.collectedAt, next: null }
      : { records: [mailbox], partial: true, collectedAt: mailbox.collectedAt, next: cursor } }));
    const result = await createExchangeMailboxInventoryClient({ dispatch })(binding, { pageSize: 1 });
    expect(result.records.map(row => row.id)).toEqual([mailbox.id, second.id]);
    expect(result.partial).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]![0].parameters).toEqual({ pageSize: 1, cursor });
  });
  it('classifies mailboxes beyond the original first 200 without marking the inventory partial', async () => {
    const mailboxes = Array.from({ length: 201 }, (_, index) => ({ ...mailbox,
      id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
      primarySmtpAddress: `account${index + 1}@example.com`,
      recipientType: index === 200 ? 'SharedMailbox' as const : 'UserMailbox' as const,
    }));
    const cursor = '66666666-6666-4666-8666-666666666666:200';
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: request.parameters.cursor
      ? { records: mailboxes.slice(200), partial: false, collectedAt: mailbox.collectedAt, next: null }
      : { records: mailboxes.slice(0, 200), partial: true, collectedAt: mailbox.collectedAt, next: cursor } }));
    const result = await createExchangeMailboxInventoryClient({ dispatch })(binding, { pageSize: 200 });
    expect(result.records).toHaveLength(201);
    expect(result.summary.sharedMailboxCount).toBe(1);
    expect(result.partial).toBe(false);
  });
  it('rejects changed snapshots, repeated identities and cursor loops', async () => {
    const cursor = '66666666-6666-4666-8666-666666666666:1';
    for (const later of [
      { records: [mailbox], partial: false, collectedAt: '2026-09-23T00:00:00.000Z', next: null },
      { records: [mailbox], partial: false, collectedAt: mailbox.collectedAt, next: null },
      { records: [mailbox], partial: true, collectedAt: mailbox.collectedAt, next: cursor },
    ]) {
      const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: request.parameters.cursor
        ? later : { records: [mailbox], partial: true, collectedAt: mailbox.collectedAt, next: cursor } }));
      await expect(createExchangeMailboxInventoryClient({ dispatch })(binding)).rejects.toMatchObject({ code: 'provider_unreachable' });
    }
  });
  it('separates shared mailboxes and per-statistic availability without guessing', async () => {
    const shared = { ...mailbox, id: '55555555-5555-4555-8555-555555555555', primarySmtpAddress: 'shared@example.com',
      recipientType: 'SharedMailbox' as const, archiveEnabled: true, mailboxBytes: 48, archiveBytes: null, statisticsUnavailable: true };
    const unavailable = { ...mailbox, id: '66666666-6666-4666-8666-666666666666', primarySmtpAddress: 'missing@example.com',
      archiveEnabled: false, mailboxBytes: null, archiveBytes: null, statisticsUnavailable: true };
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true,
      data: { records: [mailbox, shared, unavailable], partial: true, collectedAt: mailbox.collectedAt } }));
    const result = await createExchangeMailboxInventoryClient({ dispatch })(binding);
    expect(result.partial).toBe(true);
    expect(result.summary).toEqual({ userMailboxCount: 2, sharedMailboxCount: 1,
      mailboxStatisticsUnavailableCount: 1, archiveStatisticsUnavailableCount: 1 });
    expect(result.records.map(row => [row.recipientType, row.statistics])).toEqual([
      ['UserMailbox', { mailbox: 'available', archive: 'not_enabled' }],
      ['SharedMailbox', { mailbox: 'available', archive: 'unavailable' }],
      ['UserMailbox', { mailbox: 'unavailable', archive: 'not_enabled' }],
    ]);
  });
  it.each([
    [{ ...binding, tenantId: 'not-a-tenant' }, {}],
    [binding, { pageSize: 201 }],
    [{ ...binding, command: 'Get-Mailbox' }, {}],
  ])('rejects unbounded or injected inputs before dispatch', async (badBinding, input) => {
    const dispatch = vi.fn();
    await expect(createExchangeMailboxInventoryClient({ dispatch })(badBinding as typeof binding, input)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('rejects a response for a different request and exposes no provider body', async () => {
    const dispatch = vi.fn(async () => ({ requestId: '55555555-5555-4555-8555-555555555555', ok: false, code: 'provider_access_denied', detail: 'private detail' }));
    await expect(createExchangeMailboxInventoryClient({ dispatch })(binding)).rejects.toEqual(expect.objectContaining({ code: 'provider_unreachable' }));
  });
  it('passes a fixed, safe worker failure code through', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: false, code: 'worker_busy' }));
    await expect(createExchangeMailboxInventoryClient({ dispatch })(binding)).rejects.toEqual(expect.any(ExchangeWorkerError));
    await expect(createExchangeMailboxInventoryClient({ dispatch })(binding)).rejects.toEqual(expect.objectContaining({ code: 'worker_busy' }));
  });
  it('rejects oversized or malformed results', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: { records: Array.from({ length: 201 }, () => mailbox), partial: false, collectedAt: mailbox.collectedAt } }));
    await expect(createExchangeMailboxInventoryClient({ dispatch })(binding)).rejects.toEqual(expect.objectContaining({ code: 'provider_unreachable' }));
  });
});

describe('Exchange forwarding contract', () => {
  const mailboxId = mailbox.id;
  it('sends only a bounded mailbox ID and forwarding settings', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true,
      data: { mailboxId, smtpAddress: 'next@example.com', keepCopy: true, internalRecipient: null, accepted: true, verified: true } }));
    const result = await createExchangeForwardingClient({ dispatch }).set(binding, { mailboxId, smtpAddress: 'next@example.com', keepCopy: true });
    expect(result.verified).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'mailbox.forwarding.set', parameters: { mailboxId, smtpAddress: 'next@example.com', keepCopy: true } }));
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain('certificate');
  });
  it('rejects injected settings and treats a lost write response as uncertain', async () => {
    const dispatch = vi.fn(async () => { throw new Error('socket closed'); });
    const client = createExchangeForwardingClient({ dispatch });
    await expect(client.set(binding, { mailboxId, smtpAddress: 'next@example.com', keepCopy: true, command: 'Remove-Mailbox' } as never)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    await expect(client.set(binding, { mailboxId, smtpAddress: null, keepCopy: false })).rejects.toMatchObject({ code: 'unknown_write_outcome' });
  });
  it('does not accept mismatched mailbox state after a read', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true,
      data: { mailboxId: binding.organizationId, smtpAddress: null, keepCopy: false, internalRecipient: null } }));
    await expect(createExchangeForwardingClient({ dispatch }).get(binding, mailboxId)).rejects.toMatchObject({ code: 'provider_unreachable' });
  });
});

describe('Exchange automatic reply contract', () => {
  const mailboxId = mailbox.id;
  it('sends one bounded reply and validated schedule', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: { mailboxId, state: 'Scheduled',
      internalMessage: 'Away', externalMessage: 'Away', externalAudience: 'All', start: '2026-09-24T12:00:00.000Z', end: '2026-09-25T12:00:00.000Z', accepted: true, verified: true } }));
    const client = createExchangeAutoReplyClient({ dispatch });
    await expect(client.set(binding, { mailboxId, state: 'Scheduled', message: 'Away', start: '2026-09-24T12:00:00.000Z', end: '2026-09-25T12:00:00.000Z' })).resolves.toMatchObject({ verified: true });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'mailbox.autoreply.set', parameters: expect.objectContaining({ message: 'Away' }) }));
    await expect(client.set(binding, { mailboxId, state: 'Scheduled', message: 'Away', start: '2026-09-25T12:00:00.000Z', end: '2026-09-24T12:00:00.000Z' })).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('treats a lost set response as uncertain', async () => {
    const client = createExchangeAutoReplyClient({ dispatch: async () => { throw new Error('closed'); } });
    await expect(client.set(binding, { mailboxId, state: 'Disabled', message: '', start: null, end: null })).rejects.toMatchObject({ code: 'unknown_write_outcome' });
  });
});

describe('Exchange mailbox address contract', () => {
  const mailboxId = mailbox.id;
  it('dispatches only fixed primary and alias operations', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: {
      mailboxId, primarySmtpAddress: 'new@example.com', aliases: ['old@example.com'], policyEnabled: false, accepted: true, verified: true } }));
    const client = createExchangeAddressesClient({ dispatch });
    await expect(client.write(binding, 'mailbox.primary.set', { mailboxId, address: 'new@example.com' })).resolves.toMatchObject({ verified: true });
    await expect(client.write(binding, 'mailbox.alias.add', { mailboxId, address: 'old@example.com' })).resolves.toMatchObject({ accepted: true });
    await expect(client.write(binding, 'mailbox.alias.remove', { mailboxId, address: 'old@example.com' })).resolves.toMatchObject({ accepted: true });
    expect(dispatch.mock.calls.map(([request]) => request.operation)).toEqual(['mailbox.primary.set', 'mailbox.alias.add', 'mailbox.alias.remove']);
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain('certificate');
  });
  it('rejects extra input before dispatch and treats a lost alias response as uncertain', async () => {
    const dispatch = vi.fn(async () => { throw new Error('closed'); });
    const client = createExchangeAddressesClient({ dispatch });
    await expect(client.write(binding, 'mailbox.alias.add', { mailboxId, address: 'a@example.com', command: 'Remove-Mailbox' } as never)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    await expect(client.write(binding, 'mailbox.alias.add', { mailboxId, address: 'a@example.com' })).rejects.toMatchObject({ code: 'unknown_write_outcome' });
  });
});

describe('Exchange delegation contract', () => {
  const mailboxId = mailbox.id, delegateId = '66666666-6666-4666-8666-666666666666';
  it('lists only bounded, mailbox-bound direct delegation rows', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true,
      data: { mailboxId, entries: [{ delegateAddress: 'delegate@example.com', fullAccess: true, sendAs: false, sendOnBehalf: true }],
        partial: false, checkedAt: '2026-09-25T00:00:00Z' } }));
    const client = createExchangeDelegationClient({ dispatch });
    await expect(client.list(binding, mailboxId)).resolves.toMatchObject({ mailboxId, entries: [expect.objectContaining({ fullAccess: true })] });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'mailbox.delegation.list', parameters: { mailboxId } }));
    dispatch.mockImplementationOnce(async request => ({ requestId: request.requestId, ok: true,
      data: { mailboxId: delegateId, entries: [], partial: false, checkedAt: '2026-09-25T00:00:00Z' } }));
    await expect(client.list(binding, mailboxId)).rejects.toMatchObject({ code: 'provider_unreachable' });
  });
  it('dispatches one typed right per write and verifies both mailbox identities', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true,
      data: { mailboxId, delegateId, delegateAddress: 'delegate@example.com', fullAccess: true,
        sendAs: false, sendOnBehalf: false, accepted: true, verified: true } }));
    const client = createExchangeDelegationClient({ dispatch });
    await expect(client.set(binding, { mailboxId, delegateId, right: 'FullAccess', enabled: true })).resolves.toMatchObject({ verified: true });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'mailbox.delegation.set',
      parameters: { mailboxId, delegateId, right: 'FullAccess', enabled: true } }));
    await expect(client.set(binding, { mailboxId, delegateId: mailboxId, right: 'SendAs', enabled: true })).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('Exchange message trace contract', () => {
  const search = { start: '2026-09-22T00:00:00.000Z', end: '2026-09-23T00:00:00.000Z',
    sender: null, recipient: 'recipient@example.com', status: null, cursor: null };
  const row = { messageTraceId: mailbox.id, received: '2026-09-22T12:00:00.000Z', sender: 'sender@example.com',
    recipient: 'recipient@example.com', subject: 'Test', status: 'Delivered' };
  it('sends fixed read operations and accepts a bounded continuation', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: request.operation === 'trace.search'
      ? { rows: [row], next: { received: row.received, recipient: row.recipient }, partial: true, checkedAt: search.end }
      : { messageTraceId: row.messageTraceId, recipient: row.recipient, events: [{ date: row.received, event: 'DELIVER', detail: 'Delivered' }], partial: false } }));
    const client = createExchangeTraceClient({ dispatch });
    await expect(client.search(binding, search)).resolves.toMatchObject({ partial: true });
    await expect(client.detail(binding, { messageTraceId: row.messageTraceId, recipient: row.recipient })).resolves.toMatchObject({ events: [expect.objectContaining({ event: 'DELIVER' })] });
    expect(dispatch.mock.calls.map(([request]) => request.operation)).toEqual(['trace.search', 'trace.detail']);
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain('certificate');
  });
  it('rejects injected parameters and a cursor not present in its page', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true,
      data: { rows: [row], next: { received: row.received, recipient: 'different@example.com' }, partial: true, checkedAt: search.end } }));
    const client = createExchangeTraceClient({ dispatch });
    await expect(client.search(binding, { ...search, command: 'Remove-Mailbox' } as never)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    await expect(client.search(binding, search)).rejects.toMatchObject({ code: 'provider_unreachable' });
  });
});
