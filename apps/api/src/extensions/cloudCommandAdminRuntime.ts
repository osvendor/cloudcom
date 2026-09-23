import { createHash, createPrivateKey, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { importPKCS8, SignJWT, createRemoteJWKSet, jwtVerify, type CryptoKey, type JWTPayload, type KeyObject } from 'jose';
import { z } from 'zod';
import { createAdministrationTokenProvider, createUnixSocketExchangeWorkerPort, type ExchangeDescriptorRegistry } from '@cloudcom/ext-cloud-command';
import { safeFetch } from '../services/urlSafety';
import { runOutsideDbContext } from '../db';

const UUID = z.string().uuid().transform(value => value.toLowerCase());
const VERSION = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const CONFIG_ENV = 'CLOUDCOM_MICROSOFT_ADMIN_CONFIG_FILE';
const EXCHANGE_DESCRIPTOR_ENV = 'CLOUDCOM_EXCHANGE_DESCRIPTOR_FILE';
const EXCHANGE_SOCKET_ENV = 'CLOUDCOM_EXCHANGE_SOCKET_PATH';
const CALLBACK_PATH = '/extensions/cloudcommand/connect';
const LOGIN_ORIGIN = 'https://login.microsoftonline.com';
const JWKS = createRemoteJWKSet(new URL(`${LOGIN_ORIGIN}/common/discovery/v2.0/keys`), { cacheMaxAge: 600_000, cooldownDuration: 30_000 });
const ADMIN_ROLES = new Set(['62e90394-69f5-4237-9190-012177145e10', 'e8611ab8-c189-46e8-94e1-60213ab1f814']);

export type CloudCommandAdminConfiguration = { clientId: string; credentialVersion: string; redirectUri: string };
export type CloudCommandAdminConnection = { tenantId: string; clientId: string; credentialVersion: string };
export type CloudCommandAdminAuditEvent = { orgId: string; actorId: string; action: string; resourceId: string; details?: Record<string, unknown>; result: 'success' | 'failure' };
export interface CloudCommandAdminRuntime {
  configuration(): Promise<CloudCommandAdminConfiguration | null>;
  acquireToken(connection: CloudCommandAdminConnection): Promise<string>;
  verifyAuthorization(input: CloudCommandAdminConnection & { code: string; codeVerifier: string; nonce: string }): Promise<{ tenantId: string; administratorObjectId: string }>;
  audit(event: CloudCommandAdminAuditEvent): Promise<void>;
  exchange(): Promise<{ registry: ExchangeDescriptorRegistry; worker: ReturnType<typeof createUnixSocketExchangeWorkerPort> } | null>;
}

type Descriptor = CloudCommandAdminConfiguration & { certificatePath: string; privateKeyPath: string };
type GuardedFetch = typeof safeFetch;
type Dependencies = {
  env?: NodeJS.ProcessEnv;
  readFile?: (file: string, encoding: BufferEncoding) => Promise<string>;
  fetch?: GuardedFetch;
  verificationKey?: CryptoKey | KeyObject;
  auditWrite?: (event: CloudCommandAdminAuditEvent) => Promise<void>;
  writeFile?: typeof writeFile;
  rename?: typeof rename;
  chmod?: typeof chmod;
};

function unavailable(): Error { return new Error('microsoft_administration_unavailable'); }
function tokenUnavailable(): Error { return new Error('microsoft_administration_token_unavailable'); }
function authorizationInvalid(): Error { return new Error('microsoft_administration_authorization_invalid'); }

function requireBoundConnection(connection: CloudCommandAdminConnection, descriptor: Descriptor): { tenantId: string } {
  const tenantId = UUID.safeParse(connection.tenantId);
  if (!tenantId.success || connection.clientId.toLowerCase() !== descriptor.clientId || connection.credentialVersion !== descriptor.credentialVersion) throw unavailable();
  return { tenantId: tenantId.data };
}

function parseDescriptor(raw: string): Descriptor {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw unavailable(); }
  const parsed = z.object({
    clientId: UUID,
    credentialVersion: VERSION,
    certificatePath: z.string().min(1),
    privateKeyPath: z.string().min(1),
    redirectUri: z.string().url().max(2048),
  }).strict().safeParse(value);
  if (!parsed.success || !path.isAbsolute(parsed.data.certificatePath) || !path.isAbsolute(parsed.data.privateKeyPath)) throw unavailable();
  let redirect: URL;
  try { redirect = new URL(parsed.data.redirectUri); } catch { throw unavailable(); }
  if (redirect.protocol !== 'https:' || redirect.pathname !== CALLBACK_PATH || redirect.search || redirect.hash || redirect.username || redirect.password) throw unavailable();
  return parsed.data;
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || response.status >= 300) throw authorizationInvalid();
  let parsed: unknown;
  try { parsed = await response.json(); } catch { throw authorizationInvalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw authorizationInvalid();
  return parsed as Record<string, unknown>;
}

async function assertion(descriptor: Descriptor, tenantId: string, certificatePem: string, privateKeyPem: string): Promise<string> {
  try {
    const certificate = new X509Certificate(certificatePem);
    const privateKey = createPrivateKey(privateKeyPem);
    const key = await importPKCS8(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), 'PS256');
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(now) || Date.parse(certificate.validFrom) > now * 1000
      || Date.parse(certificate.validTo) <= now * 1000 || privateKey.asymmetricKeyType !== 'rsa'
      || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || !certificate.checkPrivateKey(privateKey)) throw new Error();
    const audience = `${LOGIN_ORIGIN}/${tenantId}/oauth2/v2.0/token`;
    return await new SignJWT({})
      .setProtectedHeader({ alg: 'PS256', 'x5t#S256': createHash('sha256').update(certificate.raw).digest('base64url') })
      .setIssuer(descriptor.clientId).setSubject(descriptor.clientId).setAudience(audience)
      .setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now + 300).sign(key);
  } catch { throw unavailable(); }
}

function verifiedGuid(value: unknown): string | undefined {
  const parsed = UUID.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

async function verifyIdentity(idToken: string, expected: { tenantId: string; clientId: string; nonce: string }, key?: CryptoKey | KeyObject): Promise<{ tenantId: string; administratorObjectId: string }> {
  // Narrowly follows the identity checks in apps/m365-graph-actions-executor/src/microsoft/identity.ts.
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, key ?? JWKS, { algorithms: ['RS256'], audience: expected.clientId, requiredClaims: ['iss', 'aud', 'sub', 'tid', 'oid', 'nonce', 'wids', 'exp', 'nbf'] }));
  } catch { throw authorizationInvalid(); }
  const tenantId = verifiedGuid(payload.tid);
  const administratorObjectId = verifiedGuid(payload.oid);
  const roles = Array.isArray(payload.wids) && payload.wids.every(role => typeof role === 'string') ? payload.wids as string[] : undefined;
  if (!tenantId || tenantId !== expected.tenantId || !administratorObjectId || payload.iss !== `${LOGIN_ORIGIN}/${tenantId}/v2.0`
    || payload.aud !== expected.clientId || typeof payload.sub !== 'string' || !payload.sub || payload.nonce !== expected.nonce
    || !roles || !roles.some(role => ADMIN_ROLES.has(role.toLowerCase()))) throw authorizationInvalid();
  return { tenantId, administratorObjectId };
}

/** Host-only Microsoft administration credential runtime. It never accepts descriptor paths from a browser request. */
export function createCloudCommandAdminRuntime(dependencies: Dependencies = {}): CloudCommandAdminRuntime {
  const read = dependencies.readFile ?? readFile;
  const write = dependencies.writeFile ?? writeFile;
  const move = dependencies.rename ?? rename;
  const setMode = dependencies.chmod ?? chmod;
  const fetchImpl: GuardedFetch = dependencies.fetch ?? ((url, init) => runOutsideDbContext(() => safeFetch(url, init)));
  const environment = dependencies.env ?? process.env;
  async function descriptor(): Promise<Descriptor | null> {
      const configPath = environment[CONFIG_ENV];
      if (!configPath || !path.isAbsolute(configPath)) return null;
      try { return parseDescriptor(await read(configPath, 'utf8')); } catch { return null; }
  }
  async function requiredDescriptor(): Promise<Descriptor> { return await descriptor() ?? Promise.reject(unavailable()); }
  async function certificate(config: Descriptor): Promise<{ certificatePem: string; privateKeyPem: string }> {
    try { return { certificatePem: await read(config.certificatePath, 'utf8'), privateKeyPem: await read(config.privateKeyPath, 'utf8') }; } catch { throw unavailable(); }
  }
  let exchangeWrites = Promise.resolve();
  async function exchangeBridge() {
    const descriptorPath = environment[EXCHANGE_DESCRIPTOR_ENV], socketPath = environment[EXCHANGE_SOCKET_ENV];
    if (!descriptorPath || !socketPath || !path.isAbsolute(descriptorPath) || !path.isAbsolute(socketPath)) return null;
    const config = await requiredDescriptor();
    const worker = createUnixSocketExchangeWorkerPort({ socketPath });
    const mutate = async (apply: (tenants: Record<string, Record<string, unknown>>) => void) => {
      // Serialize mutations in this API process. The deployment must provide a single shared,
      // private descriptor mount; no browser request chooses its location or contents.
      const previous = exchangeWrites;
      let release!: () => void; exchangeWrites = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        let raw: unknown = { tenants: {} };
        try { raw = JSON.parse(await read(descriptorPath, 'utf8')); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable();
          // First provision creates the private descriptor file.
        }
        const parsed = z.object({ tenants: z.record(z.string(), z.record(z.string(), z.unknown())) }).strict().safeParse(raw);
        if (!parsed.success) throw unavailable();
        const tenants = parsed.data.tenants; apply(tenants);
        const temporary = `${descriptorPath}.${randomUUID()}.tmp`;
        await write(temporary, JSON.stringify({ tenants }), { encoding: 'utf8', mode: 0o600 });
        await setMode(temporary, 0o600); await move(temporary, descriptorPath); await setMode(descriptorPath, 0o600);
      } finally { release(); }
    };
    const registry: ExchangeDescriptorRegistry = {
      async provision(binding) {
        const tenantId = UUID.parse(binding.tenantId), organizationId = UUID.parse(binding.organizationId), clientId = UUID.parse(binding.clientId);
        if (clientId !== config.clientId || binding.credentialVersion !== config.credentialVersion || !Number.isSafeInteger(binding.connectionGeneration) || binding.connectionGeneration < 1) throw unavailable();
        await mutate(tenants => {
          for (const [existingTenantId, descriptor] of Object.entries(tenants)) {
            if (descriptor.organizationId === organizationId && existingTenantId !== tenantId) delete tenants[existingTenantId];
          }
          tenants[tenantId] = { enabled: true, organizationId, tenantId, clientId, credentialVersion: binding.credentialVersion, connectionGeneration: binding.connectionGeneration,
          // Exchange accepts the tenant identity at connection time; a live capability probe remains required before enabling writes.
          exchangeOrganization: tenantId, certificatePath: config.certificatePath, privateKeyPath: config.privateKeyPath }; });
      },
      async revoke(organizationId) {
        organizationId = UUID.parse(organizationId);
        await mutate(tenants => { for (const [tenantId, descriptor] of Object.entries(tenants)) if (descriptor.organizationId === organizationId) delete tenants[tenantId]; });
      },
    };
    return { registry, worker };
  }
  return {
    async configuration() { const config = await descriptor(); return config && { clientId: config.clientId, credentialVersion: config.credentialVersion, redirectUri: config.redirectUri }; },
    async acquireToken(connection) {
      const config = await requiredDescriptor();
      const { tenantId } = requireBoundConnection(connection, config);
      const provider = createAdministrationTokenProvider({
        clientId: config.clientId, credentialVersion: config.credentialVersion, fetch: fetchImpl,
        loadCertificate: async version => {
          if (version !== config.credentialVersion) throw unavailable();
          const material = await certificate(config);
          return { clientId: config.clientId, credentialVersion: config.credentialVersion, ...material };
        },
      });
      try { return await provider(tenantId); } catch { throw tokenUnavailable(); }
    },
    async verifyAuthorization(input) {
      const config = await requiredDescriptor();
      const { tenantId } = requireBoundConnection(input, config);
      if (typeof input.code !== 'string' || !input.code || typeof input.codeVerifier !== 'string' || !input.codeVerifier || typeof input.nonce !== 'string' || !input.nonce) throw authorizationInvalid();
      const material = await certificate(config);
      const clientAssertion = await assertion(config, tenantId, material.certificatePem, material.privateKeyPem);
      const endpoint = `${LOGIN_ORIGIN}/${tenantId}/oauth2/v2.0/token`;
      let data: Record<string, unknown>;
      try {
        const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', timeoutMs: 15_000, maxBytes: 128 * 1024, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.clientId, grant_type: 'authorization_code', code: input.code, code_verifier: input.codeVerifier, redirect_uri: config.redirectUri, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: clientAssertion }).toString() });
        data = await boundedJson(response);
      } catch (error) { if (error instanceof Error && error.message === 'microsoft_administration_authorization_invalid') throw error; throw authorizationInvalid(); }
      if (typeof data.id_token !== 'string' || !data.id_token || data.id_token.length > 32_768) throw authorizationInvalid();
      return verifyIdentity(data.id_token, { tenantId, clientId: config.clientId, nonce: input.nonce }, dependencies.verificationKey);
    },
    async audit(event) {
      if (dependencies.auditWrite) return dependencies.auditWrite(event);
      const { createAuditLog } = await import('../services/auditService');
      await createAuditLog({ orgId: event.orgId, actorId: event.actorId, action: event.action, resourceType: 'microsoft_administration', resourceId: event.resourceId, details: event.details ?? {}, result: event.result });
    },
    exchange: exchangeBridge,
  };
}

export const cloudCommandAdminRuntime = createCloudCommandAdminRuntime();
