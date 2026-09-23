import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeNativeAdmissionV2, verifyNativeAdmissionProofV2, encodeNativeAdmission, hashNativeTicket, verifyNativeAdmissionProof, type NativeAdmissionBinding } from './portalNativeProof';

const key = generateKeyPairSync('ed25519');
const rawKey = key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
const bytes = (value: number) => Buffer.alloc(32, value).toString('base64url');
const binding = (): NativeAdmissionBinding => ({
  orgId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  connectionId: '44444444-4444-4444-8444-444444444444',
  targetGeneration: 1, ticketHash: bytes(5), targetChallenge: bytes(6),
  operatorPublicKey: rawKey, targetPublicKey: bytes(8),
});

describe('native admission proof', () => {
  it('verifies only the key which signed the exact connection binding', () => {
    const value = binding();
    const signature = sign(null, encodeNativeAdmission(value), key.privateKey).toString('base64url');
    expect(verifyNativeAdmissionProof(value, signature)).toBe(true);
    const changes: Partial<NativeAdmissionBinding>[] = [
      { orgId: value.deviceId }, { deviceId: value.orgId },
      { sessionId: value.connectionId }, { connectionId: value.sessionId },
      { targetGeneration: 2 }, { ticketHash: bytes(9) }, { targetChallenge: bytes(9) },
      { operatorPublicKey: bytes(9) }, { targetPublicKey: bytes(9) },
    ];
    for (const change of changes) {
      expect(verifyNativeAdmissionProof({ ...value, ...change }, signature)).toBe(false);
    }
    const other = generateKeyPairSync('ed25519');
    expect(verifyNativeAdmissionProof(value,
      sign(null, encodeNativeAdmission(value), other.privateKey).toString('base64url'))).toBe(false);
  });

  it('rejects malformed signatures, ambiguous encodings and unsafe generations', () => {
    const value = binding();
    const signature = sign(null, encodeNativeAdmission(value), key.privateKey).toString('base64url');
    for (const bad of ['', signature + '=', signature.slice(1), bytes(1), '!'.repeat(86)]) {
      expect(verifyNativeAdmissionProof(value, bad)).toBe(false);
    }
    for (const targetGeneration of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(verifyNativeAdmissionProof({ ...value, targetGeneration }, signature)).toBe(false);
    }
    for (const ticketHash of [bytes(5) + '=', bytes(5).slice(1), '\n' + bytes(5)]) {
      expect(verifyNativeAdmissionProof({ ...value, ticketHash }, signature)).toBe(false);
    }
    for (const orgId of ['', '00000000-0000-0000-0000-000000000000', value.orgId + '\n']) {
      expect(verifyNativeAdmissionProof({ ...value, orgId }, signature)).toBe(false);
    }
  });

  it('has an unambiguous cross-language wire layout', () => {
    const wire = encodeNativeAdmission({ ...binding(), operatorPublicKey: bytes(7) });
    expect(wire.subarray(0, 29).toString('ascii')).toBe('CloudCom/native/admission/v1\0');
    expect(wire.length).toBe(229);
    expect(wire.subarray(29, 45).toString('hex')).toBe('11111111111141118111111111111111');
    expect(wire.readBigUInt64BE(93)).toBe(1n);
    expect(wire.subarray(101)).toEqual(Buffer.concat([Buffer.alloc(32, 5), Buffer.alloc(32, 6), Buffer.alloc(32, 7), Buffer.alloc(32, 8)]));
  });

  it('hashes exactly 256-bit opaque tickets without accepting aliases', () => {
    expect(hashNativeTicket(bytes(0))).toBe('Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU');
    for (const bad of ['', bytes(0) + '=', bytes(0).slice(1), '!'.repeat(43)]) {
      expect(() => hashNativeTicket(bad)).toThrow();
    }
  });
});


describe('native admission v2 authenticated TCP binding', () => {
  it('appends the exact exporter under a new domain and rejects v1 or channel substitution', () => {
    const value = { ...binding(), channelBinding: bytes(9) };
    const encoded = encodeNativeAdmissionV2(value);
    const signature = sign(null, encoded, key.privateKey).toString('base64url');
    expect(encoded.length).toBe(261);
    expect(encoded.subarray(0,29).toString('ascii')).toBe('CloudCom/native/admission/v2\0');
    expect(encoded.subarray(229)).toEqual(Buffer.alloc(32,9));
    expect(verifyNativeAdmissionProofV2(value,signature)).toBe(true);
    expect(verifyNativeAdmissionProofV2({ ...value,channelBinding:bytes(10) },signature)).toBe(false);
    expect(verifyNativeAdmissionProofV2(value,sign(null,encodeNativeAdmission(value),key.privateKey).toString('base64url'))).toBe(false);
    const fixed = encodeNativeAdmissionV2({ ...binding(),operatorPublicKey:bytes(7),channelBinding:bytes(9) });
    expect(fixed.toString('hex')).toBe(Buffer.concat([
      Buffer.from('CloudCom/native/admission/v2\0','ascii'),
      Buffer.from('111111111111411181111111111111112222222222224222822222222222222233333333333343338333333333333333444444444444444484444444444444440000000000000001','hex'),
      ...[5,6,7,8,9].map(value => Buffer.alloc(32,value)),
    ]).toString('hex'));
  });
});
