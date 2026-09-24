import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('./cfAccessJwt', async original => ({
  ...await original<typeof import('./cfAccessJwt')>(), verifyCfAccessJwt: mocks.verify,
}));
import { CfAccessJwksUnavailableError } from './cfAccessJwt';
import { checkPortalCompanyGateway, currentCompanyGatewayFingerprint, verifyPortalCompanyGateway } from './portalCompanyGateway';

const orgId = '11111111-1111-4111-8111-111111111111';
const otherOrg = '22222222-2222-4222-8222-222222222222';
const config = { teamDomain: 'test-team.cloudflareaccess.com', audience: 'remote-app',
  companies: [{ subject: 'company-subject', orgId, enabled: true }] };
function configure(value: unknown = config) {
  vi.stubEnv('CLOUDCOM_COMPANY_GATEWAY_CONFIG', JSON.stringify(value));
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('CLOUDCOM_COMPANY_GATEWAY_ENABLED', 'true'); configure();
  mocks.verify.mockResolvedValue({ type: 'app', sub: 'company-subject', email: 'company@example.test',
    exp: Math.floor(Date.now() / 1000) + 300 });
});
afterEach(() => vi.unstubAllEnvs());

describe('company gateway is separate from individual identity', () => {
  it('preserves the existing flow only while explicitly disabled or unconfigured', async () => {
    for (const value of [undefined, 'false']) {
      vi.stubEnv('CLOUDCOM_COMPANY_GATEWAY_ENABLED', value);
      expect(await checkPortalCompanyGateway(undefined, orgId)).toEqual({ ok: true, orgId: null });
    }
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it('verifies the signed assertion with operator-controlled issuer and audience', async () => {
    expect(await checkPortalCompanyGateway('signed-assertion', orgId)).toEqual({ ok: true, orgId });
    expect(mocks.verify).toHaveBeenCalledWith('signed-assertion', config);
  });
  it('denies another organization even with a valid company token', async () => {
    expect(await checkPortalCompanyGateway('signed-assertion', otherOrg)).toEqual({ ok: false, status: 403 });
  });
  it('does not bind by matching email and rechecks disabled mappings', async () => {
    mocks.verify.mockResolvedValueOnce({ sub: 'unmapped', email: 'company@example.test', exp: Math.floor(Date.now()/1000)+300 });
    expect(await verifyPortalCompanyGateway('token')).toEqual({ ok: false, status: 403 });
    configure({ ...config, companies: [{ ...config.companies[0], enabled: false }] });
    expect(await verifyPortalCompanyGateway('token')).toEqual({ ok: false, status: 403 });
  });
  it('invalidates a native configuration fingerprint when a company is disabled or remapped', async () => {
    const oldFingerprint = currentCompanyGatewayFingerprint();
    expect(oldFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const decision = await verifyPortalCompanyGateway('token', true);
    expect(decision).toMatchObject({ ok: true, orgId, configFingerprint: oldFingerprint });
    configure({ ...config, companies: [{ ...config.companies[0], enabled: false }] });
    expect(currentCompanyGatewayFingerprint()).not.toBe(oldFingerprint);
    configure({ ...config, companies: [{ ...config.companies[0], orgId: otherOrg }] });
    expect(currentCompanyGatewayFingerprint()).not.toBe(oldFingerprint);
    vi.stubEnv('CLOUDCOM_COMPANY_GATEWAY_CONFIG', '{invalid');
    expect(currentCompanyGatewayFingerprint()).toBeNull();
  });
  it.each([undefined, '', 'x'.repeat(16385)])('denies absent or oversized assertion', async assertion => {
    expect(await verifyPortalCompanyGateway(assertion)).toEqual({ ok: false, status: 403 });
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it.each([
    {}, { ...config, teamDomain: 'attacker.example.test' },
    { ...config, teamDomain: 'test.cloudflareaccess.com@attacker.test' },
    { ...config, companies: [...config.companies, { subject: 'second', orgId, enabled: true }] },
    { ...config, companies: [...config.companies, { subject: 'company-subject', orgId: otherOrg, enabled: true }] },
  ])('fails closed for invalid or ambiguous configuration', async value => {
    configure(value);
    expect(await verifyPortalCompanyGateway('token')).toEqual({ ok: false, status: 503 });
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it('fails closed for a malformed feature flag or JSON', async () => {
    vi.stubEnv('CLOUDCOM_COMPANY_GATEWAY_ENABLED', 'TRUE');
    expect(await verifyPortalCompanyGateway('token')).toEqual({ ok: false, status: 503 });
    vi.stubEnv('CLOUDCOM_COMPANY_GATEWAY_ENABLED', 'true');
    vi.stubEnv('CLOUDCOM_COMPANY_GATEWAY_CONFIG', '{broken');
    expect(await verifyPortalCompanyGateway('token')).toEqual({ ok: false, status: 503 });
  });
  it('denies token verification failures and unavailable signing keys', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('invalid signature'));
    expect(await verifyPortalCompanyGateway('token')).toEqual({ ok: false, status: 403 });
    mocks.verify.mockRejectedValueOnce(new CfAccessJwksUnavailableError('offline'));
    expect(await verifyPortalCompanyGateway('token')).toEqual({ ok: false, status: 503 });
  });
  it.each([{ sub: 12, exp: 9999999999 }, { sub: '', exp: 9999999999 },
    { sub: 'company-subject', exp: 1 }, { sub: 'company-subject', exp: '9999999999' }])('rejects malformed subject/expiry', async claims => {
    mocks.verify.mockResolvedValue(claims);
    expect(await verifyPortalCompanyGateway('token')).toEqual({ ok: false, status: 403 });
  });
});


describe('explicit custom claim organization allowlist', () => {
  const custom = { cloudcom_org_id: orgId, cloudcom_account_kind: 'company_gateway' };
  const claimConfig = { teamDomain: config.teamDomain, audience: config.audience,
    mode: 'custom-claims', organizations: [{ orgId, enabled: true }] };
  beforeEach(() => {
    configure(claimConfig);
    mocks.verify.mockResolvedValue({ type: 'app', sub: 'new-company-subject',
      email: 'not-used@example.test', exp: Math.floor(Date.now()/1000)+300, custom });
  });
  it('allows only the configured organization without pre-registering subjects', async () => {
    expect(await checkPortalCompanyGateway('token', orgId)).toEqual({ ok: true, orgId });
    expect(await checkPortalCompanyGateway('token', otherOrg)).toEqual({ ok: false, status: 403 });
  });
  it('immediately denies disabled or removed organizations', async () => {
    for (const organizations of [[{ orgId, enabled: false }], [{ orgId: otherOrg, enabled: true }]]) {
      configure({ ...claimConfig, organizations });
      expect(await verifyPortalCompanyGateway('token')).toEqual({ ok: false, status: 403 });
    }
  });
  it.each([undefined, null, [], 'company_gateway', {},
    { cloudcom_org_id: orgId }, { cloudcom_account_kind: 'company_gateway' },
    { ...custom, cloudcom_org_id: [orgId] }, { ...custom, cloudcom_org_id: 'invalid' },
    { ...custom, cloudcom_org_id: otherOrg }, { ...custom, cloudcom_account_kind: 'admin' },
    { ...custom, cloudcom_account_kind: ['company_gateway'] }, { oidc_fields: custom },
    { ...custom, unexpected: true },
  ])('denies missing, trimmed, malformed or unrecognized custom claims', async value => {
    mocks.verify.mockResolvedValue({ type: 'app', sub: 'subject', exp: 9999999999, custom: value });
    expect(await verifyPortalCompanyGateway('token')).toEqual({ ok: false, status: 403 });
  });
  it.each([{ type: 'org', sub: 'subject' }, { type: 'warp', sub: 'subject' },
    { sub: 'subject' }, { type: 'app', sub: '' }, { type: 'app', sub: ' ' },
    { type: 'app', sub: 5 }])('requires an application token and individual Cloudflare subject', async value => {
    mocks.verify.mockResolvedValue({ ...value, exp: 9999999999, custom });
    expect(await verifyPortalCompanyGateway('token')).toEqual({ ok: false, status: 403 });
  });
  it.each([
    { mode: undefined }, { mode: 'other' }, { companies: config.companies },
    { organizations: [] }, { organizations: [{ orgId, enabled: 'true' }] },
    { organizations: [{ orgId, enabled: true }, { orgId, enabled: false }] },
    { organizations: [{ orgId, enabled: true, subject: 'unexpected' }] },
  ])('rejects ambiguous or malformed operator configuration', async overrides => {
    configure({ ...claimConfig, ...overrides });
    expect(await verifyPortalCompanyGateway('token')).toEqual({ ok: false, status: 503 });
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it('does not use custom claims as a fallback in subject mapping mode', async () => {
    configure(config);
    expect(await verifyPortalCompanyGateway('token')).toEqual({ ok: false, status: 403 });
  });
});
