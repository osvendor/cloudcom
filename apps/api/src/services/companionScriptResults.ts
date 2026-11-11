import { z } from 'zod';

const count=z.number().int().min(0).max(10000000);
export const spoolResultSchema=z.object({
  success:z.boolean(),mode:z.enum(['preview','execute']),
  spoolFolders:z.array(z.string().max(2048)).max(100),
  fileCount:count,deletedCount:count,failedCount:count,
  serviceState:z.string().max(100),errors:z.array(z.string().max(4000)).max(100),
  restartAttempted:z.boolean().optional(),
});
/** Only the reviewed structured result is shown/stored in the ticket, never arbitrary output. */
export function parseCompanionScriptResult(command:unknown,mode:'preview'|'execute') {
  const value=command as {stdout?:unknown;exitCode?:unknown;error?:unknown}|null;
  try {
    if(typeof value?.stdout!=='string'||value.stdout.length>200000)throw new Error('missing');
    const parsed=spoolResultSchema.parse(JSON.parse(value.stdout.trim()));
    if(parsed.mode!==mode)throw new Error('mode');
    const success=parsed.success&&value.exitCode===0&&(mode==='preview'||(parsed.failedCount===0&&parsed.serviceState.toLowerCase()==='running'&&parsed.restartAttempted===true));
    return {result:{...parsed,success},error:success?null:parsed.errors.join('; ').slice(0,4000)||'The script did not confirm successful completion.'};
  } catch {
    return {result:null,error:'The agent did not return a valid script result. Completion and deleted file count are unconfirmed.'};
  }
}

export const companionRunSchema=z.object({requestId:z.string().uuid(),scriptId:z.literal('clear-print-spool'),mode:z.enum(['preview','execute']),previewRequestId:z.string().uuid().optional(),ticketId:z.string().uuid().optional(),createTicket:z.literal(true).optional()}).strict().superRefine((v,c)=>{
  if(v.mode==='execute'&&(!v.previewRequestId||Boolean(v.ticketId)===Boolean(v.createTicket)))c.addIssue({code:'custom',message:'Choose a ticket or create a work ticket, and inspect the spool folder first'});
  if(v.mode==='preview'&&(v.ticketId||v.createTicket||v.previewRequestId))c.addIssue({code:'custom',message:'Preview does not create or modify a ticket'});
});
