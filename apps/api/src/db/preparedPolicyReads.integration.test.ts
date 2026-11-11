import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { expect, test } from 'vitest';
import { enablePreparedPolicyReads } from './preparedPolicyReads';

// Explicitly opt in against an isolated local PostgreSQL, never a live tenant DB.
const url = process.env.POLICY_PLAN_TEST_DATABASE_URL;
test.skipIf(!url)('prepared policy reads re-evaluate RLS across transactions and savepoints', async () => {
  const target = new URL(url!);
  if (!['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('Requires isolated local PostgreSQL');
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `plan_${suffix}`;
  const role = `reader_${suffix}`;
  const sql = enablePreparedPolicyReads(postgres(url!, { max: 1 }));
  const query = 'select tenant, value from "config_policy_probe" where value >= $1 order by value';
  try {
    await sql.unsafe(`create schema "${schema}"`);
    await sql.unsafe(`set search_path to "${schema}"`);
    await sql.unsafe(`create role "${role}" nologin`);
    await sql.unsafe(`create table "${schema}"."config_policy_probe" (tenant text not null, value integer not null)`);
    await sql.unsafe(`insert into "${schema}"."config_policy_probe" values ('a',1),('b',2)`);
    await sql.unsafe(`alter table "${schema}"."config_policy_probe" enable row level security`);
    await sql.unsafe(`alter table "${schema}"."config_policy_probe" force row level security`);
    await sql.unsafe(`create policy tenant on "${schema}"."config_policy_probe" using (tenant = current_setting('plan.tenant',true))`);
    await sql.unsafe(`grant usage on schema "${schema}" to "${role}"`);
    await sql.unsafe(`grant select on "${schema}"."config_policy_probe" to "${role}"`);
    for (let i = 0; i < 18; i++) {
      const tenant = ['a', 'b', 'none'][i % 3]!;
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role "${role}"`);
        await tx`select set_config('plan.tenant', ${tenant}, true)`;
        const expected = tenant === 'none' ? [] : [{ tenant, value: tenant === 'a' ? 1 : 2 }];
        expect([...await tx.unsafe(query, [0])]).toEqual(expected);
        await tx.savepoint(async (nested) => {
          expect([...await nested.unsafe(query, [0])]).toEqual(expected);
        });
      });
    }
    const plans = await sql`select generic_plans, custom_plans from pg_prepared_statements where statement = ${query}`;
    expect(plans.length).toBe(1);
    expect(Number(plans[0]!.generic_plans)).toBeGreaterThan(0);
    // Changed records remain immediately visible; this caches plans, never rows.
    await sql.unsafe(`update "${schema}"."config_policy_probe" set value=3 where tenant='a'`);
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role "${role}"`);
      await tx`select set_config('plan.tenant', 'a', true)`;
      expect([...await tx.unsafe(query, [0])]).toEqual([{ tenant: 'a', value: 3 }]);
    });
  } finally {
    await sql.unsafe(`drop schema if exists "${schema}" cascade`);
    await sql.unsafe(`drop role if exists "${role}"`);
    await sql.end();
  }
}, 30_000);
