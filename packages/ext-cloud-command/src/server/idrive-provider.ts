import type { GuardedFetch } from './transport';
import { companyId, idriveId, list, record, type IDriveAction, type IDriveRow } from './idrive-contract';

const BASE = 'https://api.idrive360.com/api/msp';
export class IDriveError extends Error {
  constructor(public code: string, public status: 400 | 403 | 404 | 409 | 502 = 502) { super(code); }
}
export function createIDriveProvider(fetch: GuardedFetch) {
  async function call(key: string, path: string, method = 'GET', query: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    try {
      const url = new URL(BASE + path);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      const response = await fetch(url.href, { method, redirect: 'error', timeoutMs: 20000, maxBytes: 4 * 1024 * 1024,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok || response.status >= 300) throw new IDriveError(response.status === 401 || response.status === 403 ? 'idrive_access_denied' : response.status === 429 ? 'idrive_rate_or_dependency_error' : 'idrive_request_failed');
      if (response.status === 204) return {};
      const value: unknown = await response.json();
      if (!Array.isArray(value) && (record(value).ok === false || record(value).success === false)) throw new IDriveError('idrive_request_failed');
      return value;
    } catch (error) { if (error instanceof IDriveError) throw error; throw new IDriveError('idrive_unavailable'); }
  }
  const q = (company: number) => ({ company_id: String(companyId.parse(company)) });
  return {
    async companies(key: string, name?: string) {
      const result = await call(key, name ? '/company/name' : '/company', 'GET', name ? { name, exact: 'false', case_sensitive: 'false' } : {});
      const roots = list(result);
      const all = roots.flatMap(row => [row, ...(Array.isArray(row.sub_company_list) ? list(row.sub_company_list) : [])]);
      return all.map(row => ({ companyId: companyId.parse(row.company_id), name: String(row.name ?? ''), status: String(row.status_description ?? '') }));
    },
    async company(key: string, company: number) {
      const row = record(await call(key, '/company', 'GET', q(company)));
      if (String(row.company_id) !== String(company)) throw new IDriveError('idrive_company_mismatch');
      return { companyId: company, name: String(row.name ?? ''), status: String(row.status_description ?? '') };
    },
    async inventory(key: string, company: number) {
      const [rawDevices, rawPlans, rawGroups] = await Promise.all([
        call(key, '/device/summary', 'GET', q(company)), call(key, '/backup_plan', 'GET', q(company)), call(key, '/group', 'GET', q(company)),
      ]);
      const devices = list(rawDevices).filter(row => String(row.company_id) === String(company));
      for (const device of devices) idriveId.parse(device.device_id);
      const allowed = new Set(devices.map(row => String(row.device_id)));
      const plans = list(rawPlans); const groups = list(rawGroups);
      for (const row of [...plans, ...groups]) {
        companyId.parse(row.id);
        if (row.company_id !== undefined && String(row.company_id) !== String(company)) throw new IDriveError('idrive_company_mismatch');
        // A company's plans/groups must not expose child-company device details.
        if (Array.isArray(row.devices) && row.devices.some(d => !allowed.has(String(record(d).device_id)))) throw new IDriveError('idrive_company_mismatch');
        if (Array.isArray(row.device_ids) && row.device_ids.some(id => !allowed.has(String(id)))) throw new IDriveError('idrive_company_mismatch');
      }
      return { devices, plans, groups };
    },
    async installer(key: string, company: number, options: { build_type: string; private_encryption: boolean; full_client: boolean }) {
      const value = record(await call(key, '/company/fetch_config_id', 'GET', { ...q(company), build_type: options.build_type, private_encryption: String(options.private_encryption), full_client: String(options.full_client) }));
      if (String(value.company_id) !== String(company)) throw new IDriveError('idrive_company_mismatch');
      const url = new URL(String(value.setup_link));
      if (url.origin !== 'https://api.idrive360.com' || !url.pathname.startsWith('/api/v1/download/setup/') || url.username || url.password) throw new IDriveError('idrive_invalid_installer');
      return { setupLink: url.href, configurationId: String(value.configuration_id ?? '') };
    },
    async action(key: string, company: number, action: IDriveAction, dry: boolean) {
      const paths = { 'company.create': '/company', 'plan.create': '/backup_plan', 'plan.edit': `/backup_plan/${'id' in action ? action.id : ''}`, 'group.create': '/group', 'group.edit': `/group/${'id' in action ? action.id : ''}`, 'device.edit': '/device', 'metadata.delete': '/device/metadata', 'notifications.edit': '/device/backup_plan/email_notification' };
      const supportsDry = ['plan.create', 'plan.edit', 'group.edit'].includes(action.kind);
      if (dry && !supportsDry) return { localPreview: true, providerDryRun: false };
      const method = ['company.create', 'plan.create', 'group.create', 'metadata.delete'].includes(action.kind) ? 'POST' : 'PUT';
      // company_id is always chosen server-side. Notification endpoint has no such field;
      // its device ownership is checked by the route before dispatch.
      const body = { ...action.data, ...(action.kind !== 'notifications.edit' ? { company_id: company } : {}) };
      return call(key, paths[action.kind], method, supportsDry ? { dry: String(dry) } : {}, body);
    },
  };
}
export type IDriveInventory = { devices: IDriveRow[]; plans: IDriveRow[]; groups: IDriveRow[] };
export function scopeIDriveInventory(all: IDriveInventory, groupId: number | null) {
  if (groupId === null) return { ...all, sharedPlansHidden: 0 };
  const group = all.groups.find(g => String(g.id) === String(groupId));
  if (!group || !Array.isArray(group.device_ids)) throw new IDriveError('idrive_group_unavailable');
  const allowed = new Set(group.device_ids.map(String));
  let sharedPlansHidden = 0;
  const plans = all.plans.filter(p => {
    const devices = Array.isArray(p.devices) ? p.devices.map(d => String(record(d).device_id)) : [];
    const groups = Array.isArray(p.groups) ? p.groups.map(g => String(typeof g === 'object' && g ? record(g).id : g)) : [];
    const touches = devices.some(id => allowed.has(id)) || groups.includes(String(groupId));
    const safe = touches && devices.every(id => allowed.has(id)) && groups.every(id => id === String(groupId));
    if (touches && !safe) sharedPlansHidden++;
    return safe;
  });
  return { devices: all.devices.filter(d => allowed.has(String(d.device_id))), plans, groups: [group], sharedPlansHidden };
}
export function assertIDriveTargets(action: IDriveAction, inventory: IDriveInventory) {
  const data = action.data as IDriveRow;
  const allowedDevices = new Set(inventory.devices.map(d => String(d.device_id)));
  const requested = [data.device_id, ...(['device_ids', 'add_device_ids', 'remove_device_ids'].flatMap(k => Array.isArray(data[k]) ? data[k] as unknown[] : []))].filter(v => v !== undefined);
  if (requested.some(id => !allowedDevices.has(String(id)))) throw new IDriveError('device_outside_selected_client', 403);
  const groups = new Set(inventory.groups.map(g => String(g.id)));
  if (Array.isArray(data.group_ids) && data.group_ids.some(id => !groups.has(String(id)))) throw new IDriveError('group_outside_selected_client', 403);
  if (action.kind === 'group.edit' && !groups.has(String(action.id))) throw new IDriveError('group_outside_selected_client', 403);
  if (action.kind === 'plan.edit' && !inventory.plans.some(p => String(p.id) === String(action.id))) throw new IDriveError('plan_outside_selected_client', 403);
}

/** Dry-run conflict reports can name computers belonging to other groups.
 * Group users receive counts, never those provider-supplied identities/messages. */
export function clientOperationResult(value: unknown, groupId: number | null, dry = false): unknown {
  if (groupId === null) return value;
  const counts: Record<string, number> = {};
  const visit = (input: unknown, path = '', depth = 0) => {
    if (depth > 8 || !input || typeof input !== 'object') return;
    if (Array.isArray(input)) { counts[path || 'items'] = input.length; return; }
    for (const [key, child] of Object.entries(input)) {
      if (!/^[a-zA-Z_]{1,60}$/.test(key)) continue;
      const next = path ? `${path}.${key}` : key;
      if (Array.isArray(child)) counts[next] = child.length;
      else if (child && typeof child === 'object') visit(child, next, depth + 1);
    }
  };
  visit(value);
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { providerResponded: !(dry && data.localPreview === true), providerDryRun: dry && data.localPreview !== true,
    localPreview: dry && data.localPreview === true, counts,
    note: 'Provider identities and messages are hidden to protect other clients. Review conflict/replaced/not-applied counts; use the IDrive console for account-wide details.' };
}
