import { describe, expect, it } from 'vitest';
import { readCippDeployment } from './cipp-config';
const env = { CLOUDCOM_CIPP_ENABLED: 'true', CLOUDCOM_CIPP_ORIGIN: 'https://cipp.example.test',
  CLOUDCOM_CIPP_PARTNER_ID: '11111111-1111-4111-8111-111111111111',
  CLOUDCOM_CIPP_AUTH_TENANT_ID: '22222222-2222-4222-8222-222222222222',
  CLOUDCOM_CIPP_CLIENT_ID: '33333333-3333-4333-8333-333333333333',
  CLOUDCOM_CIPP_CLIENT_SECRET: 'fixture', CLOUDCOM_CIPP_SCOPE: 'api://33333333-3333-4333-8333-333333333333/.default' };
describe('deployment-owned CIPP configuration', () => {
  it('is default off and fails closed on partial configuration', () => {
    expect(readCippDeployment({})).toBeNull();
    expect(readCippDeployment({ ...env, CLOUDCOM_CIPP_CLIENT_SECRET: '' })).toBeNull();
  });
  it.each(['http://cipp.example.test', 'https://user:pass@cipp.example.test', 'https://cipp.example.test/api', 'https://cipp.example.test/?token=a'])('rejects unsafe origin %s', origin => {
    expect(readCippDeployment({ ...env, CLOUDCOM_CIPP_ORIGIN: origin })).toBeNull();
  });
  it('binds mapping to backend identity while permitting a secret rotation', () => {
    const config = readCippDeployment(env)!;
    expect(config.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(readCippDeployment({ ...env, CLOUDCOM_CIPP_CLIENT_SECRET: 'rotated' })!.identity).toBe(config.identity);
    expect(readCippDeployment({ ...env, CLOUDCOM_CIPP_ORIGIN: 'https://replacement.example.test' })!.identity).not.toBe(config.identity);
  });
});
