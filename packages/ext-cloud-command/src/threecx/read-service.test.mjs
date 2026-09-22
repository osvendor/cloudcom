import test from 'node:test';
import assert from 'node:assert/strict';
import { createThreeCxReadService, normalizePbxOrigin, publicConnection } from './read-service.mjs';
const org = '11111111-1111-4111-8111-111111111111';
const partner = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const scope = { organizationId: org, partnerId: partner, actorId: 'test-actor' };
const connection = { id, organizationId: org, partnerId: partner, enabled: true, origin: 'https://pbx.example.com:5001', credentialRef: 'secret-ref', departmentId: 7 };
function fixture(overrides = {}) {
  const calls = [];
  const ports = {
    authorize: async () => { calls.push('authorize'); return true; },
    loadConnection: async () => { calls.push('load'); return connection; },
    readUsers: async input => { calls.push(input); return { value: [] }; }, ...overrides,
  };
  return { service: createThreeCxReadService(ports), calls };
}
test('rejects denied actors before lookup or provider access', async () => {
  const { service, calls } = fixture({ authorize: async () => false });
  await assert.rejects(service.listExtensions(scope, id), { code: 'access_denied' }); assert.deepEqual(calls, []);
});
test('rejects cross-org, cross-partner, wrong connection and disabled records', async () => {
  for (const changed of [{ organizationId: partner }, { partnerId: org }, { id: org }, { enabled: false }]) {
    const { service, calls } = fixture({ loadConnection: async () => ({ ...connection, ...changed }) });
    await assert.rejects(service.listExtensions(scope, id), { code: 'not_available' }); assert.equal(calls.length, 1);
  }
});
test('filters departments, strips extra fields and ignores external nextLink', async () => {
  const { service } = fixture({ readUsers: async () => ({ value: [
    { Id: 1, Number: '100', Groups: [{ GroupId: 7 }], Password: 'never-return' },
    { Id: 2, Number: '200', Groups: [{ GroupId: 8 }] },
  ], '@odata.nextLink': 'https://untrusted.example/steal' }) });
  const result = await service.listExtensions(scope, id);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].Password, undefined); assert.equal(result.items[0].Groups, undefined); assert.equal(result.nextSkip, 100);
});
test('empty filtered page still advances when raw page has more data', async () => {
  const { service } = fixture({ readUsers: async () => ({ value: Array.from({ length: 100 }, (_, i) => ({ Id: i, Number: String(i), Groups: [{ GroupId: 8 }] })) }) });
  const result = await service.listExtensions(scope, id, 100);
  assert.deepEqual(result.items, []); assert.equal(result.nextSkip, 200);
});
test('missing department membership fails closed', async () => {
  const { service } = fixture({ readUsers: async () => ({ value: [{ Id: 1, Number: '100' }] }) });
  await assert.rejects(service.listExtensions(scope, id), { code: 'invalid_provider_response' });
});
test('rejects invalid pagination before any port is called', async () => {
  const { service, calls } = fixture();
  for (const skip of [-1, 1, '100', 100100, NaN]) await assert.rejects(service.listExtensions(scope, id, skip), { code: 'invalid_page' });
  assert.deepEqual(calls, []);
});
test('provider exceptions do not leak credentials', async () => {
  const { service } = fixture({ readUsers: async () => { throw Error('secret-token'); } });
  await assert.rejects(service.listExtensions(scope, id), e => e.message === 'provider_read_failed' && !e.cause);
});
test('accepts HTTPS custom port but rejects embedded credentials, paths and non-HTTPS', () => {
  assert.equal(normalizePbxOrigin('https://pbx.example.com:5001/'), 'https://pbx.example.com:5001');
  for (const origin of ['http://pbx.example.com', 'https://user:secret@pbx.example.com', 'https://pbx.example.com/xapi', 'https://pbx.example.com?secret=x']) assert.throws(() => normalizePbxOrigin(origin));
  assert.equal(publicConnection({ ...connection, secret: 'never-return' }).secret, undefined);
  assert.equal(publicConnection(connection).credentialRef, undefined);
});
