import type { ItGlueRow } from './itGlue';
import { parseTotpSecret } from '../server/totp';

export interface ItGlueOrganizationMapping {
  sourceOrganization: string;
  organizationId: string;
}

/** Internal plan: groups contain plaintext import rows. Only expose preview to callers. */
export interface ItGlueImportPlan {
  groups: Array<{ organizationId: string; sourceOrganizations: string[]; rows: ItGlueRow[] }>;
  preview: {
    total: number;
    importable: number;
    pending: number;
    excluded: number;
    invalid: number;
    organizations: Array<{ organizationId: string; sourceOrganizations: string[]; count: number }>;
  };
}

export class ItGlueMappingError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ItGlueMappingError'; }
}

const invalid = (code: string): never => { throw new ItGlueMappingError(code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonBlockingIssues = new Set(['missing_username', 'missing_password']);

function rowIsInvalid(row: ItGlueRow): boolean {
  if (!row.sourceId.trim() || !row.sourceOrganization.trim() || !row.name.trim()) return true;
  if (row.issues.some(issue => !nonBlockingIssues.has(issue))) return true;
  if (row.otpSecret) {
    try { parseTotpSecret(row.otpSecret).key.fill(0); }
    catch { return true; }
  }
  return false;
}

/**
 * No fuzzy matching, default client or cross-client fallback. Multiple source
 * organizations may target one client only through individual explicit entries.
 * Host routes must separately authorize every destination organization.
 * Counts are disjoint: explicit exclusion wins, then invalid, pending, importable.
 */
export function planItGlueImport(
  rows: readonly ItGlueRow[],
  mappings: readonly ItGlueOrganizationMapping[],
  excludedOrganizations: readonly string[] = [],
): ItGlueImportPlan {
  const sources = new Set(rows.map(row => row.sourceOrganization));
  const targets = new Map<string, string>();
  const excluded = new Set<string>();
  for (const mapping of mappings) {
    const source = mapping.sourceOrganization;
    if (!source || source !== source.trim() || !sources.has(source)) invalid('unknown_source_organization');
    if (!uuid.test(mapping.organizationId)) invalid('invalid_target_organization');
    if (targets.has(source)) invalid('duplicate_source_mapping');
    targets.set(source, mapping.organizationId.toLowerCase());
  }
  for (const source of excludedOrganizations) {
    if (!sources.has(source)) invalid('unknown_source_organization');
    if (excluded.has(source)) invalid('duplicate_exclusion');
    if (targets.has(source)) invalid('conflicting_exclusion');
    excluded.add(source);
  }
  const groups = new Map<string, ItGlueImportPlan['groups'][number]>();
  const preview: ItGlueImportPlan['preview'] = { total: rows.length, importable: 0, pending: 0, excluded: 0, invalid: 0, organizations: [] };
  const sourceIds = new Set<string>();
  for (const row of rows) {
    if (row.sourceId && sourceIds.has(row.sourceId)) invalid('duplicate_source_id');
    if (row.sourceId) sourceIds.add(row.sourceId);
    if (excluded.has(row.sourceOrganization)) { preview.excluded++; continue; }
    if (rowIsInvalid(row)) { preview.invalid++; continue; }
    const organizationId = targets.get(row.sourceOrganization);
    if (!organizationId) { preview.pending++; continue; }
    let group = groups.get(organizationId);
    if (!group) {
      group = { organizationId, sourceOrganizations: [], rows: [] };
      groups.set(organizationId, group);
    }
    if (!group.sourceOrganizations.includes(row.sourceOrganization)) group.sourceOrganizations.push(row.sourceOrganization);
    // Snapshot the mutable row and its issue array; later input edits cannot change the plan.
    group.rows.push({ ...row, issues: [...row.issues] });
    preview.importable++;
  }
  const ordered = [...groups.values()].sort((a, b) => a.organizationId.localeCompare(b.organizationId));
  for (const group of ordered) group.sourceOrganizations.sort();
  preview.organizations = ordered.map(group => ({ organizationId: group.organizationId, sourceOrganizations: [...group.sourceOrganizations], count: group.rows.length }));
  return { groups: ordered, preview };
}
