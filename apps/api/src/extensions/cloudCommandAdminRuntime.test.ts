import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createCloudCommandAdminRuntime } from './cloudCommandAdminRuntime';

const clientId = '22222222-2222-4222-8222-222222222222';
const tenantId = '11111111-1111-4111-8111-111111111111';
const administratorObjectId = '33333333-3333-4333-8333-333333333333';
const configPath = path.resolve(tmpdir(), 'cloudcom-microsoft-admin.json');
const certificatePath = path.resolve(tmpdir(), 'cloudcom-microsoft-client.pem');
const privateKeyPath = path.resolve(tmpdir(), 'cloudcom-microsoft-client.key');
const fixture = new URL('../../../m365-graph-read-executor/src/test/fixtures/', import.meta.url);
const certificatePem = readFileSync(new URL('client-cert.pem', fixture), 'utf8');
const privateKeyPem = readFileSync(new URL('client-key.pem', fixture), 'utf8');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const descriptor = JSON.stringify({ clientId, credentialVersion: 'cert-1', certificatePath, privateKeyPath, redirectUri: 'https://breeze.example.test/extensions/cloudcommand/connect' });

function runtime(overrides: { config?: string; fetch?: typeof fetch; auditWrite?: (event: never) => Promise<void> } = {}) {
  const readFile = vi.fn(async (file: string) => {
    if (file === configPath) return overrides.config ?? descriptor;
    if (file === certificatePath) return certificatePem;
    if (file === privateKeyPath) return privateKeyPem;
    throw new Error('unexpected protected file');
  });
  return { readFile, runtime: createCloudCommandAdminRuntime({ env: { CLOUDCOM_MICROSOFT_ADMIN_CONFIG_FILE: configPath }, readFile, fetch: overrides.fetch, verificationKey: publicKey, auditWrite: overrides.auditWrite as never }) };
}

async function identity(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ tid: tenantId, oid: administratorObjectId, nonce: 'nonce', wids: ['62e90394-69f5-4237-9190-012177145e10'], ...overrides })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
    .setAudience(clientId).setSubject('subject').setIssuedAt(now).setNotBefore(now - 1).setExpirationTime(now + 300).sign(privateKey);
}

describe('Cloud Command Microsoft administration runtime', () => {
  it('exposes only public descriptor fields from the protected configuration file', async () => {
    const { runtime: subject, readFile } = runtime();
    await expect(subject.configuration()).resolves.toEqual({ clientId, credentialVersion: 'cert-1', redirectUri: 'https://breeze.example.test/extensions/cloudcommand/connect' });
    expect(readFile).toHaveBeenCalledWith(configPath, 'utf8');
  });

  it.each([
    { redirectUri: 'http://breeze.example.test/extensions/cloudcommand/connect' },
    { redirectUri: 'https://user@breeze.example.test/extensions/cloudcommand/connect' },
    { redirectUri: 'https://breeze.example.test/extensions/cloudcommand/connect?next=x' },
    { redirectUri: 'https://breeze.example.test/extensions/cloudcommand/other' },
    { certificatePath: 'relative.pem' },
  ])('rejects unsafe protected descriptor values', async changed => {
    const { runtime: subject } = runtime({ config: JSON.stringify({ clientId, credentialVersion: 'cert-1', certificatePath, privateKeyPath, redirectUri: 'https://breeze.example.test/extensions/cloudcommand/connect', ...changed }) });
    await expect(subject.configuration()).resolves.toBeNull();
  });

  it('reloads the protected descriptor and rejects client/version substitution before credential material or network use', async () => {
    const fetch = vi.fn();
    const { runtime: subject, readFile } = runtime({ fetch });
    await expect(subject.acquireToken({ tenantId, clientId: '44444444-4444-4444-8444-444444444444', credentialVersion: 'cert-1' })).rejects.toThrow('microsoft_administration_unavailable');
    await expect(subject.acquireToken({ tenantId, clientId, credentialVersion: 'other' })).rejects.toThrow('microsoft_administration_unavailable');
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exchanges the code through bounded host transport and verifies a signed administrator identity', async () => {
    const fetch = vi.fn(async () => Response.json({ id_token: await identity() }));
    const { runtime: subject } = runtime({ fetch });
    await expect(subject.verifyAuthorization({ tenantId, clientId, credentialVersion: 'cert-1', code: 'code', codeVerifier: 'verifier', nonce: 'nonce' }))
      .resolves.toEqual({ tenantId, administratorObjectId });
    expect(fetch).toHaveBeenCalledWith(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, expect.objectContaining({ method: 'POST', redirect: 'error', timeoutMs: 15_000, maxBytes: 128 * 1024 }));
    const body = new URLSearchParams(fetch.mock.calls[0]![1].body as string);
    expect(body.get('redirect_uri')).toBe('https://breeze.example.test/extensions/cloudcommand/connect');
    expect(body.get('client_id')).toBe(clientId);
  });

  it.each([
    ['wrong nonce', { nonce: 'other' }],
    ['wrong tenant', { tid: '44444444-4444-4444-8444-444444444444' }],
    ['non-administrator', { wids: [] }],
  ])('rejects a %s identity token', async (_label, overrides) => {
    const fetch = vi.fn(async () => Response.json({ id_token: await identity(overrides) }));
    const { runtime: subject } = runtime({ fetch });
    await expect(subject.verifyAuthorization({ tenantId, clientId, credentialVersion: 'cert-1', code: 'code', codeVerifier: 'verifier', nonce: 'nonce' })).rejects.toThrow('microsoft_administration_authorization_invalid');
  });

  it('rejects malformed identity tokens without disclosing provider material', async () => {
    const fetch = vi.fn(async () => Response.json({ id_token: 'not.a.jwt' }));
    const { runtime: subject } = runtime({ fetch });
    await expect(subject.verifyAuthorization({ tenantId, clientId, credentialVersion: 'cert-1', code: 'code', codeVerifier: 'verifier', nonce: 'nonce' })).rejects.toThrow('microsoft_administration_authorization_invalid');
  });

  it('uses an awaited audit writer so audit persistence failure rejects the operation', async () => {
    const auditWrite = vi.fn(async () => { throw new Error('audit database unavailable'); });
    const { runtime: subject } = runtime({ auditWrite: auditWrite as never });
    await expect(subject.audit({ orgId: tenantId, actorId: tenantId, action: 'cloudcommand.microsoft.connect', resourceId: tenantId, result: 'success' })).rejects.toThrow('audit database unavailable');
    expect(auditWrite).toHaveBeenCalledTimes(1);
  });
});
