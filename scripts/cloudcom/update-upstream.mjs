import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertCustomizations, readCustomizationContract } from './customization-contract.mjs';

const repository = 'LanternOps/breeze';
function run(command, args, cwd, env = process.env) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function prepareMerge(cwd, commit, baseline) {
  const git = (...args) => run('git', args, cwd);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected an exact upstream commit SHA');
  if (git('status', '--porcelain')) throw new Error('Refusing to update a dirty checkout');
  git('merge-base', '--is-ancestor', baseline.commit, commit);
  const original = git('rev-parse', 'HEAD');
  // Capture the pre-merge contract: an incoming change cannot remove a
  // registered module and erase its declaration to make validation pass.
  const customizations = readCustomizationContract(cwd);
  try {
    try { git('merge', '--no-commit', '--no-ff', commit); }
    catch (error) {
      // Only our explicitly owned workflow directory may be restored automatically.
      if (!git('diff', '--name-only', '--diff-filter=U')) throw error;
    }
    // Remove merge stages first: restore alone cannot resolve a deleted/modified file.
    git('rm', '-r', '-f', '--ignore-unmatch', '--', '.github/workflows');
    git('restore', '--source', original, '--staged', '--worktree', '--', '.github/workflows');
    const conflicts = git('diff', '--name-only', '--diff-filter=U');
    if (conflicts) throw new Error(`Manual upstream conflict resolution required:\n${conflicts}`);
    assertCustomizations(cwd, customizations);
    return original;
  } catch (error) {
    try { git('merge', '--abort'); } catch { /* Merge may not have started. */ }
    throw error;
  }
}

export function ensureValidation(gh, target, branch, head) {
  // workflow_dispatch explicitly permits workflows triggered by GITHUB_TOKEN.
  const runs = JSON.parse(gh('api', '--method', 'GET', `repos/${target}/actions/workflows/cloudcom-ci.yml/runs`,
    '-f', `branch=${branch}`, '-f', 'event=workflow_dispatch', '-f', 'per_page=100'));
  const validation = runs.workflow_runs.find((workflowRun) => workflowRun.head_sha === head);
  if (!validation) gh('workflow', 'run', 'cloudcom-ci.yml', '--repo', target, '--ref', branch);
  return validation?.html_url || 'dispatch requested';
}

export function verifyBaseline(git, gh, baseline) {
  if (baseline.repository !== repository || !/^[a-f0-9]{40}$/.test(baseline.commit) ||
      !/^v\d+\.\d+\.\d+$/.test(baseline.tag)) throw new Error('Invalid pinned CloudCom baseline');
  const release = JSON.parse(gh('api', `repos/${repository}/releases/tags/${baseline.tag}`));
  if (release.draft || release.prerelease || !release.published_at || release.tag_name !== baseline.tag) {
    throw new Error('Pinned baseline must be a published stable upstream release');
  }
  const ref = `refs/tags/${baseline.tag}`;
  const refs = new Map(git('ls-remote', '--tags', `https://github.com/${repository}.git`, ref, `${ref}^{}`)
    .split('\n').filter(Boolean).map((line) => { const [sha, name] = line.split(/\s+/); return [name, sha]; }));
  if ((refs.get(`${ref}^{}`) || refs.get(ref)) !== baseline.commit) {
    throw new Error('Pinned baseline tag no longer resolves to its recorded commit; manual provenance review required');
  }
}

export async function main(cwd = process.cwd()) {
  const git = (...args) => run('git', args, cwd);
  const gh = (...args) => run('gh', args, cwd);
  const baselinePath = '.github/cloudcom-baseline.json';
  const baseline = JSON.parse(readFileSync(`${cwd}/${baselinePath}`, 'utf8'));
  verifyBaseline(git, gh, baseline);
  const release = JSON.parse(gh('api', `repos/${repository}/releases/latest`));
  if (release.draft || release.prerelease || !release.published_at || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error('Only published stable version tags are accepted');
  }
  git('fetch', '--no-tags', `https://github.com/${repository}.git`, `refs/tags/${release.tag_name}`);
  const commit = git('rev-parse', 'FETCH_HEAD^{commit}');
  const summary = (message) => {
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  };
  if (commit === baseline.commit) return summary(`Already based on ${release.tag_name} (${commit}).`);
  if (release.tag_name === baseline.tag) throw new Error('Pinned upstream tag has moved; manual provenance review required');
  const target = process.env.GITHUB_REPOSITORY;
  if (!target || target.toLowerCase() === repository.toLowerCase()) throw new Error('Expected a fork repository');
  const branch = `integration/upstream-${release.tag_name}-${commit.slice(0, 12)}`;
  const base = gh('api', `repos/${target}`, '--jq', '.default_branch');
  let original;
  let head;
  if (git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)) {
    // Recover from a previous PR/API failure without rewriting anyone's branch.
    git('fetch', '--no-tags', 'origin', `refs/heads/${branch}`);
    head = git('rev-parse', 'FETCH_HEAD');
    original = git('rev-parse', 'FETCH_HEAD^1');
    const existingBaseline = JSON.parse(git('show', `FETCH_HEAD:${baselinePath}`));
    if (existingBaseline.commit !== commit || existingBaseline.repository !== repository) {
      throw new Error('Existing update branch baseline differs; manual review required');
    }
  } else {
    git('config', 'user.name', 'github-actions[bot]');
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
    git('switch', '-c', branch);
    original = prepareMerge(cwd, commit, baseline);
    writeFileSync(`${cwd}/${baselinePath}`, `${JSON.stringify({ repository, tag: release.tag_name, commit }, null, 2)}\n`);
    git('add', '--', baselinePath);
    git('commit', '-m', `chore(upstream): import ${release.tag_name}`);
    head = git('rev-parse', 'HEAD');
    if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required to publish the draft branch');
    // Supply credentials to this process only: no credential file or persistent Git config.
    run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], cwd, {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString('base64')}`,
    });
  }
  const body = `Imports the published [${release.tag_name}](${release.html_url}) release.\n\n` +
    `Upstream: ${baseline.tag} (${baseline.commit}) → ${release.tag_name} (${commit}).\n` +
    `CloudCom starting commit: ${original}.\n\n` +
    `CloudCom's complete workflow directory is preserved; upstream workflow additions are excluded. ` +
    `No deployment or automatic merge is performed. Release publication is the baseline, not proof of fork compatibility.\n\n` +
    `Before marking ready: review release notes, migrations and every maintenance-register customization; ` +
    `run CloudCom CI on this exact branch and review cumulative fork changes and affected interfaces. ` +
    `PRs created with GITHUB_TOKEN do not trigger pull_request workflows. The updater explicitly dispatches ` +
    `cloudcom-ci.yml on this branch instead. Verify its successful run is for the exact final head; ` +
    `if dispatch fails, retry the updater or run CloudCom CI manually on this branch. ` +
    `Keep this PR in draft until those checks and the maintenance record are complete. ` +
    `Prepare backup/restore and deployment acceptance separately.\n`;
  const prs = JSON.parse(gh('pr', 'list', '--repo', target, '--head', branch, '--state', 'all', '--json', 'url,state'));
  const existing = prs.find((pr) => pr.state === 'OPEN') || prs[0];
  if (existing && existing.state !== 'OPEN') {
    return summary(`Update PR is already ${existing.state.toLowerCase()}: ${existing.url}. No branch was overwritten or reopened.`);
  }
  const url = existing?.url || gh('pr', 'create', '--repo', target, '--base', base, '--head', branch, '--draft',
    '--title', `chore(upstream): import Breeze ${release.tag_name}`, '--body', body);
  const validation = ensureValidation(gh, target, branch, head);
  summary(`Draft upstream update: ${url}\n\nCloudCom CI: ${validation}. ` +
    'Review the exact final head results before marking ready; nothing was deployed or merged.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
