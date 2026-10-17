import { describe, expect, it } from 'vitest';
import type { ItGlueRow } from './itGlue';
import { planItGlueImport } from './mapping';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const row = (sourceId: string, sourceOrganization = 'Client A', extra: Partial<ItGlueRow> = {}): ItGlueRow => ({
  sourceId, sourceOrganization, name: 'PRIVATE-NAME', category: '', username: 'PRIVATE-USERNAME', email: '',
  password: 'PRIVATE-PASSWORD', url: 'https://private.invalid', notes: 'PRIVATE-NOTES', otpSecret: '', archived: false, issues: [], ...extra,
});

describe('explicit client import mapping', () => {
  it('keeps unmapped clients pending without fuzzy or default assignment', () => {
    const plan = planItGlueImport([row('1'), row('2', 'client a'), row('3', 'Client B')], [{ sourceOrganization: 'Client A', organizationId: A }]);
    expect(plan.preview).toMatchObject({ total: 3, importable: 1, pending: 2, excluded: 0, invalid: 0 });
    expect(plan.groups[0]?.rows.map(r => r.sourceId)).toEqual(['1']);
  });
  it('groups clients separately and combines targets only with explicit per-source entries', () => {
    const rows = [row('1'), row('2', 'Client B')];
    const mappings = [{ sourceOrganization: 'Client A', organizationId: A }, { sourceOrganization: 'Client B', organizationId: B }];
    expect(planItGlueImport(rows, mappings).groups).toHaveLength(2);
    const combined = planItGlueImport(rows, [{ ...mappings[0]! }, { ...mappings[1]!, organizationId: A }]);
    expect(combined.groups).toHaveLength(1);
    expect(combined.preview.organizations[0]).toEqual({ organizationId: A, sourceOrganizations: ['Client A', 'Client B'], count: 2 });
  });
  it('rejects conflicting or ambiguous configuration and bad targets', () => {
    const rows = [row('1')];
    const mapping = { sourceOrganization: 'Client A', organizationId: A };
    expect(() => planItGlueImport(rows, [mapping, mapping])).toThrow('duplicate_source_mapping');
    expect(() => planItGlueImport(rows, [mapping], ['Client A'])).toThrow('conflicting_exclusion');
    expect(() => planItGlueImport(rows, [], ['Client A', 'Client A'])).toThrow('duplicate_exclusion');
    expect(() => planItGlueImport(rows, [{ ...mapping, sourceOrganization: 'client a' }])).toThrow('unknown_source_organization');
    expect(() => planItGlueImport(rows, [{ ...mapping, organizationId: 'not-a-client' }])).toThrow('invalid_target_organization');
  });
  it('never imports invalid OTP, incomplete identity, or unrecognized validation issues', () => {
    const rows = [row('1', 'Client A', { otpSecret: 'bad!' }), row('2', 'Client A', { issues: ['invalid_otp_secret'] }), row('3', 'Client A', { issues: ['otp_value_without_secret'] }), row('4', 'Client A', { name: '' }), row('5', 'Client A', { issues: ['unknown'] }), row('6', 'Client A', { username: '', password: '', issues: ['missing_username', 'missing_password'], otpSecret: 'JBSWY3DPEHPK3PXP' })];
    const plan = planItGlueImport(rows, [{ sourceOrganization: 'Client A', organizationId: A }]);
    expect(plan.preview).toMatchObject({ importable: 1, invalid: 5 });
    expect(plan.groups[0]?.rows.map(r => r.sourceId)).toEqual(['6']);
  });
  it('counts exclusions distinctly and exposes no row values in preview', () => {
    const plan = planItGlueImport([row('1'), row('2', 'Client B')], [{ sourceOrganization: 'Client A', organizationId: A }], ['Client B']);
    expect(plan.preview).toMatchObject({ total: 2, excluded: 1, importable: 1, invalid: 0, pending: 0 });
    expect(JSON.stringify(plan.preview)).not.toMatch(/PRIVATE|private\.invalid/);
    expect(plan.groups[0]?.rows[0]?.password).toBe('PRIVATE-PASSWORD');
  });
  it('rejects duplicate source ids and snapshots inputs', () => {
    expect(() => planItGlueImport([row('1'), row('1', 'Client B')], [])).toThrow('duplicate_source_id');
    const input = row('1');
    const plan = planItGlueImport([input], [{ sourceOrganization: 'Client A', organizationId: A }]);
    input.password = 'changed'; input.issues.push('invalid_otp_secret');
    expect(plan.groups[0]?.rows[0]?.password).toBe('PRIVATE-PASSWORD');
    expect(plan.groups[0]?.rows[0]?.issues).toEqual([]);
  });
});
