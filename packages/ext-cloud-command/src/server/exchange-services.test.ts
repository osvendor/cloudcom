import { describe, expect, it, vi } from 'vitest';
import { createExchangeMailboxInventoryService } from './exchange-services';
import type { AdministrationConnection } from './admin-execution';
import type { ExchangeWorkerRequest } from './exchange-contract';

const org = '11111111-1111-4111-8111-111111111111', actor = '22222222-2222-4222-8222-222222222222';
const connection: AdministrationConnection = { id: '33333333-3333-4333-8333-333333333333', orgId: org, tenantId: '44444444-4444-4444-8444-444444444444', clientId: '55555555-5555-4555-8555-555555555555', enabled: true, generation: 4, credentialVersion: 'cert-1', permissionManifestVersion: 'business-standard-v1' };
function setup() {
  let current: AdministrationConnection | null = connection;
  const authorize = vi.fn(async (): Promise<{ actorId: string } | null> => ({ actorId: actor }));
  const loadConnection = vi.fn(async () => current);
  const registry = { provision: vi.fn(async () => {}), revoke: vi.fn(async () => {}) };
  const worker = { dispatch: vi.fn(async (request: ExchangeWorkerRequest): Promise<unknown> => ({ requestId: request.requestId, ok: true, data: { records: [], partial: false, collectedAt: '2026-09-22T00:00:00.000Z' } })) };
  const audit = vi.fn(async (_event: { action: string; result: string }) => {});
  return { authorize, loadConnection, registry, worker, audit, service: createExchangeMailboxInventoryService({ authorize, loadConnection, registry, worker, audit }), change: (value: Partial<AdministrationConnection>) => { current = { ...connection, ...value }; } };
}
describe('Exchange mailbox inventory attachment', () => {
  it('derives and provisions the descriptor from the existing connection, then dispatches one fixed operation', async () => {
    const s = setup();
    await expect(s.service.inventory({}, org, { pageSize: 25 })).resolves.toMatchObject({ records: [] });
    expect(s.registry.provision).toHaveBeenCalledWith({ organizationId: org, tenantId: connection.tenantId, clientId: connection.clientId, credentialVersion: connection.credentialVersion, connectionGeneration: 4 });
    expect(s.worker.dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'mailbox.inventory', parameters: { pageSize: 25 } }));
    expect(JSON.stringify(s.registry.provision.mock.calls)).not.toContain('certificate');
    expect(s.audit.mock.calls.map(([event]) => event.action)).toEqual(['cloudcommand.microsoft.exchange.inventory.intent', 'cloudcommand.microsoft.exchange.inventory.outcome']);
  });
  it('rejects injected operation data and unauthorized callers before connection or worker access', async () => {
    const s = setup(); s.authorize.mockResolvedValue(null);
    await expect(s.service.inventory({}, org, { pageSize: 1, command: 'Get-Mailbox' })).rejects.toMatchObject({ code: 'invalid_operation' });
    await expect(s.service.inventory({}, org, {})).rejects.toMatchObject({ code: 'access_denied' });
    expect(s.loadConnection).not.toHaveBeenCalled(); expect(s.registry.provision).not.toHaveBeenCalled(); expect(s.worker.dispatch).not.toHaveBeenCalled();
  });
  it('does not dispatch or return results after connection generation changes', async () => {
    const s = setup(); s.registry.provision.mockImplementation(async () => { s.change({ generation: 5 }); });
    await expect(s.service.inventory({}, org, {})).rejects.toMatchObject({ code: 'connection_changed' });
    expect(s.worker.dispatch).not.toHaveBeenCalled();
  });
  it('discards a completed worker response if the connection changes while it is in flight', async () => {
    const s = setup(); s.worker.dispatch.mockImplementation(async request => { s.change({ credentialVersion: 'cert-2' }); return { requestId: request.requestId, ok: true, data: { records: [], partial: false, collectedAt: '2026-09-22T00:00:00.000Z' } }; });
    await expect(s.service.inventory({}, org, {})).rejects.toMatchObject({ code: 'connection_changed' });
    expect(s.audit).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'failure', details: expect.objectContaining({ code: 'connection_changed' }) }));
  });
  it('revokes the local descriptor by organization after the primary connection lifecycle disables it', async () => {
    const s = setup(); await s.service.revoke(org); expect(s.registry.revoke).toHaveBeenCalledWith(org);
  });
  it('supports an internal post-connect provision hook without accepting a partial connection', async () => {
    const s = setup(); await s.service.provision(connection);
    expect(s.registry.provision).toHaveBeenCalledWith(expect.objectContaining({ organizationId: org, connectionGeneration: 4 }));
    await expect(s.service.provision({ ...connection, enabled: false } as unknown as AdministrationConnection)).rejects.toMatchObject({ code: 'connection_not_ready' });
  });
});

describe('Exchange forwarding administration', () => {
  const mailboxId = '66666666-6666-4666-8666-666666666666';
  it('requires mutation authorization and audits a bounded, verified change', async () => {
    const s = setup();
    s.worker.dispatch.mockImplementation(async request => ({ requestId: request.requestId, ok: true,
      data: { mailboxId, smtpAddress: 'new@example.com', keepCopy: true, internalRecipient: null, accepted: true, verified: true } }));
    await expect(s.service.forwardingSet({}, org, { mailboxId, smtpAddress: 'new@example.com', keepCopy: true })).resolves.toMatchObject({ verified: true });
    expect(s.authorize).toHaveBeenCalledWith({}, org, true);
    expect(s.worker.dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'mailbox.forwarding.set', parameters: { mailboxId, smtpAddress: 'new@example.com', keepCopy: true } }));
    expect(s.audit.mock.calls.map(([event]) => event.action)).toEqual(['cloudcommand.microsoft.exchange.forwarding.set.intent', 'cloudcommand.microsoft.exchange.forwarding.set.outcome']);
  });
  it('does not dispatch when permission or generation changes, and marks a lost write outcome uncertain', async () => {
    const s = setup(); s.authorize.mockResolvedValue(null);
    await expect(s.service.forwardingSet({}, org, { mailboxId, smtpAddress: null, keepCopy: false })).rejects.toMatchObject({ code: 'access_denied' });
    expect(s.worker.dispatch).not.toHaveBeenCalled();
    s.authorize.mockResolvedValue({ actorId: actor });
    s.registry.provision.mockImplementation(async () => { s.change({ generation: 5 }); });
    await expect(s.service.forwardingSet({}, org, { mailboxId, smtpAddress: null, keepCopy: false })).rejects.toMatchObject({ code: 'connection_changed' });
    expect(s.worker.dispatch).not.toHaveBeenCalled();
    s.change({ generation: 4 }); s.registry.provision.mockImplementation(async () => {});
    s.worker.dispatch.mockRejectedValue(new Error('socket closed'));
    await expect(s.service.forwardingSet({}, org, { mailboxId, smtpAddress: null, keepCopy: false })).rejects.toMatchObject({ code: 'unknown_write_outcome' });
  });
});

describe('Exchange automatic reply administration', () => {
  const mailboxId = '66666666-6666-4666-8666-666666666666';
  it('rejects invalid schedules before dispatch and omits reply content from audit', async () => {
    const s = setup();
    await expect(s.service.autoReplySet({}, org, { mailboxId, state: 'Scheduled', message: 'Private reply', start: '2026-09-25T00:00:00Z', end: '2026-09-24T00:00:00Z' })).rejects.toMatchObject({ code: 'invalid_operation' });
    expect(s.worker.dispatch).not.toHaveBeenCalled();
    s.worker.dispatch.mockImplementation(async request => ({ requestId: request.requestId, ok: true, data: { mailboxId,
      state: 'Enabled', internalMessage: 'Private reply', externalMessage: 'Private reply', externalAudience: 'All', start: null, end: null, accepted: true, verified: true } }));
    await expect(s.service.autoReplySet({}, org, { mailboxId, state: 'Enabled', message: 'Private reply', start: null, end: null })).resolves.toMatchObject({ verified: true });
    expect(s.authorize).toHaveBeenCalledWith({}, org, true);
    expect(JSON.stringify(s.audit.mock.calls)).not.toContain('Private reply');
    expect(s.audit.mock.calls.map(([event]) => event.action)).toEqual(['cloudcommand.microsoft.exchange.autoreply.set.intent', 'cloudcommand.microsoft.exchange.autoreply.set.outcome']);
  });
});

describe('Exchange mailbox address administration', () => {
  const mailboxId = '66666666-6666-4666-8666-666666666666';
  it('requires manager authorization and audits a field-scoped alias write', async () => {
    const s = setup();
    s.worker.dispatch.mockImplementation(async request => ({ requestId: request.requestId, ok: true,
      data: { mailboxId, primarySmtpAddress: 'owner@example.com', aliases: ['new@example.com'], policyEnabled: false, accepted: true, verified: true } }));
    await expect(s.service.addressWrite({}, org, 'mailbox.alias.add', { mailboxId, address: 'new@example.com' })).resolves.toMatchObject({ verified: true });
    expect(s.authorize).toHaveBeenCalledWith({}, org, true);
    expect(s.worker.dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'mailbox.alias.add', parameters: { mailboxId, address: 'new@example.com' } }));
    expect(s.audit.mock.calls.map(([event]) => event.action)).toEqual(['cloudcommand.microsoft.exchange.mailbox.alias.add.intent', 'cloudcommand.microsoft.exchange.mailbox.alias.add.outcome']);
  });
  it('refuses an invalid address and a stale connection before dispatch', async () => {
    const s = setup();
    await expect(s.service.addressWrite({}, org, 'mailbox.primary.set', { mailboxId, address: 'bad' })).rejects.toMatchObject({ code: 'invalid_operation' });
    s.registry.provision.mockImplementation(async () => { s.change({ generation: 5 }); });
    await expect(s.service.addressWrite({}, org, 'mailbox.alias.remove', { mailboxId, address: 'old@example.com' })).rejects.toMatchObject({ code: 'connection_changed' });
    expect(s.worker.dispatch).not.toHaveBeenCalled();
  });
});

describe('Exchange mailbox delegation administration', () => {
  const mailboxId = '66666666-6666-4666-8666-666666666666', delegateId = '77777777-7777-4777-8777-777777777777';
  it('requires manager authorization and audits one right without raw provider details', async () => {
    const s = setup();
    s.worker.dispatch.mockImplementation(async request => ({ requestId: request.requestId, ok: true,
      data: { mailboxId, delegateId, delegateAddress: 'delegate@example.com', fullAccess: true,
        sendAs: false, sendOnBehalf: false, accepted: true, verified: true } }));
    await expect(s.service.delegationSet({}, org, { mailboxId, delegateId, right: 'FullAccess', enabled: true })).resolves.toMatchObject({ verified: true });
    expect(s.authorize).toHaveBeenCalledWith({}, org, true);
    expect(s.worker.dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'mailbox.delegation.set',
      parameters: { mailboxId, delegateId, right: 'FullAccess', enabled: true } }));
    expect(s.audit.mock.calls.map(([event]) => event.action)).toEqual(['cloudcommand.microsoft.exchange.delegation.set.intent', 'cloudcommand.microsoft.exchange.delegation.set.outcome']);
  });
  it('rejects self-delegation before worker dispatch', async () => {
    const s = setup();
    await expect(s.service.delegationSet({}, org, { mailboxId, delegateId: mailboxId, right: 'SendAs', enabled: true })).rejects.toMatchObject({ code: 'invalid_operation' });
    expect(s.worker.dispatch).not.toHaveBeenCalled();
  });
});
