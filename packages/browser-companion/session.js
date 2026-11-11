import {BREEZE_ORIGIN,BRIDGE_PATH} from './config.js';
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const random=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
let generation=0,loginPending=null;
async function post(path,body,token){
  const response=await fetch(BREEZE_ORIGIN+'/api/v1/browser-companion/'+path,{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  const type=response.headers.get('Content-Type')||'';
  if(response.status!==204&&!type.includes('application/json'))throw new Error('The companion service is unavailable.');
  const data=response.status===204?{}:await response.json();if(!response.ok)throw new Error(typeof data.error==='string'?data.error:'Request unavailable.');return data;
}
export async function signIn(){
  if(loginPending)return loginPending;
  const current=++generation;
  loginPending=(async()=>{
    const verifier=random(),state=random(),challenge=b64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
    const url=new URL(BRIDGE_PATH,BREEZE_ORIGIN);url.searchParams.set('extensionId',chrome.runtime.id);url.searchParams.set('challenge',challenge);url.searchParams.set('state',state);
    // Enter LoginPage directly: the dashboard auth guard can drop the return
    // URL on a fresh session, stranding identity flow on the dashboard.
    const login=new URL('/login',BREEZE_ORIGIN);login.searchParams.set('next',url.pathname+url.search);
    let timer;
    const result=await Promise.race([
      chrome.identity.launchWebAuthFlow({url:login.href,interactive:true}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Sign-in timed out. Close the sign-in window and try again.')),180000);}),
    ]).finally(()=>clearTimeout(timer));
    if(!result)throw new Error('Sign-in cancelled.');
    const callback=new URL(result),expected=new URL(chrome.identity.getRedirectURL('companion'));
    if(callback.origin!==expected.origin||callback.pathname!==expected.pathname||callback.searchParams.get('state')!==state||!callback.searchParams.get('code')?.match(/^[A-Za-z0-9_-]{43}$/))throw new Error('Invalid sign-in response.');
    const session=await post('exchange',{code:callback.searchParams.get('code'),verifier,extensionId:chrome.runtime.id});
    const now=Date.now(),localMaximum=now+12*3600000;
    // Server expiry remains authoritative on every request. Permit ordinary
    // clock skew here, but never retain a local session longer than 12 hours.
    if(!/^ccb1\.[A-Za-z0-9_-]{43}$/.test(session.accessToken)||!Number.isSafeInteger(session.expiresAt)||session.expiresAt<=now||session.expiresAt>localMaximum+60000)throw new Error('Invalid session.');
    session.expiresAt=Math.min(session.expiresAt,localMaximum);
    if(current!==generation){await post('logout',{},session.accessToken).catch(()=>{});throw new Error('Sign-in cancelled.');}
    await chrome.storage.session.set({companionSession:session});return {};
  })().finally(()=>{loginPending=null;});return loginPending;
}
export async function signOut(){
  generation++;const {companionSession}=await chrome.storage.session.get('companionSession');
  await chrome.storage.session.clear();
  if(companionSession?.accessToken)await post('logout',{},companionSession.accessToken);
}
export async function apiRequest(input){
  const {companionSession}=await chrome.storage.session.get('companionSession');
  if(!companionSession||companionSession.expiresAt<=Date.now()){await chrome.storage.session.remove('companionSession');throw new Error('Sign in to OS Companion.');}
  const result=await post('request',input,companionSession.accessToken);
  const current=(await chrome.storage.session.get('companionSession')).companionSession;
  if(current?.accessToken!==companionSession.accessToken)throw new Error('The signed-in account changed.');
  return result;
}
export function browserRequest(input){
  const base=`/credentials/browser/orgs/${input.orgId}`;
  const vaultBase=`/credentials/orgs/${input.orgId}`;
  const workBase=`/companion-work/orgs/${input.orgId}`;
  if(input.action==='workList')return apiRequest({orgId:input.orgId,path:workBase});
  if(input.action==='workCreate')return apiRequest({orgId:input.orgId,path:workBase,method:'POST',body:{deviceId:input.deviceId,subject:input.subject}});
  if(input.action==='workUpdate')return apiRequest({orgId:input.orgId,path:workBase+'/'+input.ticketId,method:'POST',body:{action:input.workAction,...(input.workAction==='autoClose'?{enabled:input.enabled}:input.workAction==='rename'?{subject:input.subject}:{})}});
  if(input.action==='notesList')return apiRequest({orgId:input.orgId,path:vaultBase+'/documents?q='+encodeURIComponent(input.query)});
  if(input.action==='notesRead')return apiRequest({orgId:input.orgId,path:vaultBase+'/documents/'+input.documentId});
  if(input.action==='vaultList')return apiRequest({orgId:input.orgId,path:vaultBase+'/credentials?q='+encodeURIComponent(input.query)});
  if(input.action==='copySecret')return apiRequest({orgId:input.orgId,path:vaultBase+'/credentials/'+input.credentialId+'/'+(input.field==='otp'?'otp':'reveal'),method:'POST',body:input.field==='otp'?{}:{field:'password'}});
  if(input.action==='clients')return apiRequest({path:'/credentials/browser/clients'});
  if(input.action==='devices')return apiRequest({orgId:input.orgId,path:base+'/devices?q='+encodeURIComponent(input.query)});
  if(input.action==='credentials')return apiRequest({orgId:input.orgId,path:base+'/credentials?origin='+encodeURIComponent(input.origin)+'&q='+encodeURIComponent(input.query)});
  if(input.action==='fill')return apiRequest({orgId:input.orgId,path:base+'/credentials/'+input.credentialId+'/fill',method:'POST',body:{origin:input.origin,field:input.field}});
  throw new Error('Unsupported action');
}
