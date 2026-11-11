import { createHash } from 'node:crypto';
import { and,eq,sql } from 'drizzle-orm';
import { z } from 'zod';
import { db,runOutsideDbContext,withSystemDbAccessContext } from '../db';
import { devices,tickets } from '../db/schema';
import { withAuthDbAccessContext,type AuthContext } from '../middleware/auth';
import { dispatchScriptToDevice,type DispatchScriptResult } from './scriptDispatch';
import { deliverDeferredDispatch } from './scriptDeferredDelivery';
import { addTicketComment,createTicket } from './ticketService';
import { CLEAR_PRINT_SPOOL_SCRIPT } from './companionPrintScript';
import { parseCompanionScriptResult,companionRunSchema } from './companionScriptResults';
export { companionRunSchema } from './companionScriptResults';


type Input=z.infer<typeof companionRunSchema>;
type Run={id:string;org_id:string;device_id:string;actor_id:string;request_id:string;preview_id:string|null;ticket_id:string|null;ticket_number?:string|null;command_id:string|null;mode:'preview'|'execute';status:string;fingerprint:string;result:any;error:string|null;noted:boolean;created_at:Date};
const rows=<T>(r:unknown)=>r as T[];
export class CompanionScriptError extends Error {constructor(message:string,public status:400|403|404|409=409){super(message);}}
export const runView=(r:Run)=>({requestId:r.request_id,mode:r.mode,status:r.status,ticketId:r.ticket_id,ticketNumber:r.ticket_number??null,result:r.result,error:r.error,ticketNotePending:Boolean(r.ticket_id)&&!r.noted&&['queued','running'].includes(r.status),ticketNoteStatus:!r.ticket_id?'not_required':r.noted?'recorded':['queued','running'].includes(r.status)?'pending':'unavailable',createdAt:r.created_at});
const fingerprint=(orgId:string,deviceId:string,input:Input)=>createHash('sha256').update(JSON.stringify([orgId,deviceId,input.scriptId,input.mode,input.previewRequestId??null,input.ticketId??null,Boolean(input.createTicket)])).digest('hex');

export async function getCompanionRuns(orgId:string,deviceId:string,actorId:string,requestId?:string){
  return rows<Run>(await db.execute(sql`SELECT r.*,t.ticket_number FROM credentials_companion_script_runs r LEFT JOIN tickets t ON t.id=r.ticket_id AND t.org_id=r.org_id AND t.deleted_at IS NULL WHERE r.org_id=${orgId}::uuid AND r.device_id=${deviceId}::uuid AND r.actor_id=${actorId}::uuid ${requestId?sql`AND r.request_id=${requestId}::uuid`:sql``} ORDER BY r.created_at DESC LIMIT 30`));
}
export async function startCompanionScript(auth:AuthContext,orgId:string,deviceId:string,input:Input){
  let dispatch:DispatchScriptResult|undefined;
  const run=await withAuthDbAccessContext(auth,async()=>{
    // Serialize a request ID across all devices, then device mutations. Never dispatch a duplicate retry.
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${auth.user.id+':'+input.requestId},0))`);
    const existing=rows<Run>(await db.execute(sql`SELECT * FROM credentials_companion_script_runs WHERE actor_id=${auth.user.id}::uuid AND request_id=${input.requestId}::uuid`))[0];
    const fp=fingerprint(orgId,deviceId,input);
    if(existing){if(existing.fingerprint!==fp)throw new CompanionScriptError('This request ID was already used for another action');return existing;}
    const [device]=await db.select().from(devices).where(and(eq(devices.id,deviceId),eq(devices.orgId,orgId))).for('update');
    if(!device||!auth.canAccessOrg(orgId))throw new CompanionScriptError('Device unavailable',404);
    if(device.osType!=='windows')throw new CompanionScriptError('This script requires Windows');
    if(device.status!=='online'||!device.lastSeenAt||Date.now()-device.lastSeenAt.getTime()>5*60_000)throw new CompanionScriptError('The computer must be online with a recent heartbeat');
    if(rows(await db.execute(sql`SELECT id FROM credentials_companion_script_runs WHERE device_id=${deviceId}::uuid AND mode='execute' AND status IN ('queued','running') LIMIT 1`)).length)throw new CompanionScriptError('A print repair is already running on this computer');
    let preview:Run|undefined,ticketId:string|null=null;
    const actor={kind:'user' as const,userId:auth.user.id,name:auth.user.name};
    if(input.mode==='execute'){
      preview=(await getCompanionRuns(orgId,deviceId,auth.user.id,input.previewRequestId))[0];
      if(!preview||preview.mode!=='preview'||preview.status!=='completed'||preview.result?.success!==true||Date.now()-new Date(preview.created_at).getTime()>10*60_000)throw new CompanionScriptError('Inspect the spool folder again before running this script');
      if(rows(await db.execute(sql`SELECT id FROM credentials_companion_script_runs WHERE preview_id=${preview.id}::uuid LIMIT 1`)).length)throw new CompanionScriptError('This preview was already used. Inspect again for a new run');
      if(input.ticketId){
        const [ticket]=await db.select().from(tickets).where(and(eq(tickets.id,input.ticketId),eq(tickets.orgId,orgId))).for('update');
        if(!ticket||ticket.deletedAt||['closed','resolved'].includes(ticket.status)||ticket.deviceId&&ticket.deviceId!==deviceId)throw new CompanionScriptError('Choose an open ticket for this client and computer');
        ticketId=ticket.id;
      }else{
        const ticket=await createTicket({orgId,deviceId,subject:`Clear stuck print jobs — ${device.displayName||device.hostname}`,description:'Print queue maintenance requested from OS Companion.',source:'manual'},actor);
        ticketId=ticket.id;
      }
    }
    const content=`& {\n${CLEAR_PRINT_SPOOL_SCRIPT}\n} ${input.mode==='preview'?'-Preview':`-ExpectedFoldersJson '${JSON.stringify(preview!.result.spoolFolders).replace(/'/g,"''")}'`}`;
    dispatch=await dispatchScriptToDevice({device,source:{kind:'raw',content,language:'powershell',provenance:'companion.clear-print-spool'},createdBy:auth.user.id,triggeredBy:auth.user.id,triggerType:'manual',runAs:'system',timeoutSeconds:120,offlinePolicy:{kind:'reject'},deferDelivery:true});
    const status=dispatch.ok?'queued':'failed',error=dispatch.ok?null:dispatch.error;
    const saved=rows<Run>(await db.execute(sql`INSERT INTO credentials_companion_script_runs (org_id,device_id,actor_id,request_id,preview_id,ticket_id,command_id,script_id,mode,status,fingerprint,error) VALUES (${orgId}::uuid,${deviceId}::uuid,${auth.user.id}::uuid,${input.requestId}::uuid,${preview?.id??null}::uuid,${ticketId}::uuid,${dispatch.ok?dispatch.commandId:null}::uuid,${input.scriptId},${input.mode},${status},${fp},${error}) RETURNING *`))[0]!;
    if(ticketId){
      await addTicketComment(ticketId,{isPublic:false,content:`Clear stuck print jobs requested on ${device.displayName||device.hostname}.\nRun: ${input.requestId}\nPlan: stop Print Spooler, delete spool files, restart Print Spooler.\nFolders: ${preview!.result.spoolFolders.join(', ')}\nFiles seen during inspection: ${preview!.result.fileCount}.${error?'\nNot started: '+error:''}`},actor);
      if(!dispatch.ok)await db.execute(sql`UPDATE credentials_companion_script_runs SET noted=true WHERE id=${saved.id}::uuid`);
    }
    return saved;
  });
  if(dispatch?.ok)await deliverDeferredDispatch(dispatch,{companionRequestId:input.requestId});
  return withAuthDbAccessContext(auth,async()=>runView((await getCompanionRuns(orgId,deviceId,auth.user.id,input.requestId))[0]??run));
}

/** Durable reconciliation: retries after restart; note and terminal state commit together. */
export async function reconcileCompanionScripts(){
  return runOutsideDbContext(()=>withSystemDbAccessContext(async()=>{
    const pending=rows<Run>(await db.execute(sql`SELECT * FROM credentials_companion_script_runs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`));
    for(const run of pending){
      const command=rows<{status:string;result:unknown}>(await db.execute(sql`SELECT status,result FROM device_commands WHERE id=${run.command_id}::uuid AND device_id=${run.device_id}::uuid AND submitted_org_id=${run.org_id}::uuid`))[0];
      if(command&&['pending','sent','running','queued'].includes(command.status)){
        if(command.status!=='pending')await db.execute(sql`UPDATE credentials_companion_script_runs SET status='running',updated_at=now() WHERE id=${run.id}::uuid`);
        continue;
      }
      const parsed=command?parseCompanionScriptResult(command.result,run.mode):{result:null,error:'The command is unavailable. Outcome is unconfirmed.'};
      const success=command?.status==='completed'&&parsed.result?.success===true;
      const error=success?null:parsed.error||`Command ${command?.status??'unavailable'}; successful completion was not confirmed.`;
      let noted=run.noted;
      if(run.ticket_id&&!run.noted){
        const [ticket]=await db.select({id:tickets.id}).from(tickets).where(and(eq(tickets.id,run.ticket_id),eq(tickets.orgId,run.org_id)));
        // A ticket moved to another client must never receive another client's outcome.
        if(ticket){await addTicketComment(ticket.id,{isPublic:false,content:`Clear stuck print jobs: ${success?'completed successfully':'failed / not confirmed'}.\nRun: ${run.request_id}\nFiles deleted: ${parsed.result?.deletedCount??'unconfirmed'}\nFiles not deleted: ${parsed.result?.failedCount??'unconfirmed'}\nPrint Spooler: ${parsed.result?.serviceState??'unconfirmed'}${error?'\n'+error:''}`},{kind:'system',source:'scheduler',name:'OS Companion script result'});noted=true;}
      }
      await db.execute(sql`UPDATE credentials_companion_script_runs SET status=${success?'completed':'failed'},result=${parsed.result?JSON.stringify(parsed.result):null}::jsonb,error=${error},noted=${noted},updated_at=now() WHERE id=${run.id}::uuid`);
    }
  }));
}
let timer:ReturnType<typeof setInterval>|undefined,busy=false;
export function startCompanionScriptReconciler(){
  if(timer)return;
  const tick=async()=>{if(busy)return;busy=true;try{await reconcileCompanionScripts();}catch(e){console.error('[companion scripts] Result reconciliation will retry',e instanceof Error?e.message:String(e));}finally{busy=false;}};
  timer=setInterval(()=>void tick(),15000);timer.unref();void tick();
}
export function stopCompanionScriptReconciler(){if(timer)clearInterval(timer);timer=undefined;}
