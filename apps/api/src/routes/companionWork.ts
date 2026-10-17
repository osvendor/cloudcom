import {Hono} from 'hono';
import {z} from 'zod';
import {authMiddleware,requireInteractiveSession,requireMfa,requirePermission,requireScope,withAuthDbAccessContext} from '../middleware/auth';
import {getActiveOrgTenant} from '../services/tenantStatus';
import {ensureWork,findWork,listWork,mutateWork,syncWork,workView} from '../services/companionWork';
export const companionWorkRoutes=new Hono();
companionWorkRoutes.use('*',authMiddleware,requireScope('partner'),requireInteractiveSession(),requireMfa(),requirePermission('tickets','read'),requirePermission('tickets','write'),requirePermission('devices','read'));
companionWorkRoutes.use('/orgs/:orgId/*',async(c,next)=>{
 const auth=c.get('auth'),orgId=c.req.param('orgId');
 if(process.env.CLOUDCOM_CREDENTIALS_ENABLED!=='true')return c.json({error:'Work unavailable'},503);
 if(!z.string().uuid().safeParse(orgId).success||!auth.canAccessOrg(orgId!)||c.get('permissions').allowedSiteIds!==undefined)return c.json({error:'Client unavailable'},404);
 const tenant=await withAuthDbAccessContext(auth,()=>getActiveOrgTenant(orgId!));
 if(!tenant||tenant.partnerId!==auth.partnerId)return c.json({error:'Client unavailable'},404);
 await next();
});
const base='/orgs/:orgId';
companionWorkRoutes.get(base,async c=>c.json({items:await withAuthDbAccessContext(c.get('auth'),()=>listWork(c.req.param('orgId'),c.get('auth').user.id))}));
companionWorkRoutes.post(base,async c=>{
 const input=z.object({deviceId:z.string().uuid(),subject:z.string().trim().min(1).max(255).optional()}).strict().safeParse(await c.req.json().catch(()=>null));
 if(!input.success)return c.json({error:'Choose a computer and a short problem description'},400);
 try{return c.json({item:await withAuthDbAccessContext(c.get('auth'),()=>ensureWork(c.get('auth'),c.req.param('orgId'),input.data.deviceId,input.data.subject))});}catch{return c.json({error:'Could not start work for this computer'},409);}
});
companionWorkRoutes.get(base+'/:ticketId',async c=>{
 if(!z.string().uuid().safeParse(c.req.param('ticketId')).success)return c.json({error:'Work item unavailable'},404);
 try{return c.json({item:await withAuthDbAccessContext(c.get('auth'),async()=>workView(await syncWork(await findWork(c.req.param('orgId'),c.get('auth').user.id,c.req.param('ticketId')),false)))});}catch{return c.json({error:'Work item unavailable'},404);}
});
companionWorkRoutes.post(base+'/:ticketId',async c=>{
 const input=z.discriminatedUnion('action',[z.object({action:z.literal('close')}).strict(),z.object({action:z.literal('autoClose'),enabled:z.boolean()}).strict(),z.object({action:z.literal('rename'),subject:z.string().trim().min(1).max(255)}).strict()]).safeParse(await c.req.json().catch(()=>null));
 if(!input.success||!z.string().uuid().safeParse(c.req.param('ticketId')).success)return c.json({error:'Invalid work action'},400);
 try{return c.json({item:await withAuthDbAccessContext(c.get('auth'),()=>mutateWork(c.get('auth'),c.req.param('orgId'),c.req.param('ticketId'),input.data))});}catch{return c.json({error:'Could not update work item'},409);}
});
