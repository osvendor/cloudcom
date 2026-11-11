import {beforeEach,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
const m=vi.hoisted(()=>({execute:vi.fn(),selected:[] as any[],dispatch:vi.fn(),deliver:vi.fn(),comment:vi.fn(),ticket:vi.fn(),inside:false}));
vi.mock('../db',()=>({db:{execute:m.execute,select:()=>({from:()=>({where:()=>({for:async()=>m.selected,then:(resolve:any)=>resolve(m.selected)})})})},runOutsideDbContext:(f:any)=>f(),withSystemDbAccessContext:(f:any)=>f()}));
vi.mock('../middleware/auth',()=>({withAuthDbAccessContext:async(_auth:any,f:any)=>{m.inside=true;try{return await f();}finally{m.inside=false;}}}));
vi.mock('./scriptDispatch',()=>({dispatchScriptToDevice:m.dispatch}));
vi.mock('./scriptDeferredDelivery',()=>({deliverDeferredDispatch:m.deliver}));
vi.mock('./ticketService',()=>({addTicketComment:m.comment,createTicket:m.ticket}));
import {startCompanionScript,reconcileCompanionScripts} from './companionScripts';
const org='11111111-1111-4111-8111-111111111111',device='22222222-2222-4222-8222-222222222222',actor='33333333-3333-4333-8333-333333333333',request='44444444-4444-4444-8444-444444444444';
const auth={user:{id:actor,name:'Staff'},canAccessOrg:(id:string)=>id===org} as any;
const input={requestId:request,scriptId:'clear-print-spool' as const,mode:'preview' as const};
const run={id:request,org_id:org,device_id:device,actor_id:actor,request_id:request,mode:'preview',status:'queued',ticket_id:null,command_id:request,noted:false,created_at:new Date()};
beforeEach(()=>{vi.clearAllMocks();m.selected=[{id:device,orgId:org,osType:'windows',status:'online',lastSeenAt:new Date(),hostname:'TEST'}];m.execute.mockResolvedValue([]);m.dispatch.mockResolvedValue({ok:true,commandId:request});m.deliver.mockImplementation(async()=>{expect(m.inside).toBe(false);});});
describe('companion script durable admission',()=>{
 it('defers command delivery until run transaction committed; previews create no ticket',async()=>{
  m.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([run]).mockResolvedValueOnce([run]);
  expect((await startCompanionScript(auth,org,device,input)).status).toBe('queued');
  expect(m.dispatch).toHaveBeenCalledWith(expect.objectContaining({deferDelivery:true,offlinePolicy:{kind:'reject'},runAs:'system'}));expect(m.deliver).toHaveBeenCalledOnce();expect(m.ticket).not.toHaveBeenCalled();expect(m.comment).not.toHaveBeenCalled();
 });
 it('rejects replay whose request fingerprint differs without dispatch',async()=>{
  m.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{...run,fingerprint:'different'}]);
  await expect(startCompanionScript(auth,org,device,input)).rejects.toThrow('request ID');expect(m.dispatch).not.toHaveBeenCalled();
 });
 it('returns the exact durable replay without dispatch or duplicate ticket note',async()=>{
  const fingerprint=createHash('sha256').update(JSON.stringify([org,device,'clear-print-spool','preview',null,null,false])).digest('hex');
  m.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{...run,fingerprint}]).mockResolvedValueOnce([run]);
  expect((await startCompanionScript(auth,org,device,input)).requestId).toBe(request);expect(m.dispatch).not.toHaveBeenCalled();expect(m.comment).not.toHaveBeenCalled();
 });
 it('creates the selected work ticket and internal requested note before delivering',async()=>{
  const preview={...run,status:'completed',result:{success:true,spoolFolders:['C:\\Windows\\System32\\spool\\PRINTERS'],fileCount:2}};
  m.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([preview]).mockResolvedValueOnce([]).mockResolvedValueOnce([{...run,mode:'execute',ticket_id:org}]).mockResolvedValueOnce([{...run,mode:'execute',ticket_id:org}]);
  m.ticket.mockResolvedValue({id:org});
  await startCompanionScript(auth,org,device,{...input,mode:'execute',previewRequestId:actor,createTicket:true});
  expect(m.ticket).toHaveBeenCalledWith(expect.objectContaining({orgId:org,deviceId:device,source:'manual'}),expect.objectContaining({userId:actor}));
  expect(m.comment).toHaveBeenCalledWith(org,expect.objectContaining({isPublic:false}),expect.anything());
  expect(m.dispatch).toHaveBeenCalledWith(expect.objectContaining({source:expect.objectContaining({content:expect.stringContaining('-ExpectedFoldersJson')})}));
 });
 it.each([{osType:'linux'},{status:'offline'},{lastSeenAt:new Date(0)}])('rejects incompatible/offline/stale device before command or ticket',async override=>{
  m.selected=[{...m.selected[0],...override}];await expect(startCompanionScript(auth,org,device,input)).rejects.toThrow();expect(m.dispatch).not.toHaveBeenCalled();expect(m.ticket).not.toHaveBeenCalled();
 });
 it('requires fresh successful preview before executing or creating ticket',async()=>{
  await expect(startCompanionScript(auth,org,device,{...input,mode:'execute',previewRequestId:request,createTicket:true})).rejects.toThrow('Inspect');expect(m.dispatch).not.toHaveBeenCalled();expect(m.ticket).not.toHaveBeenCalled();
 });
 it('reconciles completion with deleted count into an internal ticket note',async()=>{
  const result={success:true,mode:'execute',spoolFolders:['C:\\Windows\\System32\\spool\\PRINTERS'],fileCount:4,deletedCount:4,failedCount:0,serviceState:'Running',restartAttempted:true,errors:[]};
  m.execute.mockResolvedValueOnce([{...run,mode:'execute',ticket_id:org}]).mockResolvedValueOnce([{status:'completed',result:{stdout:JSON.stringify(result),exitCode:0}}]);
  m.selected=[{id:org}];await reconcileCompanionScripts();expect(m.comment).toHaveBeenCalledWith(org,expect.objectContaining({isPublic:false,content:expect.stringContaining('Files deleted: 4')}),expect.objectContaining({kind:'system'}));
 });
 it('does not publish a result into a ticket that moved clients',async()=>{
  m.execute.mockResolvedValueOnce([{...run,mode:'execute',ticket_id:org}]).mockResolvedValueOnce([{status:'failed',result:{error:'refused'}}]);m.selected=[];await reconcileCompanionScripts();expect(m.comment).not.toHaveBeenCalled();
 });
});
