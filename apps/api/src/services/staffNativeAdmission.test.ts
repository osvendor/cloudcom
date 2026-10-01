import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rows: [] as unknown[][], changes: [] as unknown[],
  lock: vi.fn(), load: vi.fn(), authority: vi.fn(), prompt: vi.fn(), policy: vi.fn(),
}));
vi.mock('../db', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ for: async () => mocks.rows.shift() ?? [], limit: async () => mocks.rows.shift() ?? [] }),
    innerJoin: () => ({ where: () => ({ limit: async () => mocks.rows.shift() ?? [] }) }),
  }) }),
  update: () => ({ set: (value: unknown) => ({ where: async () => { mocks.changes.push(value); } }) }),
  insert: () => ({ values: (value: unknown) => ({ returning: async () => { mocks.changes.push(value); return [{ id: '11111111-1111-4111-8111-111111111111' }]; } }) }),
} }));
vi.mock('./portalNativeTarget', () => ({ requireNativeContext: () => {}, lockNativeTarget: mocks.lock }));
vi.mock('./staffNativeLogin', () => ({ loadStaffNativeSession: mocks.load, staffNativeEnabled: () => true }));
vi.mock('./staffNativeAuthority', () => ({ authorizeStaffNativeDevice: mocks.authority }));
vi.mock('../routes/remote/helpers', () => ({ resolveRemoteSessionPromptConfig: mocks.prompt }));
vi.mock('./remoteAccessPolicy', () => ({ resolveDesktopSessionPolicy: mocks.policy }));
import { consumeStaffNativeAdmission, renewStaffNativeAdmission, touchStaffNativePresence, endStaffNativeAdmission } from './staffNativeAdmission';
import { encodeNativeAdmissionV2, hashNativeTicket } from './portalNativeProof';
const id = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const dev = '33333333-3333-4333-8333-333333333333';
const uid = '44444444-4444-4444-8444-444444444444';
const b = () => randomBytes(32).toString('base64url');
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
const target = { id, orgId: org, deviceId: dev, generation: 1, credentialHash: b() };
let session: any, input: any, lease: string;
beforeEach(() => {
  vi.clearAllMocks(); mocks.changes = []; lease = b(); const ticket = b();
  session = { id, orgId: org, deviceId: dev, staffUserId: uid, targetId: id, targetGeneration: 1,
    operatorSessionHash: b(), targetPublicKey: b(), operatorPublicKey: publicKey, status: 'pending',
    hardDeadline: new Date(Date.now() + 300_000), createdAt: new Date(), endedAt: null,
    ticketHash: hashNativeTicket(ticket), ticketExpiresAt: new Date(Date.now() + 45_000), consumedAt: null,
    connectionId: id, leaseHash: hashNativeTicket(lease), leaseExpiresAt: new Date(Date.now() + 50_000),
    leaseRevision: 1, presenceUntil: new Date(Date.now() + 45_000) };
  const binding = { orgId: org, deviceId: dev, sessionId: id, connectionId: id, targetGeneration: 1,
    ticketHash: session.ticketHash, targetChallenge: b(), operatorPublicKey: publicKey,
    targetPublicKey: session.targetPublicKey, channelBinding: b() };
  input = { version: 2, sessionId: id, connectionId: id, ticket, targetChallenge: binding.targetChallenge,
    channelBinding: binding.channelBinding, operatorSignature: sign(null, encodeNativeAdmissionV2(binding), keys.privateKey).toString('base64url') };
  mocks.rows = [[session]]; mocks.lock.mockResolvedValue(target);
  mocks.load.mockResolvedValue({ userId: uid, expiresAt: Date.now() + 300_000 });
  mocks.authority.mockResolvedValue({ device: { id: dev, orgId: org } });
  mocks.prompt.mockResolvedValue({ mode: 'off' }); mocks.policy.mockResolvedValue({ maxSessionDurationHours: 1, idleTimeoutMinutes: 5 });
});
afterEach(() => vi.unstubAllEnvs());
describe('staff native bounded lease and cryptographic admission', () => {
  it('requires a real v2 proof and returns a bounded lease', async () => {
    const result = await consumeStaffNativeAdmission(target, input);
    expect(result).toMatchObject({ version: 2, revision: 1, graceSec: 0, deviceId: dev });
    expect(result.ttlMs).toBeLessThanOrEqual(45_000);
    expect(mocks.changes[0]).toMatchObject({ status: 'active', leaseRevision: 1 });
  });
  it.each(['channelBinding', 'targetChallenge', 'ticket'])('rejects altered %s without updating', async field => {
    await expect(consumeStaffNativeAdmission(target, { ...input, [field]: b() })).rejects.toThrow();
    expect(mocks.changes).toEqual([]);
  });
  it.each([{ status: 'active' }, { consumedAt: new Date() }, { ticketExpiresAt: new Date(0) },
    { targetGeneration: 2 }, { endedAt: new Date() }, { hardDeadline: new Date(0) },
    { presenceUntil: new Date(0) }])('denies replay, expiry or rotation %j', async change => {
    Object.assign(session, change);
    await expect(consumeStaffNativeAdmission(target, input)).rejects.toThrow();
    expect(mocks.changes).toEqual([]);
  });
  it('denies a different staff identity attached to the login', async () => {
    mocks.load.mockResolvedValue({ userId: dev });
    await expect(consumeStaffNativeAdmission(target, input)).rejects.toThrow();
  });
  it('cannot bypass endpoint consent', async () => {
    mocks.prompt.mockResolvedValue({ mode: 'consent' });
    await expect(consumeStaffNativeAdmission(target, input)).rejects.toThrow();
  });
  it('rechecks permission and logout during renewal', async () => {
    session.status = 'active'; mocks.authority.mockRejectedValue(new Error('revoked'));
    await expect(renewStaffNativeAdmission(target, id, id, lease)).rejects.toThrow();
    expect(mocks.changes).toEqual([]);
  });
  it('rejects the wrong lease or connection', async () => {
    session.status = 'active';
    await expect(renewStaffNativeAdmission(target, id, id, b())).rejects.toThrow();
    mocks.rows = [[session]];
    await expect(renewStaffNativeAdmission(target, id, dev, lease)).rejects.toThrow();
  });
  it('increments revision on valid renewal', async () => {
    session.status = 'active';
    expect(await renewStaffNativeAdmission(target, id, id, lease)).toMatchObject({ revision: 2 });
  });
  it('denies presence/end when the owned-session lookup finds no row', async () => {
    mocks.rows = [[], []]; const operator = { principal: { userId: uid }, sessionHash: b() } as any;
    await expect(touchStaffNativePresence(operator, id, id)).rejects.toThrow();
    await expect(endStaffNativeAdmission(operator, id)).rejects.toThrow();
  });
});
