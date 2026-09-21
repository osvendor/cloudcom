import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readCustomizationContract(cwd) {
  try { return JSON.parse(readFileSync(resolve(cwd, '.github/cloudcom-customizations.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function assertCustomizations(cwd, contract) {
  if (!contract) return; // Repositories predating the first registered module.
  if (contract.version !== 1 || !Array.isArray(contract.customizations)) throw new Error('Invalid customization contract');
  const checkedPath = path => {
    if (typeof path !== 'string' || !path) throw new Error('Invalid customization path');
    const target = resolve(cwd, path);
    const rel = relative(resolve(cwd), target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Customization path escapes repository');
    return target;
  };
  for (const item of contract.customizations) {
    for (const file of item.requiredFiles) {
      if (!statSync(checkedPath(file), { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Customization ${item.id} is missing ${file}; manual integration required`);
      }
    }
    for (const hook of item.hooks) {
      if (!hook.contains || !readFileSync(checkedPath(hook.file), 'utf8').includes(hook.contains)) {
        throw new Error(`Customization ${item.id} hook missing in ${hook.file}; manual integration required`);
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const contract = readCustomizationContract(process.cwd());
  if (!contract) throw new Error('Missing CloudCom customization contract');
  assertCustomizations(process.cwd(), contract);
  console.log('CloudCom customization files and attachment points present; behavioral tests still required.');
}
