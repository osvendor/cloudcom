import { describe, expect, it, vi } from 'vitest';
import { createExchangeMailboxInventoryClient, ExchangeWorkerError } from './exchange-contract';

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
