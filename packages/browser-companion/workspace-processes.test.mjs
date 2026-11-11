import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from '../ext-credentials/node_modules/happy-dom/lib/index.js';
import {renderProcesses} from './workspace-processes.js';
test('process polling updates CPU and RAM, pauses, and stops on disposal',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div');let timer,dispose,calls=0;const messages=[];
 const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
 globalThis.setTimeout=(fn,ms)=>{assert.equal(ms,5000);timer=fn;return 1;};globalThis.clearTimeout=()=>{timer=null;};
 try{
 await renderProcesses({root,request:async()=>({data:[{pid:1,name:'test.exe',cpuPercent:++calls*10,memoryMb:calls*20}]}),devicePath:s=>s,status:m=>messages.push(m),isCurrent:()=>true,onDispose:fn=>dispose=fn});
 assert.match(root.textContent,/10.0/);assert.match(messages.at(-1),/Updated/);await timer();assert.match(root.textContent,/20.0/);assert.match(root.textContent,/40.0/);assert.equal(calls,2);
 const auto=root.querySelector('input[type=checkbox]');auto.checked=false;auto.onchange();assert.equal(timer,null);auto.checked=true;await auto.onchange();await Promise.resolve();assert.equal(calls,3);dispose();assert.equal(timer,null);
 }finally{globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
});
test('failed refresh reports stale readings and stops automatic requests',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div');let status;
 await renderProcesses({root,request:async()=>{throw Error('Offline');},devicePath:s=>s,status:m=>status=m,isCurrent:()=>true});
 assert.match(status,/readings may be stale/);assert.equal(root.querySelector('input[type=checkbox]').checked,false);
});
