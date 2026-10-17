import {describe,it,expect} from 'vitest';
import {companionRunSchema,parseCompanionScriptResult} from './companionScriptResults';
const result={success:true,mode:'execute',spoolFolders:['C:\\Windows\\System32\\spool\\PRINTERS'],fileCount:3,deletedCount:3,failedCount:0,serviceState:'Running',errors:[],restartAttempted:true};
const command=(value:unknown,exitCode=0)=>({stdout:JSON.stringify(value),exitCode});
describe('companion script completion evidence',()=>{
 it('preserves confirmed deleted count and restarted service',()=>expect(parseCompanionScriptResult(command(result),'execute').result).toMatchObject({success:true,deletedCount:3,serviceState:'Running'}));
 it.each([{},null,{stdout:'not JSON'},command({...result,mode:'preview'}),command({...result,deletedCount:-1})])('never reports missing or invalid evidence as success',value=>expect(parseCompanionScriptResult(value,'execute').result).toBeNull());
 it.each([{...result,serviceState:'Stopped'},{...result,restartAttempted:false},{...result,failedCount:1}])('requires actual restart and no failed deletions',value=>expect(parseCompanionScriptResult(command(value),'execute').result?.success).toBe(false));
 it('requires zero exit code even when payload says success',()=>expect(parseCompanionScriptResult(command(result,1),'execute').result?.success).toBe(false));
 it('allows read-only preview without service restart',()=>expect(parseCompanionScriptResult(command({...result,mode:'preview',deletedCount:0,restartAttempted:false,serviceState:'Stopped'}),'preview').result?.success).toBe(true));
});
describe('companion script request',()=>{
 const base={requestId:'11111111-1111-4111-8111-111111111111',scriptId:'clear-print-spool',mode:'execute',previewRequestId:'22222222-2222-4222-8222-222222222222'};
 it('requires explicit ticket choice and prior preview',()=>{expect(companionRunSchema.safeParse(base).success).toBe(false);expect(companionRunSchema.safeParse({...base,createTicket:true}).success).toBe(true);expect(companionRunSchema.safeParse({...base,createTicket:true,ticketId:base.requestId}).success).toBe(false);});
 it('rejects caller code, filesystem paths and preview ticket mutation',()=>{expect(companionRunSchema.safeParse({...base,createTicket:true,content:'arbitrary'}).success).toBe(false);expect(companionRunSchema.safeParse({...base,mode:'preview',createTicket:true}).success).toBe(false);});
});
