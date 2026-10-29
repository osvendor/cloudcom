import { cpus, loadavg, totalmem } from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { HealthAuth, HealthCard, OperationsHealth } from '@cloudcom/ext-cloud-command';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { users } from '../db/schema';
import { getRedis } from '../services/redis';
import { readEventLoopLag } from '../services/eventLoopMonitor';
import { readCapacityGuard } from '../services/capacityGuard';
import { agentRolloutLimits, isAgentUpdateGuardEnabled } from '../services/agentRolloutAdmission';
import { summarizeConsumerReadiness, workerReadinessRegistry } from '../services/workerReadinessRegistry';
import { cpuStealPercent, parseCpuCounters, type CpuCounters } from './hostCpuSteal';
import { getAlertWorkTelemetrySnapshot } from '../services/alertWorkTelemetry';

type State = HealthCard['status'];
const card = (id: string, title: string, status: State, value: string, detail: string): HealthCard => ({ id, title, status, value, detail });
export const pressure = (percent: number): State => percent >= 90 ? 'critical' : percent >= 75 ? 'attention' : 'healthy';
const unknown = (id: string, title: string, detail = 'This observation could not be collected. Other observations may still be available.') => card(id, title, 'unknown', 'Unavailable', detail);
const mb = (bytes: number) => `${Math.round(bytes / 1048576).toLocaleString('en-US')} MB`;
let cached: OperationsHealth | undefined;
let inFlight: Promise<OperationsHealth> | undefined;
let previousCpu: CpuCounters | null = null;

export async function deadline<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Observation timed out')), ms); })]); }
  finally { clearTimeout(timer!); }
}

/** No caller input in SQL; capped execution, no device identifiers, payloads or secrets returned. */
async function query(statement: SQL): Promise<Record<string, unknown>> {
  return deadline(runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.execute(sql`SET LOCAL statement_timeout = '2500ms'`);
    const result = await db.execute(statement);
    return (result as unknown as Record<string, unknown>[])[0];
  }, 'operations-health')));
}
const count = (row: Record<string, unknown>, key: string): number => {
  const value = Number(row[key]);
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid observation');
  return value;
};

/** Only platform operators may reach the global cache, including after permission revocation. */
export async function readOperationsHealth(auth: HealthAuth): Promise<OperationsHealth | null> {
  // Platform authority is independent of the normal partner membership used at login.
  if (!auth.user?.id || auth.user.isPlatformAdmin !== true || !['system', 'partner'].includes(auth.scope ?? '')
    || auth.principal?.kind !== 'user_session' || auth.allowedSiteIds !== undefined) return null;
  const active = await deadline(db.select({ status: users.status, platform: users.isPlatformAdmin })
    .from(users).where(eq(users.id, auth.user.id)).limit(1));
  if (active[0]?.status !== 'active' || active[0]?.platform !== true) return null;
  if (cached && Date.now() - Date.parse(cached.checkedAt) < 30_000) return cached;
  if (!inFlight) inFlight = collect().then(result => { cached = result; return result; }).finally(() => { inFlight = undefined; });
  return inFlight;
}

async function collect(): Promise<OperationsHealth> {
  const checkedAt = new Date().toISOString();
  const capacity = readCapacityGuard();
  const rollout = agentRolloutLimits();
  let enrolled: number | null = null;
  const observe = async (id: string, title: string, fn: () => Promise<HealthCard[]>): Promise<HealthCard[]> => {
    try { return await fn(); } catch { return [unknown(id, title)]; }
  };
  // Single-flight, 30-second cache; fixed aggregate queries, never one request per endpoint.
  const groups = await Promise.all([
    observe('cpu-steal', 'Host CPU scheduling', async () => {
      const current = parseCpuCounters(await readFile('/proc/stat', 'utf8'));
      const percent = cpuStealPercent(previousCpu, current);
      previousCpu = current;
      if (percent === null) return [unknown('cpu-steal', 'Host CPU scheduling', 'Needs two valid Linux CPU observations; refresh after 30 seconds. This measures host-visible hypervisor steal time, not container quotas.')];
      return [card('cpu-steal', 'Host CPU scheduling', percent >= 20 ? 'critical' : percent >= 5 ? 'attention' : 'healthy', `${percent.toFixed(1)}% CPU unavailable`, 'Hypervisor steal time since the previous observation. Sustained pressure can indicate hosting throttling or contention; check provider CPU and burst-capacity metrics. Attention at 5%, critical at 20%.')];
    }),
    observe('database', 'Database', async () => {
      const start = performance.now();
      const row = await query(sql`SELECT count(*) AS connections, current_setting('max_connections')::int AS maximum FROM pg_stat_activity`);
      const ms = Math.round(performance.now() - start);
      const used = count(row, 'connections'), max = count(row, 'maximum');
      return [card('database', 'Database', ms > 1000 ? 'attention' : pressure(used / max * 100), `${ms} ms`, `${used} / ${max} server connections. Read probe includes connection acquisition; attention above 1 second or 75% connections.`)];
    }),
    observe('fleet', 'Agent check-ins', async () => {
      const row = await query(sql`SELECT count(*) AS total,
        count(*) FILTER (WHERE last_seen_at > now() - interval '5 minutes') AS recent,
        count(*) FILTER (WHERE status = 'online' AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')) AS stale,
        count(*) FILTER (WHERE status = 'quarantined') AS quarantined,
        count(DISTINCT agent_version) AS versions
        FROM devices WHERE status <> 'decommissioned' AND is_ephemeral = false`);
      enrolled = count(row, 'total');
      const recent = count(row, 'recent'), stale = count(row, 'stale'), quarantined = count(row, 'quarantined');
      return [card('fleet', 'Agent check-ins', enrolled === 0 ? 'unknown' : stale || quarantined ? 'attention' : 'healthy', `${recent} / ${enrolled} recent`, `${enrolled - recent} not seen in 5 minutes; powered-off devices may be expected. ${stale} marked online with stale check-ins; ${quarantined} quarantined.`),
        card('versions', 'Agent versions', 'unknown', `${count(row, 'versions')} versions`, 'Installed version diversity only. Release compliance is not evaluated; platform-specific targets may differ.')];
    }),
    observe('commands', 'Device commands', async () => {
      const row = await query(sql`SELECT count(*) AS total,
        count(*) FILTER (WHERE c.status IN ('failed','timeout','timed_out')) AS failed,
        count(*) FILTER (WHERE c.status IN ('pending','sent','queued','running')) AS pending,
        count(*) FILTER (WHERE c.status IN ('pending','sent','queued') AND c.created_at < now() - interval '2 minutes'
          AND d.last_seen_at > now() - interval '5 minutes') AS delayed
        FROM device_commands c JOIN devices d ON d.id = c.device_id WHERE c.created_at > now() - interval '24 hours' AND d.status <> 'decommissioned'`);
      const total = count(row,'total'), failed = count(row,'failed'), delayed = count(row,'delayed');
      return [card('commands', 'Device commands · 24h', total === 0 ? 'unknown' : delayed || failed ? 'attention' : 'healthy', `${count(row,'pending')} in progress`, `${failed} failed / ${total} issued. ${delayed} waiting over 2 minutes on recently seen devices. Running scripts may take longer; older commands excluded.`)];
    }),
    observe('remote', 'Remote tools', async () => {
      const row = await query(sql`SELECT count(*) AS total, count(*) FILTER (WHERE status = 'failed') AS failed,
        count(*) FILTER (WHERE status = 'active') AS active FROM remote_sessions WHERE created_at > now() - interval '24 hours'`);
      const total = count(row,'total'), failed = count(row,'failed');
      return [card('remote', 'Remote tools · 24h', total === 0 ? 'unknown' : failed ? 'attention' : 'healthy', `${count(row,'active')} active`, `${failed} failed / ${total} sessions started in 24h. Covers Breeze desktop, terminal and files; not RustDesk transport.`)];
    }),
    observe('redis', 'Redis', async () => {
      const redis = getRedis();
      if (!redis || redis.status !== 'ready') return [card('redis', 'Redis', 'critical', 'Disconnected', 'Background work and realtime features may be affected.')];
      const start = performance.now();
      await deadline(redis.ping());
      const info = await deadline(redis.info('memory'));
      const used = Number(info.match(/^used_memory:(\d+)/m)?.[1]);
      const max = Number(info.match(/^maxmemory:(\d+)/m)?.[1]);
      if (!Number.isFinite(used)) throw new Error('Missing Redis memory');
      return [card('redis', 'Redis', max > 0 ? pressure(used / max * 100) : 'attention', mb(used), `${Math.round(performance.now() - start)} ms probe. ${max > 0 ? `${mb(max)} configured memory limit; attention at 75%.` : 'No Redis memory limit configured; monitor server RAM.'}`)];
    }),
    observe('resources', 'Server resources', async () => {
      const mem = await readFile('/proc/meminfo', 'utf8');
      const available = Number(mem.match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024;
      if (!Number.isFinite(available)) throw new Error('Missing memory');
      const percent = Math.max(0, (1 - available / totalmem()) * 100);
      const disk = await statfs('/');
      const free = disk.bavail * disk.bsize, capacity = disk.blocks * disk.bsize;
      const load = loadavg()[0] / Math.max(1, cpus().length) * 100;
      return [card('memory', 'Host-visible RAM', pressure(percent), `${percent.toFixed(0)}% used`, `${mb(available)} available, accounting for reclaimable cache. Host view; container limits may differ. Attention at 75%, critical at 90%.`),
        card('disk', 'API filesystem', pressure((1 - free / capacity) * 100), `${(free / 1073741824).toFixed(1)} GB free`, 'Filesystem containing the API. Other database/backup volumes are not measured. Attention at 75% used, critical at 90%.'),
        card('load', 'Host-visible load', load >= 200 ? 'critical' : load >= 100 ? 'attention' : 'healthy', `${(load / 100).toFixed(2)} per CPU`, '1-minute runnable + waiting load divided by visible CPUs; not CPU usage percent. Attention at 1.0, critical at 2.0. Container CPU quotas are not measured.')];
    }),
  ]);
  const lag = readEventLoopLag(60_000);
  const workers = summarizeConsumerReadiness(workerReadinessRegistry.snapshot());
  const cards = groups.flat();
  cards.push(card('capacity-guard', 'Server load safeguards', !capacity.enabled ? 'attention' : capacity.canRunBackgroundWork ? 'healthy' : 'attention',
    !capacity.enabled ? 'Disabled' : capacity.canRunBackgroundWork ? 'Ready for background work' : 'Heavy background work paused',
    `CPU ${capacity.metrics.cpuBusyPercent === null ? 'unknown' : capacity.metrics.cpuBusyPercent.toFixed(1) + '%'}; pause at ${capacity.thresholds.cpuPausePercent}%, resume below ${capacity.thresholds.cpuResumePercent}% after 60 healthy seconds. ${capacity.reasons.length ? 'Waiting: ' + capacity.reasons.join(', ') + '. ' : ''}Heavy collectors such as Harmony refresh defer. Small script-monitor checks continue only with fresh safe measurements and paced capacity; sign-in, check-ins and remote tools remain available. AWS burst credits are not measured.`),
    card('agent-rollout-guard', 'Agent update safeguards', isAgentUpdateGuardEnabled() && capacity.enabled && capacity.agentUpdates.allowed ? 'healthy' : 'attention',
      isAgentUpdateGuardEnabled() ? `${capacity.agentUpdates.allowed ? 'Ready' : 'Waiting for capacity'} · ${rollout.concurrent} at once` : 'Disabled',
      `1 per site; at most ${rollout.starts} new starts every ${rollout.windowMs / 60_000} minutes. ${capacity.enabled ? `Observed ${Math.round(capacity.agentUpdates.observedMs / 1000)}/60 seconds; average CPU ${capacity.agentUpdates.averages.cpuBusyPercent === null ? 'unknown' : capacity.agentUpdates.averages.cpuBusyPercent.toFixed(1) + '%'}. ${capacity.agentUpdates.reasons.length ? 'Waiting: ' + capacity.agentUpdates.reasons.join(', ') + '. ' : ''}Current pressure still blocks new starts. ` : 'Capacity measurements disabled. '}Confirmed components settle for at least 60 seconds. Missing completion holds its slot for 10 minutes, then defers that device for the rest of a 30-minute retry window. Signed emergency rollback and independent local repair are excluded.`));
  cards.push(card('api', 'API responsiveness', !lag.monitored || !lag.coversWindow ? 'unknown' : lag.worstLagMs >= 1000 ? 'critical' : lag.worstLagMs >= 250 ? 'attention' : 'healthy', lag.monitored && lag.coversWindow ? `${Math.round(lag.worstLagMs)} ms worst delay` : 'Warming up', `60-second event-loop window. API uses ${mb(process.memoryUsage().rss)}; uptime ${(process.uptime()/3600).toFixed(1)} hours. Attention at 250 ms, critical at 1 second.`),
    card('workers', 'Background workers', !workers.required ? 'unknown' : workers.unavailable ? 'critical' : 'healthy', `${workers.runnable} / ${workers.required} ready`, `${workers.optionalRunning} optional workers running. API-process consumer readiness; queue depth and other worker processes are not measured.`),
    unknown('relay', 'Relay & bandwidth', 'Direct/relay split, relay bytes and Lightsail transfer allowance are not measured here.'),
    unknown('backups', 'Backup recovery', 'Backup freshness and restore verification are not measured here.'),
    unknown('external', 'Sign-in & integrations', 'Cloudflare, SSO, email, 3CX and Microsoft/Google upstream availability are not actively probed. A working API does not verify these services.'));
  return { checkedAt, refreshSeconds: 30, targetEndpoints: 500, enrolled, cards, alertWorkload: getAlertWorkTelemetrySnapshot() };
}
