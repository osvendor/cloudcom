import type { MiddlewareHandler } from 'hono';

/** Bound agent DB fan-in without putting human sign-in behind the same queue. */
export function agentRequestConcurrency(limit = Number(process.env.CLOUDCOM_AGENT_REQUEST_CONCURRENCY ?? 0)): MiddlewareHandler {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 64) throw Error('Invalid agent request concurrency');
  let active = 0;
  const waiting: Array<{ signal: AbortSignal; grant: () => void; abort: () => void }> = [];
  function acquire(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      let settled = false;
      const entry = {
        signal,
        grant() {
          if (settled) return;
          settled = true; signal.removeEventListener('abort', entry.abort); active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true; active--;
            while (active < limit && waiting.length) waiting.shift()!.grant();
          });
        },
        abort() {
          if (settled) return;
          settled = true;
          const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1);
          signal.removeEventListener('abort', entry.abort); resolve(null);
        },
      };
      if (active < limit && waiting.length === 0) entry.grant();
      else if (waiting.length >= 512) resolve(null);
      else { waiting.push(entry); signal.addEventListener('abort', entry.abort, { once: true }); }
    });
  }
  return async (c, next) => {
    // Admission has already reserved the single process-wide config slot. Do
    // not hold that recovery slot behind a full general-agent FIFO: those agents
    // need the empty assignment response to stop their overload retry loop.
    // This context marker is never read from a client header. Both the marker
    // and exact method/path are required. Auth/RLS and DB-pool admission still
    // run downstream; total permits are the configured general limit plus one.
    if (c.get('unifiConfigAdmissionReserved') === true && c.req.method === 'GET'
      && /^\/api\/v1\/agents\/[a-f0-9]{64}\/unifi-collectors$/i.test(c.req.path)) return next();
    if (limit === 0 || !/^\/api\/v1\/agents\/[a-f0-9]{64}(?:\/|$)/i.test(c.req.path)) return next();
    const release = await acquire(c.req.raw.signal);
    if (!release) {
      if (c.req.raw.signal.aborted) return c.body(null, 499);
      c.header('Retry-After', '5'); c.header('Cache-Control', 'no-store');
      return c.json({ error: 'Server busy; retry later', code: 'AGENT_REQUEST_QUEUE_FULL', retryAfterSeconds: 5 }, 503);
    }
    try { await next(); } finally { release(); }
  };
}
