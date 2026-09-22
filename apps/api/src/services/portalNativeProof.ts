import { createHash, createPublicKey, verify } from 'node:crypto';

const DOMAIN = Buffer.from('CloudCom/native/admission/v1\0', 'ascii');
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type NativeAdmissionBinding = {
  orgId: string;
  deviceId: string;
  sessionId: string;
  connectionId: string;
  targetGeneration: number;
  ticketHash: string;
  targetChallenge: string;
  operatorPublicKey: string;
  targetPublicKey: string;
};

function uuidBytes(value: string): Buffer {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid native binding');
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function fixedBytes(value: string, length: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid native proof encoding');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) {
    throw new Error('Invalid native proof encoding');
  }
  return bytes;
}

/** Fixed-width, domain-separated bytes shared with the managed native client. */
export function encodeNativeAdmission(binding: NativeAdmissionBinding): Buffer {
  if (!Number.isSafeInteger(binding.targetGeneration) || binding.targetGeneration < 1) {
    throw new Error('Invalid native target generation');
  }
  const generation = Buffer.alloc(8);
  generation.writeBigUInt64BE(BigInt(binding.targetGeneration));
  return Buffer.concat([
    DOMAIN, uuidBytes(binding.orgId), uuidBytes(binding.deviceId),
    uuidBytes(binding.sessionId), uuidBytes(binding.connectionId), generation,
    fixedBytes(binding.ticketHash, 32), fixedBytes(binding.targetChallenge, 32),
    fixedBytes(binding.operatorPublicKey, 32), fixedBytes(binding.targetPublicKey, 32),
  ]);
}

/**
 * This verifies possession only. Callers must independently authenticate the
 * target, atomically consume the ticket and recheck the live account assignment.
 * Never accept binding fields from the operator in place of the stored values.
 */
export function verifyNativeAdmissionProof(binding: NativeAdmissionBinding, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI, fixedBytes(binding.operatorPublicKey, 32)]),
      format: 'der', type: 'spki',
    });
    return verify(null, encodeNativeAdmission(binding), key, fixedBytes(signature, 64));
  } catch {
    return false;
  }
}

export function hashNativeTicket(ticket: string): string {
  return createHash('sha256').update(fixedBytes(ticket, 32)).digest('base64url');
}
