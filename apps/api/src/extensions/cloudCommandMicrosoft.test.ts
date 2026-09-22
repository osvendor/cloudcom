import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';

const { dbMocks, contextMocks, runtimeMocks, executorMocks, ormMocks } = vi.hoisted(() => ({
  dbMocks: { selectResults: [] as unknown[][], selectSpy: vi.fn() },
  contextMocks: {
    fromAuth: vi.fn((auth: unknown) => ({ caller: auth })),
    withCaller: vi.fn(async <T>(_context: unknown, fn: () => Promise<T>) => fn()),
    outside: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  },
  runtimeMocks: { enabled: vi.fn(), loadConfig: vi.fn() },
  executorMocks: { snapshot: vi.fn(), call: vi.fn() },
  ormMocks: { and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })), eq: vi.fn((column: unknown, value: unknown) => ({ op: 'eq', column, value })) },
}));

vi.mock('../db/schema', () => ({
  m365Connections: {
    id: { name: 'id' }, orgId: { name: 'org_id' }, profile: { name: 'profile' },
  },
}));

vi.mock('drizzle-orm', async importActual => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return {
    ...actual,
    and: ormMocks.and,
    eq: ormMocks.eq,
  };
});

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => {
      dbMocks.selectSpy(...args);
      return { from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => dbMocks.selectResults.shift() ?? []) })) })) };
    },
  },
  runOutsideDbContext: contextMocks.outside,
  withDbAccessContext: contextMocks.withCaller,
}));

vi.mock('../middleware/auth', () => ({ dbAccessContextFromAuth: contextMocks.fromAuth }));
vi.mock('../services/m365ControlPlane/runtimeConfig', () => ({
  isM365GraphReadToolsEnabledForOrg: runtimeMocks.enabled,
  loadM365CustomerGraphReadRuntimeConfig: runtimeMocks.loadConfig,
}));
vi.mock('../services/m365ControlPlane/readActionService', () => ({
  connectionExecutionSnapshot: executorMocks.snapshot,
  callGraphReadExecutor: executorMocks.call,
}));

import { nativeMicrosoftServices } from './cloudCommandMicrosoft';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG_ID = '33333333-3333-4333-8333-333333333333';
const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '66666666-6666-4666-8666-666666666666';
const SNAPSHOT = {
  id: CONNECTION_ID, orgId: ORG_ID, tenantId: 'tenant-a', consentGeneration: 3,
  permissionManifestVersion: 4, credentialVersion: 'credential-v1', vaultRef: 'vault://opaque', status: 'active',
};

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: ACTOR_ID, email: 'actor@example.test', name: 'Actor', isPlatformAdmin: false },
    token: {} as AuthContext['token'], partnerId: null, orgId: ORG_ID, scope: 'organization',
    accessibleOrgIds: [ORG_ID], canAccessOrg: (id: string) => id === ORG_ID,
    allowedSiteIds: undefined,
    ...overrides,
  } as AuthContext;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    auth: auth(), orgId: ORG_ID,
    authorization: { hasPermission: vi.fn(() => true), mfaSatisfied: true },
    ...overrides,
  } as any;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID, orgId: ORG_ID, tenantId: 'tenant-a', profile: 'customer-graph-read',
    status: 'active', displayName: 'Contoso', clientId: 'client-id-secret-adjacent', clientSecret: 'never-disclose',
    vaultRef: 'vault://opaque', credentialVersion: 'credential-v1', consentGeneration: 3,
    permissionManifestVersion: 4, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.selectResults.length = 0;
  runtimeMocks.enabled.mockReturnValue(true);
  runtimeMocks.loadConfig.mockReturnValue({});
  executorMocks.snapshot.mockImplementation((value: any) =>
    value && ['active', 'degraded'].includes(value.status) && value.tenantId && value.orgId
      ? { ...SNAPSHOT, ...value } : null,
  );
  executorMocks.call.mockResolvedValue({ ok: true, kind: 'collection', items: [{ id: 'item-1' }], truncated: false });
});

describe('nativeMicrosoftServices', () => {
  it('loads only the caller organization customer-read profile under caller RLS and exposes a credential-free connection DTO', async () => {
    dbMocks.selectResults.push([row()]);

    const result = await nativeMicrosoftServices.connection(request());

    expect(result).toMatchObject({ available: true, connected: true, enabled: true, canManage: true, status: 'active', tenantId: 'tenant-a', tenantName: 'Contoso' });
    expect(result).not.toHaveProperty('clientId');
    expect(result).not.toHaveProperty('clientSecret');
    expect(result).not.toHaveProperty('vaultRef');
    expect(result).not.toHaveProperty('credentialVersion');
    expect(contextMocks.fromAuth).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID }));
    expect(contextMocks.withCaller).toHaveBeenCalledWith(expect.objectContaining({ caller: expect.objectContaining({ orgId: ORG_ID }) }), expect.any(Function));
    expect(dbMocks.selectSpy).toHaveBeenCalledTimes(1);
    expect(ormMocks.eq).toHaveBeenCalledWith(expect.objectContaining({ name: 'org_id' }), ORG_ID);
    expect(ormMocks.eq).toHaveBeenCalledWith(expect.objectContaining({ name: 'profile' }), 'customer-graph-read');
  });

  it.each([
    ['site-restricted caller', request({ auth: auth({ allowedSiteIds: ['site-1'] }) })],
    ['cross-organization caller', request({ auth: auth({ canAccessOrg: () => false }) })],
    ['caller without organizations.read', request({ authorization: { hasPermission: vi.fn(() => false), mfaSatisfied: true } })],
    ['host site-restricted authorization', request({ authorization: { hasPermission: vi.fn(() => true), mfaSatisfied: true, allowedSiteIds: ['site-1'] } })],
  ])('denies %s before database or provider access', async (_label, input) => {
    const result = await nativeMicrosoftServices.read(input, 'users');
    expect(result).toMatchObject({ ok: false, code: 'access_denied' });
    expect(dbMocks.selectSpy).not.toHaveBeenCalled();
    expect(executorMocks.call).not.toHaveBeenCalled();
  });

  it.each([
    ['feature flag is off', () => runtimeMocks.enabled.mockReturnValue(false)],
    ['runtime configuration is unavailable', () => runtimeMocks.loadConfig.mockImplementation(() => { throw new Error('missing config'); })],
  ])('reports unavailable native capability when %s', async (_label, setup) => {
    setup();
    dbMocks.selectResults.push([row()]);
    const status = await nativeMicrosoftServices.connection(request());
    const read = await nativeMicrosoftServices.read(request(), 'users');
    expect(status).toMatchObject({ available: false, connected: true, enabled: false });
    expect(status.reason).toContain('not configured');
    expect(read).toMatchObject({ ok: false, code: 'tools_disabled' });
    expect(executorMocks.call).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['pending consent', row({ status: 'pending-consent' })],
    ['revoked', row({ status: 'revoked' })],
  ])('does not invoke the executor for a %s connection', async (_label, connection) => {
    dbMocks.selectResults.push(connection ? [connection] : []);
    const result = await nativeMicrosoftServices.read(request(), 'users');
    expect(result).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(executorMocks.call).not.toHaveBeenCalled();
  });

  it.each([
    ['users', { type: 'm365.user.list', pageSize: 50 }],
    ['groups', { type: 'm365.group.list', pageSize: 50 }],
    ['licenses', { type: 'm365.org.skus.list' }],
    ['sites', { type: 'm365.sites.list', search: '*' }],
  ] as const)('maps %s to its fixed Graph read action', async (resource, action) => {
    dbMocks.selectResults.push([row()], [row()]);
    await nativeMicrosoftServices.read(request(), resource);
    expect(executorMocks.call).toHaveBeenCalledWith(expect.objectContaining(SNAPSHOT), action, expect.objectContaining({ route: 'read', actorId: ACTOR_ID, correlationId: expect.any(String) }));
  });

  it.each([
    ['tenant rebind', { tenantId: 'tenant-b' }],
    ['consent generation change', { consentGeneration: 4 }],
  ])('discards an in-flight successful response after a %s', async (_label, changed) => {
    dbMocks.selectResults.push([row()], [row(changed)]);
    const result = await nativeMicrosoftServices.read(request(), 'users');
    expect(result).toMatchObject({ ok: false, code: 'connection_changed' });
  });

  it('passes executor failures through unchanged', async () => {
    const failure = { ok: false, code: 'executor_unavailable', message: 'Try again', retryAfterSeconds: 17 };
    dbMocks.selectResults.push([row()]);
    executorMocks.call.mockResolvedValue(failure);
    await expect(nativeMicrosoftServices.read(request(), 'users')).resolves.toEqual(failure);
    expect(dbMocks.selectSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves the executor truncation flag', async () => {
    dbMocks.selectResults.push([row()], [row()]);
    executorMocks.call.mockResolvedValue({ ok: true, kind: 'collection', items: [{ id: 'item-1' }], truncated: true });
    await expect(nativeMicrosoftServices.read(request(), 'users')).resolves.toEqual({ ok: true, items: [{ id: 'item-1' }], truncated: true });
  });
});
