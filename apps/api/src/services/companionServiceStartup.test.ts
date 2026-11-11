import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({selected:[] as any[],dispatch:vi.fn(),deliver:vi.fn(),wait:vi.fn(),audit:vi.fn(),inside:false}));
vi.mock('../db',()=>({db:{select:()=>({from:()=>({where:()=>({limit:async()=>m.selected})})})},runOutsideDbContext:(f:any)=>f()}));
vi.mock('../middleware/auth',()=>({withAuthDbAccessContext:async(_auth:any,f:any)=>{m.inside=true;try{return await f();}finally{m.inside=false;}}}));
vi.mock('./scriptDispatch',()=>({dispatchScriptToDevice:m.dispatch}));
vi.mock('./scriptDeferredDelivery',()=>({deliverDeferredDispatch:m.deliver}));
vi.mock('./commandQueue',()=>({waitForCommandResult:m.wait}));
vi.mock('./auditService',()=>({createAuditLog:m.audit}));
import {changeCompanionServiceStartup} from './companionServiceStartup';
const org='11111111-1111-4111-8111-111111111111',device='22222222-2222-4222-8222-222222222222';
const auth={user:{id:org,email:'staff@example.test'},canAccessOrg:(id:string)=>id===org} as any;
const input={name:'Spooler',startType:'disabled' as const,expectedStartType:'auto' as const};
beforeEach(()=>{vi.clearAllMocks();m.selected=[{id:device,orgId:org,osType:'windows',status:'online',lastSeenAt:new Date()}];m.dispatch.mockResolvedValue({ok:true,commandId:device});m.deliver.mockImplementation(async d=>{expect(m.inside).toBe(false);return d;});m.wait.mockResolvedValue({status:'completed',result:{exitCode:0,stdout:JSON.stringify({success:true,name:'Spooler',startType:'disabled',previousStartType:'auto'})}});m.audit.mockResolvedValue(undefined);});
it('commits before dispatch and verifies command result; audits before/after',async()=>{
 expect((await changeCompanionServiceStartup(auth,org,device,input)).startType).toBe('disabled');
 expect(m.dispatch).toHaveBeenCalledWith(expect.objectContaining({deferDelivery:true,offlinePolicy:{kind:'reject'},timeoutSeconds:30}));
 expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({result:'success',details:expect.objectContaining({name:'Spooler',previousStartType:'auto',startType:'disabled'})}));
});
it('refuses cross-org, missing, offline and non-Windows devices before dispatch',async()=>{
 await expect(changeCompanionServiceStartup({...auth,canAccessOrg:()=>false},org,device,input)).rejects.toThrow('Device unavailable');
 const fixture=m.selected[0];
 for(const values of [[],[{...fixture,osType:'linux'}],[{...fixture,status:'offline'}],[{...fixture,lastSeenAt:new Date(0)}]]){m.selected=values;await expect(changeCompanionServiceStartup(auth,org,device,input)).rejects.toThrow();}
 expect(m.dispatch).not.toHaveBeenCalled();
});
it('refusal and failed readback cannot report success',async()=>{
 m.dispatch.mockResolvedValueOnce({ok:false,error:'Maintenance blocked'});await expect(changeCompanionServiceStartup(auth,org,device,input)).rejects.toThrow('Maintenance');expect(m.wait).not.toHaveBeenCalled();
 m.wait.mockResolvedValueOnce({status:'completed',result:{exitCode:1,stdout:''}});await expect(changeCompanionServiceStartup(auth,org,device,input)).rejects.toThrow('not confirmed');expect(m.audit).toHaveBeenLastCalledWith(expect.objectContaining({result:'failure'}));
});
