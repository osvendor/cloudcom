import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
vi.mock('../db', () => ({ db: { execute: vi.fn() } }));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: vi.fn() }));
import { db } from '../db';
import { verifyDeviceAccess, type AiTool } from './aiTools';
import { registerHarmonyTools } from './aiToolsHarmony';
import type { AuthContext } from '../middleware/auth';

const orgId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const siteId = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const tools = new Map<string, AiTool>(); registerHarmonyTools(tools);
const tool = tools.get('get_harmony_evidence')!;
const auth = (extra: Record<string, unknown> = {}) => ({
  user: { id: 'user-1' }, scope: 'organization', orgId, canAccessOrg: (id: string) => id === orgId,
  principal: { kind: 'user_session' }, ...extra,
}) as unknown as AuthContext;
const run = async (input: Record<string, unknown> = { deviceId }, context = auth()) => JSON.parse(await tool.handler(input, context));
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('CLOUDCOM_THREECX_ENABLED', 'true');
  vi.mocked(verifyDeviceAccess).mockResolvedValue({ device: { id: deviceId, orgId, siteId } } as never);
  vi.mocked(db.execute).mockResolvedValueOnce([{ present: true }] as never).mockResolvedValueOnce([{
    external_id: 'endpoint-1', checked_at: new Date(),
    evidence: { antiMalwareStatus: 'Clean', realTimeProtection: null, infectedCount: 500, secret: 'not-for-ai' },
  }] as never);
});
afterEach(() => vi.unstubAllEnvs());
describe('Harmony AI evidence', () => {
  it('uses one device, tier-one security and the central device gate', () => {
    expect(tool.tier).toBe(1); expect(tool.domain).toBe('security'); expect(tool.deviceArgs).toEqual(['deviceId']);
  });
  it('returns sourced inventory with unknown RTP and explicitly unavailable hunting/actions', async () => {
    const result = await run();
    expect(result.status).toBe('ready'); expect(result.evidence.realTimeProtection).toBeNull();
    expect(result.evidence.reference).toContain(`harmony:${orgId}:endpoint-1:`);
    expect(result.threatHunting).toEqual({ available: false, reason: 'external_api_contract_pending', records: null });
    expect(result.providerResponseActions.available).toBe(false);
    expect(JSON.stringify(result)).not.toContain('not-for-ai'); expect(result.evidence).not.toHaveProperty('infectedCount');
    const query = new PgDialect().sqlToQuery(vi.mocked(db.execute).mock.calls[1][0] as never);
    expect(query.sql).toContain('e.org_id='); expect(query.sql).toContain('e.device_id=');
    expect(query.params).toEqual([orgId, deviceId]);
  });
  it('allows AI principals only within the same existing device ceiling', async () => {
    expect((await run({ deviceId }, auth({ principal: { kind: 'ai_agent' }, allowedDeviceIds: [deviceId] }))).status).toBe('ready');
  });
  it.each([
    { canAccessOrg: () => false }, { orgId: other }, { allowedDeviceIds: [] },
    { allowedDeviceIds: [other] }, { allowedDeviceIds: null },
    { allowedSiteIds: [] }, { allowedSiteIds: null },
    { allowedSiteIds: [other], canAccessSite: () => true },
    { allowedSiteIds: [siteId] }, { canAccessSite: () => false },
  ])('denies inaccessible and malformed scopes without reading the cache: %j', async (extra) => {
    expect((await run({ deviceId }, auth(extra))).error).toBeTruthy(); expect(db.execute).not.toHaveBeenCalled();
  });
  it('denies a refused device before any cache read', async () => {
    vi.mocked(verifyDeviceAccess).mockResolvedValue({ error: 'Device not found or access denied' });
    expect((await run()).error).toBeTruthy(); expect(db.execute).not.toHaveBeenCalled();
  });
  it.each([{ deviceId: 'bad' }, { deviceId, orgId: other }, { deviceId, query: 'all clients' }, {}])('rejects malformed or extra input %j', async (input) => {
    expect((await run(input)).error).toBeTruthy(); expect(verifyDeviceAccess).not.toHaveBeenCalled();
  });
  it('supports a valid site scope', async () => {
    expect((await run({ deviceId }, auth({ allowedSiteIds: [siteId], canAccessSite: (id: string) => id === siteId }))).status).toBe('ready');
  });
  it('does not read a disabled extension cache', async () => {
    vi.stubEnv('CLOUDCOM_THREECX_ENABLED', 'false'); expect((await run()).status).toBe('disabled'); expect(db.execute).not.toHaveBeenCalled();
  });
  it('does not turn missing or stale evidence into a healthy result', async () => {
    vi.mocked(db.execute).mockReset().mockResolvedValueOnce([{ present: true }] as never).mockResolvedValueOnce([] as never);
    expect((await run()).status).toBe('not_linked');
    vi.mocked(db.execute).mockResolvedValueOnce([{ present: true }] as never).mockResolvedValueOnce([{ external_id: 'endpoint', evidence: { antiMalwareStatus: 'Clean' }, checked_at: new Date('2020-01-01') }] as never);
    expect((await run()).status).toBe('stale');
  });
  it('returns a bounded error without exception data', async () => {
    vi.mocked(db.execute).mockReset().mockRejectedValue(new Error('password=private sql private'));
    const result = await run(); expect(result.status).toBe('unavailable'); expect(JSON.stringify(result)).not.toContain('private');
  });
});
