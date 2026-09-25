import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/cloudcom-candidate.yml', import.meta.url), 'utf8');
const workerDockerfile = new URL('../../deploy/cloudcom-exchange-worker/Dockerfile', import.meta.url);

test('the signed-release candidate workflow builds the isolated Exchange worker from its Dockerfile', () => {
  assert.match(workflow, /^\s+- component: exchange-worker\s*\n\s+dockerfile: deploy\/cloudcom-exchange-worker\/Dockerfile\s*$/mu);
  assert.match(workflow, /^\s+exchange-worker\) ;;\s*$/mu);
  assert.equal((workflow.match(/- component: exchange-worker/gu) ?? []).length, 1);
  assert.ok(existsSync(workerDockerfile));
  assert.match(workflow, /node scripts\/release\/require-upstream-intake\.mjs "\$SOURCE_COMMIT"/u);
  assert.match(workflow, /docker build --pull --platform linux\/amd64[^\n]+--label "org\.opencontainers\.image\.revision=\$SOURCE_COMMIT"/u);
  assert.match(workflow, /name: cloudcom-candidate-\$\{\{ matrix\.component \}\}-\$\{\{ needs\.validate\.outputs\.source_short \}\}/u);
});
