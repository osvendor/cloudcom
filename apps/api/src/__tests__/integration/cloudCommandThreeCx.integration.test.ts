import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, getAppDb } from './setup';
import { db, withDbAccessContext } from '../../db';
import { partners, organizations, users } from '../../db/schema';
import { encryptSecret, decryptForColumn } from '../../services/secretCrypto';
import { loadBuiltinExtensions } from '../../extensions/builtinExtensions';
import { BUILTINS } from '../../extensions/builtinRegistry';
import { ExtensionContributionRegistry } from '../../extensions/contributionRegistry';
import { createExtensionStateStore } from '../../extensions/stateStore';
import { createAdministrationStore, type ConsentAttempt } from '../../../../../packages/ext-cloud-command/src/server/admin-store';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';

describe('Cloud Command 3CX database boundary', () => {
  it('isolates Microsoft directory exclusions by organization and technician under forced RLS', async () => {
    const admin = getTestDb();
    const [partner] = await admin.insert(partners).values({ name: 'Directory preference isolation', slug: `pref-${crypto.randomUUID()}`, type: 'msp' }).returning();
    const [orgA, orgB] = await admin.insert(organizations).values(['a', 'b'].map(suffix => ({
      partnerId: partner!.id, name: `Preference ${suffix}`, slug: `pref-${suffix}-${crypto.randomUUID()}`, currencyCode: 'USD',
    }))).returning();
    const [actorA, actorB] = await admin.insert(users).values(['a', 'b'].map(suffix => ({
      partnerId: partner!.id, name: `Technician ${suffix}`, email: `${crypto.randomUUID()}@example.test`, status: 'active' as const,
    }))).returning();
    const target = crypto.randomUUID();
    const state = await admin.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'cloudcommand_microsoft_directory_preferences'::regclass`);
    expect(state[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const access = (orgId: string, userId: string) => ({ scope: 'organization' as const, orgId,
      partnerId: partner!.id, accessibleOrgIds: [orgId], userId });
    const insert = (orgId: string, actorId: string) => sql`INSERT INTO cloudcommand_microsoft_directory_preferences
      (org_id, actor_id, microsoft_user_id, excluded) VALUES (${orgId}::uuid, ${actorId}::uuid, ${target}::uuid, true)`;
    await withDbAccessContext(access(orgA!.id, actorA!.id), async () => {
      const [rlsContext] = await db.execute(sql`SELECT breeze_current_user_id() AS actor_id, breeze_has_org_access(${orgA!.id}::uuid) AS org_access`);
      expect(rlsContext).toMatchObject({ actor_id: actorA!.id, org_access: true });
      await db.execute(insert(orgA!.id, actorA!.id));
      expect((await db.execute(sql`SELECT actor_id FROM cloudcommand_microsoft_directory_preferences`)).map(row => row.actor_id)).toEqual([actorA!.id]);
    });
    await withDbAccessContext(access(orgA!.id, actorB!.id), async () => {
      expect(await db.execute(sql`SELECT actor_id FROM cloudcommand_microsoft_directory_preferences`)).toHaveLength(0);
    });
    await expect(withDbAccessContext(access(orgA!.id, actorB!.id), () => db.execute(insert(orgA!.id, actorA!.id)))).rejects.toThrow();
    await expect(withDbAccessContext(access(orgB!.id, actorA!.id), () => db.execute(insert(orgA!.id, actorA!.id)))).rejects.toThrow();
    expect(await getAppDb().execute(sql`SELECT * FROM cloudcommand_microsoft_directory_preferences`)).toHaveLength(0);
  });
  it.each(['cloudcommand_microsoft_admin_connections', 'cloudcommand_microsoft_admin_consent'])(
    'enforces native administration RLS for %s', async table => {
      const admin = getTestDb();
      const [partner] = await admin.insert(partners).values({ name: 'Admin isolation', slug: `admin-${crypto.randomUUID()}`, type: 'msp' }).returning();
      const [a, b, c] = await admin.insert(organizations).values(['a', 'b', 'c'].map(suffix => ({ partnerId: partner!.id,
        name: `Admin ${suffix}`, slug: `admin-${suffix}-${crypto.randomUUID()}`, currencyCode: 'USD' }))).returning();
      const [actor] = await admin.insert(users).values({ partnerId: partner!.id, name: 'Fixture', email: `${crypto.randomUUID()}@example.test`, status: 'active' }).returning();
      const builtin = BUILTINS.find(item => item.name === 'cloudcommand')!;
      const previous = process.env.CLOUDCOM_THREECX_ENABLED;
      try {
        process.env.CLOUDCOM_THREECX_ENABLED = 'true';
        await loadBuiltinExtensions({ registry: new ExtensionContributionRegistry(), stateStore: createExtensionStateStore(), ports: { builtins: [builtin] } });
      } finally { if (previous === undefined) delete process.env.CLOUDCOM_THREECX_ENABLED; else process.env.CLOUDCOM_THREECX_ENABLED = previous; }
      const state = await admin.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ${table}::regclass`);
      expect(state[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      const insert = (orgId: string) => table.endsWith('_connections')
        ? sql`INSERT INTO cloudcommand_microsoft_admin_connections (org_id, tenant_id, tenant_name, client_id, credential_version, permission_manifest_version)
            VALUES (${orgId}::uuid, ${orgId}::uuid, 'Fixture', ${actor!.id}::uuid, 'test', 'test')`
        : sql`INSERT INTO cloudcommand_microsoft_admin_consent (org_id, state_hash, actor_id, tenant_id, client_id, credential_version, stage, verifier_ciphertext, nonce, expires_at)
            VALUES (${orgId}::uuid, ${orgId}, ${actor!.id}::uuid, ${orgId}::uuid, ${actor!.id}::uuid, 'test', 'consent', 'encrypted-fixture', 'fixture', now() + interval '10 minutes')`;
      await admin.execute(insert(b!.id));
      const access = { scope: 'organization' as const, orgId: a!.id, partnerId: partner!.id, accessibleOrgIds: [a!.id], userId: actor!.id };
      await withDbAccessContext(access, async () => {
        expect((await db.execute(sql`SELECT current_user AS role`))[0]!.role).toBe('breeze_app');
        await db.execute(insert(a!.id));
        expect((await db.execute(sql`SELECT org_id FROM ${sql.identifier(table)}`)).map(row => row.org_id)).toEqual([a!.id]);
        expect(await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${b!.id}::uuid RETURNING org_id`)).toHaveLength(0);
      });
      await expect(withDbAccessContext(access, () => db.execute(insert(c!.id)))).rejects.toThrow();
      await expect(withDbAccessContext(access, () => db.execute(sql`UPDATE ${sql.identifier(table)} SET org_id = ${c!.id}::uuid WHERE org_id = ${a!.id}::uuid`))).rejects.toThrow();
      expect(await getAppDb().execute(sql`SELECT * FROM ${sql.identifier(table)}`)).toHaveLength(0);
      await expect(getAppDb().execute(insert(c!.id))).rejects.toThrow();
    });
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

  it('enforces forced RLS for Microsoft connection reads, writes, reparenting and deletion', async () => {
    const admin = getTestDb();
    const [partner] = await admin.insert(partners).values({ name: 'Microsoft isolation test', slug: `microsoft-${crypto.randomUUID()}`, type: 'msp' }).returning();
    const [a, b, c] = await admin.insert(organizations).values(['a', 'b', 'c'].map(suffix => ({
      partnerId: partner!.id, name: `Microsoft ${suffix}`, slug: `microsoft-${suffix}-${crypto.randomUUID()}`, currencyCode: 'USD',
    }))).returning();
    const state = await admin.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'cloudcommand_microsoft_connections'::regclass`);
    expect(state[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const tenant = '55555555-5555-4555-8555-555555555555';
    const insert = (org: string) => sql`INSERT INTO cloudcommand_microsoft_connections (org_id, tenant_id, tenant_domain, tenant_name, backend_identity) VALUES (${org}::uuid, ${tenant}::uuid, 'customer.example.test', 'Customer', 'fixture')`;
    await admin.execute(insert(b!.id));
    const context = { scope: 'organization' as const, orgId: a!.id, partnerId: partner!.id, accessibleOrgIds: [a!.id] };
    await withDbAccessContext(context, async () => {
      const role = await db.execute(sql`SELECT current_user AS role`);
      expect(role[0]!.role).toBe('breeze_app');
      await db.execute(insert(a!.id));
      expect((await db.execute(sql`SELECT org_id FROM cloudcommand_microsoft_connections`)).map(r => r.org_id)).toEqual([a!.id]);
      expect(await db.execute(sql`UPDATE cloudcommand_microsoft_connections SET enabled = true WHERE org_id = ${b!.id}::uuid RETURNING id`)).toHaveLength(0);
      expect(await db.execute(sql`DELETE FROM cloudcommand_microsoft_connections WHERE org_id = ${b!.id}::uuid RETURNING id`)).toHaveLength(0);
    });
    await expect(withDbAccessContext(context, () => db.execute(insert(c!.id)))).rejects.toThrow();
    await expect(withDbAccessContext(context, () => db.execute(sql`UPDATE cloudcommand_microsoft_connections SET org_id = ${c!.id}::uuid WHERE org_id = ${a!.id}::uuid`))).rejects.toThrow();
    expect(await getAppDb().execute(sql`SELECT * FROM cloudcommand_microsoft_connections`)).toHaveLength(0);
    await expect(getAppDb().execute(insert(c!.id))).rejects.toThrow();
  });

  it('atomically claims a Microsoft administration consent state only once', async () => {
    const { store, access, org, actor } = await administrationStoreFixture();
    const attempt = administrationAttempt(org.id, actor.id, null);
    await withDbAccessContext(access, () => store.start(attempt));
    const [first, second] = await Promise.all([
      withDbAccessContext(access, () => store.claim(org.id, actor.id, attempt.state_hash, 'consent')),
      withDbAccessContext(access, () => store.claim(org.id, actor.id, attempt.state_hash, 'consent')),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((first ?? second)!).toMatchObject({ org_id: org.id, actor_id: actor.id, stage: 'processing' });
  });

  it('rejects Microsoft administration consent claims from a different same-org actor, wrong organization, or expired state', async () => {
    const { store, access, sameOrgOtherActorAccess, org, otherOrg, actor, otherActor, otherAccess } = await administrationStoreFixture();
    const otherActorAttempt = administrationAttempt(org.id, otherActor.id, null);
    await withDbAccessContext(sameOrgOtherActorAccess, () => store.start(otherActorAttempt));
    await expect(withDbAccessContext(access, () => store.claim(org.id, otherActor.id, otherActorAttempt.state_hash, 'consent'))).resolves.toBeNull();
    await expect(withDbAccessContext(sameOrgOtherActorAccess, () => store.claim(org.id, actor.id, otherActorAttempt.state_hash, 'consent'))).resolves.toBeNull();
    const wrongOrg = administrationAttempt(org.id, actor.id, null);
    await withDbAccessContext(access, () => store.start(wrongOrg));
    await expect(withDbAccessContext(otherAccess, () => store.claim(otherOrg.id, actor.id, wrongOrg.state_hash, 'consent'))).resolves.toBeNull();
    const expired = administrationAttempt(org.id, actor.id, null);
    await withDbAccessContext(access, () => store.start(expired));
    await getTestDb().execute(sql`UPDATE cloudcommand_microsoft_admin_consent SET expires_at = now() - interval '1 second' WHERE org_id = ${org.id}::uuid`);
    await expect(withDbAccessContext(access, () => store.claim(org.id, actor.id, expired.state_hash, 'consent'))).resolves.toBeNull();
  });

  it('requires the latest claimed consent state and uses expected generation as a compare-and-swap save fence', async () => {
    const { store, access, org, actor } = await administrationStoreFixture();
    const initial = administrationAttempt(org.id, actor.id, null);
    await withDbAccessContext(access, () => store.start(initial));
    await withDbAccessContext(access, () => store.claim(org.id, actor.id, initial.state_hash, 'consent'));
    await expect(withDbAccessContext(access, () => store.save(initial, 'Initial tenant'))).resolves.toBe(true);
    const oldClaimedAttempt = administrationAttempt(org.id, actor.id, 1);
    await withDbAccessContext(access, () => store.start(oldClaimedAttempt));
    await withDbAccessContext(access, () => store.claim(org.id, actor.id, oldClaimedAttempt.state_hash, 'consent'));
    const current = administrationAttempt(org.id, actor.id, 1);
    await withDbAccessContext(access, () => store.start(current));
    await withDbAccessContext(access, () => store.claim(org.id, actor.id, current.state_hash, 'consent'));
    await expect(withDbAccessContext(access, () => store.save(oldClaimedAttempt, 'Old tenant'))).resolves.toBe(false);
    await expect(withDbAccessContext(access, () => store.save(current, 'Current tenant'))).resolves.toBe(true);
    const staleGeneration = administrationAttempt(org.id, actor.id, 1);
    await withDbAccessContext(access, () => store.start(staleGeneration));
    await withDbAccessContext(access, () => store.claim(org.id, actor.id, staleGeneration.state_hash, 'consent'));
    await expect(withDbAccessContext(access, () => store.save(staleGeneration, 'Stale generation tenant'))).resolves.toBe(false);
    const saved = await withDbAccessContext(access, () => store.load(org.id));
    expect(saved).toMatchObject({ tenantId: current.tenant_id, tenantName: 'Current tenant', generation: 2 });
  });
});

async function administrationStoreFixture() {
  const admin = getTestDb();
  const [partner] = await admin.insert(partners).values({ name: 'Admin store fixture', slug: `admin-store-${crypto.randomUUID()}`, type: 'msp' }).returning();
  const [org, otherOrg] = await admin.insert(organizations).values(['a', 'b'].map(suffix => ({
    partnerId: partner!.id, name: `Admin store ${suffix}`, slug: `admin-store-${suffix}-${crypto.randomUUID()}`, currencyCode: 'USD',
  }))).returning();
  const [actor, otherActor] = await admin.insert(users).values(['a', 'b'].map(suffix => ({
    partnerId: partner!.id, name: `Admin store actor ${suffix}`, email: `admin-store-${suffix}-${crypto.randomUUID()}@example.test`, status: 'active',
  }))).returning();
  const previous = process.env.CLOUDCOM_THREECX_ENABLED;
  try {
    process.env.CLOUDCOM_THREECX_ENABLED = 'true';
    const builtin = BUILTINS.find(item => item.name === 'cloudcommand')!;
    await loadBuiltinExtensions({ registry: new ExtensionContributionRegistry(), stateStore: createExtensionStateStore(), ports: { builtins: [builtin] } });
  } finally {
    if (previous === undefined) delete process.env.CLOUDCOM_THREECX_ENABLED;
    else process.env.CLOUDCOM_THREECX_ENABLED = previous;
  }
  const access = { scope: 'organization' as const, orgId: org!.id, partnerId: partner!.id, accessibleOrgIds: [org!.id], userId: actor!.id };
  const sameOrgOtherActorAccess = { scope: 'organization' as const, orgId: org!.id, partnerId: partner!.id, accessibleOrgIds: [org!.id], userId: otherActor!.id };
  const otherAccess = { scope: 'organization' as const, orgId: otherOrg!.id, partnerId: partner!.id, accessibleOrgIds: [otherOrg!.id], userId: otherActor!.id };
  return { store: createAdministrationStore({ db } as unknown as ExtensionRuntimeContext), access, sameOrgOtherActorAccess, otherAccess, org: org!, otherOrg: otherOrg!, actor: actor!, otherActor: otherActor! };
}

function administrationAttempt(orgId: string, actorId: string, expectedGeneration: number | null): ConsentAttempt {
  return { org_id: orgId, actor_id: actorId, tenant_id: crypto.randomUUID(), client_id: crypto.randomUUID(), credential_version: 'test-cert', expected_generation: expectedGeneration,
    state_hash: crypto.randomUUID().replaceAll('-', ''), stage: 'consent', verifier_ciphertext: 'encrypted-fixture', nonce: 'nonce' };
}
