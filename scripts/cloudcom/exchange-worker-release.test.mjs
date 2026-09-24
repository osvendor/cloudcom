import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { REQUIRED_RELEASE_IMAGES } from '../release/release-image-manifest.mjs';
import { signWorkerRelease, verifyWorkerRelease } from './exchange-worker-release.mjs';

const digest = (digit) => `sha256:${digit.repeat(64)}`;

test('worker release is signed separately and bound to the exact core manifest, source and archive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloudcom-worker-release-'));
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keyFile = join(dir, 'key.pem');
    const publicFile = join(dir, 'public.txt');
    const coreFile = join(dir, 'release-artifact-manifest.json');
    const coreSignature = join(dir, 'release-artifact-manifest.json.ed25519');
    const archive = join(dir, 'exchange-worker.tar.gz');
    const sourceCommit = 'a'.repeat(40);
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(publicFile, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'));
    const core = Buffer.from(`${JSON.stringify({
      schemaVersion: 1, repository: 'osvendor/cloudcom', release: 'v0.115.0', sourceCommit,
      assets: [], images: REQUIRED_RELEASE_IMAGES.map((name, index) => ({
        name, repository: `cloudcom-candidate/${name}`, digest: digest(String(index + 1)),
      })),
    })}\n`);
    writeFileSync(coreFile, core);
    writeFileSync(coreSignature, sign(null, core, privateKey).toString('base64'));
    writeFileSync(archive, 'test archive bytes');
    const common = {
      coreManifest: coreFile, coreSignature, publicKeyFile: publicFile,
      expectedRepository: 'osvendor/cloudcom', expectedRelease: 'v0.115.0', archive,
      imageDigest: digest('8'),
    };
    signWorkerRelease({ ...common, privateKeyFile: keyFile, buildRun: 'https://github.com/osvendor/cloudcom/actions/runs/123', outputDir: dir });
    const verification = {
      ...common, workerManifest: join(dir, 'exchange-worker-release.json'),
      workerSignature: join(dir, 'exchange-worker-release.json.ed25519'),
    };
    assert.equal(verifyWorkerRelease(verification).sourceCommit, sourceCommit);
    assert.equal(JSON.parse(readFileSync(verification.workerManifest, 'utf8')).image.name, 'exchange-worker');
    assert.throws(() => verifyWorkerRelease({ ...verification, imageDigest: digest('9') }), /image digest mismatch/u);
    const savedWorkerSignature = readFileSync(verification.workerSignature);
    writeFileSync(verification.workerSignature, 'AAAAAAAA');
    assert.throws(() => verifyWorkerRelease(verification), /signature verification failed/u);
    writeFileSync(verification.workerSignature, savedWorkerSignature);
    writeFileSync(archive, 'different archive bytes');
    assert.throws(() => verifyWorkerRelease(verification), /archive checksum mismatch/u);
    writeFileSync(archive, 'test archive bytes');
    const changedCore = Buffer.from(core.toString().replace(sourceCommit, 'b'.repeat(40)));
    writeFileSync(coreFile, changedCore);
    assert.throws(() => verifyWorkerRelease(verification), /signature verification failed/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
