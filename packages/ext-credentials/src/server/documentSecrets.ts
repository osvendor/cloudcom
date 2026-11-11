import { z } from 'zod';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const documentPayloadSchema = z.object({
  version: z.literal(1),
  originalBase64: z.string().max(Math.ceil(DOCUMENT_MAX_BYTES / 3) * 4),
  sheets: z.array(z.object({
    name: z.string().max(255),
    rows: z.array(z.object({ row: z.number().int().min(1), cells: z.array(z.object({ column: z.string().regex(/^[A-Z]{1,4}$/), text: z.string().max(200_000) }).strict()).max(16384) }).strict()).max(100_000),
    imageCount: z.number().int().min(0).max(100_000),
  }).strict()).max(1000),
  previewTruncated: z.boolean(),
}).strict();
export type DocumentPayload = z.infer<typeof documentPayloadSchema>;
type Crypto = ExtensionRuntimeContext['secrets'];
const fail = (): never => { throw new Error('document_encryption_unavailable'); };
function validate(value: unknown): DocumentPayload {
  const result = documentPayloadSchema.parse(value);
  const original = Buffer.from(result.originalBase64, 'base64');
  if (!original.length || original.length > DOCUMENT_MAX_BYTES || original.toString('base64') !== result.originalBase64) return fail();
  if (Buffer.byteLength(JSON.stringify({ sheets: result.sheets, previewTruncated: result.previewTruncated })) > DOCUMENT_PREVIEW_MAX_BYTES) return fail();
  return result;
}
// Both the authenticated column AAD and plaintext envelope bind each row; the
// registry uses the same payload_ciphertext:<id> convention during key rotation.
export function sealDocument(crypto: Crypto, orgId: string, id: string, value: DocumentPayload): string {
  const payload = validate(value);
  const sealed = crypto.encryptForColumn('credentials_documents', `payload_ciphertext:${id}`, JSON.stringify({ orgId, id, payload }));
  if (!sealed.startsWith('enc:v3:')) return fail();
  return sealed;
}
export function unsealDocument(crypto: Crypto, orgId: string, id: string, ciphertext: string): DocumentPayload {
  try {
    if (!ciphertext.startsWith('enc:v3:')) return fail();
    const value = JSON.parse(crypto.decryptForColumn('credentials_documents', `payload_ciphertext:${id}`, ciphertext));
    if (value.orgId !== orgId || value.id !== id) return fail();
    return validate(value.payload);
  } catch { return fail(); }
}
