import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  selectLimitMock, updateWhereMock, finalizeMock, dispatchMock, contextEvents, eqMock,
} = vi.hoisted(() => ({
  selectLimitMock: vi.fn(),
  updateWhereMock: vi.fn(),
  finalizeMock: vi.fn(),
  dispatchMock: vi.fn(),
  contextEvents: [] as string[],
  eqMock: vi.fn((left, right) => ({ op: 'eq', left, right })),
}));

vi.mock('drizzle-orm', async importOriginal => ({
  ...await importOriginal<typeof import('drizzle-orm')>(),
  eq: eqMock,
}));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    contextEvents.push('system-open');
    try { return await fn(); } finally { contextEvents.push('system-close'); }
  },
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: selectLimitMock })) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhereMock })) })),
  },
}));
vi.mock('../db/schema', () => ({
  portalRemoteSessions: {
    id: 'prs.id', deviceId: 'prs.deviceId', terminalGeneration: 'prs.terminalGeneration', terminationPhase: 'prs.terminationPhase',
  },
}));
vi.mock('./portalRemoteSessionStore', () => ({ finalizePortalDesktopStart: finalizeMock }));
vi.mock('./agentCommandRelay', () => ({
  dispatchCommandToAgent: (...args: unknown[]) => { contextEvents.push('dispatch'); return dispatchMock(...args); },
}));

import { handlePortalRemoteAgentResult } from './portalRemoteAgent';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const START_ID = `desk-start-${SESSION_ID}-33333333-3333-4333-8333-333333333333`;
const input = (overrides: Partial<Parameters<typeof handlePortalRemoteAgentResult>[0]> = {}) => ({
  commandId: START_ID, status: 'completed', result: { sessionId: SESSION_ID, answer: 'v=0 answer' }, deviceId: DEVICE_ID, agentId: 'agent-1', ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  contextEvents.length = 0;
  selectLimitMock.mockResolvedValue([{ id: SESSION_ID }]);
  updateWhereMock.mockResolvedValue([]);
  finalizeMock.mockResolvedValue({ status: 'active' });
  dispatchMock.mockResolvedValue({ status: 'sent' });
});

describe('handlePortalRemoteAgentResult', () => {
  it('fences an endpoint disconnect and sends stop only after committing the device-bound transition', async () => {
    updateWhereMock.mockReturnValueOnce({ returning: vi.fn().mockResolvedValue([{ terminalGeneration: 4n }]) });
    await expect(handlePortalRemoteAgentResult(input({ commandId: `desk-disconnect-${SESSION_ID}`,
      result: { sessionId: SESSION_ID, event: 'peer_disconnected' } }))).resolves.toBe(true);
    expect(eqMock).toHaveBeenCalledWith('prs.deviceId', DEVICE_ID);
    expect(eqMock).toHaveBeenCalledWith('prs.terminationPhase', 'none');
    expect(contextEvents).toEqual(['system-open', 'system-close', 'dispatch']);
    expect(dispatchMock).toHaveBeenCalledWith('agent-1', expect.objectContaining({ id: `desk-stop-${SESSION_ID}-4` }));
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'failed', result: { sessionId: SESSION_ID, event: 'peer_disconnected' } },
    { result: { sessionId: DEVICE_ID, event: 'peer_disconnected' } },
    { result: { sessionId: SESSION_ID, event: 'session_started' } },
  ])('ignores an invalid disconnect proof: %j', async proof => {
    await expect(handlePortalRemoteAgentResult(input({ commandId: `desk-disconnect-${SESSION_ID}`, ...proof }))).resolves.toBe(true);
    expect(updateWhereMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('does not advance the fence on a duplicate endpoint disconnect', async () => {
    updateWhereMock.mockReturnValueOnce({ returning: vi.fn().mockResolvedValue([]) });
    await handlePortalRemoteAgentResult(input({ commandId: `desk-disconnect-${SESSION_ID}`, result: { sessionId: SESSION_ID, event: 'peer_disconnected' } }));
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('cannot apply a disconnect to another device’s session', async () => {
    selectLimitMock.mockResolvedValue([]);
    await expect(handlePortalRemoteAgentResult(input({ commandId: `desk-disconnect-${SESSION_ID}`, result: { sessionId: SESSION_ID, event: 'peer_disconnected' } }))).resolves.toBe(false);
    expect(updateWhereMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('leaves staff handling available when no portal row belongs to the reporting device', async () => {
    selectLimitMock.mockResolvedValue([]);
    await expect(handlePortalRemoteAgentResult(input())).resolves.toBe(false);
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('does not finalize a claimed result for a different portal session', async () => {
    await expect(handlePortalRemoteAgentResult(input({ result: { sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', answer: 'v=0' } }))).resolves.toBe(true);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('finalizes only an exact start command with the reporting device and exact claimed session', async () => {
    await expect(handlePortalRemoteAgentResult(input())).resolves.toBe(true);
    expect(finalizeMock).toHaveBeenCalledWith(SESSION_ID, DEVICE_ID, START_ID, {
      ok: true, answer: 'v=0 answer', consentReason: undefined,
    });
  });

  it('turns a consent-denied completion into a fenced failed finalization', async () => {
    await expect(handlePortalRemoteAgentResult(input({ result: { sessionId: SESSION_ID, answer: 'must-not-activate', event: 'consent_denied' } }))).resolves.toBe(true);
    expect(finalizeMock).toHaveBeenCalledWith(SESSION_ID, DEVICE_ID, START_ID, {
      ok: false, answer: 'must-not-activate', consentReason: undefined,
    });
  });

  it('accepts a stop result only through its exact terminal-generation CAS', async () => {
    const stopId = `desk-stop-${SESSION_ID}-7`;
    await expect(handlePortalRemoteAgentResult(input({ commandId: stopId, status: 'completed', result: { stopped: true } }))).resolves.toBe(true);
    expect(updateWhereMock).toHaveBeenCalledOnce();
    expect(eqMock).toHaveBeenCalledWith('prs.terminalGeneration', 7n);
    expect(eqMock).toHaveBeenCalledWith('prs.terminationPhase', 'pending');
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('dispatches durable stop only after the failed start finalization committed', async () => {
    finalizeMock.mockResolvedValue({ status: 'failed', sessionId: SESSION_ID, deviceId: DEVICE_ID, terminalGeneration: 9n });
    await expect(handlePortalRemoteAgentResult(input({ status: 'failed', result: { sessionId: SESSION_ID } }))).resolves.toBe(true);
    expect(contextEvents).toEqual(['system-open', 'system-close', 'dispatch']);
    expect(dispatchMock).toHaveBeenCalledWith('agent-1', {
      id: `desk-stop-${SESSION_ID}-9`, type: 'stop_desktop',
      payload: { sessionId: SESSION_ID, terminalGeneration: '9' },
    });
  });
});
