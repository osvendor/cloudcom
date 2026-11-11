import { describe, expect, it } from 'vitest';
import {
  normalizeHarmonyComputer, normalizeHarmonyGroup, scopeHarmonyInventory, validateHarmonyGroupIds,
  partitionHarmonyInventory, validateHarmonyMappings, validateHarmonyMappingSelection,
  type HarmonyInventory, type HarmonyMapping,
} from './harmony-contract';

const group = { id: 'client-a', name: 'Client A', type: 'GROUP' as const };
const other = { id: 'client-b', name: 'Other client', type: 'VIRTUAL_GROUP' as const };
function computer(id = 'endpoint-a', groups: { id: string; name: string }[] = [group]) {
  return { computerId: id, computerName: id, computerGroups: groups };
}

describe('Harmony normalized evidence', () => {
  it('projects the documented fields without exposing raw provider data or inferring protection', () => {
    const result = normalizeHarmonyComputer({
      ...computer(), amStatus: 'OK', antiMalware: { engineName: 'Check Point', engineStatus: 'Running', realTimeProtection: true },
      computerIP: '192.0.2.5', computerClientVersion: 'E89', osName: 'Windows', osVersion: '11',
      computerLastLoggedInUser: 'EXAMPLE\\staff', computerLastConnection: '2026-10-14T12:00:00+02:00',
      computerAmDatDate: '2026-10-14T01:00:00Z', computerAmDatVersion: 'v1', computerAmScannedon: '2026-10-13T01:00:00Z',
      computerAmTotalInfected: '0', computerAmTotalQuarantined: '12', isDeleted: false,
      computerFdeRecoveryType: 'private recovery material', deviceComment: 'sensitive note',
      bladeStatus: [{ bladeName: 'Anti-Malware', bladeStatus: 'INSTALLED_RUNNING', statusDescription: [{ private: 'data' }] }],
    });
    expect(result).toMatchObject({ id: 'endpoint-a', groupIds: ['client-a'], realTimeProtection: null,
      lastConnectedAt: '2026-10-14T10:00:00.000Z', definitionsUpdatedAt: '2026-10-14T01:00:00.000Z',
      infectedCount: 0, quarantinedCount: 12, engineStatus: 'Running', deleted: false,
      blades: [{ name: 'Anti-Malware', status: 'INSTALLED_RUNNING' }] });
    expect(JSON.stringify(result)).not.toMatch(/private recovery|sensitive note|statusDescription/);
  });
  it('keeps unknown dates, counters and state unknown rather than inventing zeros or timezone', () => {
    expect(normalizeHarmonyComputer({ ...computer(), computerAmTotalInfected: 'N/A', computerAmTotalQuarantined: -1,
      computerLastConnection: '2026-10-14T09:00:00', computerAmScannedon: '' })).toMatchObject({
      realTimeProtection: null, infectedCount: null, quarantinedCount: null, lastConnectedAt: null, lastScanAt: null, deleted: null,
    });
  });
  it.each([undefined, null, {}, [{ name: 'Group with no ID' }]].map(value => [value]))('rejects unavailable or malformed membership %j', computerGroups => {
    expect(() => normalizeHarmonyComputer({ ...computer(), computerGroups })).toThrow();
  });
  it('allows an explicitly empty membership list but rejects duplicate group identities', () => {
    expect(normalizeHarmonyComputer(computer('none', [])).groupIds).toEqual([]);
    expect(() => normalizeHarmonyComputer(computer('duplicate', [group, group]))).toThrow();
  });
  it.each([null, [], { computerId: '' }, { ...computer(), computerName: 'x'.repeat(1025) }])('rejects malformed endpoint %j', row => {
    expect(() => normalizeHarmonyComputer(row)).toThrow();
  });
  it('restricts organization discovery to documented group kinds', () => {
    expect(normalizeHarmonyGroup({ id: 'g', type: 'OFFLINE_GROUP' })).toEqual({ id: 'g', name: 'g', type: 'OFFLINE_GROUP' });
    expect(() => normalizeHarmonyGroup({ id: 'u', type: 'USER', name: 'Someone' })).toThrow();
  });
});

describe('Harmony client scope', () => {
  const all = { checkedAt: '2026-10-14T12:00:00Z', groups: [group, other], computers: [
    normalizeHarmonyComputer(computer()),
    normalizeHarmonyComputer(computer('other-client-computer', [other])),
    normalizeHarmonyComputer(computer('shared-memberships', [group, other])),
    normalizeHarmonyComputer({ ...computer('deleted'), isDeleted: true }),
    normalizeHarmonyComputer(computer('ungrouped', [])),
  ] };
  it('selects exact group IDs and removes other group identities from included endpoints', () => {
    const scoped = scopeHarmonyInventory(all, ['client-a']);
    expect(scoped.computers.map(row => row.id)).toEqual(['endpoint-a', 'shared-memberships']);
    expect(scoped.computers.every(row => row.groupIds.join() === 'client-a')).toBe(true);
    expect(JSON.stringify(scoped)).not.toMatch(/client-b|Other client|other-client-computer|ungrouped/);
    expect(all.computers[2].groupIds).toEqual(['client-a', 'client-b']);
  });
  it.each([[], null, undefined, [''], ['client-a', 'client-a'], Array.from({ length: 101 }, (_, n) => String(n))].map(value => [value]))('rejects absent or invalid scope %j', value => {
    expect(() => validateHarmonyGroupIds(value)).toThrow();
  });
  it.each(['Client A', 'CLIENT-A', 'gone'])('never falls back to label matching or all inventory for %j', selected => {
    expect(() => scopeHarmonyInventory(all, [selected])).toThrow('harmony_group_unavailable');
  });
  it.each(['VIRTUAL_GROUP', 'OFFLINE_GROUP'] as const)('does not allow %s to scope a client', type => {
    expect(() => scopeHarmonyInventory({ ...all, groups: [{ ...group, type }] }, [group.id])).toThrow('harmony_group_scope_not_custom');
  });
});

const ORG_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const ORG_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const clientB = { ...other, type: 'GROUP' as const };
const virtual = { id: 'desktops', name: 'All desktops', type: 'VIRTUAL_GROUP' as const };
const offline = { id: 'offline', name: 'Offline machines', type: 'OFFLINE_GROUP' as const };
const mapping = (kind: HarmonyMapping['kind'], externalId: string, orgId = ORG_A): HarmonyMapping => ({ orgId, kind, externalId });
function completeInventory(): HarmonyInventory {
  return { checkedAt: '2026-10-14T12:00:00Z', groups: [group, clientB, virtual, offline].map(row => ({ ...row })), computers: [
    normalizeHarmonyComputer({ ...computer('a', [group, virtual]), bladeStatus: [{ bladeName: 'Anti-Malware', bladeStatus: 'Running' }] }),
    normalizeHarmonyComputer(computer('b', [clientB])),
    normalizeHarmonyComputer(computer('shared', [group, clientB, virtual])),
    normalizeHarmonyComputer(computer('ungrouped', [])),
    normalizeHarmonyComputer({ ...computer('deleted', [group]), isDeleted: true }),
    normalizeHarmonyComputer(computer('generic-only', [virtual, offline])),
  ] };
}

describe('Harmony mapping configuration', () => {
  it.each([
    undefined, null, {}, [null], [[]], [{ ...mapping('group', group.id), orgId: 'client-name' }],
    [{ ...mapping('group', group.id), orgId: ' aaaaaaaa-1111-4111-8111-111111111111' }],
    [{ ...mapping('group', group.id), kind: 'hostname' }], [{ ...mapping('group', group.id), externalId: '' }],
    [{ ...mapping('group', group.id), externalId: 'bad\nID' }],
    [{ ...mapping('group', group.id), defaultOrgId: ORG_B }],
    Array.from({ length: 1001 }, (_, n) => mapping('endpoint', `endpoint-${n}`)),
  ].map(value => [value]))('rejects malformed or unbounded mapping input %j', value => {
    expect(() => validateHarmonyMappings(value)).toThrow('harmony_invalid_mappings');
  });
  it('permits 1000 mappings and treats zero mappings as no publication', () => {
    expect(validateHarmonyMappings(Array.from({ length: 1000 }, (_, n) => mapping('endpoint', `endpoint-${n}`)))).toHaveLength(1000);
    expect(partitionHarmonyInventory(completeInventory(), [])).toEqual({
      projections: [], setup: { unavailableScopeCount: 0, conflictedEndpointCount: 0 },
    });
  });
  it('normalizes UUID case and deduplicates the same exact scope for the same organization', () => {
    expect(validateHarmonyMappings([mapping('group', group.id), mapping('group', group.id, ORG_A.toUpperCase())]))
      .toEqual([mapping('group', group.id)]);
  });
  it.each(['group', 'endpoint'] as const)('rejects one %s ID assigned to different organizations', kind => {
    const mappings = [mapping(kind, 'same-id'), mapping(kind, 'same-id', ORG_B)];
    expect(() => validateHarmonyMappings(mappings)).toThrow('harmony_mapping_conflict');
    expect(() => partitionHarmonyInventory(completeInventory(), mappings)).toThrow('harmony_mapping_conflict');
  });
  it('keeps group and endpoint identifier namespaces separate', () => {
    expect(validateHarmonyMappings([mapping('group', 'same-id'), mapping('endpoint', 'same-id', ORG_B)])).toHaveLength(2);
  });
  it('requires a currently present custom group or nondeleted endpoint at initial setup', () => {
    const all = completeInventory();
    expect(validateHarmonyMappingSelection(all, [mapping('group', group.id), mapping('endpoint', 'ungrouped')]))
      .toEqual([mapping('group', group.id), mapping('endpoint', 'ungrouped')]);
    expect(() => validateHarmonyMappingSelection(all, [mapping('group', 'missing')])).toThrow('harmony_group_unavailable');
    for (const id of ['missing', 'deleted']) {
      expect(() => validateHarmonyMappingSelection(all, [mapping('endpoint', id)])).toThrow('harmony_endpoint_unavailable');
    }
  });
  it.each([virtual.id, offline.id])('rejects generic group %s both during setup and later partitioning', id => {
    const all = completeInventory(); const mappings = [mapping('group', id)];
    expect(() => validateHarmonyMappingSelection(all, mappings)).toThrow('harmony_group_scope_not_custom');
    expect(() => partitionHarmonyInventory(all, mappings)).toThrow('harmony_group_scope_not_custom');
  });
});

describe('Harmony complete snapshot partitioning', () => {
  it('withholds cross-client group membership from every projection and exposes only setup counts', () => {
    const result = partitionHarmonyInventory(completeInventory(), [mapping('group', group.id), mapping('group', clientB.id, ORG_B)]);
    expect(result.projections.map(row => [row.orgId, row.computers.map(pc => pc.id)])).toEqual([[ORG_A, ['a']], [ORG_B, ['b']]]);
    expect(result.setup).toEqual({ unavailableScopeCount: 0, conflictedEndpointCount: 1 });
    const client = result.projections[0];
    expect(client.groups).toEqual([group]); expect(client.computers[0].groupIds).toEqual([group.id]);
    expect(JSON.stringify(client)).not.toMatch(/client-b|Other client|desktops|All desktops|shared|conflicted|unavailable/);
  });
  it('withholds conflicting endpoint and group claims without giving either kind priority', () => {
    const result = partitionHarmonyInventory(completeInventory(), [mapping('group', group.id), mapping('endpoint', 'a', ORG_B)]);
    expect(result.projections.map(row => row.computers.map(pc => pc.id))).toEqual([['shared'], []]);
    expect(result.setup.conflictedEndpointCount).toBe(1);
    expect(result.projections.every(row => !row.computers.some(pc => pc.id === 'a'))).toBe(true);
  });
  it('allows multiple same-client group and endpoint matches without duplicating an endpoint', () => {
    const result = partitionHarmonyInventory(completeInventory(), [
      mapping('group', group.id), mapping('group', clientB.id), mapping('endpoint', 'shared'), mapping('group', group.id),
    ]);
    expect(result.projections[0].computers.map(pc => pc.id)).toEqual(['a', 'b', 'shared']);
    expect(result.projections[0].computers[2].groupIds).toEqual([group.id, clientB.id]);
    expect(result.setup).toEqual({ unavailableScopeCount: 0, conflictedEndpointCount: 0 });
  });
  it('publishes an explicit endpoint with no group metadata unless the same client maps that group', () => {
    const all = completeInventory();
    const explicit = partitionHarmonyInventory(all, [mapping('endpoint', 'shared')]).projections[0];
    expect(explicit.groups).toEqual([]); expect(explicit.computers[0].groupIds).toEqual([]);
    const withGroup = partitionHarmonyInventory(all, [mapping('endpoint', 'shared'), mapping('group', group.id)]).projections[0];
    expect(withGroup.groups).toEqual([group]);
    expect(withGroup.computers.find(pc => pc.id === 'shared')!.groupIds).toEqual([group.id]);
  });
  it('supports an explicitly mapped ungrouped endpoint without a generic group fallback', () => {
    const result = partitionHarmonyInventory(completeInventory(), [mapping('endpoint', 'ungrouped')]);
    expect(result.projections[0].computers.map(pc => pc.id)).toEqual(['ungrouped']);
    expect(result.projections[0].groups).toEqual([]);
  });
  it('retains empty projections for disappeared/deleted scopes without returning other tenant data', () => {
    const result = partitionHarmonyInventory(completeInventory(), [
      mapping('group', 'disappeared'), mapping('endpoint', 'deleted'), mapping('endpoint', 'missing', ORG_B),
    ]);
    expect(result.projections).toEqual([ORG_A, ORG_B].map(orgId => ({ orgId, checkedAt: '2026-10-14T12:00:00Z', groups: [], computers: [] })));
    expect(result.setup).toEqual({ unavailableScopeCount: 3, conflictedEndpointCount: 0 });
  });
  it('does not match a stale group membership if that group is absent from complete discovery', () => {
    const all = completeInventory(); all.groups = all.groups.filter(row => row.id !== group.id);
    const result = partitionHarmonyInventory(all, [mapping('group', group.id)]);
    expect(result.projections[0].computers).toEqual([]); expect(result.projections[0].groups).toEqual([]);
    expect(result.setup.unavailableScopeCount).toBe(1);
  });
  it('does not let one unavailable scope suppress independently valid same-client ownership', () => {
    const result = partitionHarmonyInventory(completeInventory(), [mapping('group', 'missing'), mapping('endpoint', 'a')]);
    expect(result.projections[0].computers.map(pc => pc.id)).toEqual(['a']);
    expect(result.projections[0].computers[0].groupIds).toEqual([]);
    expect(result.setup.unavailableScopeCount).toBe(1);
  });
  it('never infers ownership from a computer name, IP, group label, or case-folded external ID', () => {
    const all = completeInventory(); all.computers[0].name = 'friendly-name'; all.computers[0].ipAddress = '192.0.2.5';
    const result = partitionHarmonyInventory(all, [
      mapping('endpoint', 'friendly-name'), mapping('endpoint', '192.0.2.5'), mapping('endpoint', 'A'), mapping('group', 'Client A'),
    ]);
    expect(result.projections[0].computers).toEqual([]); expect(result.setup.unavailableScopeCount).toBe(4);
  });
  it('excludes deleted and unmapped computers without treating deleted conflicts as live conflicts', () => {
    const all = completeInventory(); all.computers.find(pc => pc.id === 'shared')!.deleted = true;
    const result = partitionHarmonyInventory(all, [mapping('group', group.id), mapping('group', clientB.id, ORG_B)]);
    expect(result.projections.flatMap(row => row.computers.map(pc => pc.id))).toEqual(['a', 'b']);
    expect(result.setup.conflictedEndpointCount).toBe(0);
  });
  it.each(['groups', 'computers'] as const)('rejects duplicate %s identities instead of resolving contradictory snapshot evidence', field => {
    const all = completeInventory();
    if (field === 'groups') all.groups.push({ ...all.groups[0] });
    else all.computers.push({ ...all.computers[0] });
    expect(() => partitionHarmonyInventory(all, [mapping('endpoint', 'a')])).toThrow('harmony_snapshot_changed');
  });
  it('does not mutate input and returns independently mutable group, membership and blade data', () => {
    function freeze(value: unknown): void {
      if (!value || typeof value !== 'object') return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    const all = completeInventory(); const mappings = [mapping('group', group.id)];
    const before = JSON.stringify({ all, mappings }); freeze(all); freeze(mappings);
    const result = partitionHarmonyInventory(all, mappings);
    result.projections[0].groups[0].name = 'changed';
    result.projections[0].computers[0].groupIds.push('changed');
    result.projections[0].computers[0].blades[0].status = 'changed';
    expect(JSON.stringify({ all, mappings })).toBe(before);
  });
});
