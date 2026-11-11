/**
 * Drizzle calls postgres.js unsafe(), which defaults to prepare:false. Reusing
 * a bounded set of parameterized policy SELECTs lets PostgreSQL choose whether
 * a generic plan is worthwhile. It does not change SQL, parameters, transaction
 * context, RLS, or plan_cache_mode.
 */
const decoratedClients = new WeakSet<object>();
const MAX_POLICY_SHAPES = 128;
const MAX_POLICY_PARAMETERS = 256;

type DriverMethod = (...args: unknown[]) => unknown;
type DriverSurface = Record<string, unknown>;

function isPolicyRead(query: unknown, parameters: unknown): query is string {
  return typeof query === 'string'
    && Array.isArray(parameters)
    && parameters.length > 0
    && parameters.length <= MAX_POLICY_PARAMETERS
    && /^\s*select\b/i.test(query)
    && /\$[1-9]\d*\b/.test(query)
    && /\b(?:from|join)\s+"config_policy_[a-z_]+"/i.test(query)
    // Deliberately conservative: only generated, single SELECT statements.
    // Excluding literal/comment syntax avoids recognizing table names in them.
    && !/[;'`]|--|\/\*|\*\/|\$(?:[a-z_][a-z_0-9]*)?\$/i.test(query);
}

/**
 * Decorates the real callable client in place and returns that same client.
 * Driver methods are the only untyped boundary; unsafe's lazy Query is returned
 * unchanged, so Drizzle can still call .values() before anything is executed.
 * One shape budget is shared by the pool and all transaction/reserved clients.
 */
export function enablePreparedPolicyReads<T extends object>(client: T): T {
  const shapes = new Set<string>();

  function decorate(value: unknown): void {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return;
    if (decoratedClients.has(value)) return;
    const surface = value as DriverSurface;
    if (typeof surface.unsafe !== 'function') return;
    decoratedClients.add(value);

    const unsafe = surface.unsafe as DriverMethod;
    surface.unsafe = function (...args: unknown[]) {
      const [query, parameters, options] = args;
      // An explicitly supplied prepare option is always authoritative.
      const hasExplicitPrepare = options !== null && typeof options === 'object' && 'prepare' in options;
      const simpleProtocol = options !== null && typeof options === 'object' && 'simple' in options && options.simple === true;
      if (!hasExplicitPrepare && !simpleProtocol && (options === undefined || (options !== null && typeof options === 'object'))
        && isPolicyRead(query, parameters)
        && (shapes.has(query) || shapes.size < MAX_POLICY_SHAPES)) {
        shapes.add(query);
        args[2] = { prepare: true, ...options as object | undefined };
      }
      return Reflect.apply(unsafe, value, args);
    };

    for (const name of ['begin', 'savepoint']) {
      if (typeof surface[name] !== 'function') continue;
      const original = surface[name] as DriverMethod;
      surface[name] = function (...args: unknown[]) {
        // Both methods accept callback-only and options/name + callback forms.
        const callbackIndex = args.findIndex((argument) => typeof argument === 'function');
        if (callbackIndex >= 0) {
          const callback = args[callbackIndex] as DriverMethod;
          args[callbackIndex] = function (this: unknown, ...callbackArgs: unknown[]) {
            decorate(callbackArgs[0]);
            return Reflect.apply(callback, this, callbackArgs);
          };
        }
        return Reflect.apply(original, value, args);
      };
    }

    if (typeof surface.reserve === 'function') {
      const reserve = surface.reserve as DriverMethod;
      surface.reserve = function (...args: unknown[]) {
        return Promise.resolve(Reflect.apply(reserve, value, args)).then((reserved) => {
          decorate(reserved);
          return reserved;
        });
      };
    }
  }

  decorate(client);
  return client;
}
