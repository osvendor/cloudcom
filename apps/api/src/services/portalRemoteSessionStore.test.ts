import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hasDbAccessContextMock, forUpdateMock, returningMock, authorizeMock, policyMock, setMock, insertMock, insertValuesMock, neMock } = vi.hoisted(() => ({
  hasDbAccessContextMock: vi.fn(() => true),
  forUpdateMock: vi.fn(),
  returningMock: vi.fn(),
  authorizeMock: vi.fn(),
  policyMock: vi.fn(),
  setMock: vi.fn(),
  insertMock: vi.fn(),
  insertValuesMock: vi.fn(),
  neMock: vi.fn((left, right) => ({ op: 'ne', left, right })),
}));

vi.mock('drizzle-orm', async importOriginal => ({
  ...await importOriginal<typeof import('drizzle-orm')>(),
  ne: neMock,
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => ({ for: forUpdateMock })) })) })) })),
    insert: insertMock.mockImplementation(() => ({ values: insertValuesMock.mockImplementation(() => ({ returning: returningMock })) })),
    update: vi.fn(() => ({ set: setMock.mockImplementation(() => ({ where: vi.fn(() => ({ returning: returningMock })) })) })),
  },
  hasDbAccessContext: hasDbAccessContextMock,
}));
vi.mock('../db/schema', () => ({
  portalRemoteSessions: {
    id: 'prs.id', orgId: 'prs.orgId', portalUserId: 'prs.portalUserId', deviceId: 'prs.deviceId',
    assignmentId: 'prs.assignmentId', assignmentVersion: 'prs.assignmentVersion', authEpoch: 'prs.authEpoch',
    transport: 'prs.transport', status: 'prs.status', webrtcOffer: 'prs.offer', webrtcAnswer: 'prs.answer',
    desktopStartCommandId: 'prs.commandId', desktopStartGeneration: 'prs.startGeneration',
    terminalGeneration: 'prs.terminalGeneration', terminationPhase: 'prs.terminationPhase', hardDeadline: 'prs.hardDeadline', endedAt: 'prs.endedAt',
    createdAt: 'prs.createdAt', desktopPromptMode: 'prs.desktopPromptMode',
  },
}));
vi.mock('./portalRemoteAuthority', () => ({ authorizePortalRemote: authorizeMock }));
vi.mock('./remoteAccessPolicy', () => ({ resolveDesktopSessionPolicy: policyMock }));

import {
  PORTAL_DESKTOP_MAX_DURATION_MS,
  commitPortalDesktopStartIntent,
  createPortalDesktopSession,
  endPortalDesktopSession,
  finalizePortalDesktopStart,
} from './portalRemoteSessionStore';

const PRINCIPAL = { id: 'portal-user', orgId: 'org', authEpoch: 3 };
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = `desk-start-${SESSION_ID}-33333333-3333-4333-8333-333333333333`;
const lockedPending = () => ({
  id: SESSION_ID, orgId: 'org', portalUserId: 'portal-user', deviceId: DEVICE_ID,
  assignmentId: 'assignment', assignmentVersion: 2, status: 'pending', terminationPhase: 'none',
  // This is intentionally created per test. A module-level timestamp can age
  // past the two-minute offer window while Vitest loads the focused suite.
  createdAt: new Date(), hardDeadline: new Date('2030-01-01T00:00:00Z'),
});

beforeEach(() => {
  vi.clearAllMocks();
  hasDbAccessContextMock.mockReturnValue(true);
  authorizeMock.mockResolvedValue({ ok: true, assignment: { id: 'assignment', version: 2 } });
  policyMock.mockResolvedValue({ maxSessionDurationHours: 4 });
  forUpdateMock.mockResolvedValue([lockedPending()]);
  returningMock.mockResolvedValue([{ generation: 1n }]);
});

describe('portalRemoteSessionStore', () => {
  it('creates a WebRTC-only session with assignment/auth snapshots and a capped hard deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T00:00:00Z'));
    returningMock.mockResolvedValue([{ id: SESSION_ID, transport: 'webrtc' }]);
    const created = await createPortalDesktopSession(PRINCIPAL, DEVICE_ID);
    expect(created).toMatchObject({ ok: true, session: { id: SESSION_ID, transport: 'webrtc' } });
    expect(authorizeMock).toHaveBeenCalledWith(PRINCIPAL, DEVICE_ID, 'webrtc');
    const values = insertValuesMock.mock.calls[0]![0];
    expect(values).toMatchObject({ orgId: 'org', portalUserId: 'portal-user', authEpoch: 3, deviceId: DEVICE_ID, assignmentId: 'assignment', assignmentVersion: 2, transport: 'webrtc', status: 'pending' });
    expect(values.hardDeadline.getTime()).toBe(Date.now() + 4 * 60 * 60 * 1000);
    vi.useRealTimers();
  });

  it('requires a transaction before create, start, or end decisions', async () => {
    hasDbAccessContextMock.mockReturnValue(false);
    await expect(createPortalDesktopSession(PRINCIPAL, DEVICE_ID)).rejects.toThrow(/db access context/i);
    await expect(commitPortalDesktopStartIntent(SESSION_ID, PRINCIPAL, COMMAND_ID, 'v=0')).rejects.toThrow(/db access context/i);
    await expect(endPortalDesktopSession(SESSION_ID, PRINCIPAL)).rejects.toThrow(/db access context/i);
    expect(forUpdateMock).not.toHaveBeenCalled();
  });

  it('reauthorizes the locked assignment/version before the one pending-only start transition', async () => {
    const result = await commitPortalDesktopStartIntent(SESSION_ID, PRINCIPAL, COMMAND_ID, 'v=0');
    expect(result).toEqual({ ok: true, generation: 1n });
    expect(authorizeMock).toHaveBeenLastCalledWith(PRINCIPAL, DEVICE_ID, 'webrtc', { assignmentId: 'assignment', assignmentVersion: 2 });
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'connecting', webrtcOffer: 'v=0', desktopStartCommandId: COMMAND_ID }));
  });

  it('refuses reoffers and authorization failure without writing', async () => {
    forUpdateMock.mockResolvedValue([{ ...lockedPending(), status: 'connecting' }]);
    await expect(commitPortalDesktopStartIntent(SESSION_ID, PRINCIPAL, COMMAND_ID, 'v=0')).resolves.toEqual({ ok: false, reason: 'not_pending' });
    expect(setMock).not.toHaveBeenCalled();
    forUpdateMock.mockResolvedValue([lockedPending()]);
    authorizeMock.mockResolvedValue({ ok: false, reason: 'assignment_changed' });
    await expect(commitPortalDesktopStartIntent(SESSION_ID, PRINCIPAL, COMMAND_ID, 'v=0')).resolves.toEqual({ ok: false, reason: 'authorization_denied' });
    expect(setMock).not.toHaveBeenCalled();
  });

  it('refuses a pending session whose hard deadline has elapsed', async () => {
    forUpdateMock.mockResolvedValue([{ ...lockedPending(), hardDeadline: new Date(0) }]);
    await expect(commitPortalDesktopStartIntent(SESSION_ID, PRINCIPAL, COMMAND_ID, 'v=0')).resolves.toEqual({ ok: false, reason: 'expired' });
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });

  it('refuses a pending session whose short offer window elapsed before authorization or mutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T00:02:00Z'));
    forUpdateMock.mockResolvedValue([{ ...lockedPending(), createdAt: new Date('2026-09-21T00:00:00Z') }]);
    await expect(commitPortalDesktopStartIntent(SESSION_ID, PRINCIPAL, COMMAND_ID, 'v=0'))
      .resolves.toEqual({ ok: false, reason: 'terminal' });
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('finalizes only the exact device/start command CAS, with failure fenced for durable stop', async () => {
    returningMock.mockResolvedValue([{ id: SESSION_ID }]);
    await expect(finalizePortalDesktopStart(SESSION_ID, DEVICE_ID, COMMAND_ID, { ok: true, answer: 'answer' })).resolves.toEqual({ status: 'active' });
    expect(setMock).toHaveBeenLastCalledWith({ status: 'active', webrtcAnswer: 'answer' });
    returningMock.mockResolvedValue([{ id: SESSION_ID, deviceId: DEVICE_ID, terminalGeneration: 2n }]);
    await expect(finalizePortalDesktopStart(SESSION_ID, DEVICE_ID, COMMAND_ID, { ok: false })).resolves.toEqual({ status: 'failed', sessionId: SESSION_ID, deviceId: DEVICE_ID, terminalGeneration: 2n });
    expect(setMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', terminationPhase: 'pending' }));
  });

  it('requires explicit consent proof before accepting an answer for a consent-mode session', async () => {
    returningMock.mockResolvedValue([{ id: SESSION_ID }]);
    await finalizePortalDesktopStart(SESSION_ID, DEVICE_ID, COMMAND_ID, { ok: true, answer: 'answer' });
    expect(neMock).toHaveBeenCalledWith('prs.desktopPromptMode', 'consent');

    vi.clearAllMocks();
    returningMock.mockResolvedValue([{ id: SESSION_ID }]);
    await finalizePortalDesktopStart(SESSION_ID, DEVICE_ID, COMMAND_ID, { ok: true, answer: 'answer', consentReason: 'user' });
    expect(neMock).not.toHaveBeenCalled();
  });

  it('ends a live owned session by bumping and returning the terminal generation', async () => {
    forUpdateMock.mockResolvedValue([{ id: SESSION_ID, orgId: 'org', portalUserId: 'portal-user', deviceId: DEVICE_ID, status: 'active' }]);
    returningMock.mockResolvedValue([{ terminalGeneration: '9007199254740993' }]);
    await expect(endPortalDesktopSession(SESSION_ID, PRINCIPAL)).resolves.toEqual({ ok: true, sessionId: SESSION_ID, orgId: 'org', portalUserId: 'portal-user', deviceId: DEVICE_ID, terminalGeneration: 9007199254740993n });
    expect(setMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'disconnected', terminationPhase: 'pending' }));
  });
});
