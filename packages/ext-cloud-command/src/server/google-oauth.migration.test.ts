import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(fileURLToPath(new URL('../../migrations/2026-09-23-google-oauth-connections.sql', import.meta.url)), 'utf8');
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../manifest.json', import.meta.url)), 'utf8'));

describe('Google OAuth extension migration', () => {
  it('keeps refresh grants separate from DWD and forces org/actor RLS', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS cloudcommand_google_oauth_connections/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS cloudcommand_google_oauth_attempts/);
    expect(migration).toMatch(/UNIQUE \(customer_id\)/);
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(migration).toMatch(/breeze_has_org_access\(org_id\)/);
    expect(migration).toMatch(/actor_id = breeze_current_user_id\(\)/);
    expect(migration).not.toMatch(/ALTER TABLE google_workspace_connections/i);
  });
  it('excludes token, PKCE verifier and browser state from org exports', () => {
    const columns = manifest.tenancy.orgExportColumns;
    expect(columns.cloudcommand_google_oauth_connections.exclude).toContain('refresh_token');
    expect(columns.cloudcommand_google_oauth_attempts.exclude).toEqual(expect.arrayContaining([
      'state_hash', 'browser_hash', 'verifier_ciphertext']));
    expect(manifest.tenancy.orgCascadeDeleteTables).toEqual(expect.arrayContaining([
      'cloudcommand_google_oauth_connections', 'cloudcommand_google_oauth_attempts']));
  });
});
