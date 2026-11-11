import {and,eq} from 'drizzle-orm';
import {db,runOutsideDbContext} from '../db';
import {devices} from '../db/schema';
import {withAuthDbAccessContext,type AuthContext} from '../middleware/auth';
import {dispatchScriptToDevice} from './scriptDispatch';
import {deliverDeferredDispatch} from './scriptDeferredDelivery';
import {waitForCommandResult} from './commandQueue';
import {createAuditLog} from './auditService';
import {serviceStartupScript,parseServiceStartupResult,type ServiceStartupInput} from './companionServiceStartupScript';

export async function changeCompanionServiceStartup(auth:AuthContext,orgId:string,deviceId:string,input:ServiceStartupInput){
  let commandId:string|undefined;
  try{
    const dispatch=await withAuthDbAccessContext(auth,async()=>{
      const [device]=await db.select().from(devices).where(and(eq(devices.id,deviceId),eq(devices.orgId,orgId))).limit(1);
      if(!device||!auth.canAccessOrg(orgId))throw Error('Device unavailable');
      if(device.osType!=='windows')throw Error('Startup changes require Windows');
      if(device.status!=='online'||!device.lastSeenAt||Date.now()-device.lastSeenAt.getTime()>300000)throw Error('The computer must be online with a recent heartbeat');
      return dispatchScriptToDevice({device,source:{kind:'raw',content:serviceStartupScript(input),language:'powershell',provenance:'companion.service-startup'},createdBy:auth.user.id,triggeredBy:auth.user.id,triggerType:'manual',runAs:'system',timeoutSeconds:30,offlinePolicy:{kind:'reject'},deferDelivery:true});
    });
    if(!dispatch.ok)throw Error(dispatch.error);
    commandId=dispatch.commandId;
    const delivered=await deliverDeferredDispatch(dispatch);
    if(!delivered.ok)throw Error(delivered.error);
    const command=await runOutsideDbContext(()=>waitForCommandResult(dispatch.commandId,45000));
    if(command.status!=='completed')throw Error('Startup change was not confirmed. Refresh services before retrying.');
    const result=parseServiceStartupResult(command.result,input);
    await createAuditLog({orgId,actorId:auth.user.id,actorEmail:auth.user.email,action:'service_startup_changed',resourceType:'device',resourceId:deviceId,details:{...result,commandId},result:'success'});
    return result;
  }catch(e){
    await createAuditLog({orgId,actorId:auth.user.id,actorEmail:auth.user.email,action:'service_startup_changed',resourceType:'device',resourceId:deviceId,details:{name:input.name,previousStartType:input.expectedStartType,startType:input.startType,commandId},result:'failure',errorMessage:e instanceof Error?e.message:'Startup change failed'});
    throw e;
  }
}
