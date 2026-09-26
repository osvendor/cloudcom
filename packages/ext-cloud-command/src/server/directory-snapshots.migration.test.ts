import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(fileURLToPath(new URL('../../migrations/2026-09-25-microsoft-directory-snapshots.sql', import.meta.url)), 'utf8');
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../manifest.json', import.meta.url)), 'utf8'));

describe('Microsoft directory snapshot tenancy', () => {
  it('forces organization RLS and keeps raw directory/usage data out of organization exports', () => {
    expect(migration).toMatch(/org_id uuid PRIMARY KEY/i);
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/USING \(breeze_has_org_access\(org_id\)\)/i);
    expect(migration).toMatch(/WITH CHECK \(breeze_has_org_access\(org_id\)\)/i);
    expect(manifest.tenancy.orgCascadeDeleteTables).toContain('cloudcommand_microsoft_directory_snapshots');
    expect(manifest.tenancy.orgExportColumns.cloudcommand_microsoft_directory_snapshots.exclude)
      .toEqual(expect.arrayContaining(['directory_data', 'usage_data']));
  });
});
