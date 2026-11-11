import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { currentDeviceUser, previousDeviceUsers, deviceIdentitySearch } from './deviceIdentity';

const dialect = new PgDialect();
describe('device identities', () => {
  it('requires an online, recently observed user to claim current presence', () => {
    const { sql } = dialect.sqlToQuery(currentDeviceUser);
    expect(sql).toContain("= 'online'");
    expect(sql).toContain("interval '5 minutes'");
    expect(sql).toContain('NULLIF(BTRIM(');
    expect(sql).toContain('ELSE NULL');
  });
  it('binds history to both device and org, deduplicates and excludes the current user', () => {
    const { sql } = dialect.sqlToQuery(previousDeviceUsers);
    expect(sql).toContain('s.device_id = "devices"."id" AND s.org_id = "devices"."org_id"');
    expect(sql).toContain('DISTINCT ON (lower(entries.username))');
    expect(sql).toContain('IS DISTINCT FROM lower(');
    expect(sql).toContain('recent.seen_at DESC NULLS LAST');
    expect(sql).not.toContain('LIMIT 1');
  });
  it('searches original name, alias and all retained usernames with literal wildcard input', () => {
    const query = dialect.sqlToQuery(deviceIdentitySearch('a%_\\b'));
    expect(query.params).toEqual(Array(4).fill('%a\\%\\_\\\\b%'));
    expect(query.sql).toContain('"devices"."hostname" ILIKE');
    expect(query.sql).toContain('"devices"."display_name" ILIKE');
    expect(query.sql).toContain('s.username ILIKE');
    expect(query.sql).toContain('s.org_id = "devices"."org_id"');
  });
});
