import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ExtensionRuntimeContext, ExtensionRequestAuthorization } from '@breeze/extension-sdk';
import type { DurableAudit, CompanionAuthorize } from './index';
import { unseal } from './secrets';
import { generateTotp } from './totp';

type Auth = { scope: string; principal: { kind: string }; partnerId: string | null; user: { id: string }; canAccessOrg(id: string): boolean };
type Variables = { auth: Auth; extensionAuthorization: ExtensionRequestAuthorization; browserOrg: string };
const uuid = z.string().uuid();
const rows = <T>(result: unknown): T[] => { if (!Array.isArray(result)) throw new Error('Invalid result'); return result; };
export function websiteOrigin(value: string): string | null {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null; } catch { return null; }
}
/** Staff browser companion; existing session, RBAC, RLS and disclosure audit remain authoritative. */
export function createBrowserCompanionRoutes(context: ExtensionRuntimeContext, audit: DurableAudit, companionAuthorize?: CompanionAuthorize) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const a = c.get('auth'), p = c.get('extensionAuthorization');
    if (!a || !p) return c.json({ error: 'Sign in to Breeze' }, 401);
    if (a.scope !== 'partner' || a.principal?.kind !== 'user_session' || !a.partnerId || p.allowedSiteIds !== undefined || !p.mfaSatisfied) return c.json({ error: 'Verified staff access required' }, 403);
    await next();
  });
  app.post('/authorize',async c=>{
    if(!companionAuthorize)return c.json({error:'Companion sign-in unavailable'},503);
    return c.json(await companionAuthorize(c.get('auth'),await c.req.json()));
  });
  app.use('/orgs/:orgId/*', async(c,next)=>{
    const a=c.get('auth');
    const orgValue = c.req.param('orgId');
    {
      const org = uuid.safeParse(orgValue);
      if (!org.success || !a.canAccessOrg(org.data)) return c.json({ error: 'Client unavailable' }, 404);
      const client = rows(await context.db.execute(sql`SELECT o.id FROM organizations o JOIN partners p ON p.id=o.partner_id WHERE o.id=${org.data}::uuid AND o.partner_id=${a.partnerId}::uuid AND o.deleted_at IS NULL AND o.status IN ('active','trial') AND p.deleted_at IS NULL AND p.status='active'`));
      if (!client.length) return c.json({ error: 'Client unavailable' }, 404);
      c.set('browserOrg', org.data);
    }
    await next();
  });
  app.get('/clients', async c => {
    const a = c.get('auth'), p = c.get('extensionAuthorization');
    if (!p.hasPermission('credentials', 'read') && !p.hasPermission('devices', 'read')) return c.json({ error: 'Access denied' }, 403);
    const clients = rows<{ id: string; name: string }>(await context.db.execute(sql`SELECT o.id,o.name FROM organizations o JOIN partners p ON p.id=o.partner_id WHERE o.partner_id=${a.partnerId}::uuid AND o.deleted_at IS NULL AND o.status IN ('active','trial') AND p.deleted_at IS NULL AND p.status='active' ORDER BY o.name,o.id LIMIT 1001`)).filter(x => a.canAccessOrg(x.id));
    return c.json({ clients: clients.slice(0,1000), truncated: clients.length > 1000 });
  });
  app.get('/orgs/:orgId/devices', async c => {
    const p = c.get('extensionAuthorization');
    if (!p.hasPermission('devices','read')) return c.json({ error: 'Access denied' }, 403);
    const q = c.req.query('q') ?? ''; if (q.length > 200) return c.json({ error: 'Search too long' }, 400);
    const pattern = `%${q.replace(/[\\%_]/g,'\\$&')}%`;
    const devices = rows(await context.db.execute(sql`SELECT d.id,d.hostname,d.display_name AS "displayName",u.observed_user AS "currentUser",u.last_user AS "lastUser",d.status,d.os_type AS "osType"
      FROM devices d
      LEFT JOIN LATERAL (SELECT s.username FROM device_sessions s WHERE s.device_id=d.id AND s.org_id=d.org_id AND NULLIF(BTRIM(s.username),'') IS NOT NULL ORDER BY s.login_at DESC,s.id DESC LIMIT 1) history ON true
      CROSS JOIN LATERAL (SELECT
        CASE WHEN d.status='online' AND d.last_seen_at > now()-interval '5 minutes' THEN NULLIF(BTRIM(d.last_user),'') ELSE NULL END AS observed_user,
        COALESCE(history.username,NULLIF(BTRIM(d.last_user),'')) AS last_user) u
      WHERE d.org_id=${c.get('browserOrg')}::uuid AND d.status NOT IN ('decommissioned','quarantined')
      AND (d.hostname ILIKE ${pattern} OR d.display_name ILIKE ${pattern} OR u.observed_user ILIKE ${pattern} OR u.last_user ILIKE ${pattern}) ORDER BY d.hostname,d.id LIMIT 101`));
    return c.json({ devices: devices.slice(0,100), truncated: devices.length>100, canRemote: p.hasPermission('remote','access'), canTools: p.hasPermission('devices','execute') });
  });
  app.get('/orgs/:orgId/credentials', async c => {
    if (!c.get('extensionAuthorization').hasPermission('credentials','read')) return c.json({ error:'Access denied' },403);
    const origin = websiteOrigin(c.req.query('origin') ?? ''), q = c.req.query('q') ?? '';
    if (!origin || q.length>200) return c.json({error:'A secure website is required'},400);
    // Bound query without global credential search; exact scheme/host/port matching.
    const found = rows<{url:string;name:string;username:string;email:string}>(await context.db.execute(sql`SELECT id,name,username,email,url,has_password AS "hasPassword",has_otp AS "hasOtp" FROM credentials_records WHERE org_id=${c.get('browserOrg')}::uuid AND archived=false ORDER BY name,id LIMIT 2001`));
    const credentials = found.slice(0,2000).filter(x=>websiteOrigin(x.url)===origin && `${x.name} ${x.username} ${x.email}`.toLowerCase().includes(q.toLowerCase()));
    return c.json({credentials:credentials.slice(0,100),truncated:found.length>2000 || credentials.length>100});
  });
  app.post('/orgs/:orgId/credentials/:id/fill', async c => {
    const p = c.get('extensionAuthorization'), id = uuid.safeParse(c.req.param('id'));
    const input = z.object({origin:z.string().max(2048),field:z.enum(['username','password','otp'])}).strict().safeParse(await c.req.json().catch(()=>null));
    if (!input.success || !id.success || websiteOrigin(input.data.origin)!==input.data.origin) return c.json({error:'Invalid fill request'},400);
    const {origin,field}=input.data;
    if (!p.hasPermission('credentials','read') || !p.hasPermission('credentials',field==='otp'?'otp':'reveal')) return c.json({error:'Access denied'},403);
    const orgId=c.get('browserOrg');
    const record=rows<{url:string;username:string;email:string;secret_ciphertext:string}>(await context.db.execute(sql`SELECT url,username,email,secret_ciphertext FROM credentials_records WHERE org_id=${orgId}::uuid AND id=${id.data}::uuid AND archived=false`))[0];
    if (!record || websiteOrigin(record.url)!==origin) return c.json({error:'Credential does not match this website'},404);
    let value=record.username || record.email || '', expiresAt:string|undefined;
    if(field!=='username') { const secret=unseal(context.secrets,orgId,id.data,record.secret_ciphertext); if(field==='password')value=secret.password;else {if(!secret.otpSecret)return c.json({error:'No OTP available'},404);const otp=generateTotp(secret.otpSecret);value=otp.code;expiresAt=otp.expiresAt;} }
    if(!value)return c.json({error:'No value available'},404);
    await audit({orgId,actorId:c.get('auth').user.id,actorType:'user',action:'credentials.browser.fill',resourceType:'credential',resourceId:id.data,result:'success',details:{field}});
    return c.json({value,...(expiresAt?{expiresAt}:{})});
  });
  return app;
}
