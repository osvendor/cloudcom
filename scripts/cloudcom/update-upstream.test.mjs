import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareMerge, ensureValidation, verifyBaseline } from './update-upstream.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'cloudcom-upstream-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, text) => {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  git('init', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  write('.github/workflows/upstream.yml', 'upstream: old\n');
  write('app.txt', 'released baseline\n');
  git('add', '.'); git('commit', '-m', 'baseline');
  const baseline = { commit: git('rev-parse', 'HEAD') };
  git('switch', '-c', 'upstream');
  write('.github/workflows/upstream.yml', 'upstream: changed\n');
  write('.github/workflows/new-upstream.yml', 'new: forbidden\n');
  write('app.txt', 'next released baseline\n');
  git('add', '.'); git('commit', '-m', 'next release');
  const next = git('rev-parse', 'HEAD');
  git('switch', 'main');
  git('rm', '.github/workflows/upstream.yml');
  write('.github/workflows/cloudcom-ci.yml', 'cloudcom: own\n');
  git('add', '.'); git('commit', '-m', 'fork workflows');
  return { cwd, git, write, baseline, next };
}

test('imports release code and preserves exact fork workflow tree, including upstream additions and conflicts', (t) => {
  const { cwd, git, baseline, next } = fixture(t);
  const tree = git('rev-parse', 'HEAD:.github/workflows');
  prepareMerge(cwd, next, baseline);
  assert.equal(readFileSync(join(cwd, 'app.txt'), 'utf8'), 'next released baseline\n');
  assert.equal(readFileSync(join(cwd, '.github/workflows/cloudcom-ci.yml'), 'utf8'), 'cloudcom: own\n');
  assert.equal(existsSync(join(cwd, '.github/workflows/upstream.yml')), false);
  assert.equal(existsSync(join(cwd, '.github/workflows/new-upstream.yml')), false);
  assert.equal(git('diff', '--name-only', '--diff-filter=U'), '');
  git('commit', '-m', 'integration');
  assert.equal(git('rev-parse', 'HEAD:.github/workflows'), tree);
  assert.equal(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
});

test('application conflict aborts merge without changing fork content or committing', (t) => {
  const { cwd, git, write, baseline, next } = fixture(t);
  write('app.txt', 'our customization\n');
  git('add', '.'); git('commit', '-m', 'custom app');
  const original = git('rev-parse', 'HEAD');
  assert.throws(() => prepareMerge(cwd, next, baseline), /Manual upstream conflict resolution required/);
  assert.equal(git('rev-parse', 'HEAD'), original);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(readFileSync(join(cwd, 'app.txt'), 'utf8'), 'our customization\n');
  assert.equal(existsSync(join(cwd, '.git/MERGE_HEAD')), false);
});

test('refuses dirty checkouts and release history rollback', (t) => {
  const { cwd, git, write, baseline, next } = fixture(t);
  write('app.txt', 'uncommitted\n');
  assert.throws(() => prepareMerge(cwd, next, baseline), /dirty checkout/);
  assert.equal(readFileSync(join(cwd, 'app.txt'), 'utf8'), 'uncommitted\n');
  git('restore', 'app.txt');
  assert.throws(() => prepareMerge(cwd, baseline.commit, { commit: next }));
  assert.equal(git('status', '--porcelain'), '');
});

test('aborts a conflict-free upstream update that removes a registered attachment', t => {
  const { cwd, git, write, baseline } = fixture(t);
  // Extend baseline on a new upstream branch, then fork only the declaration.
  git('switch', '-c', 'contract-base', baseline.commit);
  write('host.ts', 'mount(customModule);\n');
  git('add', 'host.ts'); git('commit', '-m', 'shared attachment');
  const base = { commit: git('rev-parse', 'HEAD') };
  git('switch', '-c', 'contract-upstream');
  write('host.ts', 'mount(upstreamModule);\n');
  git('add', 'host.ts'); git('commit', '-m', 'upstream removes attachment');
  const release = git('rev-parse', 'HEAD');
  git('switch', '-c', 'contract-fork', base.commit);
  write('.github/cloudcom-customizations.json', JSON.stringify({ version: 1, customizations: [{
    id: 'remote', requiredFiles: ['host.ts'], hooks: [{ file: 'host.ts', contains: 'mount(customModule)' }],
  }] }));
  git('add', '.'); git('commit', '-m', 'register customization');
  const original = git('rev-parse', 'HEAD');
  assert.throws(() => prepareMerge(cwd, release, base), /hook missing/);
  assert.equal(git('rev-parse', 'HEAD'), original);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(readFileSync(join(cwd, 'host.ts'), 'utf8'), 'mount(customModule);\n');
});

test('dispatches validation when only earlier heads have runs and avoids duplicate exact-head runs', () => {
  const calls = [];
  const gh = (...args) => {
    calls.push(args);
    return JSON.stringify({ workflow_runs: [{ head_sha: 'old-head', html_url: 'https://example.invalid/run' }] });
  };
  assert.equal(ensureValidation(gh, 'owner/fork', 'integration/update', 'new-head'), 'dispatch requested');
  assert.deepEqual(calls[1], ['workflow', 'run', 'cloudcom-ci.yml', '--repo', 'owner/fork', '--ref', 'integration/update']);
  calls.length = 0;
  assert.equal(ensureValidation(gh, 'owner/fork', 'integration/update', 'old-head'), 'https://example.invalid/run');
  assert.equal(calls.length, 1);
});

test('validation dispatch failures propagate so an update never claims successful validation', () => {
  const gh = (...args) => {
    if (args[0] === 'api') return JSON.stringify({ workflow_runs: [] });
    throw new Error('dispatch denied');
  };
  assert.throws(() => ensureValidation(gh, 'owner/fork', 'integration/update', 'head'), /dispatch denied/);
});

test('validates baseline release provenance for lightweight and annotated tags and rejects mismatches', () => {
  const commit = 'a'.repeat(40);
  const baseline = { repository: 'LanternOps/breeze', tag: 'v1.2.3', commit };
  const gh = () => JSON.stringify({ tag_name: baseline.tag, published_at: '2026-01-01', draft: false, prerelease: false });
  assert.doesNotThrow(() => verifyBaseline(() => `${commit}\trefs/tags/v1.2.3`, gh, baseline));
  assert.doesNotThrow(() => verifyBaseline(() => `${'b'.repeat(40)}\trefs/tags/v1.2.3\n${commit}\trefs/tags/v1.2.3^{}`, gh, baseline));
  assert.throws(() => verifyBaseline(() => `${'b'.repeat(40)}\trefs/tags/v1.2.3`, gh, baseline), /no longer resolves/);
  assert.throws(() => verifyBaseline(() => '', gh, baseline), /no longer resolves/);
  assert.throws(() => verifyBaseline(() => '', gh, { ...baseline, tag: '--invalid' }), /Invalid pinned/);
  assert.throws(() => verifyBaseline(() => '', () => JSON.stringify({ tag_name: baseline.tag, draft: true }), baseline), /published stable/);
});
