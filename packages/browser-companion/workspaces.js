import {apiRequest} from './session.js';
const prefix='workspace:';
export function workspaceId(url){
  const u=new URL(url);
  if(u.origin!==new URL(chrome.runtime.getURL('/')).origin||u.pathname!=='/workspace.html')throw new Error('Workspace unavailable');
  const id=u.searchParams.get('workspace')||u.hash.slice(1);
  if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('Choose a device from the extension.');
  return id;
}
export async function contextFor(url){
  const id=workspaceId(url),key=prefix+id;
  const context=(await chrome.storage.session.get(key))[key];
  if(!context)throw new Error('This workspace has expired. Choose a device again.');
  return context;
}
export async function openWorkspace(context,mode){
  const id=crypto.randomUUID(),key=prefix+id;
  await chrome.storage.session.set({[key]:context});
  // A query change reloads an already-open side panel; a hash change does not.
  const path='workspace.html?workspace='+id;
  return {workspaceUrl:chrome.runtime.getURL(path)};
}
export async function ensureWork(context){
  return apiRequest({orgId:context.orgId,path:`/companion-work/orgs/${context.orgId}`,method:'POST',body:{deviceId:context.device.id}});
}
export async function desktop(context){
  await ensureWork(context);
  const result=await apiRequest({orgId:context.orgId,deviceId:context.device.id,path:'/staff-native/launch/'+context.device.id,method:'POST'});
  const expected='cloudcom-remote://staff/connect/'+context.device.id;
  if(result.launchUrl!==expected)throw new Error('Invalid desktop launch response');
  return {launchUri:expected};
}
export async function workspaceMessage(message,sender){
  const context=await contextFor(sender.url);
  if(message.type==='workspaceContext')return context;
  if(message.type==='openWorkspace'){
    const tool=message.tool||context.tool;
    if(!['processes','services','ipscan','events','tasks','registry','files','terminal','scripts'].includes(tool))throw new Error('Unsupported tool');
    return openWorkspace({...context,tool},message.mode);
  }
  if(message.type==='desktop')return desktop(context);
  if(message.type==='toolRequest'){
    let body=message.body;
    const scriptRun=message.path===`/companion-scripts/orgs/${context.orgId}/devices/${context.device.id}/runs`;
    if((message.method||'GET')!=='GET'&&!(scriptRun&&(body?.mode==='preview'||body?.ticketId&&!body?.createTicket))){
      const work=await ensureWork(context);
      if(scriptRun&&body?.mode==='execute'&&body.createTicket){
        if(!work?.item?.id)throw Error('Work ticket could not be created.');
        body={...body,ticketId:work.item.id};delete body.createTicket;
      }
    }
    const result=await apiRequest({orgId:context.orgId,deviceId:context.device.id,path:message.path,method:message.method||'GET',body});
    if(result?.success===false||result?.testResult?.success===false)throw new Error(result.error||'The device could not complete the action.');
    return result;
  }
  throw new Error('Unsupported workspace action');
}
