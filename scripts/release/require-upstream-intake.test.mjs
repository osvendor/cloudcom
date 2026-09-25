import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { requireUpstreamIntake } from './require-upstream-intake.mjs';

test('allows the baseline-advancing intake commit and refuses later feature commits', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cloudcom-intake-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const commit = (message) => {
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const setBaseline = (tag, upstreamCommit) => writeFileSync(
    join(cwd, '.github', 'cloudcom-baseline.json'),
    `${JSON.stringify({ repository: 'LanternOps/breeze', tag, commit: upstreamCommit })}\n`,
  );
  try {
    git('init', '-q');
    mkdirSync(join(cwd, '.github'));
    writeFileSync(join(cwd, 'README.md'), 'fixture\n');
    const firstUpstream = commit('first upstream');
    setBaseline('v0.115.0', firstUpstream);
    const secondUpstream = commit('second upstream');
    setBaseline('v0.116.0', secondUpstream);
    const intake = commit('import upstream release');
    assert.deepEqual(requireUpstreamIntake(cwd, intake), { previous: 'v0.115.0', current: 'v0.116.0' });
    assert.match(execFileSync(process.execPath, [fileURLToPath(new URL('./require-upstream-intake.mjs', import.meta.url)), intake], { cwd, encoding: 'utf8' }), /Upstream intake confirmed/);

    writeFileSync(join(cwd, 'feature.txt'), 'routine change\n');
    const feature = commit('routine feature');
    assert.throws(() => requireUpstreamIntake(cwd, feature), /only at a LanternOps release intake/);
  } finally {
    if (dirname(realpathSync(cwd)) !== realpathSync(tmpdir())) throw new Error('Unsafe fixture cleanup target');
    rmSync(cwd, { recursive: true, force: true });
  }
});
