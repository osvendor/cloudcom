import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(fileURLToPath(new URL('../../migrations/2026-09-22-microsoft-directory-preferences.sql', import.meta.url)), 'utf8');

describe('Microsoft directory preference migration', () => {
  it('creates an actor-and-organization scoped preference table with forced RLS', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS cloudcommand_microsoft_directory_preferences/i);
    expect(migration).toMatch(/PRIMARY KEY \(org_id, actor_id, microsoft_user_id\)/i);
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/breeze_has_org_access\(org_id\) AND actor_id = breeze_current_user_id\(\)/i);
    expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE .* TO breeze_app/i);
  });
});
