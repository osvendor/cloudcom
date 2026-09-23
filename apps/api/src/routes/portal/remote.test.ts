import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; hostname: string; displayName: string | null; status: string }>,
  targets: [] as Array<{ rustdeskId: string }>,
  authorize: vi.fn(),
  company: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => mocks.rows }), limit: async () => mocks.targets }),
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({ orderBy: () => ({ limit: async () => mocks.rows }) }),
          }),
        }),
      }),
    })),
  },
}));
vi.mock('../../db/schema', () => ({
  devices: { id: 'device.id', orgId: 'device.orgId', hostname: 'device.hostname', displayName: 'device.displayName', status: 'device.status' },
  portalNativeTargets: { orgId: 'target.orgId', deviceId: 'target.deviceId', enabled: 'target.enabled', rustdeskId: 'target.rustdeskId' },
  portalRemoteAssignments: { portalUserId: 'assignment.portalUserId', deviceId: 'assignment.deviceId', orgId: 'assignment.orgId', enabled: 'assignment.enabled', expiresAt: 'assignment.expiresAt' },
  portalRemoteSettings: { orgId: 'settings.orgId', enabled: 'settings.enabled' },
}));
vi.mock('../../services/portalRemoteFeature', () => ({ isPortalRemoteFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../../services/portalRemoteAuthority', () => ({ authorizePortalRemote: mocks.authorize }));
vi.mock('../../services/portalCompanyGateway', () => ({ checkPortalCompanyGateway: mocks.company }));
vi.mock('../../services/portalNativeLogin', () => ({ NATIVE_SESSION_PREFIX: 'ccn1.' }));
vi.mock('./remoteDesktop', () => ({ portalDesktopRoutes: new Hono() }));
vi.mock('./nativeAdmission', () => ({ portalNativeAdmissionRoutes: new Hono() }));
vi.mock('./nativeLogin', () => ({ portalNativeAuthorizeRoutes: new Hono() }));

import { portalRemoteRoutes } from './remote';

const principal = {
  id: 'portal-user', orgId: '11111111-1111-4111-8111-111111111111', authEpoch: 4,
  email: 'portal-user@example.test', name: 'Portal user', contactId: null,
  receiveNotifications: true, status: 'active', accessMode: 'remote_only' as const,
};

function app(auth: { token?: string; authMethod?: 'bearer' | 'cookie' } = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('portalAuth', { user: principal, token: auth.token ?? 'test-token',
      authMethod: auth.authMethod ?? 'bearer', timezone: 'UTC' });
    await next();
  });
  app.route('/', portalRemoteRoutes);
  return app;
}

const device = (id = '22222222-2222-4222-8222-222222222222') => ({
  id, hostname: `host-${id.slice(0, 4)}`, displayName: null, status: 'online',
});
const capable = (lease = 1, fence = 1) => ({
  ok: true as const,
  device: { revocationLeaseProtocolVersion: lease, desktopFenceProtocolVersion: fence },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.targets = [];
  vi.stubEnv('CLOUDCOM_NATIVE_ADMISSION_ENABLED', 'false');
  mocks.authorize.mockResolvedValue(capable());
  mocks.company.mockResolvedValue({ ok: true, orgId: principal.orgId });
});

describe('GET /remote/devices WebRTC availability', () => {
  it('denies a company mismatch before reading devices', async () => {
    mocks.company.mockResolvedValue({ ok: false, status: 403 });
    const response = await app().request('/remote/devices', { headers: { 'Cf-Access-Jwt-Assertion': 'test-assertion' } });
    expect(response.status).toBe(403);
    expect(mocks.company).toHaveBeenCalledWith('test-assertion', principal.orgId);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
  it('uses the browser-bound company claim for a native bearer and still gates browser sessions', async () => {
    const native = await app({ token: 'ccn1.' + 'A'.repeat(43) }).request('/remote/devices');
    expect(native.status).toBe(200);
    expect(mocks.company).not.toHaveBeenCalled();

    mocks.company.mockResolvedValue({ ok: false, status: 403 });
    const browser = await app({ token: 'browser-session', authMethod: 'cookie' }).request('/remote/devices');
    expect(browser.status).toBe(403);
    expect(mocks.company).toHaveBeenCalledWith(undefined, principal.orgId);
  });
  it('uses the authenticated portal principal for every assigned device', async () => {
    mocks.rows = [device(), device('33333333-3333-4333-8333-333333333333')];

    const response = await app().request('/remote/devices');

    expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenNthCalledWith(1,
      { id: principal.id, orgId: principal.orgId, authEpoch: principal.authEpoch }, mocks.rows[0]!.id, 'webrtc');
    expect(mocks.authorize).toHaveBeenNthCalledWith(2,
      { id: principal.id, orgId: principal.orgId, authEpoch: principal.authEpoch }, mocks.rows[1]!.id, 'webrtc');
  });

  it.each([
    'extension_disabled', 'assignment_unavailable', 'assignment_changed', 'device_unavailable',
    'transport_disabled', 'organization_unavailable', 'remote_control_denied', 'policy_denied',
  ])('advertises WebRTC as unavailable for authority denial %s', async reason => {
    mocks.rows = [device()];
    mocks.authorize.mockResolvedValue({ ok: false, reason });

    const response = await app().request('/remote/devices');
    const body = await response.json() as { devices: Array<{ transports: { webrtc: { available: boolean } } }> };

    expect(response.status).toBe(200);
    expect(body.devices[0]!.transports.webrtc.available).toBe(false);
  });

  it.each([
    ['missing lease protocol', 0, 1],
    ['unknown lease protocol', 2, 1],
    ['missing fence protocol', 1, 0],
    ['unknown fence protocol', 1, 2],
  ])('requires exact version 1 for %s', async (_name, lease, fence) => {
    mocks.rows = [device()];
    mocks.authorize.mockResolvedValue(capable(lease, fence));

    const response = await app().request('/remote/devices');
    const body = await response.json() as { devices: Array<{ transports: { webrtc: { available: boolean } } }> };

    expect(body.devices[0]!.transports.webrtc.available).toBe(false);
  });

  it('advertises WebRTC only for an authorized fence-capable device and keeps native unavailable', async () => {
    mocks.rows = [device()];

    const response = await app().request('/remote/devices');
    const body = await response.json() as { devices: Array<{ transports: { webrtc: { available: boolean }; rustdesk: { available: boolean } } }> };

    expect(body.devices[0]!.transports.webrtc).toEqual({ available: true });
    expect(body.devices[0]!.transports.rustdesk.available).toBe(false);
  });

  it('exposes a RustDesk peer ID only for an assigned device with native admission enabled and an enrolled target', async () => {
    vi.stubEnv('CLOUDCOM_NATIVE_ADMISSION_ENABLED', 'true');
    mocks.rows = [device()];
    mocks.targets = [{ rustdeskId: '48660403' }];

    const response = await app().request('/remote/devices');
    const body = await response.json() as { devices: Array<{ transports: { rustdesk: { available: boolean; peerId?: string } } }> };

    expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(
      { id: principal.id, orgId: principal.orgId, authEpoch: principal.authEpoch }, mocks.rows[0]!.id, 'rustdesk');
    expect(body.devices[0]!.transports.rustdesk).toEqual({ available: true, peerId: '48660403' });
  });

  it('never exposes an enrolled target when RustDesk authorization is denied', async () => {
    vi.stubEnv('CLOUDCOM_NATIVE_ADMISSION_ENABLED', 'true');
    mocks.rows = [device()];
    mocks.targets = [{ rustdeskId: '48660403' }];
    mocks.authorize.mockImplementation(async (_principal, _deviceId, transport) =>
      transport === 'rustdesk' ? { ok: false, reason: 'transport_disabled' } : capable());

    const response = await app().request('/remote/devices');
    const body = await response.json() as { devices: Array<{ transports: { rustdesk: { available: boolean; peerId?: string } } }> };

    expect(body.devices[0]!.transports.rustdesk.available).toBe(false);
    expect(body.devices[0]!.transports.rustdesk).not.toHaveProperty('peerId');
  });

  it('returns an empty list without calling authority when there are no grants', async () => {
    const response = await app().request('/remote/devices');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ devices: [] });
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
