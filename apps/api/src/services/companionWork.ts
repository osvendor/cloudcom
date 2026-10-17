import {z} from 'zod';
import {getUserPermissions,hasPermission,canAccessOrg} from './permissions';
import {getActiveOrgTenant} from './tenantStatus';
import {and,eq,sql} from 'drizzle-orm';
import {db,runOutsideDbContext,withSystemDbAccessContext} from '../db';
import {devices,tickets,users} from '../db/schema';
import {type AuthContext} from '../middleware/auth';
import {createTicket,changeTicketStatus,addTicketComment,updateTicketFields} from './ticketService';
import {auditWorkActivity,workCanAutoClose,type WorkActivity} from './companionWorkModel';

type Meta={actorId:string;startedAt:string;lastIntentAt?:string;autoClose:boolean;activities:WorkActivity[]};
type Ticket=typeof tickets.$inferSelect;
const metaSchema=z.object({actorId:z.string().uuid(),startedAt:z.string().datetime(),lastIntentAt:z.string().datetime().optional(),autoClose:z.boolean(),activities:z.array(z.object({id:z.string(),label:z.string(),at:z.string().datetime(),state:z.enum(['success','pending','failure'])})).max(2100)});
const meta=(t:Ticket)=>{const parsed=metaSchema.safeParse((t.customFields as any)?.osCompanionWork);return parsed.success?parsed.data:undefined;};
const actor=(auth:AuthContext)=>({kind:'user' as const,userId:auth.user.id,name:auth.user.name});
export const workView=(t:Ticket)=>({id:t.id,ticketNumber:t.internalNumber||t.ticketNumber,subject:t.subject,deviceId:t.deviceId,status:t.status,autoClose:meta(t)?.autoClose===true,activities:meta(t)?.activities??[],updatedAt:t.updatedAt});
const lock=async(orgId:string,actorId:string,deviceId:string)=>{await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${orgId+':'+actorId+':'+deviceId+':work'},0))`);};
async function saveMeta(t:Ticket,m:Meta){const [updated]=await db.update(tickets).set({customFields:{...(t.customFields as object??{}),osCompanionWork:m},updatedAt:new Date()}).where(and(eq(tickets.id,t.id),eq(tickets.orgId,t.orgId))).returning();return updated!;}
export async function listWork(orgId:string,actorId:string){return (await db.select().from(tickets).where(sql`${tickets.orgId}=${orgId}::uuid AND ${tickets.deletedAt} IS NULL AND ${tickets.customFields}->'osCompanionWork'->>'actorId'=${actorId}`).orderBy(sql`${tickets.updatedAt} DESC`).limit(100)).map(workView);}
export async function findWork(orgId:string,actorId:string,id:string){const [t]=await db.select().from(tickets).where(and(eq(tickets.id,id),eq(tickets.orgId,orgId))).for('update');if(!t||t.deletedAt||meta(t)?.actorId!==actorId)throw Error('Work item unavailable');return t;}
export async function ensureWork(auth:AuthContext,orgId:string,deviceId:string,subject?:string){
 await lock(orgId,auth.user.id,deviceId);
 const [device]=await db.select().from(devices).where(and(eq(devices.id,deviceId),eq(devices.orgId,orgId)));
 if(!device)throw Error('Device unavailable');
 const [existing]=await db.select().from(tickets).where(sql`${tickets.orgId}=${orgId}::uuid AND ${tickets.deviceId}=${deviceId}::uuid AND ${tickets.deletedAt} IS NULL AND ${tickets.status} NOT IN ('closed','resolved') AND ${tickets.customFields}->'osCompanionWork'->>'actorId'=${auth.user.id}`).limit(1).for('update');
 if(existing)return workView(await saveMeta(existing,{...meta(existing)!,lastIntentAt:new Date().toISOString()}));
 const t=await createTicket({orgId,deviceId,subject:subject||`Work on ${device.displayName||device.hostname}`,description:'Internal technician activity log. Timeline records actions; successful actions do not prove the issue is resolved.',source:'manual'},actor(auth));
 return workView(await saveMeta(t,{actorId:auth.user.id,startedAt:new Date().toISOString(),autoClose:false,activities:[]}));
}
async function eventsFor(t:Ticket):Promise<{events:WorkActivity[];blocked:boolean}>{
 const m=meta(t)!;const start=m.startedAt;
 const audit=await db.execute(sql`SELECT id,action,timestamp,result FROM audit_logs WHERE org_id=${t.orgId}::uuid AND actor_id=${m.actorId}::uuid AND resource_id=${t.deviceId}::uuid AND resource_type IN ('device','device_file') AND timestamp>=${start}::timestamp ORDER BY timestamp LIMIT 501`);
 const events=(audit as any[]).map(auditWorkActivity).filter(Boolean) as WorkActivity[];
 const sessions=await db.execute(sql`SELECT id,type,status,created_at,ended_at FROM remote_sessions WHERE org_id=${t.orgId}::uuid AND device_id=${t.deviceId}::uuid AND user_id=${m.actorId}::uuid AND (created_at>=${start}::timestamp OR ended_at>=${start}::timestamp OR ended_at IS NULL) ORDER BY created_at LIMIT 501`);
 for(const s of sessions as any[])events.push({id:'remote:'+s.id,label:s.type==='desktop'?'Remote desktop':s.type==='terminal'?'Terminal session':'File transfer',at:new Date(s.ended_at||s.created_at).toISOString(),state:s.status==='disconnected'&&s.ended_at?'success':['pending','connecting','active'].includes(s.status)?'pending':'failure'});
 const native=await db.execute(sql`SELECT id,status,created_at,ended_at FROM staff_native_sessions WHERE org_id=${t.orgId}::uuid AND device_id=${t.deviceId}::uuid AND staff_user_id=${m.actorId}::uuid AND (created_at>=${start}::timestamp OR ended_at>=${start}::timestamp OR ended_at IS NULL) ORDER BY created_at LIMIT 501`);
 for(const s of native as any[])events.push({id:'native:'+s.id,label:'RustDesk session',at:new Date(s.ended_at||s.created_at).toISOString(),state:s.status==='disconnected'&&s.ended_at?'success':'pending'});
 const scripts=await db.execute(sql`SELECT id,status,created_at,completed_at,exit_code FROM script_executions WHERE org_id=${t.orgId}::uuid AND device_id=${t.deviceId}::uuid AND triggered_by=${m.actorId}::uuid AND trigger_type='manual' AND (created_at>=${start}::timestamp OR completed_at>=${start}::timestamp OR status IN ('pending','queued','running','cancelling')) ORDER BY created_at LIMIT 501`);
 for(const s of scripts as any[])events.push({id:'script:'+s.id,label:'Ran script',at:new Date(s.completed_at||s.created_at).toISOString(),state:s.status==='completed'&&s.exit_code===0?'success':['pending','queued','running','cancelling'].includes(s.status)?'pending':'failure'});
 const repairs=await db.execute(sql`SELECT id,status,updated_at,result->>'deletedCount' AS deleted_count FROM credentials_companion_script_runs WHERE org_id=${t.orgId}::uuid AND device_id=${t.deviceId}::uuid AND actor_id=${m.actorId}::uuid AND mode='execute' AND created_at>=${start}::timestamp ORDER BY created_at LIMIT 501`);
 for(const r of repairs as any[]){const count=Number(r.deleted_count);events.push({id:'repair:'+r.id,label:r.status==='completed'&&Number.isSafeInteger(count)&&count>=0?`Cleared ${count} print jobs; spooler restarted`:'Clear stuck print jobs',at:new Date(r.updated_at).toISOString(),state:r.status==='completed'?'success':['queued','running'].includes(r.status)?'pending':'failure'});}
 const pending=await db.execute(sql`SELECT id FROM device_commands WHERE submitted_org_id=${t.orgId}::uuid AND device_id=${t.deviceId}::uuid AND created_by=${m.actorId}::uuid AND (created_at>=${start}::timestamp OR status IN ('pending','sent','queued','running')) AND status NOT IN ('completed') LIMIT 1`);
 // Never auto-close a truncated or ambiguous history. Preserve failures rather than hiding them.
 const blocked=(pending as any[]).length>0||[audit,sessions,native,scripts,repairs].some(a=>(a as any[]).length>500);
 const combined=new Map(m.activities.map(e=>[e.id,e]));for(const e of events)combined.set(e.id,e);const merged=[...combined.values()].sort((a,b)=>a.at.localeCompare(b.at));return {events:merged.slice(0,2100),blocked:blocked||merged.length>2100};
}
export async function syncWork(t:Ticket,auto=true){
 if(!t.deviceId||!meta(t)||['closed','resolved'].includes(t.status))return t;
 const [device]=await db.select({id:devices.id}).from(devices).where(and(eq(devices.id,t.deviceId),eq(devices.orgId,t.orgId)));
 if(!device)return t;
 const m=meta(t)!;const {events,blocked}=await eventsFor(t);
 const changed=JSON.stringify(events)!==JSON.stringify(m.activities);
 if(changed){
  const previous=new Map(m.activities.map(e=>[e.id,e]));
  const fresh=events.filter(e=>JSON.stringify(previous.get(e.id))!==JSON.stringify(e));
  if(fresh.length)await addTicketComment(t.id,{isPublic:false,content:fresh.map(e=>`${e.at} — ${e.label} (${e.state})`).join('\n')},{kind:'system',source:'scheduler',name:'OS Companion work log'});
  t=await saveMeta(t,{...m,activities:events});
 }
 if(auto&&!blocked&&(!m.lastIntentAt||Date.now()-Date.parse(m.lastIntentAt)>=15*60_000)&&workCanAutoClose(events,m.autoClose)){
  await changeTicketStatus(t.id,{status:'closed'},{resolutionNote:'Auto-closed after 15 minutes without activity. Recorded actions completed; issue resolution was not independently verified.'},{kind:'system',source:'scheduler',name:'OS Companion inactivity rule'});
  const [closed]=await db.select().from(tickets).where(eq(tickets.id,t.id));return closed!;
 }
 return t;
}
export async function mutateWork(auth:AuthContext,orgId:string,id:string,input:{action:string;enabled?:boolean;subject?:string}){
 let t=await findWork(orgId,auth.user.id,id);if(['closed','resolved'].includes(t.status))throw Error('Work item is already closed');
 t=await syncWork(t,false);
 if(input.action==='close'){await changeTicketStatus(t.id,{status:'closed'},{resolutionNote:'Closed by technician from OS Companion.'},actor(auth));const [closed]=await db.select().from(tickets).where(eq(tickets.id,t.id));return workView(closed!);}
 if(input.action==='rename'){await updateTicketFields(t.id,{subject:input.subject!},actor(auth));const [renamed]=await db.select().from(tickets).where(eq(tickets.id,t.id));return workView(renamed!);}
 return workView(await saveMeta(t,{...meta(t)!,autoClose:input.enabled===true,lastIntentAt:new Date().toISOString()}));
}
let timer:ReturnType<typeof setInterval>|undefined,busy=false,scanAfter='00000000-0000-0000-0000-000000000000';
export async function reconcileCompanionWork(){return runOutsideDbContext(()=>withSystemDbAccessContext(async()=>{
 const open=await db.select().from(tickets).where(sql`${tickets.deletedAt} IS NULL AND ${tickets.status} NOT IN ('closed','resolved') AND ${tickets.customFields} ? 'osCompanionWork' AND ${tickets.id}>${scanAfter}::uuid`).orderBy(tickets.id).limit(100).for('update',{skipLocked:true});
  if(!open.length)scanAfter='00000000-0000-0000-0000-000000000000';
 for(const t of open){
  scanAfter=t.id;
  const m=meta(t);if(!m)continue;
  const tenant=await getActiveOrgTenant(t.orgId);
  const [user]=await db.select({status:users.status,partnerId:users.partnerId}).from(users).where(eq(users.id,m.actorId));
  if(!tenant||!user||user.status!=='active'||tenant.partnerId!==user.partnerId)continue;
  const p=await getUserPermissions(m.actorId,{partnerId:user.partnerId,scope:'partner'},{bypassCache:true});
  if(!p||p.scope!=='partner'||p.allowedSiteIds!==undefined||!canAccessOrg(p,t.orgId)||!hasPermission(p,'tickets','write')||!hasPermission(p,'tickets','read')||!hasPermission(p,'devices','read'))continue;
  await syncWork(t);

 }
}));}
export function startCompanionWorkReconciler(){if(timer)return;const tick=async()=>{if(busy)return;busy=true;try{await reconcileCompanionWork();}catch(e){console.error('[companion work] Reconciliation will retry',e instanceof Error?e.message:String(e));}finally{busy=false;}};timer=setInterval(()=>void tick(),30000);timer.unref();void tick();}
export function stopCompanionWorkReconciler(){if(timer)clearInterval(timer);timer=undefined;}

