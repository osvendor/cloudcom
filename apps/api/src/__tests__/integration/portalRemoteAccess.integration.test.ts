import { describe, it, expect, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTestDb, getAppDb } from './setup';
import { db, withDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, users, portalUsers, portalRemoteAssignments, portalRemoteSettings, portalRemoteSessions } from '../../db/schema';
import { loadPortalRemoteAssignment } from '../../services/portalRemoteAuthority';
import { createPortalDesktopSession, commitPortalDesktopStartIntent, endPortalDesktopSession } from '../../services/portalRemoteSessionStore';
import { preparePortalRemoteLease, renewPortalRemoteLeaseIfPresent } from '../../services/portalRemoteLease';
import { getRedis } from '../../services/redis';

vi.mock('../../services/portalRemoteFeature', () => ({ isPortalRemoteFeatureEnabled: vi.fn().mockResolvedValue(true) }));
vi.mock('../../services/tenantStatus', () => ({ getActiveOrgTenant: vi.fn().mockResolvedValue({ partnerId: 'partner' }) }));
vi.mock('../../services/remoteAccessPolicy', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/remoteAccessPolicy')>(),
  checkRemoteAccess: vi.fn().mockResolvedValue({ allowed: true }),
  resolveDesktopSessionPolicy: vi.fn().mockResolvedValue({ maxSessionDurationHours: 1 }),
}));
vi.mock('../../config/partnerTrustMode', () => ({ partnerTrustMode: () => 'off' }));

async function fixture() {
  const admin = getTestDb();
  const [partner] = await admin.insert(partners).values({ name: 'Remote QA', slug: `remote-${crypto.randomUUID()}`, type: 'msp' }).returning();
  const [a, b] = await admin.insert(organizations).values(['a', 'b'].map(name => ({ partnerId: partner!.id, name, slug: crypto.randomUUID(), currencyCode: 'USD' }))).returning();
  const [staff] = await admin.insert(users).values({ partnerId: partner!.id, email: `${crypto.randomUUID()}@example.com`, name: 'Admin' }).returning();
  const [siteA] = await admin.insert(sites).values({ orgId: a!.id, name: 'A' }).returning();
  const [siteB] = await admin.insert(sites).values({ orgId: b!.id, name: 'B' }).returning();
  const [deviceA, deviceB] = await admin.insert(devices).values([
    { orgId: a!.id, siteId: siteA!.id, agentId: crypto.randomUUID(), hostname: 'A', osType: 'windows' as const, osVersion: '11', architecture: 'amd64', agentVersion: '0.115.0', status: 'online' as const },
    { orgId: b!.id, siteId: siteB!.id, agentId: crypto.randomUUID(), hostname: 'B', osType: 'windows' as const, osVersion: '11', architecture: 'amd64', agentVersion: '0.115.0', status: 'online' as const },
  ]).returning();
  const [alice, bob, outsider] = await admin.insert(portalUsers).values([
    { orgId: a!.id, email: 'alice@example.com', accessMode: 'remote_only' as const },
    { orgId: a!.id, email: 'bob@example.com', accessMode: 'remote_only' as const },
    { orgId: b!.id, email: 'outsider@example.com', accessMode: 'remote_only' as const },
  ]).returning();
  await admin.insert(portalRemoteSettings).values([{ orgId: a!.id, enabled: true }, { orgId: b!.id, enabled: true }]);
  const values = { orgId: a!.id, portalUserId: alice!.id, deviceId: deviceA!.id, createdByUserId: staff!.id };
  const [grant] = await admin.insert(portalRemoteAssignments).values(values).returning();
  const context = { scope: 'organization' as const, orgId: a!.id, accessibleOrgIds: [a!.id] };
  return { admin, a: a!, b: b!, staff: staff!, deviceA: deviceA!, deviceB: deviceB!, alice: alice!, bob: bob!, outsider: outsider!, values, grant: grant!, context };
}

describe('portal remote database authorization', () => {
  it('enforces forced RLS for all three tables as the real application role', async () => {
    const f = await fixture();
    const rows = await f.admin.execute(sql`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('portal_remote_settings','portal_remote_assignments','portal_remote_sessions')`);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    await withDbAccessContext(f.context, async () => {
      expect((await db.execute(sql`SELECT current_user AS role`))[0]!.role).toBe('breeze_app');
      expect(await db.select().from(portalRemoteSettings)).toHaveLength(1);
      expect(await db.update(portalRemoteSettings).set({ enabled: false }).where(eq(portalRemoteSettings.orgId, f.b.id)).returning()).toHaveLength(0);
      expect(await db.delete(portalRemoteSettings).where(eq(portalRemoteSettings.orgId, f.b.id)).returning()).toHaveLength(0);
    });
    await expect(withDbAccessContext(f.context, () => db.insert(portalRemoteAssignments).values({ ...f.values, orgId: f.b.id, portalUserId: f.outsider.id, deviceId: f.deviceB.id }))).rejects.toThrow();
    expect(await getAppDb().select().from(portalRemoteAssignments)).toHaveLength(0);
    await expect(getAppDb().insert(portalRemoteSessions).values({ orgId: f.a.id, portalUserId: f.alice.id, deviceId: f.deviceA.id, assignmentId: f.grant.id, assignmentVersion: 1, authEpoch: 1, transport: 'webrtc', hardDeadline: new Date(Date.now() + 60000) })).rejects.toThrow();
  });

  it('rejects cross-org device and identity links even for the database owner', async () => {
    const f = await fixture();
    await expect(f.admin.insert(portalRemoteAssignments).values({ ...f.values, deviceId: f.deviceB.id })).rejects.toThrow();
    await expect(f.admin.insert(portalRemoteAssignments).values({ ...f.values, portalUserId: f.outsider.id })).rejects.toThrow();
    await expect(f.admin.insert(portalRemoteSessions).values({ orgId: f.a.id, portalUserId: f.bob.id, deviceId: f.deviceA.id, assignmentId: f.grant.id, assignmentVersion: 1, authEpoch: 1, transport: 'webrtc', hardDeadline: new Date(Date.now() + 60000) })).rejects.toThrow();
  });

  it('does not turn organization membership into a device grant and rechecks live account state', async () => {
    const f = await fixture();
    const principal = { id: f.alice.id, orgId: f.a.id, authEpoch: 1 };
    await withDbAccessContext(f.context, async () => {
      expect(await loadPortalRemoteAssignment(principal, f.deviceA.id)).not.toBeNull();
      expect(await loadPortalRemoteAssignment({ ...principal, id: f.bob.id }, f.deviceA.id)).toBeNull();
      expect(await loadPortalRemoteAssignment(principal, f.deviceB.id)).toBeNull();
      expect(await loadPortalRemoteAssignment({ ...principal, authEpoch: 2 }, f.deviceA.id)).toBeNull();
      await db.update(portalUsers).set({ status: 'disabled' }).where(eq(portalUsers.id, f.alice.id));
      expect(await loadPortalRemoteAssignment(principal, f.deviceA.id)).toBeNull();
    });
  });

  it('increments assignment generations durably and cannot reparent grants', async () => {
    const f = await fixture();
    const [changed] = await f.admin.update(portalRemoteAssignments).set({ enabled: false, version: 1 }).where(eq(portalRemoteAssignments.id, f.grant.id)).returning();
    expect(changed!.version).toBe(2);
    await withDbAccessContext(f.context, async () => {
      expect(await loadPortalRemoteAssignment({ id: f.alice.id, orgId: f.a.id, authEpoch: 1 }, f.deviceA.id)).toBeNull();
    });
    await expect(f.admin.update(portalRemoteAssignments).set({ portalUserId: f.bob.id }).where(eq(portalRemoteAssignments.id, f.grant.id))).rejects.toThrow();
  });

  it('rejects a real device organization move and leaves grant and session ownership in the source org', async () => {
    const f = await fixture();
    const [session] = await f.admin.insert(portalRemoteSessions).values({
      orgId: f.a.id,
      portalUserId: f.alice.id,
      deviceId: f.deviceA.id,
      assignmentId: f.grant.id,
      assignmentVersion: f.grant.version,
      authEpoch: 1,
      transport: 'webrtc',
      hardDeadline: new Date(Date.now() + 60_000),
    }).returning();

    await expect(
      f.admin.update(devices).set({ orgId: f.b.id }).where(eq(devices.id, f.deviceA.id)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: '23503',
        constraint_name: 'portal_remote_assignment_device_org_fk',
      }),
    });

    const [device] = await f.admin.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, f.deviceA.id));
    const [grant] = await f.admin.select({ orgId: portalRemoteAssignments.orgId, deviceId: portalRemoteAssignments.deviceId }).from(portalRemoteAssignments).where(eq(portalRemoteAssignments.id, f.grant.id));
    const [preservedSession] = await f.admin.select({ orgId: portalRemoteSessions.orgId, deviceId: portalRemoteSessions.deviceId }).from(portalRemoteSessions).where(eq(portalRemoteSessions.id, session!.id));
    expect(device).toMatchObject({ orgId: f.a.id });
    expect(grant).toMatchObject({ orgId: f.a.id, deviceId: f.deviceA.id });
    expect(preservedSession).toMatchObject({ orgId: f.a.id, deviceId: f.deviceA.id });
  });

  it('commits an exact start before a fresh Redis-backed lease read, and rejects a replayed offer', async () => {
    const f = await fixture();
    await f.admin.update(portalRemoteSettings).set({ webrtcEnabled: true }).where(eq(portalRemoteSettings.orgId, f.a.id));
    await f.admin.update(devices).set({ revocationLeaseProtocolVersion: 1, desktopFenceProtocolVersion: 1 }).where(eq(devices.id, f.deviceA.id));
    const p = { id: f.alice.id, orgId: f.a.id, authEpoch: 1 };
    const created = await withDbAccessContext(f.context, () => createPortalDesktopSession(p, f.deviceA.id));
    expect(created.ok).toBe(true); if (!created.ok) return;
    const command = `desk-start-${created.session.id}-33333333-3333-4333-8333-333333333333`;
    const started = await withDbAccessContext(f.context, () => commitPortalDesktopStartIntent(created.session.id, p, command, 'v=0'));
    expect(started.ok).toBe(true);
    await expect(preparePortalRemoteLease(created.session.id, p)).resolves.toMatchObject({ ok: true });
    await withDbAccessContext(f.context, () => expect(commitPortalDesktopStartIntent(created.session.id, p, command, 'v=0')).resolves.toEqual({ ok: false, reason: 'not_pending' }));
    await getRedis()?.del(`portal:remote:lease:${created.session.id}`, `portal:remote:viewer:${created.session.id}`);
  });

  it('does not let another same-org user or another org end a portal session', async () => {
    const f = await fixture();
    const [session] = await f.admin.insert(portalRemoteSessions).values({ orgId: f.a.id, portalUserId: f.alice.id, deviceId: f.deviceA.id, assignmentId: f.grant.id, assignmentVersion: 1, authEpoch: 1, transport: 'webrtc', hardDeadline: new Date(Date.now() + 60_000) }).returning();
    await withDbAccessContext(f.context, () => expect(endPortalDesktopSession(session!.id, { id: f.bob.id, orgId: f.a.id, authEpoch: 1 })).resolves.toEqual({ ok: false, reason: 'not_found' }));
    await withDbAccessContext({ scope: 'organization', orgId: f.b.id, accessibleOrgIds: [f.b.id] }, () => expect(endPortalDesktopSession(session!.id, { id: f.outsider.id, orgId: f.b.id, authEpoch: 1 })).resolves.toEqual({ ok: false, reason: 'not_found' }));
  });

  it('revokes a real Redis lease and writes a terminal fence when its assignment is disabled', async () => {
    const f = await fixture();
    await f.admin.update(portalRemoteSettings).set({ webrtcEnabled: true }).where(eq(portalRemoteSettings.orgId, f.a.id));
    await f.admin.update(devices).set({ revocationLeaseProtocolVersion: 1, desktopFenceProtocolVersion: 1 }).where(eq(devices.id, f.deviceA.id));
    const p = { id: f.alice.id, orgId: f.a.id, authEpoch: 1 };
    const created = await withDbAccessContext(f.context, () => createPortalDesktopSession(p, f.deviceA.id));
    if (!created.ok) throw new Error('fixture session creation failed');
    await withDbAccessContext(f.context, () => commitPortalDesktopStartIntent(created.session.id, p, `desk-start-${created.session.id}-33333333-3333-4333-8333-333333333333`, 'v=0'));
    await expect(preparePortalRemoteLease(created.session.id, p)).resolves.toMatchObject({ ok: true });
    await f.admin.update(portalRemoteAssignments).set({ enabled: false }).where(eq(portalRemoteAssignments.id, f.grant.id));
    await expect(renewPortalRemoteLeaseIfPresent(created.session.id, { expectDeviceId: f.deviceA.id })).resolves.toMatchObject({ status: 'revoked', reason: 'permissions_changed' });
    const [fenced] = await f.admin.select({ phase: portalRemoteSessions.terminationPhase, generation: portalRemoteSessions.terminalGeneration }).from(portalRemoteSessions).where(eq(portalRemoteSessions.id, created.session.id));
    expect(fenced).toMatchObject({ phase: 'pending' }); expect(fenced!.generation).not.toBeNull();
  });

  it('revokes renewal and fences the session when the portal auth epoch changes', async () => {
    const f = await fixture();
    await f.admin.update(portalRemoteSettings).set({ webrtcEnabled: true }).where(eq(portalRemoteSettings.orgId, f.a.id));
    await f.admin.update(devices).set({ revocationLeaseProtocolVersion: 1, desktopFenceProtocolVersion: 1 }).where(eq(devices.id, f.deviceA.id));
    const p = { id: f.alice.id, orgId: f.a.id, authEpoch: 1 };
    const created = await withDbAccessContext(f.context, () => createPortalDesktopSession(p, f.deviceA.id));
    if (!created.ok) throw new Error('fixture session creation failed');
    await withDbAccessContext(f.context, () => commitPortalDesktopStartIntent(created.session.id, p, `desk-start-${created.session.id}-33333333-3333-4333-8333-333333333333`, 'v=0'));
    await expect(preparePortalRemoteLease(created.session.id, p)).resolves.toMatchObject({ ok: true });
    await f.admin.update(portalUsers).set({ authEpoch: sql`${portalUsers.authEpoch} + 1` }).where(eq(portalUsers.id, f.alice.id));
    await expect(renewPortalRemoteLeaseIfPresent(created.session.id, { expectDeviceId: f.deviceA.id })).resolves.toMatchObject({ status: 'revoked', reason: 'permissions_changed' });
    const [fenced] = await f.admin.select({ phase: portalRemoteSessions.terminationPhase, generation: portalRemoteSessions.terminalGeneration }).from(portalRemoteSessions).where(eq(portalRemoteSessions.id, created.session.id));
    expect(fenced).toMatchObject({ phase: 'pending' }); expect(fenced!.generation).not.toBeNull();
  });
});
