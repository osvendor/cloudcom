import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const baselinePath = new URL('../cloudcom-baseline.json', import.meta.url);
const docsPath = /^(?:docs\/|apps\/docs\/|scripts\/docs-review\/|README(?:\.[^/]+)?$|AGENTS\.md$|[^/]+\.mdx?$)/u;
const supported = [
  ['native', /^agent\//u],
];
const remoteAccessWebPaths = new Set([
  'apps/web/src/components/remote/RemoteToolsPage.tsx',
  'apps/web/src/components/cloudcom/RemoteAccessAlternatives.tsx',
  'apps/web/src/components/cloudcom/RemoteAccessAlternatives.test.tsx',
]);
// Only this reviewed API surface has change-focused coverage below. Unknown
// API, schema and portal changes continue to fail closed.
const remoteAccessApiPaths = new Set([
  'apps/api/src/routes/devices/index.ts',
  'apps/api/src/routes/devices/cloudcomRemoteAccess.ts',
  'apps/api/src/routes/devices/cloudcomRemoteAccess.test.ts',
  'apps/api/src/services/cloudcom/remoteAccessOptions.ts',
  'apps/api/src/services/cloudcom/remoteAccessOptions.test.ts',
]);
const infraPaths = new Set([
  'AGENTS.md', '.github/actionlint.yaml', '.github/actions/load-smoke-images/action.yml',
  '.github/scripts/check-cloudcom-runner.sh', '.github/scripts/ci-area-gating.test.mjs',
  '.github/scripts/ci-build-reuse.test.mjs', '.github/scripts/classify-pr-paths.sh',
  '.github/scripts/classify-pr-paths.test.mjs', '.github/scripts/mobile-native-ci.test.mjs',
  '.github/scripts/prepare-ci-apt-sources.test.mjs', 'deploy/.env.example',
  'deploy/docker-compose.prod.yml', 'scripts/check-guided-setup-systemd-unit.sh',
  'scripts/check-guided-setup-signed-image-floor.sh', 'scripts/prod/deploy.sh',
  'scripts/release/release-image-consumers.test.mjs', 'scripts/smoke-guided-setup.sh',
]);

export function readBaseline(text = readFileSync(baselinePath, 'utf8')) {
  const baseline = JSON.parse(text);
  if (baseline.repository !== 'LanternOps/breeze') throw new Error('baseline.repository must be LanternOps/breeze');
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][\w.-]+)?$/u.test(baseline.tag ?? '')) throw new Error('baseline.tag must be a release tag');
  if (!/^[0-9a-f]{40}$/u.test(baseline.commit ?? '')) throw new Error('baseline.commit must be a 40-character SHA');
  return baseline;
}

export function classify(paths) {
  const result = { api: false, web: false, shared: false, native: false, infra: false, unsupported: [] };
  for (const path of paths.filter(Boolean)) {
    if (docsPath.test(path)) continue;
    if (remoteAccessApiPaths.has(path)) {
      result.api = true;
      continue;
    }
    if (remoteAccessWebPaths.has(path)) {
      result.web = true;
      continue;
    }
    if (path === 'apps/api/src/config/envComposeParity.test.ts') {
      result.infra = true;
      continue;
    }
    if (infraPaths.has(path) || path.startsWith('.github/workflows/') || path.startsWith('.github/cloudcom-') || path.startsWith('.github/scripts/cloudcom-') || path.startsWith('scripts/cloudcom/')) {
      result.infra = true;
      continue;
    }
    const category = supported.find(([, pattern]) => pattern.test(path))?.[0];
    if (category) result[category] = true;
    else result.unsupported.push(path);
  }
  return { ...result, docsOnly: paths.length > 0 && Object.values(result).every((value) => value === false || Array.isArray(value) && value.length === 0) };
}

function changedPaths(baseline) {
  execFileSync('git', ['cat-file', '-e', `${baseline.commit}^{commit}`], { stdio: 'inherit' });
  execFileSync('git', ['merge-base', '--is-ancestor', baseline.commit, 'HEAD'], { stdio: 'inherit' });
  return execFileSync('git', ['diff', '--name-only', baseline.commit, 'HEAD'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
}

function output(result) {
  for (const [name, value] of Object.entries(result)) {
    const rendered = Array.isArray(value) ? value.join(',') : String(value);
    process.stdout.write(`${name}=${rendered}\n`);
  }
}

function verifyRemoteTag(baseline) {
  const remote = `https://github.com/${baseline.repository}.git`;
  const [releaseTag, draft, prerelease] = execFileSync('gh', ['api', `repos/${baseline.repository}/releases/tags/${baseline.tag}`, '--jq', '[.tag_name, .draft, .prerelease] | @tsv'], { encoding: 'utf8' }).trim().split('\t');
  if (releaseTag !== baseline.tag || draft !== 'false' || prerelease !== 'false') throw new Error(`baseline ${baseline.repository}@${baseline.tag} is not a published stable release`);
  const refs = execFileSync('git', ['ls-remote', '--tags', remote, `refs/tags/${baseline.tag}`, `refs/tags/${baseline.tag}^{}`], { encoding: 'utf8' });
  const tagCommit = refs.split('\n').map((line) => line.split('\t')).find(([, ref]) => ref === `refs/tags/${baseline.tag}^{}`)?.[0]
    ?? refs.split('\n').map((line) => line.split('\t')).find(([, ref]) => ref === `refs/tags/${baseline.tag}`)?.[0];
  if (tagCommit !== baseline.commit) {
    throw new Error(`baseline ${baseline.repository}@${baseline.tag} resolved to ${tagCommit || 'nothing'}, expected ${baseline.commit}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseline = readBaseline();
  if (process.argv.includes('--verify-remote')) verifyRemoteTag(baseline);
  const classification = classify(changedPaths(baseline));
  if (classification.unsupported.length > 0) {
    console.error(`Unsupported cumulative-delta paths:\n${classification.unsupported.map((path) => `  - ${JSON.stringify(path)}`).join('\n')}`);
  }
  const result = {
    baseline_commit: baseline.commit,
    api: classification.api,
    web: classification.web,
    shared: classification.shared,
    native: classification.native,
    infra: classification.infra,
    docsOnly: classification.docsOnly,
    unsupported: classification.unsupported.length > 0,
  };
  const lines = Object.entries(result).map(([name, value]) => `${name}=${String(value)}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  } else output(result);
}
