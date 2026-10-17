import { randomUUID } from 'node:crypto';
import type { GuardedFetch } from './transport';
import {
  HARMONY_REGIONS, HarmonyError, harmonyId, harmonyRecord, normalizeHarmonyComputer,
  normalizeHarmonyGroup, scopeHarmonyInventory, validateHarmonyGroupIds, validateHarmonyCustomGroupScope,
  type HarmonyComputer, type HarmonyCredentials, type HarmonyGroup, type HarmonyInventory,
} from './harmony-contract';
export { HarmonyError } from './harmony-contract';

const API = '/app/endpoint-web-mgmt/harmony/endpoint/api';
const REQUEST_MS = 15000;
const OPERATION_MS = 120000;
const MAX_BYTES = 4 * 1024 * 1024;
const GROUP_PAGE_SIZE = 100;
const COMPUTER_PAGE_SIZE = 250;
const MAX_GROUPS = 5000;
const MAX_COMPUTERS = 10000;
const MAX_JOB_POLLS = 20;
type Session = { origin: string; headers: Record<string, string>; signal: AbortSignal };

function credential(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new HarmonyError('harmony_invalid_credentials', 400);
  return value;
}
function token(value: unknown): string {
  try { return credential(value, 32768); }
  catch { throw new HarmonyError('harmony_invalid_response'); }
}
function jobId(value: unknown): string {
  const id = harmonyId(value);
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(id)) throw new HarmonyError('harmony_invalid_response');
  return id;
}
function integer(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new HarmonyError('harmony_invalid_response');
  return value;
}
function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, 500);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new HarmonyError('harmony_timeout')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Read-only transport. Fixed vendor regions are deployment configuration;
 * caller-supplied origins and server-supplied next URLs are never accepted.
 * All state/tokens belong to one bounded operation, never shared across clients.
 */
export function createHarmonyProvider(fetch: GuardedFetch) {
  async function call(origin: string, path: string, signal: AbortSignal, headers: Record<string, string> = {}, body?: unknown, method = 'POST') {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(abort, REQUEST_MS);
    let rejectAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new HarmonyError('harmony_timeout'));
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      });
      const request = (async () => {
        if (controller.signal.aborted) throw new HarmonyError('harmony_timeout');
        const response = await fetch(origin + path, {
          method, redirect: 'error', timeoutMs: REQUEST_MS, maxBytes: MAX_BYTES, signal: controller.signal,
          headers: { Accept: 'application/json', 'x-mgmt-data-request-id': randomUUID(),
            'x-mgmt-data-request-source': 'cloudcommand-harmony', ...headers,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.redirected || response.status >= 300 && response.status < 400) throw new HarmonyError('harmony_redirect_refused');
        if (response.status === 401 || response.status === 403) throw new HarmonyError('harmony_access_denied');
        if (response.status === 429) throw new HarmonyError('harmony_rate_limited');
        if (!response.ok) throw new HarmonyError('harmony_request_failed');
        const raw = await response.text();
        if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new HarmonyError('harmony_response_too_large');
        let value: unknown;
        try { value = raw ? JSON.parse(raw) : {}; } catch { throw new HarmonyError('harmony_invalid_response'); }
        return { value, headers: response.headers };
      })();
      return await Promise.race([request, aborted]);
    } catch (error) {
      if (error instanceof HarmonyError) throw error;
      throw new HarmonyError('harmony_unavailable');
    } finally {
      clearTimeout(timeout); signal.removeEventListener('abort', abort);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    }
  }
  async function session(credentials: HarmonyCredentials, signal: AbortSignal): Promise<Session> {
    if (!Object.hasOwn(HARMONY_REGIONS, credentials.region)) throw new HarmonyError('harmony_invalid_region', 400);
    const origin = HARMONY_REGIONS[credentials.region];
    const clientId = credential(credentials.clientId, 512);
    const accessKey = credential(credentials.accessKey, 8192);
    const auth = harmonyRecord((await call(origin, '/auth/external', signal, {}, { clientId, accessKey })).value);
    const authData = auth.data == null ? auth : harmonyRecord(auth.data);
    const headers = { Authorization: `Bearer ${token(authData.token)}`, 'x-mgmt-data-session-id': randomUUID() };
    const login = await call(origin, API + '/v1/session/login/cloud?operationName=LoginCloud', signal, headers);
    const apiToken = login.headers.get('x-mgmt-api-token') || harmonyRecord(login.value).apiToken;
    return { origin, headers: { ...headers, 'x-mgmt-api-token': token(apiToken) }, signal };
  }
  async function management(current: Session, path: string, body?: unknown, asJob = false, method = 'POST'): Promise<unknown> {
    return (await call(current.origin, API + path, current.signal,
      { ...current.headers, 'x-mgmt-run-as-job': asJob ? 'on' : 'off' }, body, method)).value;
  }
  async function jobResult(current: Session, submitted: unknown): Promise<unknown> {
    const id = jobId(harmonyRecord(submitted).jobId);
    for (let attempt = 0; attempt < MAX_JOB_POLLS; attempt++) {
      const result = harmonyRecord(await management(current, '/v1/jobs/' + encodeURIComponent(id) + '?operationName=GetJobById', undefined, false, 'GET'));
      if (result.status === 'IN_PROGRESS') { if (attempt + 1 < MAX_JOB_POLLS) await delay(current.signal); continue; }
      if (result.status === 'FAILED' || result.status === 'NOT_FOUND') throw new HarmonyError('harmony_job_failed');
      if (result.status !== 'DONE') throw new HarmonyError('harmony_invalid_response');
      if (result.statusType !== 2 || integer(result.statusCode, 599) < 200 || (result.statusCode as number) >= 300) throw new HarmonyError('harmony_job_failed');
      return result.data;
    }
    throw new HarmonyError('harmony_job_timeout');
  }
  async function groups(current: Session): Promise<HarmonyGroup[]> {
    const output: HarmonyGroup[] = []; const ids = new Set<string>();
    // The extra request at the limit can prove that an exact full final page ended.
    for (let offset = 0; offset <= MAX_GROUPS; offset += GROUP_PAGE_SIZE) {
      const value = await management(current, '/v1/organization/tree/search', {
        searchTerm: '', searchType: 'CONTAINS', paging: { pageSize: GROUP_PAGE_SIZE, offset },
        entityTypesToSearch: ['GROUP', 'VIRTUAL_GROUP', 'OFFLINE_GROUP'],
      });
      if (!Array.isArray(value) || value.length > GROUP_PAGE_SIZE) throw new HarmonyError('harmony_invalid_response');
      for (const raw of value) {
        const group = normalizeHarmonyGroup(raw);
        if (ids.has(group.id)) throw new HarmonyError('harmony_snapshot_changed');
        ids.add(group.id); output.push(group);
      }
      if (output.length > MAX_GROUPS) throw new HarmonyError('harmony_inventory_limit');
      if (value.length < GROUP_PAGE_SIZE) return output;
    }
    throw new HarmonyError('harmony_inventory_limit');
  }
  async function computers(current: Session): Promise<HarmonyComputer[]> {
    const output: HarmonyComputer[] = []; const ids = new Set<string>();
    let expectedTotal: number | undefined;
    for (let offset = 0; offset < MAX_COMPUTERS; offset += COMPUTER_PAGE_SIZE) {
      const submitted = await management(current, '/v1/asset-management/computers/filtered?operationName=ComputersByFilter', {
        filters: [], paging: { pageSize: COMPUTER_PAGE_SIZE, offset }, viewType: 'DEVICES',
      }, true);
      const page = harmonyRecord(await jobResult(current, submitted));
      const total = integer(page.totalCount, MAX_COMPUTERS);
      if (expectedTotal !== undefined && expectedTotal !== total) throw new HarmonyError('harmony_snapshot_changed');
      expectedTotal = total;
      if (page.pageOffset !== offset || page.pageSize !== COMPUTER_PAGE_SIZE || !Array.isArray(page.computers)
        || page.computers.length !== Math.min(COMPUTER_PAGE_SIZE, Math.max(0, total - offset))) throw new HarmonyError('harmony_incomplete_snapshot');
      for (const raw of page.computers) {
        const computer = normalizeHarmonyComputer(raw);
        if (ids.has(computer.id)) throw new HarmonyError('harmony_snapshot_changed');
        ids.add(computer.id); output.push(computer);
      }
      if (output.length === total) return output;
    }
    throw new HarmonyError('harmony_inventory_limit');
  }
  async function bounded<T>(credentials: HarmonyCredentials, work: (current: Session) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPERATION_MS);
    try { return await work(await session(credentials, controller.signal)); }
    finally { clearTimeout(timer); }
  }
  return {
    // Account-wide group discovery belongs only behind the caller's setup/admin gate.
    groups: (credentials: HarmonyCredentials) => bounded(credentials, groups),
    // Complete tenant evidence for a future host-only setup/sync caller. This
    // method performs NO authorization and is not a client-visible projection.
    // The host must authorize first and partition with ALL approved mappings.
    administrativeInventory: (credentials: HarmonyCredentials): Promise<HarmonyInventory> => bounded(credentials, async current => ({
      groups: await groups(current), computers: await computers(current), checkedAt: new Date().toISOString(),
    })),
    inventory(credentials: HarmonyCredentials, groupIds: string[]): Promise<HarmonyInventory> {
      // Reject missing scope before opening a credentialed session.
      const selected = validateHarmonyGroupIds(groupIds);
      return bounded(credentials, async current => {
        const discovered = await groups(current);
        validateHarmonyCustomGroupScope(discovered, selected);
        return scopeHarmonyInventory({ groups: discovered, computers: await computers(current), checkedAt: new Date().toISOString() }, selected);
      });
    },
  };
}
