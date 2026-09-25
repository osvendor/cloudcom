import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const TAG = /^v\d+\.\d+\.\d+$/;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function baseline(cwd, rev) {
  const value = JSON.parse(git(cwd, 'show', `${rev}:.github/cloudcom-baseline.json`));
  if (value.repository !== 'LanternOps/breeze' || !TAG.test(value.tag) || !SHA.test(value.commit)) {
    throw new Error(`Invalid upstream baseline at ${rev}`);
  }
  return value;
}

export function requireUpstreamIntake(cwd, sourceCommit) {
  if (!SHA.test(sourceCommit)) throw new Error('Expected an exact source commit SHA');
  const current = baseline(cwd, sourceCommit);
  const previous = baseline(cwd, `${sourceCommit}^1`);
  if (current.tag === previous.tag || current.commit === previous.commit) {
    throw new Error('Runtime images are built only at a LanternOps release intake; the baseline must advance in this commit');
  }
  git(cwd, 'merge-base', '--is-ancestor', previous.commit, current.commit);
  return { previous: previous.tag, current: current.tag };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const result = requireUpstreamIntake(process.cwd(), process.argv[2]);
    console.log(`Upstream intake confirmed: ${result.previous} -> ${result.current}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
