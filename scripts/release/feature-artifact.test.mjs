import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createFeatureManifest, signFeatureManifest, verifyFeatureManifest } from './feature-artifact.mjs';

const names = ['dist/index.cjs', 'dist/worker.cjs', 'dist/scripts/recover-stuck-agents.cjs',
  'dist/scripts/upgrade-preflight.cjs', 'packages/ext-cloud-command/dist/web/index.js'];
const baseCommit = 'a'.repeat(40);
const sourcePatchSha256 = 'b'.repeat(64);
const baseApiImage = `cloudcom-candidate/api@sha256:${'c'.repeat(64)}`;
const baseWorkerImage = `cloudcom-candidate/exchange-worker@sha256:${'e'.repeat(64)}`;

test('signed API feature artifact is bound to exact source, image and files', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloudcom-feature-artifact-'));
  try {
    for (const [index, name] of names.entries()) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `file-${index}`);
    }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const manifestBytes = createFeatureManifest({ root, baseCommit, sourcePatchSha256, baseApiImage });
    const signature = signFeatureManifest(manifestBytes, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const input = { root, manifestBytes, signature, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), expectedImage: baseApiImage };
    assert.equal(verifyFeatureManifest(input).files.length, 5);
    writeFileSync(join(root, 'dist', 'unlisted.cjs'), 'extra');
    assert.throws(() => verifyFeatureManifest(input), /unexpected artifact tree member/);
    rmSync(join(root, 'dist', 'unlisted.cjs'));
    assert.throws(() => verifyFeatureManifest({ ...input, expectedImage: `cloudcom-candidate/api@sha256:${'d'.repeat(64)}` }), /base API image mismatch/);
    assert.throws(() => verifyFeatureManifest({ ...input, manifestBytes: Buffer.from(`${manifestBytes.toString()} `) }), /signature mismatch/);
    writeFileSync(join(root, names[0]), 'tampered');
    assert.throws(() => verifyFeatureManifest(input), /artifact hash mismatch/);
    rmSync(join(root, names[0]));
    try {
      symlinkSync(join(root, names[1]), join(root, names[0]));
      assert.throws(() => verifyFeatureManifest(input), /invalid artifact file/);
    } catch (error) {
      if (error.code !== 'EPERM') throw error; // Windows without developer-mode symlinks.
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('signed combined feature artifact binds the unchanged worker image and scripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloudcom-feature-worker-'));
  try {
    for (const name of [...names, 'worker/exchange-worker.py', 'worker/exchange-persistent.ps1']) {
      const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, name);
    }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const manifestBytes = createFeatureManifest({ root, baseCommit, sourcePatchSha256, baseApiImage, baseWorkerImage });
    const signature = signFeatureManifest(manifestBytes, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const input = { root, manifestBytes, signature, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), expectedImage: baseApiImage, expectedWorkerImage: baseWorkerImage };
    assert.equal(verifyFeatureManifest(input).schemaVersion, 2);
    assert.throws(() => verifyFeatureManifest({ ...input, expectedWorkerImage: `${baseWorkerImage.slice(0, -1)}d` }), /base worker image mismatch/);
    writeFileSync(join(root, 'worker/exchange-worker.py'), 'tampered');
    assert.throws(() => verifyFeatureManifest(input), /artifact hash mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('signed schema feature includes exact extension manifest and ordered migration files', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloudcom-feature-schema-'));
  const migration = '2026-09-25-microsoft-directory-layouts.sql';
  try {
    for (const name of [...names, 'worker/exchange-worker.py', 'worker/exchange-persistent.ps1',
      'packages/ext-cloud-command/manifest.json', `packages/ext-cloud-command/migrations/${migration}`]) {
      const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, name);
    }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const manifestBytes = createFeatureManifest({ root, baseCommit, sourcePatchSha256, baseApiImage,
      baseWorkerImage, migrations: [migration] });
    const signature = signFeatureManifest(manifestBytes, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const input = { root, manifestBytes, signature, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      expectedImage: baseApiImage, expectedWorkerImage: baseWorkerImage };
    assert.equal(verifyFeatureManifest(input).schemaVersion, 3);
    assert.throws(() => createFeatureManifest({ root, baseCommit, sourcePatchSha256, baseApiImage,
      baseWorkerImage, migrations: ['../escape.sql'] }), /invalid ordered migration set/);
    assert.throws(() => createFeatureManifest({ root, baseCommit, sourcePatchSha256, baseApiImage,
      migrations: [migration] }), /requires a worker image identity/);
    writeFileSync(join(root, 'packages/ext-cloud-command/migrations', migration), 'modified');
    assert.throws(() => verifyFeatureManifest(input), /artifact hash mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
