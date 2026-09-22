import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  selectLimit: vi.fn(), execute: vi.fn(), contextEvents: [] as string[], authorize: vi.fn(), create: vi.fn(),
  commit: vi.fn(), end: vi.fn(), lease: vi.fn(), touch: vi.fn(), policy: vi.fn(), prompt: vi.fn(), dispatch: vi.fn(), audit: vi.fn(),
}));
vi.mock('../../db', () => ({
  withDbAccessContext: async (_ctx: unknown, fn: () => Promise<unknown>) => { m.contextEvents.push('tx-open'); try { return await fn(); } finally { m.contextEvents.push('tx-close'); } },
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: m.selectLimit })) })) })) })),
    execute: m.execute,
  },
}));
vi.mock('../../db/schema', () => ({ portalRemoteSessions: { id: 's.id', portalUserId: 's.user', orgId: 's.org', authEpoch: 's.epoch', deviceId: 's.device' }, devices: { id: 'd.id', orgId: 'd.org', agentId: 'd.agent', hostname: 'd.host' } }));
vi.mock('../../services/portalRemoteAuthority', () => ({ authorizePortalRemote: m.authorize }));
vi.mock('../../services/portalRemoteSessionStore', () => ({ createPortalDesktopSession: m.create, commitPortalDesktopStartIntent: m.commit, endPortalDesktopSession: m.end, PORTAL_DESKTOP_START_TIMEOUT_MS: 120000 }));
vi.mock('../../services/portalRemoteLease', () => ({ preparePortalRemoteLease: m.lease, touchPortalRemoteViewer: m.touch }));
vi.mock('../../services/remoteAccessPolicy', () => ({ resolveDesktopSessionPolicy: m.policy }));
vi.mock('../../services/agentCommandRelay', () => ({ dispatchCommandToAgent: (...a: unknown[]) => { m.contextEvents.push('dispatch'); return m.dispatch(...a); } }));
vi.mock('../remote/helpers', () => ({ createDesktopStartCommandId: () => 'desk-start-11111111-1111-4111-8111-111111111111-33333333-3333-4333-8333-333333333333', getIceServers: () => [], resolveRemoteSessionPromptConfig: m.prompt }));
vi.mock('./helpers', () => ({ validatePortalCookieCsrfRequest: () => null, writePortalAudit: m.audit }));
vi.mock('./remoteRateLimit', () => ({ portalRemoteStartRateLimit: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../../services/remoteDesktopTerminalIntent', () => ({ buildStopDesktopCommand: (id: string, generation: bigint) => ({ id: `desk-stop-${id}-${generation}`, type: 'stop_desktop', payload: { sessionId: id, terminalGeneration: generation.toString() } }) }));

import { portalDesktopRoutes } from './remoteDesktop';

const SESSION = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const principal = { id: 'portal-user', orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', authEpoch: 3,
  email: 'customer@example.test', name: 'Customer', contactId: null, receiveNotifications: true, status: 'active' };
const row = (extra = {}) => ({ session: { id: SESSION, deviceId: DEVICE, assignmentId: 'grant', assignmentVersion: 2, authEpoch: 3, status: 'pending', terminationPhase: 'none', terminalGeneration: null, desktopStartGeneration: 2n, hardDeadline: new Date(Date.now() + 60_000), createdAt: new Date(), webrtcAnswer: null, ...extra }, device: { agentId: 'agent-1', hostname: 'desktop' } });
function app(user = principal) { const a = new Hono(); a.use('*', async (c, next) => { c.set('portalAuth', { user, token: 'x', authMethod: 'bearer', timezone: 'UTC' }); await next(); }); a.route('/', portalDesktopRoutes); return a; }
function request(path: string, init: RequestInit = {}) { return app().request(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } }); }

beforeEach(() => {
  vi.clearAllMocks(); m.contextEvents.length = 0;
  m.selectLimit.mockResolvedValue([row()]); m.execute.mockResolvedValue([]);
  m.authorize.mockResolvedValue({ ok: true, device: { revocationLeaseProtocolVersion: 1, desktopFenceProtocolVersion: 1 } });
  m.create.mockResolvedValue({ ok: true, session: { id: SESSION, status: 'pending' } });
  m.commit.mockImplementation(async () => { m.contextEvents.push('commit'); return { ok: true, generation: 2n }; });
  m.lease.mockImplementation(async () => { m.contextEvents.push('lease'); return { ok: true, lease: { token: 'opaque', expiresAt: Date.now() + 60_000, hardDeadline: Date.now() + 60_000, renewEverySec: 20, graceSec: 15 } }; });
  m.touch.mockResolvedValue({ ok: true }); m.policy.mockResolvedValue({ idleTimeoutMinutes: 5, maxSessionDurationHours: 1 });
  m.prompt.mockResolvedValue({ mode: 'off' }); m.dispatch.mockResolvedValue({ status: 'sent' });
  m.end.mockResolvedValue({ ok: true, terminalGeneration: 3n });
});

describe('portal desktop routes', () => {
  it.each(['owner mismatch', 'wrong organization', 'stale auth epoch'])('denies %s without invoking start services', async () => {
    m.selectLimit.mockResolvedValue([]);
    const response = await request(`/remote/sessions/${SESSION}/offer`, { method: 'POST', body: JSON.stringify({ offer: 'v=0' }) });
    expect(response.status).toBe(404); expect(m.commit).not.toHaveBeenCalled(); expect(m.lease).not.toHaveBeenCalled(); expect(m.dispatch).not.toHaveBeenCalled();
  });

  it('refuses an expired assignment on a live read and fences it through end', async () => {
    m.authorize.mockResolvedValue({ ok: false, reason: 'assignment_unavailable' });
    const response = await request(`/remote/sessions/${SESSION}`);
    expect(response.status).toBe(403); expect(m.end).toHaveBeenCalledWith(SESSION, expect.objectContaining({ id: principal.id, orgId: principal.orgId, authEpoch: 3 }));
  });

  it('requires both agent protocol declarations before creating a portal session', async () => {
    m.authorize.mockResolvedValue({ ok: true, device: { revocationLeaseProtocolVersion: 0, desktopFenceProtocolVersion: 1 } });
    const response = await request('/remote/sessions', { method: 'POST', body: JSON.stringify({ deviceId: DEVICE, transport: 'webrtc' }) });
    expect(response.status).toBe(503); expect(m.create).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });

  it('commits the start intent before preparing a lease and publishing the agent command', async () => {
    const response = await request(`/remote/sessions/${SESSION}/offer`, { method: 'POST', body: JSON.stringify({ offer: 'v=0 offer' }) });
    expect(response.status).toBe(200);
    const commitEvent = m.contextEvents.indexOf('commit');
    const closeBeforeLease = m.contextEvents.indexOf('tx-close', commitEvent);
    const leaseEvent = m.contextEvents.indexOf('lease');
    const leaseCall = m.lease.mock.invocationCallOrder[0]!;
    const commitCall = m.commit.mock.invocationCallOrder[0]!;
    const dispatchCall = m.dispatch.mock.invocationCallOrder[0]!;
    expect(closeBeforeLease).toBeGreaterThan(commitEvent); expect(closeBeforeLease).toBeLessThan(leaseEvent);
    expect(commitCall).toBeLessThan(leaseCall); expect(leaseCall).toBeLessThan(dispatchCall);
    expect(m.dispatch).toHaveBeenCalledWith('agent-1', expect.objectContaining({ type: 'start_desktop', payload: expect.objectContaining({ startGeneration: '2' }) }));
  });

  it('does not publish a start command when lease preparation is denied', async () => {
    m.lease.mockResolvedValue({ ok: false, reason: 'permissions_changed' });
    const response = await request(`/remote/sessions/${SESSION}/offer`, { method: 'POST', body: JSON.stringify({ offer: 'v=0' }) });
    expect(response.status).toBe(503);
    expect(m.dispatch).not.toHaveBeenCalledWith('agent-1', expect.objectContaining({ type: 'start_desktop' }));
    expect(m.end).toHaveBeenCalled();
  });

  it('passes the consent prompt contract to the agent start command', async () => {
    m.prompt.mockResolvedValue({ mode: 'consent', consentUnavailableBehavior: 'deny', notifyOnEnd: true, showIndicator: true });
    await request(`/remote/sessions/${SESSION}/offer`, { method: 'POST', body: JSON.stringify({ offer: 'v=0' }) });
    expect(m.dispatch).toHaveBeenCalledWith('agent-1', expect.objectContaining({ payload: expect.objectContaining({ prompt: expect.objectContaining({ mode: 'consent', technicianName: 'Customer', consentTimeoutMs: 30000 }) }) }));
  });

  it('retries a pending terminal fence with the same stop identity', async () => {
    const terminal = row({ status: 'disconnected', terminationPhase: 'pending', terminalGeneration: 3n });
    m.selectLimit.mockResolvedValue([terminal]);
    m.end.mockResolvedValue({ ok: false, reason: 'not_live' });
    const response = await request(`/remote/sessions/${SESSION}/end`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    expect(m.dispatch).toHaveBeenCalledWith('agent-1', { id: `desk-stop-${SESSION}-3`, type: 'stop_desktop', payload: { sessionId: SESSION, terminalGeneration: '3' } });
  });
});
