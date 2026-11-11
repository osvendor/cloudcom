import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { releaseVersions } from './cloudcom-release-versions.mjs';

const baseline = {
  repository: 'LanternOps/breeze', tag: 'v0.121.0', commit: 'a'.repeat(40),
  forkVersion: '0.121.5', binariesVersion: '0.119.5',
};

test('retains fork revision for both server builds and pins older binaries independently', () => {
  assert.deepEqual(releaseVersions(baseline), {
    build_version: '0.121.5', baseline_tag: 'v0.121.0', binaries_version: '0.119.5',
  });
});

test('a full release has no older binary pairing', () => {
  assert.equal(releaseVersions({ ...baseline, binariesVersion: '0.121.5' }).binaries_version, '');
});

test('invalid and missing metadata fail closed rather than falling back to upstream', () => {
  for (const change of [
    { forkVersion: undefined }, { binariesVersion: undefined }, { forkVersion: '0.122.5' },
    { tag: 'v0.121.6' }, { binariesVersion: '0.122.0' }, { binariesVersion: '0.121.6' },
    { forkVersion: '0.121.5\nbuild_version=1.0.0' }, { forkVersion: '0.121.05' },
    { forkVersion: '0.121.5+custom' }, { commit: 'not-a-commit' }, { repository: 'other/repo' },
  ]) assert.throws(() => releaseVersions({ ...baseline, ...change }));
});

test('checked-in intake metadata is valid', () => {
  const checkedIn = JSON.parse(readFileSync(new URL('../../.github/cloudcom-baseline.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => releaseVersions(checkedIn));
});

test('candidate workflow validates immutable source metadata and bakes binary pairing', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/cloudcom-candidate.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('git show "$SOURCE_COMMIT:.github/cloudcom-baseline.json" | node scripts/release/cloudcom-release-versions.mjs >> "$GITHUB_OUTPUT"'));
  assert.ok(workflow.includes('binaries_version: ${{ steps.validate.outputs.binaries_version }}'));
  assert.ok(workflow.includes('BINARIES_VERSION: ${{ needs.validate.outputs.binaries_version }}'));
  assert.ok(workflow.includes('--build-arg "BREEZE_BINARIES_VERSION=$BINARIES_VERSION"'));
  assert.ok(workflow.includes('--build-arg "APP_VERSION=$BUILD_VERSION"'));
  assert.ok(workflow.includes('--build-arg "PUBLIC_APP_VERSION=$BUILD_VERSION"'));
  assert.ok(!workflow.includes('build_version="${baseline_tag#v}"'));
});
