import { runInNewContext } from 'node:vm';
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

test('candidate archives bind release version and export independent OCI provenance', () => {
  assert.match(workflow, /--label "org\.opencontainers\.image\.version=\$BUILD_VERSION"/u);
  assert.match(workflow, /python3 scripts\/release\/inspect-candidate-archive\.py[^\n]+"\$SOURCE_COMMIT" "\$BUILD_VERSION"/u);
  assert.match(workflow, /docker image inspect "\$image" > image-inspect\.json/u);
  assert.match(workflow, /^\s+image-inspect\.json$/mu);
  assert.match(workflow, /^\s+oci-provenance\.json$/mu);
});


test('metadata heredoc writes parseable JSON with an actual trailing newline', () => {
  const match = workflow.match(/node <<'NODE'\r?\n([\s\S]*?)\r?\n          NODE/u);
  assert.ok(match, 'metadata Node heredoc missing');
  const writes = new Map();
  const inspect = [{ Id: 'sha256:test', RepoTags: ['candidate:test'], Created: '2026-01-01' }];
  runInNewContext(match[1].split('\n').map(line => line.replace(/^          /u, '')).join('\n'), {
    require: name => { assert.equal(name, 'node:fs'); return {
      readFileSync: name => { assert.equal(name, 'image-inspect.json'); return JSON.stringify(inspect); },
      writeFileSync: (name, data) => writes.set(name, data),
    }; },
    process: { env: { COMPONENT: 'api', SOURCE: 'a'.repeat(40), BASELINE_TAG: 'v0.128.0', BUILD_VERSION: '0.128.5' } },
  });
  const bytes = writes.get('metadata.json');
  assert.ok(bytes.endsWith('\n'));
  const metadata = JSON.parse(bytes);
  assert.equal(metadata.version, '0.128.5');
  assert.equal(metadata.imageId, 'sha256:test');
  assert.equal(metadata.sourceCommit, 'a'.repeat(40));
});
