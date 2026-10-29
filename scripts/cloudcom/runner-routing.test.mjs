import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const read = name => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const ci = read('cloudcom-ci');
const selectors = [...ci.matchAll(/^    runs-on: \$\{\{ (.+) \}\}$/gmu)].map(match => match[1]);
const local = ['self-hosted', 'Linux', 'X64', 'cloudcom-linux'];
const hosted = ['ubuntu-24.04'];

test('all six CI jobs route untrusted events to disposable workers', () => {
  assert.equal(selectors.length, 6);
  for (const expression of selectors) {
    for (const [repository, event_name, ref, expected] of [
      ['osvendor/cloudcom', 'push', 'refs/heads/main', local],
      ['osvendor/cloudcom', 'workflow_dispatch', 'refs/heads/main', local],
      ['osvendor/cloudcom', 'workflow_dispatch', 'refs/heads/integration/upstream-v1', local],
      ['osvendor/cloudcom', 'pull_request', 'refs/pull/123/merge', hosted],
      ['osvendor/cloudcom', 'pull_request_target', 'refs/heads/main', hosted],
      ['other/fork', 'push', 'refs/heads/main', hosted],
      ['other/fork', 'workflow_dispatch', 'refs/heads/main', hosted],
      ['osvendor/cloudcom', 'push', 'refs/heads/unreviewed', hosted],
    ]) {
      const selected = runInNewContext(expression, { github: { repository, event_name, ref }, fromJSON: JSON.parse });
      assert.deepEqual(Array.from(selected), expected, `${repository} ${event_name} ${ref}`);
    }
  }
});

test('maintenance and candidate jobs retain source and publication boundaries', () => {
  const upstream = read('cloudcom-upstream');
  const candidate = read('cloudcom-candidate');
  for (const workflow of [upstream, candidate]) {
    assert.match(workflow, /github\.repository == 'osvendor\/cloudcom' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/u);
    assert.match(workflow, /runs-on: \[self-hosted, Linux, X64, cloudcom-linux\]/u);
  }
  assert.match(candidate, /max-parallel: 1/u);
  assert.match(candidate, /node scripts\/release\/require-upstream-intake\.mjs/u);
  assert.match(candidate, /successful push-triggered CloudCom CI/u);
  assert.match(upstream, /cancel-in-progress: false/u);
});

test('self-hosted jobs do not require package-install sudo and stay bounded', () => {
  assert.match(ci, /mkdir -p "\$RUNNER_TEMP\/cloudcom-bin"/u);
  assert.match(ci, /if: runner.environment == 'github-hosted'\n\s+run: sudo apt-get/u);
  assert.equal(ci.split('\n').filter(line => line.includes('sudo ')).length, 1);
  assert.match(ci, /pkg-config --exists libpcap/u);
  assert.match(ci, /go test -p 1 -race/u);
  assert.match(ci, /--child-concurrency=1 --network-concurrency=4/u);
  assert.equal((ci.match(/timeout-minutes:/gu) ?? []).length, 6);
});

test('manual smoke verifies the dedicated runner without checkout, builds or deployment', () => {
  const smoke = read('cloudcom-runner-smoke');
  assert.match(smoke, /on:\n  workflow_dispatch:\n/u);
  assert.doesNotMatch(smoke, /^  (push|pull_request|schedule):/mu);
  assert.match(smoke, /github\.repository == 'osvendor\/cloudcom' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/u);
  assert.match(smoke, /runs-on: \[self-hosted, Linux, X64, cloudcom-linux\]/u);
  assert.match(smoke, /test "\$RUNNER_ENVIRONMENT" = self-hosted/u);
  for (const command of ['node --version', 'pnpm --version', 'gh --version', 'python3 --version', 'pkg-config --modversion libpcap', 'docker version', 'docker compose version', 'Import-Module Pester -RequiredVersion 5.7.1']) {
    assert.ok(smoke.includes(command), `missing prerequisite check: ${command}`);
  }
  assert.doesNotMatch(smoke, /uses:|docker (?:build|run|push)|git |sudo |deploy/u);
});
