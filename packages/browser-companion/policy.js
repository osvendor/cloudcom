export const TOOLS = ['webrtc','desktop','cmd','powershell','processes','services','ipscan','registry','events','tasks','terminal','files','scripts'];
export function secureOrigin(value) {
  try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.origin:null;}catch{return null;}
}
export function toolUrl(origin,device,tool) {
  if(!TOOLS.includes(tool)||!device||!/^[0-9a-f-]{36}$/i.test(device.id))throw new Error('Device unavailable');
  const url=new URL('/remote/tools',origin);
  url.searchParams.set('deviceId',device.id);url.searchParams.set('deviceName',device.displayName||device.hostname);url.searchParams.set('os',device.osType);
  url.hash=tool==='events'?'eventlog':tool==='desktop'?'processes':tool;
  return url.href;
}
/** Runs in the isolated world of the selected top-level document; never submits forms. */
export function websiteField(operation,expectedUrl,field,value="",expectedIndex=-1) {
  if(location.href!==expectedUrl||location.protocol!=='https:')return {ok:false,error:'The page changed. Search again.'};
  const inputs=[...document.querySelectorAll('input')];
  const candidates=inputs.filter(input=>{
    const style=getComputedStyle(input),rect=input.getBoundingClientRect();
    if(input.disabled||input.readOnly||input.type==='hidden'||!rect.width||!rect.height||style.visibility!=='visible'||style.display==='none'||style.opacity==='0')return false;
    const autocomplete=input.autocomplete.toLowerCase();
    if(field==='password')return input.type==='password'&&!autocomplete.includes('new-password');
    if(field==='otp')return autocomplete==='one-time-code'||input===document.activeElement&&['text','tel','number'].includes(input.type);
    return ['text','email','tel'].includes(input.type)&&(input===document.activeElement||autocomplete==='username'||autocomplete==='email'||input.type==='email'||/^(username|user|email|login|loginfmt)$/i.test(input.name)||/^(username|email|loginfmt)$/i.test(input.id));
  });
  const focused=candidates.find(input=>input===document.activeElement);
  if(focused)candidates.splice(0,candidates.length,focused);
  if(candidates.length!==1)return {ok:false,error:'Could not identify one login field. Select a supported login page.'};
  const input=candidates[0],index=inputs.indexOf(input);
  // Refuse credential transmission through an explicitly insecure/cross-origin form.
  if(input.form){try{const action=new URL(input.form.action||location.href,location.href);if(action.origin!==location.origin)return {ok:false,error:'The form submits to a different website.'};}catch{return {ok:false,error:'Invalid form destination'};}}
  if(operation==='inspect')return {ok:true,index,url:location.href};
  if(index!==expectedIndex||typeof value!=='string')return {ok:false,error:'Login field changed. Search again.'};
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
  input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
  return {ok:true};
}
