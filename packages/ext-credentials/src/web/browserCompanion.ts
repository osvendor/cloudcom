import type { ExtensionHostApi } from '@breeze/extension-web-sdk';
const ID=/^[0-9a-f-]{36}$/i;
export function companionRequest(input: unknown): {path:string;init?:RequestInit} | null {
  if(!input || typeof input!=='object')return null;
  const v=input as Record<string,unknown>;
  if(v.action==='clients')return {path:'/browser/clients'};
  if(typeof v.orgId!=='string'||!ID.test(v.orgId))return null;
  const path=`/browser/orgs/${v.orgId}`;
  if(v.action==='devices' && typeof v.query==='string' && v.query.length<=200)return {path:`${path}/devices?q=${encodeURIComponent(v.query)}`};
  if(typeof v.origin!=='string'||v.origin.length>2048)return null;
  let u:URL;try{u=new URL(v.origin);}catch{return null;}
  if(u.protocol!=='https:'||u.origin!==v.origin)return null;
  if(v.action==='credentials' && typeof v.query==='string' && v.query.length<=200)return {path:`${path}/credentials?origin=${encodeURIComponent(v.origin)}&q=${encodeURIComponent(v.query)}`};
  if(v.action==='fill' && typeof v.credentialId==='string' && ID.test(v.credentialId) && ['username','password','otp'].includes(String(v.field)))return {path:`${path}/credentials/${v.credentialId}/fill`,init:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin:v.origin,field:v.field})}};
  return null;
}
export class BrowserCompanionPage extends HTMLElement {
  private root=this.attachShadow({mode:'open'});
  private api:ExtensionHostApi|null=null;
  private enabled=false;
  private revision=0;
  private ports=new Set<MessagePort>();
  set hostApi(value:ExtensionHostApi|null){this.disconnect();this.api=value;this.render();}
  set context(_value:unknown){/* Client choice is explicit in the companion; server validates every request. */}
  connectedCallback(){window.addEventListener('message',this.handshake);this.render();}
  disconnectedCallback(){window.removeEventListener('message',this.handshake);this.disconnect();}
  private disconnect(){this.enabled=false;this.revision++;for(const p of this.ports)p.close();this.ports.clear();}
  private handshake=(event:MessageEvent)=>{
    if(!this.enabled||event.source!==window||event.origin!==location.origin||location.pathname!=='/extensions/credentials/browser-companion'||event.data?.type!=='cloudcom-companion-port-v1'||event.ports.length!==1)return;
    const port=event.ports[0];if(this.ports.size>=8){port.close();return;}this.ports.add(port);
    port.onmessage=async message=>{
      const revision=this.revision,request=companionRequest(message.data);
      if(!request||!this.api||!this.enabled){port.postMessage({ok:false,error:'Companion is locked'});this.ports.delete(port);port.close();return;}
      try{
        const response=await this.api.request(request.path,{...request.init,cache:'no-store'});
        if(revision!==this.revision||!this.enabled)return;
        if(!response.ok){port.postMessage({ok:false,error:response.status===401?'Sign in to Breeze again':response.status===403?'Your staff permissions or verification do not allow this action':'Request unavailable'});return;}
        const data=await response.json();if(revision===this.revision&&this.enabled)port.postMessage({ok:true,data});
      }catch{if(revision===this.revision)port.postMessage({ok:false,error:'Breeze connection unavailable'});}
      finally{this.ports.delete(port);port.close();}
    };port.start();port.postMessage({ready:true});
  };
  private render(){
    this.root.replaceChildren();const main=document.createElement('main');main.style.cssText='max-width:680px;padding:24px;font:14px system-ui';
    const params=new URLSearchParams(location.search);
    const extensionId=params.get('extensionId'),challenge=params.get('challenge'),state=params.get('state');
    if(extensionId||challenge||state){
      const h=document.createElement('h1');h.textContent='Sign in to OS Companion';
      const p=document.createElement('p');p.textContent='Use your current staff permissions in the Edge extension for this browser session. This window closes after sign-in; no Breeze tab needs to stay open.';
      const status=document.createElement('p');status.setAttribute('role','status');
      const button=document.createElement('button');button.textContent='Continue to OS Companion';button.style.cssText='font:inherit;padding:10px 16px;cursor:pointer';
      button.disabled=!extensionId?.match(/^[a-p]{32}$/)||!challenge?.match(/^[A-Za-z0-9_-]{43}$/)||!state?.match(/^[A-Za-z0-9_-]{43}$/);
      button.onclick=async()=>{if(!this.api)return;button.disabled=true;try{
        const response=await this.api.request('/browser/authorize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({extensionId,challenge,state}),cache:'no-store'});
        if(!response.ok)throw new Error();const result=await response.json();const callback=new URL(result.redirectUri);
        if(callback.origin!==`https://${extensionId}.chromiumapp.org`||callback.pathname!=='/companion'||callback.searchParams.get('state')!==state||!callback.searchParams.get('code')?.match(/^[A-Za-z0-9_-]{43}$/))throw new Error();
        location.assign(callback.href);
      }catch{status.textContent='Staff sign-in could not be authorized. Check that this extension is registered and try again.';button.disabled=false;}};
      main.append(h,p,status,button);this.root.append(main);return;
    }
    const h=document.createElement('h1');h.textContent='Edge companion';
    const p=document.createElement('p');p.textContent='Keep this tab open to use the staff Edge extension. It uses your Breeze session and client permissions without copying your sign-in token into the extension.';
    const status=document.createElement('p');status.setAttribute('role','status');status.textContent=this.enabled?'Connected bridge enabled. The Edge toolbar is ready.':'Bridge locked.';
    const button=document.createElement('button');button.textContent=this.enabled?'Lock companion':'Enable companion';button.style.cssText='font:inherit;padding:10px 16px;cursor:pointer';
    button.onclick=async()=>{if(this.enabled){this.disconnect();this.render();return;}if(!this.api)return;button.disabled=true;try{const r=await this.api.request('/browser/clients',{cache:'no-store'});if(!r.ok)throw new Error();this.enabled=true;this.render();}catch{status.textContent='Verified staff access is required. Sign in to Breeze and try again.';button.disabled=false;}};
    main.append(h,p,status,button);this.root.append(main);
  }
}
if(!customElements.get('cloudcom-browser-companion-page'))customElements.define('cloudcom-browser-companion-page',BrowserCompanionPage);
