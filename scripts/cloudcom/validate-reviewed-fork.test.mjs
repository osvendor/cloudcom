import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { manifest, validateManifest, selectedGroups } from './validate-reviewed-fork.mjs';
import { classify } from '../../.github/scripts/cloudcom-delta.mjs';
test('every reviewed source and test exists and selects real validation', () => {
  assert.equal(validateManifest(), true);
  for (const [name, group] of Object.entries(manifest.groups)) {
    for (const source of group.paths) {
      assert.equal(selectedGroups([source])[0][0], name);
      assert.deepEqual(classify([source]).unsupported, []);
    }
  }
});
test('unknown neighboring paths remain fail-closed', () => {
  for (const source of ['apps/api/src/services/newCpuPolicy.ts','packages/ext-credentials/src/server/unreviewed.ts','packages/browser-companion/unknown.js','apps/api/migrations/new-schema.sql']) {
    assert.deepEqual(classify([source]).unsupported, [source]);
    assert.deepEqual(selectedGroups([source]), []);
  }
});
test('missing validation cannot be registered', () => {
  const missing = structuredClone(manifest); missing.groups.companion.commands=[];
  assert.throws(()=>validateManifest(missing),/Incomplete/);
});
test('database and browser groups execute behavioral gates rather than text checks', () => {
  const db = readFileSync(new URL('./test-reviewed-fork-db.sh',import.meta.url),'utf8');
  for (const expected of ['db:migrate','vitest.config.cloudcom-reviewed-db.ts','vitest.config.rls-coverage.ts','CLOUDCOM_GUARD_TEST_REDIS_URL','POLICY_PLAN_TEST_DATABASE_URL']) assert.ok(db.includes(expected));
  assert.ok(manifest.groups.companion.commands.some(c=>c.args.includes('test')));
  assert.ok(manifest.groups.credentials.commands.some(c=>c.args.includes('test:web')));
});
