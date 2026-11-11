import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { devices } from '../../db/schema/devices';
import { configPolicyMonitors } from '../../db/schema/monitorDefinitions';
import { configPolicyFeatureLinks } from '../../db/schema/configurationPolicies';
import type { DeviceHierarchy } from '../deviceHierarchy';
import { pickWinner, resolveMonitorsForDevice, selectContributingAttachments, MONITOR_RESOLVER_CAPABILITIES, type MonitorCandidate } from './monitorResolver';

function candidate(overrides: Partial<MonitorCandidate>): MonitorCandidate {
  return {
    monitorId: 'm',
    enabled: true,
    overrides: null,
    sourcePolicyId: 'p',
    sourceLevel: 'organization',
    inheritedFromParent: false,
    priority: 0,
    assignedAt: 0,
    ...overrides,
  };
}

describe('monitor attachment ranking (#5289)', () => {
  it('site override beats org baseline; a policy own row beats the one it inherits from its parent', () => {
    const winner = pickWinner([
      candidate({ sourcePolicyId: 'org-base', sourceLevel: 'organization' }),
      candidate({ sourcePolicyId: 'site-x', sourceLevel: 'site', enabled: false }),
      candidate({
        sourcePolicyId: 'site-x-parent',
        sourceLevel: 'site',
        inheritedFromParent: true,
        overrides: { value: 95 },
      }),
    ]);
    expect(winner.sourcePolicyId).toBe('site-x');
    expect(winner.enabled).toBe(false);
  });

  it('device beats device_group beats site beats organization beats partner', () => {
    const all: MonitorCandidate[] = [
      candidate({ sourcePolicyId: 'partner', sourceLevel: 'partner' }),
      candidate({ sourcePolicyId: 'org', sourceLevel: 'organization' }),
      candidate({ sourcePolicyId: 'site', sourceLevel: 'site' }),
      candidate({ sourcePolicyId: 'group', sourceLevel: 'device_group' }),
      candidate({ sourcePolicyId: 'device', sourceLevel: 'device' }),
    ];
    expect(pickWinner(all).sourcePolicyId).toBe('device');
    expect(pickWinner(all.slice(0, 4)).sourcePolicyId).toBe('group');
    expect(pickWinner(all.slice(0, 3)).sourcePolicyId).toBe('site');
    expect(pickWinner(all.slice(0, 2)).sourcePolicyId).toBe('org');
  });

  it('at the same level the LOWER assignment priority wins, then the earlier assignment', () => {
    expect(
      pickWinner([
        candidate({ sourcePolicyId: 'late', priority: 10 }),
        candidate({ sourcePolicyId: 'early', priority: 1 }),
      ]).sourcePolicyId,
    ).toBe('early');

    expect(
      pickWinner([
        candidate({ sourcePolicyId: 'second', assignedAt: 200 }),
        candidate({ sourcePolicyId: 'first', assignedAt: 100 }),
      ]).sourcePolicyId,
    ).toBe('first');
  });

  it('the winner carries its own overrides, not a merge of the losers', () => {
    const winner = pickWinner([
      candidate({ sourcePolicyId: 'org', overrides: { value: 70, durationMinutes: 5 } }),
      candidate({ sourcePolicyId: 'site', sourceLevel: 'site', overrides: { value: 95 } }),
    ]);
    expect(winner.overrides).toEqual({ value: 95 });
  });
});

describe('monitor link/attachment query parity', () => {
  const hierarchy: DeviceHierarchy = {
    deviceId: 'device', orgId: 'org', siteId: 'site', deviceRole: 'workstation', osType: 'windows',
    org: { partnerId: 'partner', type: 'customer' }, site: { id: 'site', name: 'Site', timezone: 'UTC' }, groupIds: [],
  };
  const assignment = (policyId: string, level: string, parentPolicyId: string | null = null) => ({
    policyId, parentPolicyId, level, priority: 0, createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const link = (configPolicyId: string, inheritance: unknown, monitorId: string | null, enabled: boolean | null = true) => ({
    configPolicyId, inlineSettings: { inheritance }, monitorId, enabled: monitorId === null ? null : enabled, overrides: null,
  });
  async function resolve(assignments: ReturnType<typeof assignment>[], rows: ReturnType<typeof link>[]) {
    const attachmentWhere = vi.fn(async (_where: Parameters<PgDialect['sqlToQuery']>[0]) => rows);
    const leftJoin = vi.fn((_table: unknown, _on: unknown) => ({ where: attachmentWhere }));
    const attachmentFrom = vi.fn(() => ({ leftJoin }));
    const select = vi.fn()
      .mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: async () => assignments }) }) }) })
      .mockReturnValueOnce({ from: attachmentFrom });
    const executor = { select } as unknown as NonNullable<Parameters<typeof resolveMonitorsForDevice>[1]>;
    const result = await resolveMonitorsForDevice('device', executor, { hierarchy });
    expect(select).toHaveBeenCalledTimes(2); // assignments + links/attachments, no separate replace read
    expect(attachmentFrom).toHaveBeenCalledWith(configPolicyFeatureLinks);
    expect(leftJoin.mock.calls[0]?.[0]).toBe(configPolicyMonitors);
    const query = new PgDialect().sqlToQuery(attachmentWhere.mock.calls[0]![0]);
    expect(query.sql).not.toContain("'inheritance'");
    expect(query.params).toContain('monitors');
    return result;
  }

  it('retains an empty replace link while suppressing its parent and farther replace assignments', async () => {
    expect(await resolve([
      assignment('site-p', 'site', 'parent-p'), assignment('org-p', 'organization'), assignment('partner-p', 'partner'),
    ], [
      link('site-p', 'replace', null), link('parent-p', 'cumulative', 'parent-monitor'),
      link('org-p', 'replace', 'org-monitor'), link('partner-p', 'cumulative', 'builtin'),
    ])).toEqual({ kind: 'resolved', monitors: [expect.objectContaining({ monitorId: 'builtin' })] });
  });

  it('allows an empty cumulative link to inherit parent attachments', async () => {
    expect(await resolve([assignment('child', 'site', 'parent')], [
      link('child', 'cumulative', null), link('parent', 'cumulative', 'cpu'),
    ])).toEqual({ kind: 'resolved', monitors: [expect.objectContaining({ monitorId: 'cpu', inheritedFromParent: true })] });
  });

  it('preserves disabled closest attachments and resolves multiple levels as before', async () => {
    expect(await resolve([assignment('org-p', 'organization'), assignment('site-p', 'site')], [
      link('org-p', 'cumulative', 'cpu'), link('site-p', 'cumulative', 'cpu', false),
    ])).toEqual({ kind: 'resolved', monitors: [expect.objectContaining({ monitorId: 'cpu', enabled: false, sourcePolicyId: 'site-p' })] });
  });

  it('handles the null attachment projection produced when RLS hides attachments but exposes a replace link', async () => {
    // Models the LEFT JOIN result, not a substitute for the real-RLS integration suite.
    expect(await resolve([assignment('child', 'site', 'parent')], [
      link('child', 'replace', null), link('parent', 'cumulative', 'cpu'),
    ])).toEqual({ kind: 'resolved', monitors: [] });
  });

  it.each([null, undefined, 'invalid'])('keeps invalid inheritance %s cumulative', async inheritance => {
    expect(await resolve([assignment('child', 'site', 'parent')], [
      link('child', inheritance, null), link('parent', 'cumulative', 'cpu'),
    ])).toEqual({ kind: 'resolved', monitors: [expect.objectContaining({ monitorId: 'cpu', inheritedFromParent: true })] });
  });
});


describe('monitor assignment device filters (#6344)', () => {
  it.each([
    ['workstation', 'windows'],
    ['server', 'linux'],
    ['laptop', 'macos'],
  ])('gates assignments on role %s and OS %s before loading attachments', async (deviceRole, osType) => {
    const assignmentWhere = vi.fn((_where: Parameters<PgDialect['sqlToQuery']>[0]) => ({ orderBy: async () => [] }));
    const select = vi.fn()
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [
        { id: 'device', orgId: 'org', siteId: 'site', deviceRole, osType },
      ] }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [{ partnerId: 'partner' }] }) }) })
      .mockReturnValueOnce({ from: () => ({ where: async () => [] }) })
      .mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ where: assignmentWhere }) }) });
    const executor = { select } as unknown as NonNullable<Parameters<typeof resolveMonitorsForDevice>[1]>;

    expect(await resolveMonitorsForDevice('device', executor)).toEqual({ kind: 'resolved', monitors: [] });
    const query = new PgDialect().sqlToQuery(assignmentWhere.mock.calls[0]![0]);
    expect(query.sql).toContain('"config_policy_assignments"."role_filter" IS NULL');
    expect(query.sql).toContain('ANY("config_policy_assignments"."role_filter")');
    expect(query.sql).toContain('"config_policy_assignments"."os_filter" IS NULL');
    expect(query.sql).toContain('ANY("config_policy_assignments"."os_filter")');
    expect(query.params.slice(-2)).toEqual([deviceRole, osType]);
    expect(select.mock.calls[0]![0]).toMatchObject({ deviceRole: devices.deviceRole, osType: devices.osType });
    expect(select).toHaveBeenCalledTimes(4);
  });

  it('never applies a partner-level assignment to a device whose org is the hidden quick_support org', async () => {
    const assignmentWhere = vi.fn((_where: Parameters<PgDialect['sqlToQuery']>[0]) => ({ orderBy: async () => [] }));
    const select = vi.fn()
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [
        { id: 'device', orgId: 'org', siteId: 'site', deviceRole: 'workstation', osType: 'windows' },
      ] }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [{ partnerId: 'partner', type: 'quick_support' }] }) }) })
      .mockReturnValueOnce({ from: () => ({ where: async () => [] }) })
      .mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ where: assignmentWhere }) }) });
    const executor = { select } as unknown as NonNullable<Parameters<typeof resolveMonitorsForDevice>[1]>;

    expect(await resolveMonitorsForDevice('device', executor)).toEqual({ kind: 'resolved', monitors: [] });
    const query = new PgDialect().sqlToQuery(assignmentWhere.mock.calls[0]![0]);
    // A partner-level config-policy assignment must never be considered for an
    // ephemeral Quick Support device — its org has no real fleet the partner
    // authored partner-wide policies against.
    expect(query.params).not.toContain('partner');
  });

  it('still applies a partner-level assignment to an ordinary org device (control)', async () => {
    const assignmentWhere = vi.fn((_where: Parameters<PgDialect['sqlToQuery']>[0]) => ({ orderBy: async () => [] }));
    const select = vi.fn()
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [
        { id: 'device', orgId: 'org', siteId: 'site', deviceRole: 'workstation', osType: 'windows' },
      ] }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [{ partnerId: 'partner', type: 'customer' }] }) }) })
      .mockReturnValueOnce({ from: () => ({ where: async () => [] }) })
      .mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ where: assignmentWhere }) }) });
    const executor = { select } as unknown as NonNullable<Parameters<typeof resolveMonitorsForDevice>[1]>;

    expect(await resolveMonitorsForDevice('device', executor)).toEqual({ kind: 'resolved', monitors: [] });
    const query = new PgDialect().sqlToQuery(assignmentWhere.mock.calls[0]![0]);
    expect(query.params).toContain('partner');
  });
});

describe('inheritance: replace (W05c1, spec §Inheritance correction)', () => {
  const assignment = (policyId: string, level: 'organization' | 'site' | 'partner', parentPolicyId: string | null = null, priority = 0) => ({
    policyId, parentPolicyId, level, priority, createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const row = (configPolicyId: string, monitorId: string) => ({ configPolicyId, monitorId, enabled: true, overrides: null });

  it('among replace links only the closest contributes; cumulative links still add; a replace policy never consults its parent', () => {
    const assignments = [
      assignment('partner-p', 'partner'),          // cumulative: built-ins
      assignment('org-p', 'organization', 'org-parent'), // replace: converted org rules
      assignment('site-p', 'site'),                // replace: converted site rules
    ];
    const byPolicy = new Map([
      ['partner-p', [row('partner-p', 'builtin-cpu')]],
      ['org-p', [row('org-p', 'org-rule-1')]],
      ['org-parent', [row('org-parent', 'parent-rule')]],
      ['site-p', [row('site-p', 'site-rule-1')]],
    ]);
    const inheritance = new Map([['org-p', 'replace' as const], ['site-p', 'replace' as const]]);

    const contributed = selectContributingAttachments({ assignments, byPolicy, inheritanceByPolicy: inheritance });
    const ids = contributed.map((c) => `${c.sourcePolicyId}:${c.monitorId}:${c.inheritedFromParent ? 'parent' : 'own'}`).sort();
    expect(ids).toEqual(['partner-p:builtin-cpu:own', 'site-p:site-rule-1:own']);
  });

  it('an empty replace attachment set continues to shadow inherited monitors', () => {
    const assignments = [assignment('child', 'site', 'parent')];
    const byPolicy = new Map([['parent', [row('parent', 'cpu')]]]);
    expect(selectContributingAttachments({ assignments, byPolicy,
      inheritanceByPolicy: new Map([['child', 'replace']]) })).toEqual([]);
  });
  it('cumulative everywhere reproduces today\'s behaviour (own + parent for every assignment)', () => {
    const assignments = [assignment('org-p', 'organization', 'org-parent'), assignment('site-p', 'site')];
    const byPolicy = new Map([
      ['org-p', [row('org-p', 'm1')]],
      ['org-parent', [row('org-parent', 'm2')]],
      ['site-p', [row('site-p', 'm3')]],
    ]);
    const contributed = selectContributingAttachments({ assignments, byPolicy, inheritanceByPolicy: new Map() });
    expect(contributed.map((c) => c.monitorId).sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('declares the capabilities the converter checks', () => {
    expect(MONITOR_RESOLVER_CAPABILITIES).toEqual({ roleOsFilters: true, inheritance: true });
  });
});
