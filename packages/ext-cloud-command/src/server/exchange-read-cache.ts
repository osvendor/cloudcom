import type { AdministrationConnection } from './admin-execution';
import type { MicrosoftRequest } from './native-microsoft';

/** Host encrypts values, namespaces keys and detaches work from request DB context. */
export interface ExchangeReadCachePort {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  claim(key: string, ttlSeconds: number): Promise<string | null>;
  release(key: string, token: string): Promise<void>;
  epoch(key: string, rotate: boolean): Promise<string>;
  runDetached(request: MicrosoftRequest, work: () => Promise<void>): void;
  withRequestDb<T>(request: MicrosoftRequest, work: () => Promise<T>): Promise<T>;
}
export type CachedExchangeOperation = 'mailbox.forwarding.get' | 'mailbox.autoreply.get' | 'mailbox.delegation.list' | 'mailbox.delegation.get';
const FRESH_MS = 5 * 60_000;
const TTL = 3600;
const safeFailureCodes = new Set(['access_denied','connection_not_ready','connection_changed','exchange_unavailable','audit_unavailable','provider_unreachable','provider_access_denied','provider_rejected','worker_busy']);
type Entry = { checkedAt: number; value: Record<string, unknown> };
function entry(value: unknown): Entry | null {
  if (!value || typeof value !== 'object') return null;
  const e = value as Entry;
  return Number.isFinite(e.checkedAt) && e.value && typeof e.value === 'object' && !Array.isArray(e.value) ? e : null;
}
async function refreshWhenAvailable(refresh: () => Promise<unknown>) {
  // Only explicit pre-dispatch admission rejection is retried. Twenty attempts
  // allow 38 seconds of waiting plus the worker's 45-second read deadline,
  // remaining inside the 90-second cache leases. No request DB context is held.
  const retryDeadline = Date.now() + 38_000;
  for (let attempt = 0; ; attempt++) {
    try { return await refresh(); }
    catch (error) {
      if (attempt >= 19 || Date.now() >= retryDeadline || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'worker_busy') throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}
export function createExchangeReadCache(port: ExchangeReadCachePort, now = Date.now) {
  function prefix(binding: AdministrationConnection, mailboxId: string) {
    return JSON.stringify(['exchange-mailbox-v1', binding.orgId, binding.id, binding.tenantId, binding.clientId,
      binding.credentialVersion, binding.generation, binding.permissionManifestVersion, mailboxId]);
  }
  return {
    async invalidate(binding: AdministrationConnection, mailboxId: string) {
      // Immutable data namespaces prevent an older in-flight refresh from
      // resurrecting pre-mutation values, even if it completes after invalidation.
      await port.epoch(`${prefix(binding, mailboxId)}:epoch`, true);
    },
    async read(request: MicrosoftRequest, binding: AdministrationConnection, operation: CachedExchangeOperation,
      mailboxId: string, delegateId: string | undefined, force: boolean, refresh: () => Promise<unknown>) {
      const base = prefix(binding, mailboxId), epochKey = `${base}:epoch`;
      const epoch = await port.epoch(epochKey, false);
      const key = JSON.stringify([base, epoch, operation, delegateId ?? '']);
      const saved = entry(await port.get(`${key}:data`));
      const stale = !saved || now() - saved.checkedAt >= FRESH_MS;
      const retryAt = await port.get(`${key}:retry`);
      const eligible = force || !(typeof retryAt === 'number' && retryAt > now());
      let refreshing = Boolean(await port.get(`${key}:running`));
      if ((stale || force) && eligible) {
        const token = await port.claim(`${key}:lease`, 90);
        if (token) {
          const globalToken = await port.claim('exchange-mailbox-v1:background', 90);
          if (!globalToken) {
            await port.release(`${key}:lease`, token);
            const usable = await port.epoch(epochKey, false) === epoch ? saved : null;
            return { ...(usable?.value ?? { pending: true }), cache: { checkedAt: usable ? new Date(usable.checkedAt).toISOString() : null, stale: !usable || stale, refreshing: true, refreshFailed: false } };
          }
          refreshing = true;
          await port.set(`${key}:running`, true, 90);
          port.runDetached(request, async () => {
            let stage = 'refresh';
            try {
              const value = await refreshWhenAvailable(refresh);
              if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_cache_result');
              stage = 'publish';
              await port.set(`${key}:data`, { checkedAt: now(), value }, TTL);
              await port.delete(`${key}:retry`);
            } catch (error) {
              const candidate = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
              const code = typeof candidate === 'string' && safeFailureCodes.has(candidate) ? candidate : 'unclassified';
              console.warn('[CloudCommand] Mailbox cache refresh failed', { stage, code });
              // Retain last good data. Never persist provider errors or secrets
              // from exception messages; a retry window prevents polling storms.
              await port.set(`${key}:retry`, now() + 60_000, 120);
            } finally {
              await Promise.allSettled([port.delete(`${key}:running`), port.release(`${key}:lease`, token),
                port.release('exchange-mailbox-v1:background', globalToken)]);
            }
          });
        } else refreshing = true;
      }
      const currentEpoch = await port.epoch(epochKey, false);
      const usable = currentEpoch === epoch ? saved : null;
      return { ...(usable?.value ?? { pending: true }), cache: {
        checkedAt: usable ? new Date(usable.checkedAt).toISOString() : null,
        stale: !usable || now() - usable.checkedAt >= FRESH_MS, refreshing,
        refreshFailed: typeof retryAt === 'number' && retryAt > now(),
      } };
    },
  };
}
