import {BREEZE_ORIGIN} from './config.js';
import {secureOrigin,websiteField,TOOLS} from './policy.js';
import {browserRequest as request,signIn,signOut} from './session.js';
import {openWorkspace,desktop,workspaceMessage,ensureWork} from './workspaces.js';
let revision=0,credentialCache=null,deviceCache=null,vaultCache=null;
const clean=()=>{revision++;credentialCache=null;deviceCache=null;vaultCache=null;};
const fail=message=>{throw new Error(message);};
async function selected(){return (await chrome.storage.session.get('clientId')).clientId||'';}
async function target(){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id||!secureOrigin(tab.url)||secureOrigin(tab.url)===BREEZE_ORIGIN)fail('Open the secure website you want to sign in to.');return tab;}
async function client(){const id=await selected();if(!id)fail('Choose a client first.');return id;}
async function handle(message){
  if(message.type==='connect'){clean();await signIn();return {};}
  if(message.type==='lock'){clean();await signOut();return {};}
  if(message.type==='status'){
    let siteOrigin='';try{siteOrigin=secureOrigin((await target()).url)||'';}catch{}
    try{const data=await request({action:'clients'});const id=await selected();if(id&&!data.clients.some(c=>c.id===id)){clean();await chrome.storage.session.remove('clientId');}return {connected:true,origin:BREEZE_ORIGIN,siteOrigin,clients:data.clients,clientId:await selected()};}
    catch{return {connected:false,origin:BREEZE_ORIGIN,siteOrigin,clients:[]};}
  }
  if(message.type==='selectClient'){clean();const rev=revision;await chrome.storage.session.remove('clientId');const data=await request({action:'clients'});if(rev!==revision)fail('Client changed. Try again.');if(!data.clients.some(c=>c.id===message.clientId))fail('Client unavailable');await chrome.storage.session.set({clientId:message.clientId});return {};}
  const orgId=await client(),rev=revision;
  const check=()=>{if(rev!==revision)fail('Client changed. Search again.');};
  if(['notesList','notesRead','vaultList'].includes(message.type)){
    if(message.type==='notesRead'&&!/^[0-9a-f-]{36}$/i.test(message.documentId||''))fail('Note unavailable');
    const data=await request({action:message.type,orgId,query:String(message.query||'').slice(0,200),documentId:message.documentId});check();
    if(message.type==='vaultList')vaultCache={orgId,ids:new Set((data.credentials||[]).map(c=>c.id)),expires:Date.now()+120000};
    return data;
  }
  if(message.type==='copySecret'){
    if(!vaultCache||vaultCache.orgId!==orgId||vaultCache.expires<Date.now()||!vaultCache.ids.has(message.credentialId)||!['password','otp'].includes(message.field))fail('Search client logins again.');
    const data=await request({action:'copySecret',orgId,credentialId:message.credentialId,field:message.field});check();
    if(data.expiresAt&&Date.parse(data.expiresAt)<=Date.now()+1000)fail('Code expired. Try again.');
    return {value:data.value??data.code,expiresAt:data.expiresAt};
  }
  if(message.type==='credentials'){
    credentialCache=null;const tab=await target(),origin=secureOrigin(tab.url);
    const data=await request({action:'credentials',orgId,origin,query:String(message.query||'').slice(0,200)});check();
    credentialCache={orgId,tabId:tab.id,url:tab.url,origin,ids:new Set(data.credentials.map(x=>x.id)),expires:Date.now()+120000};return data;
  }
  if(message.type==='devices'){deviceCache=null;const data=await request({action:'devices',orgId,query:String(message.query||'').slice(0,200)});check();deviceCache={orgId,...data,expires:Date.now()+120000};await chrome.storage.session.set({deviceCache});return data;}
  if(['workList','workCreate','workUpdate'].includes(message.type)){const data=await request({action:message.type,orgId,deviceId:message.deviceId,subject:message.subject,ticketId:message.ticketId,workAction:message.action,enabled:message.enabled});check();return data;}
  if(message.type==='openTool'){
    let cache=deviceCache||(await chrome.storage.session.get('deviceCache')).deviceCache;
    let device=cache?.devices.find(d=>d.id===message.deviceId);
    if(cache?.orgId===orgId&&device&&cache.expires<Date.now()){
      const data=await request({action:'devices',orgId,query:device.hostname||device.displayName||''});check();
      cache=deviceCache={orgId,...data,expires:Date.now()+120000};await chrome.storage.session.set({deviceCache});device=cache.devices.find(d=>d.id===message.deviceId);
    }
    if(!cache||cache.orgId!==orgId||cache.expires<Date.now()||!device||!TOOLS.includes(message.tool))fail('Search devices again.');
    if(device.status!=='online'||!(['desktop','webrtc'].includes(message.tool)?cache.canRemote:cache.canTools))fail('Remote access is unavailable.');
    if(['cmd','powershell','services','registry','events','tasks','scripts'].includes(message.tool)&&device.osType!=='windows')fail('This tool requires Windows.');
    const clients=await request({action:'clients'});check();
    const current=clients.clients.find(c=>c.id===orgId);if(!current)fail('Client unavailable');
    const context={orgId,clientName:current.name,device,tool:message.tool};
    if(message.tool==='webrtc'){await ensureWork(context);check();await chrome.tabs.create({url:new URL('/login?next='+encodeURIComponent('/remote/desktop/'+device.id),BREEZE_ORIGIN).href,active:true});return {}; }
    if(['cmd','powershell','registry'].includes(message.tool)){context.shell=message.tool==='cmd'?'cmd':message.tool==='powershell'?'powershell':undefined;context.tool=message.tool==='registry'?'registry':'terminal';const view=await openWorkspace(context,'embedded');await chrome.tabs.create({url:view.workspaceUrl,active:true});return {launched:true};}
    return message.tool==='desktop'?desktop(context):openWorkspace(context,'embedded');
  }
  if(message.type==='fill'){
    const cache=credentialCache,tab=await target();
    if(!cache||cache.orgId!==orgId||cache.expires<Date.now()||cache.tabId!==tab.id||cache.url!==tab.url||!cache.ids.has(message.credentialId)||!['username','password','otp'].includes(message.field))fail('The client or page changed. Search logins again.');
    const [inspection]=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},func:websiteField,args:['inspect',cache.url,message.field]});
    if(!inspection?.result?.ok||!inspection.documentId)fail(inspection?.result?.error||'Login field unavailable');
    const data=await request({action:'fill',orgId,credentialId:message.credentialId,origin:cache.origin,field:message.field});check();
    if(data.expiresAt&&Date.parse(data.expiresAt)<=Date.now()+1000)fail('The code expired. Try again.');
    if((await target()).id!==tab.id)fail('The active tab changed.');check();
    const [filled]=await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[inspection.documentId]},func:websiteField,args:['fill',cache.url,message.field,data.value,inspection.result.index]});
    if(!filled?.result?.ok)fail(filled?.result?.error||'Could not fill the field');return {ok:true};
  }
  fail('Unsupported action');
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id)return false;
  const windowActions=['status','connect','lock','selectClient','devices','openTool','workList','workCreate','workUpdate'];
  const popup=sender.url===chrome.runtime.getURL('popup.html')&&(!sender.tab||windowActions.includes(message.type));
  let workspace=false;try{const u=new URL(sender.url);workspace=u.origin===new URL(chrome.runtime.getURL('/')).origin&&u.pathname==='/workspace.html';}catch{}
  if(!popup&&!workspace)return false;
  const action=popup?handle(message):workspaceMessage(message,sender);
  action.then(data=>respond({ok:true,data}),error=>respond({ok:false,error:error instanceof Error?error.message:'Action unavailable'}));return true;
});
// Closing a website invalidates a pending fill, never the browser session.
chrome.tabs.onRemoved.addListener(()=>{clean();});

// One persistent surface; toolbar clicks never create a popup or another workspace.
chrome.sidePanel?.setOptions({path:'popup.html',enabled:true}).catch(()=>{});
chrome.sidePanel?.setPanelBehavior({openPanelOnActionClick:true}).catch(()=>{});
