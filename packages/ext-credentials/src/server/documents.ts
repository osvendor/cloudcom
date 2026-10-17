import { createHash } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ExtensionRuntimeContext, ExtensionRequestAuthorization } from '@breeze/extension-sdk';
import type { DurableAudit } from './index';
import { unsealDocument } from './documentSecrets';
import { extractDocumentImages } from './documentImages';

type Auth = { user: { id: string }; partnerId: string | null; canAccessOrg(id: string): boolean };
type Variables = { auth: Auth; extensionAuthorization: ExtensionRequestAuthorization; documentOrgId: string };
type Metadata = { id: string; name: string; filename: string; mimeType: string; sourceOrganization: string; sourceId: string; sha256: string; sizeBytes: number; sheetCount: number; createdAt: string };
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const rows = <T>(result: unknown): T[] => { if (!Array.isArray(result)) throw new Error('Invalid document result'); return result; };
const metadata = sql`id,name,filename,mime_type AS "mimeType",source_organization AS "sourceOrganization",source_id AS "sourceId",sha256,size_bytes AS "sizeBytes",sheet_count AS "sheetCount",created_at AS "createdAt"`;
export function createDocumentRoutes(context: ExtensionRuntimeContext, audit: DurableAudit) {
  const app = new Hono<{ Variables: Variables }>();
  // Scoped middleware only: sibling credential routes retain their own policy.
  const authorize: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    const auth = c.get('auth'), permissions = c.get('extensionAuthorization');
    if (!auth || !permissions) return c.json({ error: 'Authentication required' }, 401);
    const org = uuid.safeParse(c.req.param('orgId'));
    if (!org.success) return c.json({ error: 'Client unavailable' }, 404);
    if (!auth.canAccessOrg(org.data) || permissions.allowedSiteIds !== undefined || !permissions.hasPermission('credentials', 'read')) return c.json({ error: 'Access denied' }, 403);
    if (c.req.param('id') && (!permissions.hasPermission('credentials', 'reveal') || !permissions.mfaSatisfied)) return c.json({ error: 'Credential permission and account verification required' }, 403);
    const client = rows<{ partner_id: string }>(await context.db.execute(sql`SELECT o.partner_id FROM organizations o JOIN partners p ON p.id=o.partner_id WHERE o.id=${org.data}::uuid AND o.deleted_at IS NULL AND o.status IN ('active','trial') AND p.deleted_at IS NULL AND p.status='active'`))[0];
    if (!client || (auth.partnerId && auth.partnerId !== client.partner_id)) return c.json({ error: 'Client unavailable' }, 404);
    c.set('documentOrgId', org.data); await next();
  };
  app.onError(() => { context.log('error', 'Document operation failed'); return new Response(JSON.stringify({ error: 'Unable to complete document operation' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); });
  app.get('/orgs/:orgId/documents', authorize, async c => {
    const query = c.req.query('q') ?? '';
    if (query.length > 200) return c.json({ error: 'Search is too long' }, 400);
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const documents = rows(await context.db.execute(sql`SELECT ${metadata} FROM credentials_documents WHERE org_id=${c.get('documentOrgId')}::uuid AND (name ILIKE ${pattern} OR filename ILIKE ${pattern}) ORDER BY name,id LIMIT 500`));
    return c.json({ documents });
  });
  for (const download of [false, true]) app.get(`/orgs/:orgId/documents/:id${download ? '/download' : ''}`, authorize, async c => {
    const id = uuid.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Document unavailable' }, 404);
    const orgId = c.get('documentOrgId');
    const found = rows<Metadata & { payload_ciphertext: string }>(await context.db.execute(sql`SELECT ${metadata},payload_ciphertext FROM credentials_documents WHERE org_id=${orgId}::uuid AND id=${id.data}::uuid`))[0];
    if (!found) return c.json({ error: 'Document unavailable' }, 404);
    const payload = unsealDocument(context.secrets, orgId, id.data, found.payload_ciphertext);
    const original = Buffer.from(payload.originalBase64, 'base64');
    if (original.length !== found.sizeBytes || createHash('sha256').update(original).digest('hex') !== found.sha256 || payload.sheets.length !== found.sheetCount) throw new Error('Document integrity unavailable');
    await audit({ orgId, actorId: c.get('auth').user.id, actorType: 'user', action: download ? 'credentials.document.download' : 'credentials.document.read', resourceType: 'credential_document', resourceId: id.data, result: 'success', details: {} });
    if (download) {
      // A fixed safe fallback plus encoded original name avoids header injection.
      const safeName = found.filename.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 255);
      c.header('Content-Disposition', `attachment; filename="document.xlsx"; filename*=UTF-8''${encodeURIComponent(safeName).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`);
      c.header('Content-Type', 'application/octet-stream');
      return c.body(new Uint8Array(original));
    }
    const { payload_ciphertext: _ciphertext, ...document } = found;
    const images = extractDocumentImages(original, payload.sheets);
    return c.json({ document, sheets: payload.sheets.map((sheet, index) => ({ ...sheet, ...images[index] })), previewTruncated: payload.previewTruncated });
  });
  return app;
}
