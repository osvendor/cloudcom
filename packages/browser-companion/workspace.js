import {renderProcesses,renderServices} from './workspace-processes.js';
import {renderEvents,renderTasks} from './workspace-events-tasks.js';
import {renderRegistry} from './workspace-registry.js';
import {renderScripts} from './workspace-scripts.js';
import {renderFiles} from './workspace-files.js';
import {renderTerminal} from './workspace-terminal.js';
import {renderIPScan} from './workspace-network.js';
const $=s=>document.querySelector(s);
let context,revision=0,dispose=()=>{};
let panelWindowId;
chrome.windows.getLastFocused({windowTypes:['normal']}).then(w=>{panelWindowId=w.id;}).catch(()=>{});
const send=async message=>{
  const response=await chrome.runtime.sendMessage(message);
  if(!response?.ok)throw new Error(response?.error||'Request unavailable');
  return response.data;
};
function status(message,bad=false){const el=$('[data-region="status"]');el.textContent=message;el.classList.toggle('error',bad);}
async function loadTool(tool){
  const current=++revision;
  dispose();dispose=()=>{};
  const root=document.createElement('div');
  $('[data-region="tool-content"]').replaceChildren(root);
  document.querySelectorAll('[data-tool]').forEach(b=>{const active=b.dataset.tool===tool;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});
  const isCurrent=()=>current===revision;
  // Each render owns its DOM and immutable device context. Late responses
  // cannot render into or issue commands through another view.
  const selected=context;
  const title=document.getElementById("workspaceTitle");if(title)title.textContent=`${selected.clientName} · ${selected.device.displayName||selected.device.hostname} · ${tool==='terminal'?(selected.shell||'Terminal'):tool==='events'?'Event Viewer':tool.charAt(0).toUpperCase()+tool.slice(1)}`;
  let mutation=false;
  const request=async(path,method='GET',body)=>{
    if(!isCurrent())throw new Error('This tool view is no longer active.');
    if(method!=='GET'&&mutation)throw new Error('Wait for the current action to finish.');
    if(method!=='GET')mutation=true;
    try{const result=await send({type:'toolRequest',path,method,body});if(result?.success===false||result?.testResult?.success===false)throw new Error(result.error||'Action failed');return result;}
    finally{if(method!=='GET')mutation=false;}
  };
  const opts={osType:selected.device.osType,orgId:selected.orgId,deviceName:selected.device.displayName||selected.device.hostname,clientName:selected.clientName,embedded:window.parent!==window,openFullView:async()=>{const view=await send({type:'openWorkspace',tool});if(isCurrent())await chrome.tabs.create({url:view.workspaceUrl});},shell:selected.shell,root,isCurrent,request,deviceId:selected.device.id,onDispose:fn=>{dispose=fn;},endSession:id=>send({type:'toolRequest',path:`/remote/sessions/${id}/end`,method:'POST'}),devicePath:suffix=>`/system-tools/devices/${selected.device.id}${suffix}`,status:(text,bad)=>{if(isCurrent())status(text,bad);}};
  try{
    if(tool==='desktop'){
      const {launchUri}=await send({type:'desktop'});
      if(!isCurrent())return;
      if(launchUri!=='cloudcom-remote://staff/connect/'+selected.device.id)throw new Error('Invalid desktop launch');
      location.href=launchUri;status('Opening RustDesk…');return;
    }
    const render={processes:renderProcesses,services:renderServices,ipscan:renderIPScan,events:renderEvents,tasks:renderTasks,registry:renderRegistry,files:renderFiles,scripts:renderScripts,terminal:renderTerminal}[tool];
    if(!render)throw new Error('Unknown tool.');
    await render(opts);
  }catch(error){if(isCurrent())status(error.message,true);}
}
async function init(){
  try{
    context=await send({type:'workspaceContext'});
    document.body.classList.toggle('embedded',window.parent!==window);
    if(window.parent===window){const h=document.createElement('h2');h.id='workspaceTitle';h.textContent=`${context.clientName} · ${context.device.displayName||context.device.hostname} · ${context.shell||context.tool}`;document.querySelector('main').prepend(h);}
    const select=document.getElementById('toolSelect');
    for(const option of select.options)option.disabled=['services','events','registry','tasks','scripts'].includes(option.value)&&context.device.osType!=='windows';
    select.value=context.tool||'processes';select.onchange=()=>loadTool(select.value);
    await loadTool(context.tool||'processes');
  }catch(error){status(error.message,true);}
}
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='session'&&changes.companionSession){revision++;dispose();$('[data-region="tool-content"]').replaceChildren();status('Sign-in changed. Reopen this workspace from Devices.',true);}
});
window.addEventListener('pagehide',()=>{revision++;dispose();});
init();
