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

function runtime(overrides: { config?: string; fetch?: typeof fetch; auditWrite?: (event: never) => Promise<void>; exchange?: boolean } = {}) {
  const exchangePath = path.resolve(tmpdir(), 'cloudcom-exchange-descriptors.json');
  const files = new Map<string, string>();
  const readFile = vi.fn(async (file: string) => {
    if (file === configPath) return overrides.config ?? descriptor;
    if (file === certificatePath) return certificatePem;
    if (file === privateKeyPath) return privateKeyPem;
    if (file === exchangePath && files.has(file)) return files.get(file)!;
    if (file === exchangePath) throw Object.assign(new Error('missing descriptor'), { code: 'ENOENT' });
    throw new Error('unexpected protected file');
  });
  const writeFile = vi.fn(async (file: string, value: string) => { files.set(file, value); });
  const rename = vi.fn(async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); });
  const chmod = vi.fn(async () => {});
  const env = { CLOUDCOM_MICROSOFT_ADMIN_CONFIG_FILE: configPath, ...(overrides.exchange ? { CLOUDCOM_EXCHANGE_DESCRIPTOR_FILE: exchangePath, CLOUDCOM_EXCHANGE_SOCKET_PATH: '/run/cloudcom/exchange.sock' } : {}) };
  return { readFile, writeFile, rename, chmod, files, exchangePath, runtime: createCloudCommandAdminRuntime({ env, readFile, writeFile: writeFile as never, rename: rename as never, chmod: chmod as never, fetch: overrides.fetch, verificationKey: publicKey, auditWrite: overrides.auditWrite as never }) };
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
  it('creates and revokes local Exchange descriptors from the same protected application credential', async () => {
    const h = runtime({ exchange: true });
    const exchange = await h.runtime.exchange();
    expect(exchange).not.toBeNull();
    await exchange!.registry.provision({ organizationId: administratorObjectId, tenantId, clientId, credentialVersion: 'cert-1', connectionGeneration: 3 });
    const persisted = JSON.parse(h.files.get(h.exchangePath)!);
    expect(persisted.tenants[tenantId]).toMatchObject({ organizationId: administratorObjectId, tenantId, clientId, credentialVersion: 'cert-1', connectionGeneration: 3, enabled: true });
    expect(JSON.stringify(persisted)).not.toContain(privateKeyPem);
    await exchange!.registry.revoke(administratorObjectId);
    expect(JSON.parse(h.files.get(h.exchangePath)!).tenants).toEqual({});
    expect(h.chmod).toHaveBeenCalledWith(h.exchangePath, 0o600);
  });

  it('removes an old tenant descriptor when an organization reconnects to a new tenant', async () => {
    const h = runtime({ exchange: true });
    const exchange = (await h.runtime.exchange())!;
    await exchange.registry.provision({ organizationId: administratorObjectId, tenantId, clientId, credentialVersion: 'cert-1', connectionGeneration: 3 });
    const replacementTenant = '55555555-5555-4555-8555-555555555555';
    await exchange.registry.provision({ organizationId: administratorObjectId, tenantId: replacementTenant, clientId, credentialVersion: 'cert-1', connectionGeneration: 4 });
    expect(Object.keys(JSON.parse(h.files.get(h.exchangePath)!).tenants)).toEqual([replacementTenant]);
  });

  it('fails closed if an existing Exchange descriptor cannot be parsed', async () => {
    const h = runtime({ exchange: true });
    h.files.set(h.exchangePath, '{invalid');
    const exchange = (await h.runtime.exchange())!;
    await expect(exchange.registry.provision({ organizationId: administratorObjectId, tenantId, clientId, credentialVersion: 'cert-1', connectionGeneration: 3 })).rejects.toThrow('microsoft_administration_unavailable');
    expect(h.writeFile).not.toHaveBeenCalled();
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
