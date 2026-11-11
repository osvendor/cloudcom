import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from '../ext-credentials/node_modules/happy-dom/lib/index.js';
import {registryAddress,registryPlan,renderRegistry} from './workspace-registry.js';
const setup=async()=>{const win=new Window();globalThis.document=win.document;let active=true;const calls=[];const root=document.createElement('div');document.body.append(root);const opts={root,deviceName:'TEST-PC',clientName:'Test client',devicePath:s=>'/device'+s,isCurrent:()=>active,status:()=>{},request:async(path,method='GET',body)=>{calls.push({path,method,body});return {data:[]};}};await renderRegistry(opts);return {root,calls,opts,expire:()=>active=false};};
const click=async(root,label)=>{const b=[...root.querySelectorAll('button')].find(x=>x.textContent===label);assert.ok(b,label);await b.onclick();};
test('address and plan bind exact path and preserve strict numeric/binary parsing',()=>{
 assert.deepEqual(registryAddress('HKLM\\Software\\Example'),{hive:'HKEY_LOCAL_MACHINE',path:'Software\\Example'});
 const t={hive:'HKLM',path:'Software'};assert.equal(registryPlan('new-key',t,{name:'Example'}).body.path,'Software\\Example');
 assert.throws(()=>registryPlan('new-key',t,{name:'one\\two'}),/subkey/);assert.throws(()=>registryPlan('delete-key',{hive:'HKLM',path:''}),/hives/);
 assert.throws(()=>registryPlan('new-value',t,{name:'n',type:'REG_QWORD',data:'9007199254740992'}),/safely/);
 assert.deepEqual(registryPlan('new-value',t,{name:'n',type:'REG_BINARY',data:'ff 00'}).body.data,[255,0]);
});
test('new key requires preview then apply, names target, and Cancel makes no mutation',async()=>{
 const {root,calls}=await setup();await click(root,'New key');root.querySelector('form input').value='Example';await click(root,'Preview change');assert.match(root.querySelector('[role=dialog]').textContent,/TEST-PC/);assert.match(root.querySelector('[role=dialog]').textContent,/HKEY_LOCAL_MACHINE\\SOFTWARE\\Example/);assert.equal(calls.filter(x=>x.method!=='GET').length,0);await click(root,'Cancel');assert.equal(calls.filter(x=>x.method!=='GET').length,0);
});
test('back retains draft and apply writes only the frozen preview target once',async()=>{
 const {root,calls}=await setup();await click(root,'New key');root.querySelector('form input').value='Example';await click(root,'Preview change');await click(root,'Back');assert.equal(root.querySelector('form input').value,'Example');await click(root,'Preview change');const apply=[...root.querySelectorAll('button')].find(x=>x.textContent==='Apply change');await Promise.all([apply.onclick(),apply.onclick()]);assert.deepEqual(calls.filter(x=>x.method!=='GET'),[{path:'/device/registry/key',method:'POST',body:{hive:'HKEY_LOCAL_MACHINE',path:'SOFTWARE\\Example'}}]);
});
test('expired view never writes',async()=>{
 const {root,calls,expire}=await setup();await click(root,'New key');root.querySelector('form input').value='Example';await click(root,'Preview change');expire();await click(root,'Apply change');assert.equal(calls.filter(x=>x.method!=='GET').length,0);
});
test('target created by another actor is rejected at preflight',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div');document.body.append(root);let collision=false;const writes=[];await renderRegistry({root,devicePath:x=>x,isCurrent:()=>true,status:()=>{},request:async(path,method='GET')=>{if(method!=='GET')writes.push(path);return {data:collision&&path.includes('/keys?')?[{name:'Example',path:'SOFTWARE\\Example'}]:[]};}});await click(root,'New key');root.querySelector('form input').value='Example';await click(root,'Preview change');collision=true;await click(root,'Apply change');assert.match(root.querySelector('[role=alert]').textContent,/already exists/);assert.equal(writes.length,0);
});
