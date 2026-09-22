import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; hostname: string; displayName: string | null; status: string }>,
  authorize: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
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
  portalRemoteAssignments: { portalUserId: 'assignment.portalUserId', deviceId: 'assignment.deviceId', orgId: 'assignment.orgId', enabled: 'assignment.enabled', expiresAt: 'assignment.expiresAt' },
  portalRemoteSettings: { orgId: 'settings.orgId', enabled: 'settings.enabled' },
}));
vi.mock('../../services/portalRemoteFeature', () => ({ isPortalRemoteFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../../services/portalRemoteAuthority', () => ({ authorizePortalRemote: mocks.authorize }));
vi.mock('./remoteDesktop', () => ({ portalDesktopRoutes: new Hono() }));

import { portalRemoteRoutes } from './remote';

const principal = {
  id: 'portal-user', orgId: '11111111-1111-4111-8111-111111111111', authEpoch: 4,
  email: 'portal-user@example.test', name: 'Portal user', contactId: null,
  receiveNotifications: true, status: 'active', accessMode: 'remote_only' as const,
};

function app() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('portalAuth', { user: principal, token: 'test-token', authMethod: 'bearer', timezone: 'UTC' });
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
  mocks.authorize.mockResolvedValue(capable());
});

describe('GET /remote/devices WebRTC availability', () => {
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

  it('returns an empty list without calling authority when there are no grants', async () => {
    const response = await app().request('/remote/devices');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ devices: [] });
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
