import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, getAppDb } from './setup';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { partners, organizations, users } from '../../db/schema';
import { loadBuiltinExtensions } from '../../extensions/builtinExtensions';
import { BUILTINS } from '../../extensions/builtinRegistry';
import { ExtensionContributionRegistry } from '../../extensions/contributionRegistry';
import { createExtensionStateStore } from '../../extensions/stateStore';

describe('Cloud Command Google OAuth isolation', () => {
  it('enforces org RLS and actor-bound consent attempts as breeze_app', async () => {
    const admin = getTestDb();
    const [partner] = await admin.insert(partners).values({ name: 'OAuth isolation', slug: `google-oauth-${crypto.randomUUID()}`, type: 'msp' }).returning();
    const [a, b] = await admin.insert(organizations).values(['a', 'b'].map(letter => ({
      partnerId: partner!.id, name: `Google ${letter}`, slug: `google-${letter}-${crypto.randomUUID()}`, currencyCode: 'USD',
    }))).returning();
    const [actorA, actorB] = await admin.insert(users).values(['a', 'b'].map(letter => ({
      partnerId: partner!.id, name: `Technician ${letter}`, email: `${crypto.randomUUID()}@example.test`, status: 'active' as const,
    }))).returning();
    const builtin = BUILTINS.find(item => item.name === 'cloudcommand')!;
    const previous = process.env.CLOUDCOM_THREECX_ENABLED;
    try {
      process.env.CLOUDCOM_THREECX_ENABLED = 'true';
      await loadBuiltinExtensions({ registry: new ExtensionContributionRegistry(), stateStore: createExtensionStateStore(), ports: { builtins: [builtin] } });
    } finally {
      if (previous === undefined) delete process.env.CLOUDCOM_THREECX_ENABLED;
      else process.env.CLOUDCOM_THREECX_ENABLED = previous;
    }
    for (const table of ['cloudcommand_google_oauth_connections', 'cloudcommand_google_oauth_attempts']) {
      const state = await admin.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ${table}::regclass`);
      expect(state[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
    const context = (orgId: string, userId: string) => ({ scope: 'organization' as const, orgId,
      partnerId: partner!.id, accessibleOrgIds: [orgId], userId });
    await withDbAccessContext(context(a!.id, actorA!.id), async () => {
      await db.execute(sql`INSERT INTO cloudcommand_google_oauth_attempts
        (state_hash, org_id, actor_id, browser_hash, verifier_ciphertext, expected_domain, expires_at)
        VALUES ('state-a', ${a!.id}::uuid, ${actorA!.id}::uuid, 'browser-a', 'encrypted-fixture',
          'example.test', now() + interval '10 minutes')`);
      await db.execute(sql`INSERT INTO cloudcommand_google_oauth_connections
        (org_id, customer_id, customer_domain, authorized_email, refresh_token, granted_scopes)
        VALUES (${a!.id}::uuid, 'C123', 'example.test', 'admin@example.test', 'encrypted-fixture', 'scope')`);
      expect(await db.execute(sql`SELECT customer_id FROM cloudcommand_google_oauth_connections`)).toHaveLength(1);
      expect(await db.execute(sql`SELECT state_hash FROM cloudcommand_google_oauth_attempts`)).toHaveLength(1);
    });
    await withDbAccessContext(context(a!.id, actorB!.id), async () => {
      expect(await db.execute(sql`SELECT state_hash FROM cloudcommand_google_oauth_attempts`)).toHaveLength(0);
      expect(await db.execute(sql`SELECT customer_id FROM cloudcommand_google_oauth_connections`)).toHaveLength(1);
    });
    await withDbAccessContext(context(b!.id, actorA!.id), async () => {
      expect(await db.execute(sql`SELECT state_hash FROM cloudcommand_google_oauth_attempts`)).toHaveLength(0);
      expect(await db.execute(sql`SELECT customer_id FROM cloudcommand_google_oauth_connections`)).toHaveLength(0);
    });
    await expect(withDbAccessContext(context(b!.id, actorA!.id), () => db.execute(sql`DELETE FROM cloudcommand_google_oauth_connections WHERE org_id = ${a!.id}::uuid RETURNING id`)))
      .resolves.toHaveLength(0);
    expect(await getAppDb().execute(sql`SELECT * FROM cloudcommand_google_oauth_connections`)).toHaveLength(0);
    await withSystemDbAccessContext(async () => {
      expect(await db.execute(sql`SELECT state_hash FROM cloudcommand_google_oauth_attempts WHERE state_hash = 'state-a'`)).toHaveLength(1);
    });

    // The two route write paths take the same organization-row lock before
    // checking the opposite credential table. Race them against a fresh org:
    // exactly one mode may commit, regardless of which request wins the lock.
    const oauthConnect = () => withDbAccessContext(context(b!.id, actorA!.id), () => db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM organizations WHERE id = ${b!.id}::uuid FOR UPDATE`);
      if ((await tx.execute(sql`SELECT id FROM google_workspace_connections WHERE org_id = ${b!.id}::uuid`)).length) return false;
      await tx.execute(sql`INSERT INTO cloudcommand_google_oauth_connections
        (org_id, customer_id, customer_domain, authorized_email, refresh_token, granted_scopes)
        VALUES (${b!.id}::uuid, 'C-race', 'example.test', 'admin@example.test', 'encrypted-fixture', 'scope')`);
      return true;
    }));
    const dwdConnect = () => withDbAccessContext(context(b!.id, actorB!.id), () => db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM organizations WHERE id = ${b!.id}::uuid FOR UPDATE`);
      if ((await tx.execute(sql`SELECT id FROM cloudcommand_google_oauth_connections WHERE org_id = ${b!.id}::uuid`)).length) return false;
      await tx.execute(sql`INSERT INTO google_workspace_connections
        (org_id, customer_domain, admin_email, service_account_email, service_account_key)
        VALUES (${b!.id}::uuid, 'example.test', 'admin@example.test', 'sa@example.test', 'encrypted-fixture')`);
      return true;
    }));
    const winners = await Promise.all([oauthConnect(), dwdConnect()]);
    expect(winners.filter(Boolean)).toHaveLength(1);
    const oauthRows = await admin.execute(sql`SELECT id FROM cloudcommand_google_oauth_connections WHERE org_id = ${b!.id}::uuid`);
    const dwdRows = await admin.execute(sql`SELECT id FROM google_workspace_connections WHERE org_id = ${b!.id}::uuid`);
    expect(oauthRows.length + dwdRows.length).toBe(1);
  });
});
