/** Public Endpoint Management OpenAPI 1.9.236 (Computer, IBaseGroup, SlimEntity).
 * https://api.swaggerhub.com/apis/Check-Point/web-mgmt-external-api-production/1.9.236
 * Only allowlisted evidence crosses this boundary; never return raw provider rows.
 */
export const HARMONY_REGIONS = {
  us: 'https://cloudinfra-gw-us.portal.checkpoint.com',
  eu: 'https://cloudinfra-gw.portal.checkpoint.com',
  ap: 'https://cloudinfra-gw.ap.portal.checkpoint.com',
} as const;
export type HarmonyRegion = keyof typeof HARMONY_REGIONS;
export type HarmonyCredentials = { region: HarmonyRegion; clientId: string; accessKey: string };
export class HarmonyError extends Error {
  constructor(public code: string, public status: 400 | 403 | 404 | 409 | 502 = 502) { super(code); }
}
export type HarmonyGroup = { id: string; name: string; type: 'GROUP' | 'VIRTUAL_GROUP' | 'OFFLINE_GROUP' };
export type HarmonyComputer = {
  id: string; name: string; groupIds: string[];
  ipAddress: string | null; osName: string | null; osVersion: string | null;
  clientVersion: string | null; username: string | null;
  lastConnectedAt: string | null; lastSyncedAt: string | null;
  antiMalwareStatus: string | null; engineName: string | null; engineStatus: string | null;
  // amStatus and engineStatus are undocumented free text, not evidence of RTP.
  realTimeProtection: boolean | null;
  definitionsVersion: string | null; definitionsUpdatedAt: string | null; lastScanAt: string | null;
  infectedCount: number | null; quarantinedCount: number | null;
  isolationStatus: string | null; deleted: boolean | null;
  blades: { name: string; status: string | null }[];
};
export type HarmonyInventory = { groups: HarmonyGroup[]; computers: HarmonyComputer[]; checkedAt: string };
export type HarmonyMapping = { orgId: string; kind: 'group' | 'endpoint'; externalId: string };
export type HarmonyPartition = {
  projections: Array<HarmonyInventory & { orgId: string }>;
  // Administrative diagnostics, never part of an individual client's inventory.
  // This module does not authorize access to either the input or these counts.
  setup: { unavailableScopeCount: number; conflictedEndpointCount: number };
};
const MAX_MAPPINGS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function harmonyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarmonyError('harmony_invalid_response');
  return value as Record<string, unknown>;
}
export function harmonyId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HarmonyError('harmony_invalid_response');
  }
  return value;
}
function text(value: unknown, max = 1024): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new HarmonyError('harmony_invalid_response');
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || null;
}
function timestamp(value: unknown): string | null {
  const input = text(value, 128);
  // Avoid guessing a provider-local timezone or interpreting an empty string as epoch.
  if (!input || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(input)) return null;
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function count(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d{1,16}$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function distinct(ids: string[]): string[] {
  if (new Set(ids).size !== ids.length) throw new HarmonyError('harmony_invalid_response');
  return ids;
}
export function normalizeHarmonyGroup(value: unknown): HarmonyGroup {
  const row = harmonyRecord(value);
  const id = harmonyId(row.id);
  if (row.type !== 'GROUP' && row.type !== 'VIRTUAL_GROUP' && row.type !== 'OFFLINE_GROUP') throw new HarmonyError('harmony_invalid_response');
  return { id, name: text(row.name) ?? id, type: row.type };
}
export function normalizeHarmonyComputer(value: unknown): HarmonyComputer {
  const row = harmonyRecord(value);
  const id = harmonyId(row.computerId);
  // Missing membership is not an account-wide grant. Refuse to publish an
  // apparently complete snapshot if membership evidence cannot be evaluated.
  if (!Array.isArray(row.computerGroups) || row.computerGroups.length > 1000) throw new HarmonyError('harmony_membership_unavailable');
  const groupIds = distinct(row.computerGroups.map(group => harmonyId(harmonyRecord(group).id)));
  const malware = row.antiMalware == null ? {} : harmonyRecord(row.antiMalware);
  if (row.bladeStatus != null && (!Array.isArray(row.bladeStatus) || row.bladeStatus.length > 100)) throw new HarmonyError('harmony_invalid_response');
  const blades = ((row.bladeStatus ?? []) as unknown[]).map(value => {
    const blade = harmonyRecord(value);
    return { name: text(blade.bladeName), status: text(blade.bladeStatus, 128) };
  }).filter((blade): blade is { name: string; status: string | null } => blade.name !== null);
  return {
    id, name: text(row.computerName) ?? id, groupIds,
    ipAddress: text(row.computerIP, 256), osName: text(row.osName), osVersion: text(row.osVersion),
    clientVersion: text(row.computerClientVersion, 256),
    username: text(row.computerLastLoggedInUser) ?? text(row.computerUserName),
    lastConnectedAt: timestamp(row.computerLastConnection), lastSyncedAt: timestamp(row.computerSyncedon),
    antiMalwareStatus: text(row.amStatus), engineName: text(malware.engineName), engineStatus: text(malware.engineStatus),
    realTimeProtection: null,
    definitionsVersion: text(row.computerAmDatVersion, 256), definitionsUpdatedAt: timestamp(row.computerAmDatDate),
    lastScanAt: timestamp(row.computerAmScannedon), infectedCount: count(row.computerAmTotalInfected),
    quarantinedCount: count(row.computerAmTotalQuarantined), isolationStatus: text(row.isolationStatus, 256),
    deleted: typeof row.isDeleted === 'boolean' ? row.isDeleted : null, blades,
  };
}

export function validateHarmonyGroupIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new HarmonyError('harmony_group_scope_required', 400);
  try { return distinct(value.map(harmonyId)); }
  catch { throw new HarmonyError('harmony_invalid_group_scope', 400); }
}
/** Discovery may include virtual/offline groups; only custom GROUPs can scope a client. */
export function validateHarmonyCustomGroupScope(groups: HarmonyGroup[], groupIds: string[]): string[] {
  const selected = validateHarmonyGroupIds(groupIds);
  for (const id of selected) {
    const group = groups.find(group => group.id === id);
    if (!group) throw new HarmonyError('harmony_group_unavailable', 409);
    if (group.type !== 'GROUP') throw new HarmonyError('harmony_group_scope_not_custom', 400);
  }
  return selected;
}
function projectComputer(computer: HarmonyComputer, groupIds: string[]): HarmonyComputer {
  return { ...computer, groupIds, blades: computer.blades.map(blade => ({ ...blade })) };
}
/** Exact IDs only, no label matching, descendants, or account-wide fallback.
 * For a shared tenant, use partitionHarmonyInventory with the complete mapping
 * set instead: a single client's group list cannot detect cross-client overlap.
 */
export function scopeHarmonyInventory(all: HarmonyInventory, selectedGroupIds: string[]): HarmonyInventory {
  const selected = new Set(validateHarmonyCustomGroupScope(all.groups, selectedGroupIds));
  return {
    groups: all.groups.filter(group => selected.has(group.id)).map(group => ({ ...group })), checkedAt: all.checkedAt,
    computers: all.computers.filter(computer => computer.deleted !== true && computer.groupIds.some(id => selected.has(id)))
      .map(computer => projectComputer(computer, computer.groupIds.filter(id => selected.has(id)))),
  };
}

/** Structural configuration validation only. Empty mappings publish nothing;
 * identical same-org scopes are deduplicated, never used to widen ownership. */
export function validateHarmonyMappings(value: unknown): HarmonyMapping[] {
  if (!Array.isArray(value) || value.length > MAX_MAPPINGS) throw new HarmonyError('harmony_invalid_mappings', 400);
  const scopes = new Map<string, HarmonyMapping>();
  for (const input of value) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HarmonyError('harmony_invalid_mappings', 400);
    const row = input as Record<string, unknown>;
    if (Object.keys(row).length !== 3 || Object.keys(row).some(key => !['orgId', 'kind', 'externalId'].includes(key))
      || typeof row.orgId !== 'string' || !UUID.test(row.orgId) || (row.kind !== 'group' && row.kind !== 'endpoint')) {
      throw new HarmonyError('harmony_invalid_mappings', 400);
    }
    let externalId: string;
    try { externalId = harmonyId(row.externalId); }
    catch { throw new HarmonyError('harmony_invalid_mappings', 400); }
    const mapping: HarmonyMapping = { orgId: row.orgId.toLowerCase(), kind: row.kind, externalId };
    const key = JSON.stringify([mapping.kind, mapping.externalId]);
    const previous = scopes.get(key);
    if (previous && previous.orgId !== mapping.orgId) throw new HarmonyError('harmony_mapping_conflict', 400);
    scopes.set(key, mapping);
  }
  return [...scopes.values()];
}

function inventoryIndex(all: HarmonyInventory) {
  if (!Array.isArray(all.groups) || all.groups.length > 5000 || !Array.isArray(all.computers) || all.computers.length > 10000) {
    throw new HarmonyError('harmony_invalid_response');
  }
  const groups = new Map<string, HarmonyGroup>();
  const computers = new Map<string, HarmonyComputer>();
  for (const group of all.groups) {
    const id = harmonyId(group.id);
    if (groups.has(id)) throw new HarmonyError('harmony_snapshot_changed');
    groups.set(id, group);
  }
  for (const computer of all.computers) {
    const id = harmonyId(computer.id);
    if (computers.has(id)) throw new HarmonyError('harmony_snapshot_changed');
    computers.set(id, computer);
  }
  return { groups, computers };
}

/** Initial setup must select evidence that is present now. Later syncs instead
 * use partitionHarmonyInventory so removed scopes yield no client data. */
export function validateHarmonyMappingSelection(all: HarmonyInventory, value: unknown): HarmonyMapping[] {
  const mappings = validateHarmonyMappings(value);
  const index = inventoryIndex(all);
  for (const mapping of mappings) {
    if (mapping.kind === 'group') {
      const group = index.groups.get(mapping.externalId);
      if (!group) throw new HarmonyError('harmony_group_unavailable', 409);
      if (group.type !== 'GROUP') throw new HarmonyError('harmony_group_scope_not_custom', 400);
    } else {
      const computer = index.computers.get(mapping.externalId);
      if (!computer || computer.deleted === true) throw new HarmonyError('harmony_endpoint_unavailable', 409);
    }
  }
  return mappings;
}

/** Partition one complete normalized tenant snapshot against ALL approved
 * mappings. Authorization and completeness are host responsibilities. Never use
 * only the requesting client's mappings: that would hide competing ownership.
 * Conflicts are withheld from every client; diagnostics contain counts only. */
export function partitionHarmonyInventory(all: HarmonyInventory, value: unknown): HarmonyPartition {
  const mappings = validateHarmonyMappings(value);
  const index = inventoryIndex(all);
  const projections = new Map<string, HarmonyInventory & { orgId: string }>();
  const groupOwners = new Map<string, string>();
  const endpointOwners = new Map<string, string>();
  const setup = { unavailableScopeCount: 0, conflictedEndpointCount: 0 };
  for (const mapping of mappings) {
    if (!projections.has(mapping.orgId)) projections.set(mapping.orgId, {
      orgId: mapping.orgId, checkedAt: all.checkedAt, groups: [], computers: [],
    });
    if (mapping.kind === 'group') {
      const group = index.groups.get(mapping.externalId);
      if (!group) { setup.unavailableScopeCount++; continue; }
      if (group.type !== 'GROUP') throw new HarmonyError('harmony_group_scope_not_custom', 400);
      groupOwners.set(group.id, mapping.orgId);
      projections.get(mapping.orgId)!.groups.push({ ...group });
    } else {
      const computer = index.computers.get(mapping.externalId);
      if (!computer || computer.deleted === true) { setup.unavailableScopeCount++; continue; }
      endpointOwners.set(computer.id, mapping.orgId);
    }
  }
  for (const computer of all.computers) {
    if (computer.deleted === true) continue;
    const owners = new Set<string>();
    const explicitOwner = endpointOwners.get(computer.id);
    if (explicitOwner) owners.add(explicitOwner);
    for (const groupId of computer.groupIds) {
      const owner = groupOwners.get(groupId);
      if (owner) owners.add(owner);
    }
    if (owners.size > 1) { setup.conflictedEndpointCount++; continue; }
    if (owners.size === 0) continue;
    const owner = owners.values().next().value!;
    projections.get(owner)!.computers.push(projectComputer(computer,
      computer.groupIds.filter(id => groupOwners.get(id) === owner)));
  }
  return { projections: [...projections.values()], setup };
}
