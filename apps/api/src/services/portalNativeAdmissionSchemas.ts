import { z } from 'zod';
export const nativeAdmissionEnabled = () => process.env.CLOUDCOM_NATIVE_ADMISSION_ENABLED === 'true';
export const nativeUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export function nativeBytes(length: number) {
  return z.string().max(Math.ceil(length * 4 / 3)).refine(value => {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === length && bytes.toString('base64url') === value;
  });
}
export const targetEnrollmentSchema = z.object({ version: z.literal(2), installationId: nativeUuid,
  targetPublicKey: nativeBytes(32), targetCredential: nativeBytes(32), rustdeskId: z.string().regex(/^[0-9]{1,32}$/),
}).strict();
export const targetRotationSchema = targetEnrollmentSchema.extend({ expectedGeneration: z.number().int().positive().max(2147483646) }).strict();
export const nativeIssueSchema = z.object({ version: z.literal(2), deviceId: nativeUuid, operatorPublicKey: nativeBytes(32) }).strict();
export const nativeConsumeSchema = z.object({ version: z.literal(2), sessionId: nativeUuid, ticket: nativeBytes(32),
  connectionId: nativeUuid, targetChallenge: nativeBytes(32), channelBinding: nativeBytes(32), operatorSignature: nativeBytes(64),
}).strict();
export const nativePresenceSchema = z.object({ version: z.literal(2), connectionId: nativeUuid }).strict();
export const nativeRenewSchema = nativePresenceSchema.extend({ leaseToken: nativeBytes(32) }).strict();
export type NativeEnrollment = z.infer<typeof targetEnrollmentSchema>;
export type NativeConsume = z.infer<typeof nativeConsumeSchema>;
export type NativeOperator = { id: string; orgId: string; authEpoch: number; sessionHash: string; expiresAt: number };
export type NativeTarget = { id: string; orgId: string; deviceId: string; generation: number; credentialHash: string };
export class NativeAdmissionError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 503) { super('Native admission unavailable'); }
}
