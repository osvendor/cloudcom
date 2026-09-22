import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { portalRemoteSessions } from '../db/schema';
import { finalizePortalDesktopStart } from './portalRemoteSessionStore';
import { buildStopDesktopCommand, parseDesktopStopCommandId } from './remoteDesktopTerminalIntent';
import { parseDesktopStartCommandId } from '../routes/remote/helpers';
import { dispatchCommandToAgent } from './agentCommandRelay';

/** Called only with the device/agent identity established by agent WS auth. */
export async function handlePortalRemoteAgentResult(input: {
  commandId: string; status: string; result: Record<string, unknown> | null | undefined;
  deviceId: string; agentId: string;
}): Promise<boolean> {
  const start = parseDesktopStartCommandId(input.commandId);
  const stop = parseDesktopStopCommandId(input.commandId);
  const disconnected = /^desk-disconnect-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(input.commandId)?.[1];
  if (!start && !stop && !disconnected) return false;
  const sessionId = disconnected ?? (start ?? stop)!.sessionId;
  const outcome = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [session] = await db.select({ id: portalRemoteSessions.id }).from(portalRemoteSessions)
      .where(and(eq(portalRemoteSessions.id, sessionId), eq(portalRemoteSessions.deviceId, input.deviceId))).limit(1);
    if (!session) return { handled: false as const };
    if (disconnected) {
      if (input.status !== 'completed' || input.result?.event !== 'peer_disconnected'
        || input.result.sessionId !== sessionId) return { handled: true as const };
      // Portal session IDs never reconnect/restart. The authenticated endpoint
      // can terminalize only its own session. Publish a durable stop after the
      // commit so an in-flight start cannot resurrect the disconnected peer.
      const [ended] = await db.update(portalRemoteSessions).set({
        status: 'disconnected', endedAt: new Date(),
        desktopStartGeneration: sql`${portalRemoteSessions.desktopStartGeneration} + 1`,
        terminalGeneration: sql`${portalRemoteSessions.desktopStartGeneration} + 1`,
        terminationPhase: 'pending',
      }).where(and(eq(portalRemoteSessions.id, sessionId), eq(portalRemoteSessions.deviceId, input.deviceId),
        eq(portalRemoteSessions.terminationPhase, 'none')))
        .returning({ terminalGeneration: portalRemoteSessions.terminalGeneration });
      return { handled: true as const, ...(ended ? { stop: BigInt(ended.terminalGeneration!) } : {}) };
    }
    if (stop && input.status === 'completed') {
      await db.update(portalRemoteSessions).set({ terminationPhase: 'confirmed' }).where(and(
        eq(portalRemoteSessions.id, sessionId), eq(portalRemoteSessions.deviceId, input.deviceId),
        eq(portalRemoteSessions.terminalGeneration, stop.terminalGeneration), eq(portalRemoteSessions.terminationPhase, 'pending'),
      ));
      return { handled: true as const };
    }
    if (!start || !['completed','failed'].includes(input.status)) return { handled: true as const };
    const claimedSession = input.result?.sessionId;
    if (claimedSession !== undefined && claimedSession !== sessionId) return { handled: true as const };
    const denied = input.result?.event === 'consent_denied';
    const success = input.status === 'completed' && !denied && claimedSession === sessionId;
    const finalized = await finalizePortalDesktopStart(sessionId, input.deviceId, input.commandId, {
      ok: success,
      answer: typeof input.result?.answer === 'string' ? input.result.answer : null,
      consentReason: typeof input.result?.consentReason === 'string' ? input.result.consentReason : undefined,
    });
    return { handled: true as const, ...(finalized.status === 'failed' ? { stop: finalized.terminalGeneration } : {}) };
  }, 'portalRemoteAgent.result'));
  if ('stop' in outcome && outcome.stop !== undefined) {
    await dispatchCommandToAgent(input.agentId, buildStopDesktopCommand(sessionId, outcome.stop));
  }
  return outcome.handled;
}
