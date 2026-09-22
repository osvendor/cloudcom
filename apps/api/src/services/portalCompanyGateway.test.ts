import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('./cfAccessJwt', async original => ({
  ...await original<typeof import('./cfAccessJwt')>(), verifyCfAccessJwt: mocks.verify,
}));
import { CfAccessJwksUnavailableError } from './cfAccessJwt';
import { checkPortalCompanyGateway, verifyPortalCompanyGateway } from './portalCompanyGateway';

const orgId = '11111111-1111-4111-8111-111111111111';
const otherOrg = '22222222-2222-4222-8222-222222222222';
const config = { teamDomain: 'test-team.cloudflareaccess.com', audience: 'remote-app',
  companies: [{ subject: 'company-subject', orgId, enabled: true }] };
function configure(value: unknown = config) {
  vi.stubEnv('CLOUDCOM_COMPANY_GATEWAY_CONFIG', JSON.stringify(value));
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('CLOUDCOM_COMPANY_GATEWAY_ENABLED', 'true'); configure();
  mocks.verify.mockResolvedValue({ sub: 'company-subject', email: 'company@example.test',
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
