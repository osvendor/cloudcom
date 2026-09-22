import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { db, withDbAccessContext } from '../../db';
import { devices, portalRemoteSessions } from '../../db/schema';
import { authorizePortalRemote, type PortalRemotePrincipal } from '../../services/portalRemoteAuthority';
import { createPortalDesktopSession, commitPortalDesktopStartIntent, endPortalDesktopSession, PORTAL_DESKTOP_START_TIMEOUT_MS } from '../../services/portalRemoteSessionStore';
import { preparePortalRemoteLease, touchPortalRemoteViewer } from '../../services/portalRemoteLease';
import { resolveDesktopSessionPolicy } from '../../services/remoteAccessPolicy';
import { buildStopDesktopCommand } from '../../services/remoteDesktopTerminalIntent';
import { dispatchCommandToAgent } from '../../services/agentCommandRelay';
import { createDesktopStartCommandId, getIceServers, resolveRemoteSessionPromptConfig } from '../remote/helpers';
import { validatePortalCookieCsrfRequest, writePortalAudit } from './helpers';
import { portalRemoteStartRateLimit } from './remoteRateLimit';

export const portalDesktopRoutes = new Hono();
portalDesktopRoutes.post('/remote/sessions', portalRemoteStartRateLimit);
portalDesktopRoutes.post('/remote/sessions/:id/offer', portalRemoteStartRateLimit);
const idSchema = z.string().uuid();
function principal(c: Context): PortalRemotePrincipal {
  const { user } = c.get('portalAuth');
  return { id: user.id, orgId: user.orgId, authEpoch: user.authEpoch! };
}
function scoped<T>(p: PortalRemotePrincipal, action: () => Promise<T>) {
  return withDbAccessContext({ scope: 'organization', orgId: p.orgId, accessibleOrgIds: [p.orgId], userId: null }, action);
}
async function owned(p: PortalRemotePrincipal, sessionId: string) {
  const [row] = await db.select({ session: portalRemoteSessions, device: { agentId: devices.agentId, hostname: devices.hostname } })
    .from(portalRemoteSessions).innerJoin(devices, and(eq(devices.id, portalRemoteSessions.deviceId), eq(devices.orgId, portalRemoteSessions.orgId)))
    .where(and(eq(portalRemoteSessions.id, sessionId), eq(portalRemoteSessions.portalUserId, p.id), eq(portalRemoteSessions.orgId, p.orgId), eq(portalRemoteSessions.authEpoch, p.authEpoch))).limit(1);
  return row ?? null;
}
async function end(p: PortalRemotePrincipal, sessionId: string) {
  const row = await scoped(p, async () => {
    const found = await owned(p, sessionId);
    if (!found) return null;
    const result = await endPortalDesktopSession(sessionId, p);
    return { found, result };
  });
  if (!row) return null;
  if (row.result.ok) {
    await dispatchCommandToAgent(row.found.device.agentId, buildStopDesktopCommand(sessionId, row.result.terminalGeneration));
  } else if (row.found.session.terminationPhase === 'pending' && row.found.session.terminalGeneration !== null) {
    await dispatchCommandToAgent(row.found.device.agentId, buildStopDesktopCommand(sessionId, row.found.session.terminalGeneration));
  }
  return scoped(p, () => owned(p, sessionId));
}

portalDesktopRoutes.post('/remote/sessions', zValidator('json', z.object({ deviceId: idSchema, transport: z.enum(['webrtc','rustdesk']) }).strict()), async c => {
  const csrf = validatePortalCookieCsrfRequest(c);
  if (csrf) return c.json({ error: csrf }, 403);
  const p = principal(c); const input = c.req.valid('json');
  const decision = await scoped(p, () => authorizePortalRemote(p, input.deviceId, input.transport));
  if (!decision.ok) return c.json({ error: 'This computer is not available for remote access' }, 403);
  if (input.transport !== 'webrtc') return c.json({ error: 'Managed RustDesk is not ready', code: 'transport_unavailable' }, 503);
  if (decision.device.revocationLeaseProtocolVersion !== 1 || decision.device.desktopFenceProtocolVersion !== 1) {
    return c.json({ error: 'This computer needs a remote access agent update', code: 'agent_upgrade_required' }, 503);
  }
  const created = await scoped(p, async () => {
    // All customer starts for this device serialize. Existing technician
    // sessions are also treated as busy; the endpoint remains the final arbiter.
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.deviceId}, 0))`);
    // An abandoned landing page must not reserve a computer for twelve hours.
    // Pending rows have never published a start command, so expiry is confirmed.
    await db.execute(sql`UPDATE portal_remote_sessions SET status='disconnected',ended_at=now(),desktop_start_generation=1,terminal_generation=1,termination_phase='confirmed' WHERE device_id=${input.deviceId}::uuid AND status='pending' AND desktop_start_generation=0 AND created_at <= now() - interval '120 seconds'`);
    const busy = await db.execute(sql`SELECT id FROM remote_sessions WHERE device_id=${input.deviceId}::uuid AND type='desktop' AND status IN ('pending','connecting','active') UNION ALL SELECT id FROM portal_remote_sessions WHERE device_id=${input.deviceId}::uuid AND status IN ('pending','connecting','active') AND hard_deadline>now() LIMIT 1`);
    if (busy.length) return { ok: false as const, reason: 'busy' };
    return createPortalDesktopSession(p, input.deviceId);
  });
  if (!created.ok) return c.json({ error: created.reason === 'busy' ? 'This computer already has a remote session' : 'Remote access is unavailable' }, 409);
  writePortalAudit(c, { orgId: p.orgId, actorId: p.id, actorType: 'user', action: 'portal.remote.created', resourceType: 'device', resourceId: input.deviceId, details: { principalType: 'portal_user', sessionId: created.session.id, transport: 'webrtc' } });
  return c.json({ session: { id: created.session.id, status: created.session.status, transport: 'webrtc' }, launch: { url: `/portal/remote/${created.session.id}` } }, 201);
});

portalDesktopRoutes.get('/remote/sessions/:id', async c => {
  const parsed = idSchema.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'Session unavailable' }, 404);
  const p = principal(c); const row = await scoped(p, () => owned(p, parsed.data));
  if (!row) return c.json({ error: 'Session unavailable' }, 404);
  if (['pending','connecting','active'].includes(row.session.status)) {
    const access = await scoped(p, () => authorizePortalRemote(p, row.session.deviceId, 'webrtc', { assignmentId: row.session.assignmentId, assignmentVersion: row.session.assignmentVersion }));
    if (!access.ok || row.session.hardDeadline.getTime() <= Date.now()
      || (row.session.status === 'pending' && Date.now() - row.session.createdAt.getTime() >= PORTAL_DESKTOP_START_TIMEOUT_MS)) {
      await end(p, row.session.id);
      return c.json({ error: 'Remote access has ended' }, 403);
    }
    if (row.session.status !== 'pending') {
      const presence = await touchPortalRemoteViewer(row.session.id, p);
      if (!presence.ok) return c.json({ error: 'Remote access is unavailable' }, presence.reason === 'forbidden' ? 403 : 503);
    }
  }
  return c.json({ session: { id: row.session.id, status: row.session.status, hostname: row.device.hostname,
    webrtcAnswer: row.session.webrtcAnswer, terminationPhase: row.session.terminationPhase },
    iceServers: getIceServers({ sessionId: row.session.id, userId: `portal:${p.id}`, deviceId: row.session.deviceId }) });
});

portalDesktopRoutes.post('/remote/sessions/:id/offer', zValidator('json', z.object({ offer: z.string().min(1).max(65535) }).strict()), async c => {
  const csrf = validatePortalCookieCsrfRequest(c);
  if (csrf) return c.json({ error: csrf }, 403);
  const parsed = idSchema.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'Session unavailable' }, 404);
  const p = principal(c); const row = await scoped(p, () => owned(p, parsed.data));
  if (!row) return c.json({ error: 'Session unavailable' }, 404);
  const policy = await scoped(p, () => resolveDesktopSessionPolicy(row.session.deviceId));
  const prompt = await scoped(p, () => resolveRemoteSessionPromptConfig(row.session.deviceId));
  const commandId = createDesktopStartCommandId(row.session.id);
  const intent = await scoped(p, () => commitPortalDesktopStartIntent(row.session.id, p, commandId, c.req.valid('json').offer, prompt.mode));
  if (!intent.ok) return c.json({ error: 'This session cannot be started' }, 409);
  const lease = await preparePortalRemoteLease(row.session.id, p);
  if (!lease.ok) { await end(p, row.session.id); return c.json({ error: 'Secure session authorization is unavailable' }, 503); }
  const current = await scoped(p, () => owned(p, row.session.id));
  if (!current || current.session.terminationPhase !== 'none' || current.session.desktopStartGeneration !== intent.generation) {
    return c.json({ error: 'This session has ended' }, 409);
  }
  const dispatched = await dispatchCommandToAgent(row.device.agentId, { id: commandId, type: 'start_desktop', payload: {
    sessionId: row.session.id, startGeneration: intent.generation.toString(), offer: c.req.valid('json').offer,
    iceServers: getIceServers({ sessionId: row.session.id, userId: `portal:${p.id}`, deviceId: row.session.deviceId }),
    clipboard: { hostToViewer: false, viewerToHost: false },
    idleTimeoutMinutes: policy.idleTimeoutMinutes, maxSessionDurationHours: policy.maxSessionDurationHours,
    revocationLease: lease.lease,
    ...(prompt.mode === 'off' ? {} : { prompt: {
      mode: prompt.mode, technicianName: c.get('portalAuth').user.name ?? 'Authorized customer',
      consentUnavailableBehavior: prompt.consentUnavailableBehavior, consentTimeoutMs: 30000,
      notifyOnEnd: prompt.notifyOnEnd, showIndicator: prompt.showIndicator,
    } }),
  } });
  if (dispatched.status !== 'sent') { await end(p, row.session.id); return c.json({ error: 'The computer is not reachable' }, 503); }
  return c.json({ success: true });
});

portalDesktopRoutes.post('/remote/sessions/:id/end', async c => {
  const csrf = validatePortalCookieCsrfRequest(c);
  if (csrf) return c.json({ error: csrf }, 403);
  const parsed = idSchema.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'Session unavailable' }, 404);
  const p = principal(c); const row = await end(p, parsed.data);
  if (!row) return c.json({ error: 'Session unavailable' }, 404);
  writePortalAudit(c, { orgId: p.orgId, actorId: p.id, actorType: 'user', action: 'portal.remote.ended', resourceType: 'device', resourceId: row.session.deviceId, details: { principalType: 'portal_user', sessionId: row.session.id } });
  return c.json({ success: true, terminationPhase: row.session.terminationPhase });
});
