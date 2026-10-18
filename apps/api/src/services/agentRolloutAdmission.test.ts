import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ eval: vi.fn(), healthy: vi.fn(), ready: true }));
vi.mock('./redis', () => ({ getRedis: () => mocks.ready ? { status: 'ready', eval: mocks.eval } : null }));
vi.mock('./capacityGuard', () => ({ canRunAgentUpdateWork: mocks.healthy }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.ready = true;
  vi.stubEnv('CLOUDCOM_UPDATE_GUARD_ENABLED', 'true');
  mocks.eval.mockResolvedValue([1, 'admitted']); mocks.healthy.mockReturnValue(true);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('agent rollout admission transport', () => {
  it('does no Redis work when disabled or no update is required', async () => {
    const mod = await import('./agentRolloutAdmission');
    vi.stubEnv('CLOUDCOM_UPDATE_GUARD_ENABLED', 'false');
    expect((await mod.admitAgentUpdate({ deviceId: 'device-1', targets: { agent: '1.2.3' } })).allowed).toBe(true);
    vi.stubEnv('CLOUDCOM_UPDATE_GUARD_ENABLED', 'true');
    await mod.admitAgentUpdate({ deviceId: 'device-1', targets: {} });
    expect(mocks.eval).not.toHaveBeenCalled();
  });
  it('uses one shared atomic script with hashed authenticated site identity and pressure signal', async () => {
    const { admitAgentUpdate } = await import('./agentRolloutAdmission');
    mocks.healthy.mockReturnValue(false);
    await admitAgentUpdate({ deviceId: 'device-1', siteKey: 'org:site', targets: { agent: '1.2.3', watchdog: '1.2.3' } });
    const args = mocks.eval.mock.calls[0];
    expect(args[1]).toBe(3);
    expect(args.slice(2,5).every((s: string) => s.includes('{agent-rollout}'))).toBe(true);
    expect(args[7]).toMatch(/^[a-f0-9]{64}$/);
    expect(args[10]).toBe('0');
    expect(args.slice(11)).toEqual([2,1,2,120000,600000,1800000,60000]);
  });
  it('fails closed on Redis outage, malformed targets and command errors', async () => {
    const { admitAgentUpdate } = await import('./agentRolloutAdmission');
    mocks.ready = false;
    expect((await admitAgentUpdate({ deviceId: 'd', targets: { agent: '1' } })).allowed).toBe(false);
    mocks.ready = true;
    expect((await admitAgentUpdate({ deviceId: 'd', targets: { agent: '' } })).reason).toBe('invalid-update');
    mocks.eval.mockRejectedValue(new Error('secret connection'));
    expect(await admitAgentUpdate({ deviceId: 'd', targets: { agent: '1' } })).toEqual({ allowed: false, reason: 'admission-unavailable' });
  });
  it('bounds a stalled Redis request and keeps the actual operation single flight', async () => {
    vi.useFakeTimers();
    const { admitAgentUpdate } = await import('./agentRolloutAdmission');
    let finish!: (value: unknown) => void;
    mocks.eval.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = admitAgentUpdate({ deviceId: 'd', targets: { agent: '1' } });
    await vi.advanceTimersByTimeAsync(251);
    expect((await first).allowed).toBe(false);
    expect((await admitAgentUpdate({ deviceId: 'd', targets: { agent: '1' } })).reason).toBe('admission-pending');
    expect(mocks.eval).toHaveBeenCalledTimes(1);
    finish([1, 'admitted']); await Promise.resolve();
  });
  it('withholds only update fields while preserving heartbeat and credential operations', async () => {
    const { guardHeartbeatUpdates } = await import('./agentRolloutAdmission');
    mocks.eval.mockResolvedValue([0, 'server-pressure']);
    const response = { upgradeTo: '2', helperUpgradeTo: '2', watchdogUpgradeTo: '2', commands: [{ type: 'ping' }], rotateToken: { token: 'test' }, configUpdate: { x: true } };
    await guardHeartbeatUpdates({ deviceId: 'd', siteKey: 'org:site', versions: { agent: '1' }, response });
    expect(response).toEqual({ upgradeTo: null, helperUpgradeTo: undefined, watchdogUpgradeTo: undefined, commands: [{ type: 'ping' }], rotateToken: { token: 'test' }, configUpdate: { x: true } });
    expect(mocks.eval.mock.calls.map(a => a[8])).toEqual(['observe','admit']);
  });
  it('keeps admitted component offers intact', async () => {
    const { guardHeartbeatUpdates } = await import('./agentRolloutAdmission');
    const response = { upgradeTo: '2', watchdogUpgradeTo: '2' };
    await guardHeartbeatUpdates({ deviceId: 'd', siteKey: 'org:site', versions: { agent: '1' }, response });
    expect(response).toEqual({ upgradeTo: '2', watchdogUpgradeTo: '2' });
  });
  it('keeps watchdog-reported version separate from its main-agent recovery offer', async () => {
    const { guardHeartbeatUpdates } = await import('./agentRolloutAdmission');
    await guardHeartbeatUpdates({ deviceId: 'd', siteKey: 'org:site', versions: { watchdog: '1' }, response: { upgradeTo: '2', watchdogUpgradeTo: '2' } });
    expect(JSON.parse(mocks.eval.mock.calls[0][9])).toEqual({ watchdog: '1' });
    expect(JSON.parse(mocks.eval.mock.calls[1][9])).toEqual({ agent: '2', watchdog: '2' });
  });
  it('refuses invalid capacity configuration instead of dropping limits', async () => {
    const { agentRolloutLimits } = await import('./agentRolloutAdmission');
    for (const value of ['0','-1','100','NaN','2.5']) expect(() => agentRolloutLimits({ CLOUDCOM_UPDATE_MAX_CONCURRENT: value })).toThrow();
    expect(() => agentRolloutLimits({ CLOUDCOM_UPDATE_GUARD_ENABLED: 'maybe' })).toThrow();
    expect(agentRolloutLimits({})).toMatchObject({ concurrent: 2, perSite: 1, starts: 2 });
  });
});
