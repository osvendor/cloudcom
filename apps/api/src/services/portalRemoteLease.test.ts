import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectLimitMock, returningMock, getRedisMock, authorizeMock } = vi.hoisted(() => ({
  selectLimitMock: vi.fn(), returningMock: vi.fn(), getRedisMock: vi.fn(), authorizeMock: vi.fn(),
}));
vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: selectLimitMock })) })) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: returningMock })) })) })),
  },
}));
vi.mock('../db/schema', () => ({
  portalRemoteSessions: { id: 's.id', orgId: 's.org', portalUserId: 's.user', deviceId: 's.device', assignmentId: 's.assignment', assignmentVersion: 's.assignmentVersion', authEpoch: 's.epoch', transport: 's.transport', status: 's.status', terminationPhase: 's.phase', hardDeadline: 's.deadline', desktopStartGeneration: 's.start', terminalGeneration: 's.terminal', endedAt: 's.ended' },
  devices: { id: 'd.id', orgId: 'd.org', revocationLeaseProtocolVersion: 'd.lease', desktopFenceProtocolVersion: 'd.fence' },
}));
vi.mock('./redis', () => ({ getRedis: getRedisMock }));
vi.mock('./portalRemoteAuthority', () => ({ authorizePortalRemote: authorizeMock }));

import { preparePortalRemoteLease, renewPortalRemoteLeaseIfPresent, touchPortalRemoteViewer } from './portalRemoteLease';

const SESSION = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL = { id: 'portal-user', orgId: 'org', authEpoch: 3 };
const ROW = {
  id: SESSION, orgId: 'org', portalUserId: 'portal-user', deviceId: 'device', assignmentId: 'assignment', assignmentVersion: 2,
  authEpoch: 3, status: 'active', terminationPhase: 'none', hardDeadline: new Date(Date.now() + 60_000),
  startGeneration: 4n, terminalGeneration: null, revocationLeaseProtocolVersion: 1, desktopFenceProtocolVersion: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  selectLimitMock.mockResolvedValue([ROW]);
  returningMock.mockResolvedValue([{ terminalGeneration: 5n }]);
  authorizeMock.mockResolvedValue({ ok: true });
  getRedisMock.mockReturnValue({ set: vi.fn(), del: vi.fn(), get: vi.fn().mockResolvedValue('viewer'), eval: vi.fn().mockResolvedValue(JSON.stringify({ token: 'opaque', hardDeadline: ROW.hardDeadline.getTime() })) });
});

describe('portal remote lease', () => {
  it('issues only a Redis-backed, device-authenticated lease with the durable deadline', async () => {
    const result = await preparePortalRemoteLease(SESSION, PRINCIPAL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lease.renewEverySec).toBe(20);
      expect(result.lease.graceSec).toBe(15);
      expect(result.lease.hardDeadline).toBe(ROW.hardDeadline.getTime());
      expect(result.lease.token).not.toContain(SESSION);
    }
    expect(authorizeMock).toHaveBeenCalledWith(PRINCIPAL, 'device', 'webrtc', { assignmentId: 'assignment', assignmentVersion: 2 });
  });

  it('returns null solely for a missing portal session so staff renewal can fall through', async () => {
    selectLimitMock.mockResolvedValue([]);
    await expect(renewPortalRemoteLeaseIfPresent(SESSION, { expectDeviceId: 'device' })).resolves.toBeNull();
  });

  it('does not recreate a missing Redis lease during renew', async () => {
    const redis = { set: vi.fn(), del: vi.fn(), get: vi.fn().mockResolvedValue('viewer'), eval: vi.fn().mockResolvedValue(null) };
    getRedisMock.mockReturnValue(redis);
    await expect(renewPortalRemoteLeaseIfPresent(SESSION, { expectDeviceId: 'device' })).resolves.toEqual({ status: 'unavailable' });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects a foreign device before renewing or exposing a grant', async () => {
    const redis = getRedisMock();
    await expect(renewPortalRemoteLeaseIfPresent(SESSION, { expectDeviceId: 'other-device' })).resolves.toEqual({ status: 'forbidden' });
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('fences a definitive authorization loss and returns revoked with a terminal generation', async () => {
    authorizeMock.mockResolvedValue({ ok: false, reason: 'assignment_changed' });
    await expect(renewPortalRemoteLeaseIfPresent(SESSION, { expectDeviceId: 'device' })).resolves.toEqual({ status: 'revoked', reason: 'permissions_changed', terminalGeneration: '5' });
  });

  it('requires viewer presence and never extends it during agent renewal', async () => {
    const redis = { set: vi.fn(), del: vi.fn(), get: vi.fn().mockResolvedValue(null), eval: vi.fn() };
    getRedisMock.mockReturnValue(redis);
    await expect(renewPortalRemoteLeaseIfPresent(SESSION, { expectDeviceId: 'device' })).resolves.toEqual({ status: 'revoked', reason: 'session_ended', terminalGeneration: '5' });
    expect(redis.eval).not.toHaveBeenCalled();

    redis.get.mockResolvedValue('viewer');
    redis.eval.mockResolvedValue(JSON.stringify({ token: 'opaque', hardDeadline: ROW.hardDeadline.getTime() }));
    await expect(renewPortalRemoteLeaseIfPresent(SESSION, { expectDeviceId: 'device' })).resolves.toMatchObject({ status: 'renewed' });
    expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining('PEXPIRE'), 1, `portal:remote:lease:${SESSION}`, expect.any(String));
  });

  it('touches viewer presence only after owned live authorization, with no ownership disclosure', async () => {
    const redis = getRedisMock();
    await expect(touchPortalRemoteViewer(SESSION, PRINCIPAL)).resolves.toMatchObject({ ok: true });
    expect(redis.set).toHaveBeenCalledWith(`portal:remote:viewer:${SESSION}`, '1', 'PX', expect.any(Number));
    const viewerTtl = redis.set.mock.calls[0]![3] as number;
    expect(viewerTtl).toBeGreaterThan(0);
    expect(viewerTtl).toBeLessThanOrEqual(60_000);
    selectLimitMock.mockResolvedValue([]);
    await expect(touchPortalRemoteViewer(SESSION, PRINCIPAL)).resolves.toEqual({ ok: false, reason: 'forbidden' });
  });
});
