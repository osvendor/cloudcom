import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCustomizations, readCustomizationContract } from './customization-contract.mjs';

test('fails an integration when a registered module or upstream attachment is removed', t => {
  const root = mkdtempSync(join(tmpdir(), 'cloudcom-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contract = { version: 1, customizations: [{ id: 'remote', requiredFiles: ['module.ts'], hooks: [{ file: 'host.ts', contains: 'mount(module)' }] }] };
  writeFileSync(join(root, 'module.ts'), 'export const module = {};');
  writeFileSync(join(root, 'host.ts'), 'mount(module);');
  assert.doesNotThrow(() => assertCustomizations(root, contract));
  writeFileSync(join(root, 'host.ts'), 'mount(upstream);');
  assert.throws(() => assertCustomizations(root, contract), /hook missing/);
  writeFileSync(join(root, 'host.ts'), 'mount(module);');
  rmSync(join(root, 'module.ts'));
  assert.throws(() => assertCustomizations(root, contract), /missing module.ts/);
});

test('rejects malformed and escaping contracts without suppressing parse failures', t => {
  const root = mkdtempSync(join(tmpdir(), 'cloudcom-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(readCustomizationContract(root), null);
  assert.throws(() => assertCustomizations(root, { version: 2 }), /Invalid/);
  assert.throws(() => assertCustomizations(root, { version: 1, customizations: [{ requiredFiles: ['../outside'], hooks: [] }] }), /escapes/);
  mkdirSync(join(root, '.github'));
  writeFileSync(join(root, '.github/cloudcom-customizations.json'), '{ broken');
  assert.throws(() => readCustomizationContract(root), SyntaxError);
});
