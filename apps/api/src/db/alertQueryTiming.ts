import { getActiveAlertWorkSpan } from '../services/alertWorkTelemetry';

type Method = (...args: unknown[]) => unknown;
type Surface = Record<string, unknown>;
const decorated = new WeakSet<object>();

/** postgres-js Query stays lazy and retains its identity and all fluent options.
 * Elapsed time includes pool/network/server waits; it is not database CPU time.
 * Only unsafe queries created in an active alert span are instrumented.
 */
export function enableAlertQueryTiming<T extends object>(client: T): T {
  function decorate(value: unknown): void {
    if ((!value || typeof value !== 'object') && typeof value !== 'function') return;
    if (decorated.has(value as object)) return;
    const surface = value as Surface;
    if (typeof surface.unsafe !== 'function') return;
    decorated.add(value as object);
    const unsafe = surface.unsafe as Method;
    surface.unsafe = function (...args: unknown[]) {
      const query = Reflect.apply(unsafe, value, args) as Surface;
      if (!getActiveAlertWorkSpan() || !query || typeof query.handle !== 'function') return query;
      const handle = query.handle as Method;
      let started = false;
      query.handle = function (...handleArgs: unknown[]) {
        const span = getActiveAlertWorkSpan();
        if (!started && !query.executed && span) {
          started = true;
          const start = performance.now();
          let settled = false;
          for (const name of ['resolve', 'reject']) {
            const original = query[name] as Method;
            query[name] = function (...settleArgs: unknown[]) {
              if (!settled) {
                settled = true;
                span.queryCount++;
                span.dbElapsedMs += Math.max(0, performance.now() - start);
              }
              return Reflect.apply(original, query, settleArgs);
            };
          }
        }
        return Reflect.apply(handle, query, handleArgs);
      };
      return query;
    };
    for (const name of ['begin', 'savepoint']) {
      if (typeof surface[name] !== 'function') continue;
      const original = surface[name] as Method;
      surface[name] = function (...args: unknown[]) {
        const index = args.findIndex(arg => typeof arg === 'function');
        if (index >= 0) {
          const callback = args[index] as Method;
          args[index] = function (this: unknown, ...callbackArgs: unknown[]) {
            decorate(callbackArgs[0]);
            return Reflect.apply(callback, this, callbackArgs);
          };
        }
        return Reflect.apply(original, value, args);
      };
    }
    if (typeof surface.reserve === 'function') {
      const reserve = surface.reserve as Method;
      surface.reserve = function (...args: unknown[]) {
        return Promise.resolve(Reflect.apply(reserve, value, args)).then(reserved => {
          decorate(reserved);
          return reserved;
        });
      };
    }
  }
  decorate(client);
  return client;
}
