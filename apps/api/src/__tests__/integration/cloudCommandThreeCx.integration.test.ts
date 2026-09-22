import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, getAppDb } from './setup';
import { db, withDbAccessContext } from '../../db';
import { partners, organizations } from '../../db/schema';
import { encryptSecret, decryptForColumn } from '../../services/secretCrypto';
import { loadBuiltinExtensions } from '../../extensions/builtinExtensions';
import { BUILTINS } from '../../extensions/builtinRegistry';
import { ExtensionContributionRegistry } from '../../extensions/contributionRegistry';
import { createExtensionStateStore } from '../../extensions/stateStore';

describe('Cloud Command 3CX database boundary', () => {
  it('loads through the real host pipeline and remains safe to disable after migration', async () => {
    const previous = process.env.CLOUDCOM_THREECX_ENABLED;
    const builtin = BUILTINS.find(item => item.name === 'cloudcommand')!;
    const stateStore = createExtensionStateStore();
    try {
      process.env.CLOUDCOM_THREECX_ENABLED = 'true';
      const registry = new ExtensionContributionRegistry();
      await loadBuiltinExtensions({ registry, stateStore, ports: { builtins: [builtin] } });
      expect(registry.getByRouteNamespace('cloud-command')?.enabled).toBe(true);
      process.env.CLOUDCOM_THREECX_ENABLED = 'false';
      const disabled = new ExtensionContributionRegistry();
      await loadBuiltinExtensions({ registry: disabled, stateStore, ports: { builtins: [builtin] } });
      expect(disabled.getByRouteNamespace('cloud-command')).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CLOUDCOM_THREECX_ENABLED;
      else process.env.CLOUDCOM_THREECX_ENABLED = previous;
    }
  });
  it('enforces forced RLS as breeze_app for reads, writes, reparenting and deletion', async () => {
    const admin = getTestDb();
    const [partner] = await admin.insert(partners).values({ name: '3CX isolation test', slug: `threecx-${crypto.randomUUID()}`, type: 'msp' }).returning();
    const [a, b, c] = await admin.insert(organizations).values(['a', 'b', 'c'].map(suffix => ({
      partnerId: partner!.id, name: `3CX ${suffix}`, slug: `threecx-${suffix}-${crypto.randomUUID()}`, currencyCode: 'USD',
    }))).returning();
    const state = await admin.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'cloudcommand_threecx_connections'::regclass`);
    expect(state[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const insert = (org: string) => sql`INSERT INTO cloudcommand_threecx_connections (org_id, origin, client_id, secret_ciphertext) VALUES (${org}::uuid, 'https://pbx.example.com', 'test-client', 'encrypted-fixture')`;
    await admin.execute(insert(b!.id));
    const context = { scope: 'organization' as const, orgId: a!.id, partnerId: partner!.id, accessibleOrgIds: [a!.id] };
    await withDbAccessContext(context, async () => {
      const role = await db.execute(sql`SELECT current_user AS role`);
      expect(role[0]!.role).toBe('breeze_app');
      await db.execute(insert(a!.id));
      expect((await db.execute(sql`SELECT org_id FROM cloudcommand_threecx_connections`)).map(r => r.org_id)).toEqual([a!.id]);
      expect(await db.execute(sql`UPDATE cloudcommand_threecx_connections SET enabled = true WHERE org_id = ${b!.id}::uuid RETURNING id`)).toHaveLength(0);
      expect(await db.execute(sql`DELETE FROM cloudcommand_threecx_connections WHERE org_id = ${b!.id}::uuid RETURNING id`)).toHaveLength(0);
    });
    // Each expected SQL error uses a separate transaction: a rejected statement aborts its transaction.
    await expect(withDbAccessContext(context, () => db.execute(insert(c!.id)))).rejects.toThrow();
    await expect(withDbAccessContext(context, () => db.execute(sql`UPDATE cloudcommand_threecx_connections SET org_id = ${c!.id}::uuid WHERE org_id = ${a!.id}::uuid`))).rejects.toThrow();
    expect(await getAppDb().execute(sql`SELECT * FROM cloudcommand_threecx_connections`)).toHaveLength(0);
    await expect(getAppDb().execute(insert(c!.id))).rejects.toThrow();
  });

  it('binds encrypted credentials to the organization and column', () => {
    const table = 'cloudcommand_threecx_connections';
    const value = encryptSecret('synthetic-test-secret', { aad: `${table}.secret_ciphertext:org-a` })!;
    expect(value.startsWith('enc:v3:')).toBe(true);
    expect(decryptForColumn(table, 'secret_ciphertext:org-a', value)).toBe('synthetic-test-secret');
    expect(() => decryptForColumn(table, 'secret_ciphertext:org-b', value)).toThrow();
  });
});
