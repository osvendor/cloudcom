import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const manifest = JSON.parse(readFileSync(new URL('../../.github/cloudcom-reviewed-impacts.json', import.meta.url), 'utf8'));
export function validateManifest(value = manifest) {
  if (value.version !== 1) throw new Error('Unsupported impact manifest version');
  const seen = new Set();
  for (const [name, group] of Object.entries(value.groups)) {
    if (!group.paths.length || !group.tests.length || !group.commands.length) throw new Error(`Incomplete validation group ${name}`);
    for (const entry of [...group.paths, ...group.tests]) {
      if (entry.includes('..') || path.isAbsolute(entry) || !existsSync(path.join(root, entry))) throw new Error(`Missing/unsafe reviewed path ${entry}`);
    }
    for (const entry of group.paths) {
      if (seen.has(entry)) throw new Error(`Duplicate reviewed path ${entry}`);
      seen.add(entry);
    }
    for (const command of group.commands) {
      if (!['pnpm','node','python3','bash'].includes(command.program) || !Array.isArray(command.args) || !command.args.length || command.cwd.includes('..') || path.isAbsolute(command.cwd)) throw new Error(`Unsafe command in ${name}`);
    }
  }
  return true;
}
export function selectedGroups(paths) {
  const changed = new Set(paths);
  return Object.entries(manifest.groups).filter(([, group]) => group.paths.some(p => changed.has(p)));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateManifest();
  if (!process.argv.includes('--check')) {
    const baseline = JSON.parse(readFileSync(new URL('../../.github/cloudcom-baseline.json', import.meta.url), 'utf8'));
    const paths = execFileSync('git', ['diff','--name-only',baseline.commit,'HEAD'], {cwd:root,encoding:'utf8'}).trim().split('\n');
    for (const [name, group] of selectedGroups(paths)) {
      console.log(`Validating reviewed fork group: ${name}`);
      for (const command of group.commands) {
        execFileSync(command.program, command.args, {cwd:path.join(root,command.cwd),stdio:'inherit',env:{...process.env, NODE_OPTIONS:process.env.NODE_OPTIONS || '--max-old-space-size=2000'}});
      }
    }
  }
}
