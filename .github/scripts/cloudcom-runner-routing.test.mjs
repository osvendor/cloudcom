import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const workflows = new URL('../workflows/', import.meta.url);
const safeRouting = `\${{ fromJSON((github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository) && '["ubuntu-24.04"]' || '["self-hosted","linux","cloudcom"]') }}`;
const ci = readFileSync(new URL('ci.yml', workflows), 'utf8');

function jobBody(source, name) {
  const body = source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`, 'm'))?.[1];
  assert.ok(body, `ci.yml: missing job ${name}`);
  return body;
}

test('fork PR workflows keep CloudCom Linux execution off the private runner', () => {
  let checked = 0;
  for (const file of readdirSync(workflows).filter(name => name.endsWith('.yml'))) {
    const source = readFileSync(new URL(file, workflows), 'utf8');
    // pull_request_target must never be introduced as a workaround for fork checks.
    assert.doesNotMatch(source, /^\s*pull_request_target\s*:/m, file);
    if (!/^\s*pull_request\s*:/m.test(source)) continue;
    for (const line of source.split('\n')) {
      if (!/^\s*(?:runs-on|runner):/.test(line) || !line.includes('cloudcom')) continue;
      assert.ok(line.trim().endsWith(safeRouting), `${file}: unsafe private runner routing: ${line.trim()}`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'Expected to inspect CloudCom PR runner routes');
});


test('privileged and native dependency jobs use disposable hosted runners', () => {
  for (const [file, directJobs, matrixJobs] of [
    ['ci.yml', ['test-agent', 'recovery-media-e2e', 'rust-check'], []],
    ['release.yml', ['build-recovery-media', 'create-release'], ['build-viewer', 'build-helper']],
  ]) {
    const source = readFileSync(new URL(file, workflows), 'utf8');
    for (const name of [...directJobs, ...matrixJobs]) {
      const body = source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`, 'm'))?.[1];
      assert.ok(body, `${file}: missing job ${name}`);
      if (directJobs.includes(name)) {
        assert.match(body, /^    runs-on: ubuntu-24\.04$/m, name);
      } else {
        assert.match(body, /^            runner: ubuntu-22\.04$/m, name);
        assert.doesNotMatch(body, /^            runner: cloudcom$/m, name);
      }
    }
  }
});

test('memory-heavy and sharded application jobs use hosted runners', () => {
  for (const [name, shardCount, condition] of [
    ['typecheck', null, "needs.changes.outputs.code == 'true' && needs.changes.outputs.app == 'true'"],
    ['test-api', 8, "needs.changes.outputs.code == 'true' && needs.changes.outputs.app == 'true' && needs.changes.outputs.api == 'true'"],
    ['test-web', 4, "needs.changes.outputs.code == 'true' && needs.changes.outputs.app == 'true' && needs.changes.outputs.web == 'true'"],
    ['integration-test', 16, "needs.changes.outputs.code == 'true' && needs.changes.outputs.app == 'true' && needs.changes.outputs.api == 'true'"],
  ]) {
    const body = jobBody(ci, name);
    assert.match(body, /^    runs-on: ubuntu-24\.04$/m, `${name}: must use a hosted runner`);
    assert.match(body, /^    needs: \[changes\]$/m, `${name}: changes gate changed`);
    assert.ok(body.split('\n').includes(`    if: ${condition}`), `${name}: area gate changed`);
    if (name === 'typecheck') {
      assert.match(body, /^    timeout-minutes: 30$/m, 'typecheck: timeout changed');
    }
    if (shardCount !== null) {
      assert.match(body, new RegExp(`shard: \\[${Array.from({ length: shardCount }, (_, index) => index + 1).join(', ')}\\]`), `${name}: shard matrix changed`);
    }
  }
});
