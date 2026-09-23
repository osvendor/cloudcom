#!/usr/bin/env node

import { createPrivateKey, createPublicKey, createHash, sign, verify } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyReleaseImageManifest } from '../release/release-image-manifest.mjs';

const sourcePattern = /^[0-9a-f]{40}$/u;
const hashPattern = /^[0-9a-f]{64}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const rawKeyPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const imageRepository = 'cloudcom-candidate/exchange-worker';
const documentName = 'exchange-worker-release.json';
const signatureName = 'exchange-worker-release.json.ed25519';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function sha256File(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (let length; (length = readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
      hash.update(buffer.subarray(0, length));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}
const fail = (message) => { throw new Error(message); };

function keyFromText(text) {
  const value = text.trim();
  if (value.startsWith('-----BEGIN PUBLIC KEY-----')) return createPublicKey(value);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 32) return createPublicKey({ key: Buffer.concat([rawKeyPrefix, decoded]), type: 'spki', format: 'der' });
  return createPublicKey({ key: decoded, type: 'spki', format: 'der' });
}

function verifySignedBytes(bytes, signatureBytes, publicKeyText) {
  const encoded = signatureBytes.toString('utf8').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) fail('invalid signature encoding');
  const signature = Buffer.from(encoded, 'base64');
  if (signature.length !== 64 || !verify(null, bytes, keyFromText(publicKeyText), signature)) fail('signature verification failed');
}

function verifiedCore({ coreManifest, coreSignature, publicKey, expectedRepository, expectedRelease }) {
  const bytes = readFileSync(coreManifest);
  if (bytes.length > 1024 * 1024) fail('core manifest is too large');
  const core = JSON.parse(bytes.toString('utf8'));
  const verified = verifyReleaseImageManifest({
    manifestBytes: bytes,
    signatureBytes: readFileSync(coreSignature),
    publicKeys: publicKey,
    expectedRepository,
    expectedRelease,
    requiredImages: core.images,
  });
  return { bytes, sourceCommit: verified.sourceCommit, release: core.release, repository: core.repository };
}

function validateDocument(document, core, archive) {
  if (!document || typeof document !== 'object' || Array.isArray(document) || document.schemaVersion !== 1 || document.kind !== 'cloudcom.exchange-worker') fail('invalid worker document');
  if (document.repository?.toLowerCase() !== core.repository.toLowerCase() || document.release !== core.release || document.sourceCommit !== core.sourceCommit) fail('worker source identity mismatch');
  if (!sourcePattern.test(document.sourceCommit) || document.coreManifestSha256 !== sha256(core.bytes)) fail('worker core manifest binding mismatch');
  if (document.image?.name !== 'exchange-worker' || document.image.repository !== imageRepository || !digestPattern.test(document.image.digest ?? '')) fail('invalid worker image binding');
  if (!hashPattern.test(document.archiveSha256 ?? '') || document.archiveSha256 !== sha256File(archive)) fail('worker archive checksum mismatch');
  if (typeof document.buildRun !== 'string' || !/^https:\/\/github\.com\/osvendor\/cloudcom\/actions\/runs\/[0-9]+$/u.test(document.buildRun)) fail('invalid worker build run');
  return document;
}

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!key?.startsWith('--') || !args[i + 1] || key in result) fail('invalid or duplicate option');
    result[key] = args[i + 1];
  }
  return result;
}

export function signWorkerRelease(input) {
  const publicKey = readFileSync(input.publicKeyFile, 'utf8').trim();
  const core = verifiedCore({ ...input, publicKey });
  if (!sourcePattern.test(core.sourceCommit)) fail('invalid core source commit');
  const privateKey = createPrivateKey(readFileSync(input.privateKeyFile));
  if (!createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(keyFromText(publicKey).export({ type: 'spki', format: 'der' }))) fail('signing key does not match core trust key');
  const document = validateDocument({
    schemaVersion: 1,
    kind: 'cloudcom.exchange-worker',
    repository: core.repository,
    release: core.release,
    sourceCommit: core.sourceCommit,
    coreManifestSha256: sha256(core.bytes),
    image: { name: 'exchange-worker', repository: imageRepository, digest: input.imageDigest },
    archiveSha256: sha256File(input.archive),
    buildRun: input.buildRun,
  }, core, input.archive);
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  const signature = Buffer.from(`${sign(null, bytes, privateKey).toString('base64')}\n`);
  mkdirSync(input.outputDir, { recursive: true });
  writeFileSync(join(input.outputDir, documentName), bytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(input.outputDir, signatureName), signature, { flag: 'wx', mode: 0o600 });
  return document;
}

export function verifyWorkerRelease(input) {
  const publicKey = readFileSync(input.publicKeyFile, 'utf8').trim();
  const core = verifiedCore({ ...input, publicKey });
  const bytes = readFileSync(input.workerManifest);
  if (bytes.length > 16384) fail('worker document is too large');
  verifySignedBytes(bytes, readFileSync(input.workerSignature), publicKey);
  const document = validateDocument(JSON.parse(bytes.toString('utf8')), core, input.archive);
  if (input.imageDigest && document.image.digest !== input.imageDigest) fail('worker image digest mismatch');
  return document;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const raw = options(args);
    const common = {
      coreManifest: raw['--core-manifest'], coreSignature: raw['--core-signature'],
      publicKeyFile: raw['--public-key-file'], expectedRepository: raw['--expected-repository'],
      expectedRelease: raw['--expected-release'], archive: raw['--archive'],
      imageDigest: raw['--image-digest'],
    };
    if (command === 'sign') {
      signWorkerRelease({ ...common, privateKeyFile: raw['--private-key-file'], buildRun: raw['--build-run'], outputDir: raw['--output-dir'] });
    } else if (command === 'verify') {
      verifyWorkerRelease({ ...common, workerManifest: raw['--worker-manifest'], workerSignature: raw['--worker-signature'] });
    } else fail('expected sign or verify command');
    process.stdout.write('Verified CloudCom Exchange worker release binding\n');
  } catch (error) {
    process.stderr.write(`exchange-worker-release: ${error.message}\n`);
    process.exitCode = 1;
  }
}
