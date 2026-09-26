import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(fileURLToPath(new URL('../../migrations/2026-09-25-microsoft-directory-layouts.sql', import.meta.url)), 'utf8');

describe('Microsoft directory layout migration', () => {
  it('keeps personal layout state scoped to both actor and organization', () => {
    expect(migration).toMatch(/PRIMARY KEY \(org_id, actor_id, resource\)/i);
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/breeze_has_org_access\(org_id\) AND actor_id = breeze_current_user_id\(\)/i);
  });
});
