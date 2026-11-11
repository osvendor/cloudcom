#!/usr/bin/env node

// A feature release overlays code onto the exact upstream-intake API image.
// The signing key stays on the operator host; production receives only the
// public key, manifest, signature, and immutable artifact directory.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const commit = /^[0-9a-f]{40}$/u;
const digest = /^[0-9a-f]{64}$/u;
const image = /^(?:[a-z0-9][a-z0-9./-]*@)?sha256:[0-9a-f]{64}$/u;
const files = Object.freeze([
  'dist/index.cjs',
  'dist/worker.cjs',
  'dist/scripts/recover-stuck-agents.cjs',
  'dist/scripts/upgrade-preflight.cjs',
  'packages/ext-cloud-command/dist/web/index.js',
]);
const workerFiles = Object.freeze(['worker/exchange-worker.py', 'worker/exchange-persistent.ps1']);
const extensionManifest = 'packages/ext-cloud-command/manifest.json';
const migrationName = /^20[0-9]{2}-[a-z0-9][a-z0-9._-]*\.sql$/u;
function migrationPaths(names) {
  if (!Array.isArray(names) || names.length > 16 || names.some(name => !migrationName.test(name))
    || new Set(names).size !== names.length || names.some((name, index) => index > 0 && names[index - 1] >= name)) {
    fail('invalid ordered migration set');
  }
  return names.map(name => `packages/ext-cloud-command/migrations/${name}`);
}
const maxFileBytes = 64 * 1024 * 1024;
const maxManifestBytes = 16 * 1024;

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function readRegular(root, name) {
  let full = resolve(root);
  if (!lstatSync(full).isDirectory() || lstatSync(full).isSymbolicLink()) fail('invalid artifact root');
  for (const segment of name.split('/').slice(0, -1)) {
    full = join(full, segment);
    const parent = lstatSync(full);
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail(`invalid artifact directory: ${name}`);
  }
  full = join(full, name.split('/').at(-1));
  const stat = lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFileBytes) fail(`invalid artifact file: ${name}`);
  return readFileSync(full);
}
function listedFiles(root, relative) {
  const full = join(resolve(root), ...relative.split('/'));
  const children = readdirSync(full, { withFileTypes: true });
  return children.flatMap(child => {
    const name = `${relative}/${child.name}`;
    if (child.isSymbolicLink()) fail(`symlink in artifact tree: ${name}`);
    if (child.isDirectory()) return listedFiles(root, name);
    if (!child.isFile()) fail(`invalid artifact tree member: ${name}`);
    return [name];
  });
}
function checkIdentity(input) {
  if (!commit.test(input.baseCommit ?? '') || !digest.test(input.sourcePatchSha256 ?? '')
    || !image.test(input.baseApiImage ?? '')) fail('invalid feature release identity');
  if (input.baseWorkerImage !== undefined && !image.test(input.baseWorkerImage)) fail('invalid worker image identity');
}
export function createFeatureManifest({ root, baseCommit, sourcePatchSha256, baseApiImage, baseWorkerImage, migrations = [] }) {
  checkIdentity({ baseCommit, sourcePatchSha256, baseApiImage, baseWorkerImage });
  const migrationFiles = migrationPaths(migrations);
  if (migrationFiles.length && !baseWorkerImage) fail('migration feature requires a worker image identity');
  const entries = [...files, ...(baseWorkerImage ? workerFiles : []),
    ...(migrationFiles.length ? [extensionManifest, ...migrationFiles] : [])].map(path => {
    const bytes = readRegular(root, path);
    return { path, sha256: sha256(bytes), bytes: bytes.length };
  });
  return Buffer.from(`${JSON.stringify({ schemaVersion: migrationFiles.length ? 3 : baseWorkerImage ? 2 : 1,
    kind: 'cloudcom-api-feature', baseCommit, sourcePatchSha256, baseApiImage,
    ...(baseWorkerImage ? { baseWorkerImage } : {}), migrations: migrationFiles.length ? migrations : 'unchanged',
    files: entries }, null, 2)}\n`);
}
export function signFeatureManifest(manifestBytes, privateKeyPem) {
  if (manifestBytes.length > maxManifestBytes) fail('manifest too large');
  return sign(null, manifestBytes, createPrivateKey(privateKeyPem));
}
export function verifyFeatureManifest({ root, manifestBytes, signature, publicKeyPem, expectedImage, expectedWorkerImage }) {
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length > maxManifestBytes || !Buffer.isBuffer(signature)
    || signature.length !== 64) fail('invalid manifest or signature');
  if (!verify(null, manifestBytes, createPublicKey(publicKeyPem), signature)) fail('feature signature mismatch');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('invalid manifest JSON'); }
  if (!manifest || ![1, 2, 3].includes(manifest.schemaVersion) || manifest.kind !== 'cloudcom-api-feature'
    || (manifest.schemaVersion === 3 ? !Array.isArray(manifest.migrations) || !manifest.migrations.length
      : manifest.migrations !== 'unchanged')) fail('invalid manifest type or migrations');
  const migrationFiles = manifest.schemaVersion === 3 ? migrationPaths(manifest.migrations) : [];
  checkIdentity(manifest);
  if (manifest.schemaVersion >= 2 && !manifest.baseWorkerImage) fail('worker image identity missing');
  if (manifest.baseApiImage !== expectedImage) fail('base API image mismatch');
  if (manifest.schemaVersion >= 2 && manifest.baseWorkerImage !== expectedWorkerImage) fail('base worker image mismatch');
  if (manifest.schemaVersion === 1 && manifest.baseWorkerImage !== undefined) fail('unexpected worker identity');
  const requiredFiles = [...files, ...(manifest.baseWorkerImage ? workerFiles : []),
    ...(migrationFiles.length ? [extensionManifest, ...migrationFiles] : [])];
  if (!Array.isArray(manifest.files) || manifest.files.length !== requiredFiles.length) fail('artifact file set mismatch');
  for (const [index, name] of requiredFiles.entries()) {
    const entry = manifest.files[index];
    if (!entry || entry.path !== name || !digest.test(entry.sha256 ?? '') || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0 || entry.bytes > maxFileBytes) fail('invalid artifact entry');
    const bytes = readRegular(root, name);
    if (entry.bytes !== bytes.length || entry.sha256 !== sha256(bytes)) fail(`artifact hash mismatch: ${name}`);
  }
  const actual = [...listedFiles(root, 'dist'), ...listedFiles(root, 'packages/ext-cloud-command/dist/web'),
    ...(manifest.baseWorkerImage ? listedFiles(root, 'worker') : []),
    ...(migrationFiles.length ? [extensionManifest, ...listedFiles(root, 'packages/ext-cloud-command/migrations')] : [])].sort();
  const expected = [...requiredFiles].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
    fail('unexpected artifact tree member');
  return manifest;
}
function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined || Object.hasOwn(result, key)) fail('invalid CLI options');
    result[key] = value;
  }
  return result;
}
function cli(argv) {
  const [command, ...args] = argv, o = options(args);
  if (command === 'manifest') {
    writeFileSync(o['--output'], createFeatureManifest({ root: o['--root'], baseCommit: o['--base-commit'],
      sourcePatchSha256: o['--source-patch-sha256'], baseApiImage: o['--base-api-image'],
      baseWorkerImage: o['--base-worker-image'],
      migrations: o['--migrations'] ? o['--migrations'].split(',') : [] }), { flag: 'wx' });
  } else if (command === 'sign') {
    writeFileSync(o['--output'], signFeatureManifest(readFileSync(o['--manifest']), readFileSync(o['--private-key'])), { flag: 'wx' });
  } else if (command === 'verify') {
    const manifest = verifyFeatureManifest({ root: o['--root'], manifestBytes: readFileSync(o['--manifest']),
      signature: readFileSync(o['--signature']), publicKeyPem: readFileSync(o['--public-key']),
      expectedImage: o['--expected-image'], expectedWorkerImage: o['--expected-worker-image'] });
    process.stdout.write(`Verified CloudCom API feature artifacts over ${manifest.baseApiImage}\n`);
  } else if (command === 'keygen') {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(o['--private-key'], privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    writeFileSync(o['--public-key'], publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o644 });
  } else fail('usage: feature-artifact.mjs <manifest|sign|verify> --...');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { cli(process.argv.slice(2)); } catch (error) { process.stderr.write(`feature-artifact: ${error.message}\n`); process.exitCode = 1; }
}
