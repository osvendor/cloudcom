import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and,eq } from 'drizzle-orm';
import { db,withDbAccessContext } from '../db';
import { devices,remoteSessions } from '../db/schema';
import { computeAccessibleOrgIds } from '../middleware/auth';
import { ipAllowlistGuard } from '../middleware/ipAllowlistGuard';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp,rateLimitIpKey } from '../services/clientIp';
import { companionIds,exchangeBrowserCompanion,authenticateBrowserCompanion,endBrowserCompanion,companionDispatchToken } from '../services/browserCompanionSession';
import { companionCallSchema,classifyCompanionCall } from '../services/browserCompanionPolicy';
import { canAccessOrg } from '../services/permissions';
import { getActiveOrgTenant } from '../services/tenantStatus';

export function createBrowserCompanionTransport(dispatch:(request:Request,env:Record<string,unknown>)=>Promise<Response>){
  const app=new Hono();
  app.use('*',bodyLimit({maxSize:8*1024*1024}));
  app.use('*',async(c,next)=>{
    c.header('Cache-Control','no-store');
    const origin=c.req.header('Origin')??'';
    const id=origin.match(/^chrome-extension:\/\/([a-p]{32})$/)?.[1];
    if(!id||!companionIds().includes(id))return c.json({error:'Companion not registered'},403);
    c.header('Access-Control-Allow-Origin',origin);c.header('Vary','Origin');
    c.header('Access-Control-Allow-Headers','Authorization, Content-Type');c.header('Access-Control-Allow-Methods','POST, OPTIONS');
    if(c.req.method==='OPTIONS')return c.body(null,204);
    const redis=getRedis();if(!redis)return c.json({error:'Companion unavailable'},503);
    const limit=await rateLimiter(redis,`browser_companion:${rateLimitIpKey(getTrustedClientIp(c))}`,180,60);
    if(!limit.allowed)return c.json({error:'Too many requests'},429);
    await next();
  });
  app.onError((_error,c)=>c.json({error:'Companion request denied or sign-in expired'},403));
  app.post('/exchange',async c=>{
    const input=await c.req.json();
    if(input.extensionId!==c.req.header('Origin')?.slice('chrome-extension://'.length))return c.json({error:'Sign-in denied'},403);
    return c.json(await exchangeBrowserCompanion(input));
  });
  app.post('/logout',async c=>{
    const a=await authenticateBrowserCompanion(c.req.header('Authorization'),c.req.header('Origin')!.slice('chrome-extension://'.length));
    await endBrowserCompanion(a.key);return c.json({success:true});
  });
  app.post('/request',async c=>{
    const a=await authenticateBrowserCompanion(c.req.header('Authorization'),c.req.header('Origin')!.slice('chrome-extension://'.length));
    const input=companionCallSchema.parse(await c.req.json()),operation=classifyCompanionCall(input);
    if(!operation)return c.json({error:'Operation unavailable'},400);
    const p=a.session.principal;
    const {orgIds}=await computeAccessibleOrgIds('partner',p.partnerId,null,p.userId);
    const denied=await ipAllowlistGuard(c,async()=>{}, {partnerId:p.partnerId,isPlatformAdmin:false,actorId:p.userId,actorEmail:a.session.identity.email});
    if(denied)return denied;
    const refused=await withDbAccessContext({scope:'partner',orgId:null,accessibleOrgIds:orgIds,currentPartnerId:p.partnerId,accessiblePartnerIds:[p.partnerId],userId:p.userId},async()=>{
      if(input.orgId){
        const tenant=await getActiveOrgTenant(input.orgId);
        if(!tenant||tenant.partnerId!==p.partnerId||!canAccessOrg(a.authority.permissions,input.orgId))return c.json({error:'Client unavailable'},404);
      }
      if(input.deviceId){
        const [device]=await db.select({id:devices.id}).from(devices).where(and(eq(devices.id,input.deviceId),eq(devices.orgId,input.orgId!))).limit(1);
        if(!device)return c.json({error:'Device unavailable'},404);
      }
      if(operation.kind==='session'){
        const [session]=await db.select({id:remoteSessions.id}).from(remoteSessions).where(and(eq(remoteSessions.id,operation.sessionId),eq(remoteSessions.deviceId,input.deviceId!),eq(remoteSessions.orgId,input.orgId!),eq(remoteSessions.userId,p.userId),eq(remoteSessions.type,'terminal'))).limit(1);
        if(!session)return c.json({error:'Session unavailable'},404);
      }
      return null;
    });
    if(refused)return refused;
      const url=new URL(c.req.url);url.pathname='/api/v1'+input.path.split('?')[0]!;url.search=input.path.includes('?')?input.path.slice(input.path.indexOf('?')):'';
      // Preserve only transport identity. Do not forward caller-provided tenant,
      // impersonation, cookie, or authorization-selection headers to core routes.
      const headers=new Headers();
      for(const name of ['host','user-agent','cf-connecting-ip','x-forwarded-for','x-forwarded-proto','x-real-ip']){
        const value=c.req.header(name);if(value)headers.set(name,value);
      }
      headers.set('Authorization','Bearer '+await companionDispatchToken(a.session));headers.set('Content-Type','application/json');
      // Core proxy trust and terminal tickets need the original socket identity.
      // This is server-owned request context, never an addon-supplied field.
      const forward=()=>dispatch(new Request(url,{method:input.method,headers,body:input.method==='GET'||input.body===undefined?undefined:JSON.stringify(input.body)}),c.env);
      const response=await forward();
      if(response.ok&&input.method==='GET'&&url.pathname.endsWith('/files/download')){
        const bytes=new Uint8Array(await response.arrayBuffer());
        if(bytes.length>4*1024*1024)return c.json({error:'Downloads in the companion are limited to 4 MiB.'},413);
        return c.json({content:Buffer.from(bytes).toString('base64'),encoding:'base64'});
      }
      const safeHeaders=new Headers({'Content-Type':response.headers.get('Content-Type')??'application/json','Cache-Control':'no-store',
        'Access-Control-Allow-Origin':c.req.header('Origin')!,'Vary':'Origin'});
      return new Response(response.body,{status:response.status,headers:safeHeaders});
  });
  return app;
}
