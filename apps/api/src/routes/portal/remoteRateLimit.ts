import type { Context, Next } from 'hono';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';

/** Bound session creation and SDP work per authenticated customer. End and
 * heartbeat remain available so throttling cannot prevent disconnection. */
export async function portalRemoteStartRateLimit(c: Context, next: Next) {
  const { user } = c.get('portalAuth');
  const result = await rateLimiter(getRedis(), `portal_remote_start:${user.orgId}:${user.id}`, 20, 60);
  if (!result.allowed) {
    c.header('Retry-After', '60');
    return c.json({ error: 'Too many connection attempts. Please wait a minute.' }, 429);
  }
  await next();
}
