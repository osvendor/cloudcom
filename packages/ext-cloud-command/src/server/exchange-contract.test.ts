import { describe, expect, it, vi } from 'vitest';
import { createExchangeAddressesClient, createExchangeAutoReplyClient, createExchangeDelegationClient, createExchangeForwardingClient, createExchangeMailboxInventoryClient, ExchangeWorkerError } from './exchange-contract';

const binding = {
  organizationId: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222',
  clientId: '33333333-3333-4333-8333-333333333333', credentialVersion: 'cert-2026-09', connectionGeneration: 7,
};
const mailbox = {
  id: '44444444-4444-4444-8444-444444444444', primarySmtpAddress: 'test@example.com', recipientType: 'UserMailbox',
  archiveEnabled: false, mailboxBytes: 12, archiveBytes: null, collectedAt: '2026-09-22T00:00:00.000Z', statisticsUnavailable: false,
};
describe('Exchange worker contract', () => {
  it('dispatches only the fixed bounded mailbox inventory operation', async () => {
    const dispatch = vi.fn(async request => ({ requestId: request.requestId, ok: true, data: { records: [mailbox], partial: false, collectedAt: mailbox.collectedAt } }));
    const result = await createExchangeMailboxInventoryClient({ dispatch })(binding, { pageSize: 25 });
    expect(result.records).toEqual([mailbox]);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ ...binding, operation: 'mailbox.inventory', parameters: { pageSize: 25 }, requestId: expect.any(String) }));
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain('certificate');
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
