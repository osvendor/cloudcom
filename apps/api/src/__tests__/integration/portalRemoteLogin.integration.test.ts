import './setup';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  devices,
  installedExtensions,
  organizations,
  partners,
  portalRemoteAssignments,
  portalRemoteSettings,
  portalUsers,
  sites,
  users,
} from '../../db/schema';
import { hashPassword } from '../../services/password';
import { authRoutes, portalAuthMiddleware } from '../../routes/portal/auth';
import { portalRemoteRoutes } from '../../routes/portal/remote';
import { getTestDb } from './setup';

describe.runIf(!!process.env.DATABASE_URL_APP)('portal remote list through real login', () => {
  const priorFeatureFlag = process.env.CLOUDCOM_REMOTE_ACCESS_ENABLED;

  beforeAll(() => {
    process.env.CLOUDCOM_REMOTE_ACCESS_ENABLED = 'true';
  });

  afterAll(() => {
    if (priorFeatureFlag === undefined) delete process.env.CLOUDCOM_REMOTE_ACCESS_ENABLED;
    else process.env.CLOUDCOM_REMOTE_ACCESS_ENABLED = priorFeatureFlag;
  });

  it('lists only the logged-in customer assignment and invalidates removal and epoch changes', async () => {
    const admin = getTestDb();
    const password = 'Synthetic-Remote-Login-156!';
    const [partner] = await admin.insert(partners).values({
      name: 'Remote login QA', slug: `remote-login-${crypto.randomUUID()}`, type: 'msp',
    }).returning();
    const [org] = await admin.insert(organizations).values({
      partnerId: partner!.id, name: 'Customer', slug: crypto.randomUUID(), currencyCode: 'USD',
    }).returning();
    const [site] = await admin.insert(sites).values({ orgId: org!.id, name: 'HQ' }).returning();
    const [staff] = await admin.insert(users).values({
      partnerId: partner!.id, email: `remote-staff-${crypto.randomUUID()}@example.test`, name: 'Remote admin',
    }).returning();
    const [assignedDevice, unassignedDevice] = await admin.insert(devices).values([
      { orgId: org!.id, siteId: site!.id, agentId: crypto.randomUUID(), hostname: 'assigned-host', osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '0.115.0', status: 'online' },
      { orgId: org!.id, siteId: site!.id, agentId: crypto.randomUUID(), hostname: 'unassigned-host', osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '0.115.0', status: 'online' },
    ]).returning();
    const passwordHash = await hashPassword(password);
    const [assignedUser, sameOrgUser] = await admin.insert(portalUsers).values([
      { orgId: org!.id, email: `assigned-${crypto.randomUUID()}@example.test`, passwordHash, status: 'active', accessMode: 'remote_only' },
      { orgId: org!.id, email: `unassigned-${crypto.randomUUID()}@example.test`, passwordHash, status: 'active', accessMode: 'remote_only' },
    ]).returning();
    await admin.insert(portalRemoteSettings).values({ orgId: org!.id, enabled: true });
    const [assignment] = await admin.insert(portalRemoteAssignments).values({
      orgId: org!.id, portalUserId: assignedUser!.id, deviceId: assignedDevice!.id, createdByUserId: staff!.id,
    }).returning();
    await admin.insert(installedExtensions).values({
      name: 'rustdeskaccess', enabled: true, lifecycleState: 'active', configuredVersion: 'test', activeVersion: 'test',
    });

    const app = new Hono();
    app.route('/api/v1/portal', authRoutes);
    app.use('/api/v1/portal/remote/*', portalAuthMiddleware);
    app.use('/api/v1/portal/devices', portalAuthMiddleware);
    // This intentionally minimal protected endpoint proves the real middleware
    // denies remote-only accounts before any normal portal device handler runs.
    app.get('/api/v1/portal/devices', c => c.json({ unexpected: true }));
    app.route('/api/v1/portal', portalRemoteRoutes);

    const login = async (email: string) => {
      const response = await app.request('/api/v1/portal/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, orgId: org!.id }),
      });
      expect(response.status).toBe(200);
      const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
      expect(cookie).toBeTruthy();
      return { Cookie: cookie! };
    };

    const assignedHeaders = await login(assignedUser!.email);
    const assignedList = await app.request('/api/v1/portal/remote/devices', { headers: assignedHeaders });
    expect(assignedList.status).toBe(200);
    expect((await assignedList.json()).devices.map((row: { id: string }) => row.id)).toEqual([assignedDevice!.id]);
    expect((await app.request('/api/v1/portal/devices', { headers: assignedHeaders })).status).toBe(403);

    const sameOrgHeaders = await login(sameOrgUser!.email);
    const sameOrgList = await app.request('/api/v1/portal/remote/devices', { headers: sameOrgHeaders });
    expect(sameOrgList.status).toBe(200);
    expect((await sameOrgList.json()).devices).toEqual([]);

    await admin.update(portalRemoteAssignments).set({ enabled: false }).where(eq(portalRemoteAssignments.id, assignment!.id));
    const removed = await app.request('/api/v1/portal/remote/devices', { headers: assignedHeaders });
    expect(removed.status).toBe(200);
    expect((await removed.json()).devices).toEqual([]);

    await admin.update(portalUsers).set({ authEpoch: sql`${portalUsers.authEpoch} + 1` }).where(eq(portalUsers.id, assignedUser!.id));
    expect((await app.request('/api/v1/portal/remote/devices', { headers: assignedHeaders })).status).toBe(401);
    expect(unassignedDevice).toBeDefined();
  });
});
