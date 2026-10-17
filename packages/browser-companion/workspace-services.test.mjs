import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from '../ext-credentials/node_modules/happy-dom/lib/index.js';
import {renderServices} from './workspace-processes.js';
const setup=request=>{globalThis.document=new Window().document;const root=document.createElement('div');const messages=[];return {root,request,messages,status:(...m)=>messages.push(m),orgId:'org',deviceId:'device',osType:'windows',devicePath:s=>s,isCurrent:()=>true};};
const service={name:'Service A',displayName:'Test service',status:'running',startType:'auto'};
test('startup dropdown changes configuration only and reports verified success',async()=>{
 const calls=[];const opts=setup(async(path,method,body)=>{calls.push({path,method,body});return method==='POST'?{success:true,startType:body.startType}:{data:[{...service}]};});
 await renderServices(opts);const select=opts.root.querySelector('select');select.value='disabled';await select.onchange();
 assert.deepEqual(calls[1],{path:'/companion-scripts/orgs/org/devices/device/service-startup',method:'POST',body:{name:'Service A',startType:'disabled',expectedStartType:'auto'}});
 assert.equal(calls.length,2);assert.match(opts.messages.at(-1)[0],/Current running state unchanged/);assert.equal(opts.root.querySelector('select').value,'disabled');
});
test('failed or unverified changes revert selection and show failure',async()=>{
 for(const response of [{success:false,error:'Denied'},{success:true}]){
  const opts=setup(async(_p,m)=>m==='POST'?response:{data:[{...service}]});await renderServices(opts);const select=opts.root.querySelector('select');select.value='manual';await select.onchange();
  assert.equal(select.value,'auto');assert.equal(select.disabled,false);assert.equal(opts.messages.at(-1)[1],true);
 }
});
test('startup edits are disabled while a mutation is pending and on non-Windows devices',async()=>{
 let done;const opts=setup(async(_p,m)=>m==='POST'?await new Promise(r=>done=r):{data:[{...service}]});await renderServices(opts);
 const select=opts.root.querySelector('select');select.value='manual';const pending=select.onchange();assert.equal(select.disabled,true);done({success:true,startType:'manual'});await pending;
 const linux=setup(async()=>({data:[{...service}]}));linux.osType='linux';await renderServices(linux);assert.equal(linux.root.querySelector('select').disabled,true);
});
