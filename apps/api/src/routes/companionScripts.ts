import { Hono } from 'hono';
import { and,eq,sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { devices } from '../db/schema';
import { authMiddleware,requireInteractiveSession,requireMfa,requirePermission,requireScope,withAuthDbAccessContext } from '../middleware/auth';
import { hasPermission,type UserPermissions } from '../services/permissions';
import { getActiveOrgTenant } from '../services/tenantStatus';
import { TicketServiceError } from '../services/ticketService';
import { companionRunSchema,CompanionScriptError,getCompanionRuns,runView,startCompanionScript } from '../services/companionScripts';
import {serviceStartupSchema} from '../services/companionServiceStartupScript';
import {changeCompanionServiceStartup} from '../services/companionServiceStartup';

export const companionScriptRoutes=new Hono();
companionScriptRoutes.use('*',authMiddleware,requireScope('partner'),requireInteractiveSession(),requireMfa(),requirePermission('scripts','execute'),requirePermission('devices','read'));
companionScriptRoutes.use('/orgs/:orgId/devices/:deviceId/*',async(c,next)=>{
  if(process.env.CLOUDCOM_CREDENTIALS_ENABLED!=='true')return c.json({error:'Companion scripts unavailable'},503);
  const auth=c.get('auth'),p=c.get('permissions') as UserPermissions;
  const orgId=c.req.param('orgId'),deviceId=c.req.param('deviceId');
  if(!z.string().uuid().safeParse(orgId).success||!z.string().uuid().safeParse(deviceId).success||!auth.canAccessOrg(orgId!)||p.allowedSiteIds!==undefined)return c.json({error:'Device unavailable'},404);
  const found=await withAuthDbAccessContext(auth,async()=>{
    const tenant=await getActiveOrgTenant(orgId!);
    if(!tenant||tenant.partnerId!==auth.partnerId)return [];
    return db.select({id:devices.id}).from(devices).where(and(eq(devices.id,deviceId!),eq(devices.orgId,orgId!))).limit(1);
  });
  if(!found.length)return c.json({error:'Device unavailable'},404);
  await next();
});
const base='/orgs/:orgId/devices/:deviceId';
companionScriptRoutes.post(base+'/service-startup',async c=>{
  const input=serviceStartupSchema.safeParse(await c.req.json().catch(()=>null));
  if(!input.success)return c.json({error:'Choose a supported service startup type'},400);
  try{return c.json(await changeCompanionServiceStartup(c.get('auth'),c.req.param('orgId'),c.req.param('deviceId'),input.data));}
  catch(e){return c.json({error:e instanceof Error?e.message:'Startup change failed'},409);}
});
companionScriptRoutes.get(base+'/catalog',c=>c.json({scripts:[{id:'clear-print-spool',name:'Clear stuck print jobs',description:'Stop Print Spooler, delete queued spool files, and restart Print Spooler. Removes pending print jobs for every printer on this computer.',requiresPreview:true}]}));
companionScriptRoutes.get(base+'/tickets',requirePermission('tickets','read'),async c=>{
  const found=await withAuthDbAccessContext(c.get('auth'),()=>db.execute(sql`SELECT id,ticket_number AS "ticketNumber",subject FROM tickets WHERE org_id=${c.req.param('orgId')}::uuid AND deleted_at IS NULL AND status NOT IN ('closed','resolved') AND (device_id IS NULL OR device_id=${c.req.param('deviceId')}::uuid) ORDER BY updated_at DESC LIMIT 100`));
  return c.json({tickets:found});
});
companionScriptRoutes.get(base+'/runs',async c=>c.json({runs:await withAuthDbAccessContext(c.get('auth'),async()=>(await getCompanionRuns(c.req.param('orgId'),c.req.param('deviceId'),c.get('auth').user.id)).map(runView))}));
companionScriptRoutes.get(base+'/runs/:requestId',async c=>{
  if(!z.string().uuid().safeParse(c.req.param('requestId')).success)return c.json({error:'Run unavailable'},404);
  const run=await withAuthDbAccessContext(c.get('auth'),async()=>(await getCompanionRuns(c.req.param('orgId'),c.req.param('deviceId'),c.get('auth').user.id,c.req.param('requestId')))[0]);
  return run?c.json({run:runView(run)}):c.json({error:'Run unavailable'},404);
});
companionScriptRoutes.post(base+'/runs',async c=>{
  const input=companionRunSchema.safeParse(await c.req.json().catch(()=>null));
  if(!input.success)return c.json({error:'Inspect first, then choose an existing ticket or create a work ticket'},400);
  const p=c.get('permissions') as UserPermissions;
  if(input.data.mode==='execute'&&(!hasPermission(p,'tickets','write')||!hasPermission(p,'tickets','read')))return c.json({error:'Ticket read and write permissions required'},403);
  try{return c.json({run:await startCompanionScript(c.get('auth'),c.req.param('orgId'),c.req.param('deviceId'),input.data)},202);}
  catch(e){if(e instanceof CompanionScriptError||e instanceof TicketServiceError)return c.json({error:e.message},e.status);throw e;}
});
