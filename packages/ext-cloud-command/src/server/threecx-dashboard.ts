import type { Hono } from 'hono';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';
import { createThreeCxReadService } from '../threecx/read-service.mjs';
import { ProviderError, type Credentials, type createProvider } from './transport';
import type { ThreeCxConnection, Variables } from './index';

type Provider = ReturnType<typeof createProvider>;
type Scope = Variables['scope'];
const integerFields = ['CallsActive', 'MaxSimCalls', 'ExtensionsRegistered', 'ExtensionsTotal', 'TrunksRegistered', 'TrunksTotal', 'FreeDiskSpace', 'TotalDiskSpace'] as const;
const booleanFields = ['HasNotRunningServices', 'BackupScheduled'] as const;
type Status = { Version: string | null; LastBackupDateTime: string | null } & Record<typeof integerFields[number], number | null> & Record<typeof booleanFields[number], boolean | null>;

/** The 3CX status endpoint is PBX-wide. Never show it for a department-bound organization. */
export function projectSystemStatus(raw: unknown): Status {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProviderError('invalid_provider_response');
  const source = raw as Record<string, unknown>;
  const result = { Version: null, LastBackupDateTime: null } as Status;
  for (const key of ['Version', 'LastBackupDateTime'] as const) {
    const value = source[key];
    if (value != null && (typeof value !== 'string' || value.length > 128)) throw new ProviderError('invalid_provider_response');
    result[key] = value ?? null;
  }
  for (const key of integerFields) {
    const value = source[key];
    if (value != null && (!Number.isSafeInteger(value) || (value as number) < 0)) throw new ProviderError('invalid_provider_response');
    result[key] = value == null ? null : value as number;
  }
  for (const key of booleanFields) {
    const value = source[key];
    if (value != null && typeof value !== 'boolean') throw new ProviderError('invalid_provider_response');
    result[key] = value == null ? null : value as boolean;
  }
  return result;
}

export async function readThreeCxDashboard(input: {
  scope: Scope;
  row: ThreeCxConnection;
  credentials: Credentials;
  provider: Provider;
}) {
  const { scope, row, credentials, provider } = input;
  const service = createThreeCxReadService({
    authorize: async () => true,
    loadConnection: async () => ({ id: row.id, organizationId: row.org_id, partnerId: scope.partnerId, origin: row.origin, enabled: row.enabled, departmentId: row.department_id }),
    readUsers: async ({ query }: { query: Record<string, string | number> }) => provider.users(credentials, query),
  });
  let total = 0;
  let registered = 0;
  let nextSkip: number | null = 0;
  // Bound dashboard work to ten raw pages. Never present a partial count as complete.
  for (let pageNumber = 0; pageNumber < 10 && nextSkip !== null; pageNumber += 1) {
    const page = await service.listExtensions(scope, row.id, nextSkip);
    total += page.items.length;
    registered += page.items.filter((item: Record<string, unknown>) => item.IsRegistered === true).length;
    nextSkip = page.nextSkip;
  }
  let status: Status | null = null;
  let statusAvailability: 'available' | 'department_scoped' | 'permission_limited' = 'department_scoped';
  if (row.department_id === null) {
    try {
      status = projectSystemStatus(await provider.systemStatus(credentials));
      statusAvailability = 'available';
    } catch (error) {
      // A 403 or unavailable status endpoint must not hide the department-safe counts.
      if (!(error instanceof ProviderError)) throw error;
      statusAvailability = 'permission_limited';
    }
  }
  return {
    scope: row.department_id === null ? 'full_pbx' : 'department',
    extensions: { total, registered, complete: nextSkip === null },
    status, statusAvailability, checkedAt: new Date().toISOString(),
  };
}

export function mountThreeCxDashboard(app: Hono<{ Variables: Variables }>, deps: {
  connection(orgId: string): Promise<ThreeCxConnection | undefined>;
  credentials(row: ThreeCxConnection): Credentials;
  provider: Provider;
  context: ExtensionRuntimeContext;
}) {
  app.get('/threecx/dashboard', async c => {
    const scope = c.get('scope');
    const row = await deps.connection(scope.organizationId);
    if (!row?.enabled) return c.json({ error: 'Not available', code: 'not_available' }, 404);
    return c.json(await readThreeCxDashboard({ scope, row, credentials: deps.credentials(row), provider: deps.provider }));
  });
}
