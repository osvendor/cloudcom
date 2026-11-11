import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from '../ext-credentials/node_modules/happy-dom/lib/index.js';
import {renderScripts} from './workspace-scripts.js';
function setup(){globalThis.document=new Window().document;return document.createElement('div');}
test('one Run performs preflight then executes against the same device and automatic Work ticket',async()=>{
 const root=setup(),calls=[];let latest;
 const request=async(path,method,body)=>{calls.push({path,method,body});if(path.endsWith('/catalog'))return {scripts:[{id:'clear-print-spool'}]};if(method==='POST'){latest={...body,status:'completed',createdAt:'2026-10-08T12:00:00Z',result:{success:true,deletedCount:4}};return {run:latest};}return path.endsWith('/runs')?{runs:[]}:{run:latest};};
 await renderScripts({root,orgId:'o',deviceId:'d',request,status:()=>{},isCurrent:()=>true});
 assert.equal(calls.some(c=>c.method==='POST'),false);await root.querySelector('button').onclick();
 const posts=calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].body.mode,'preview');assert.equal(posts[1].body.previewRequestId,posts[0].body.requestId);assert.equal(posts[1].body.createTicket,true);
 assert.ok(calls.every(c=>c.path.startsWith('/companion-scripts/orgs/o/devices/d/')));assert.equal(root.querySelector('.script-state').textContent,'Successful');assert.notEqual(root.querySelector('time').textContent,'Never run');assert.equal(root.querySelectorAll('button').length,1);assert.equal(root.querySelector('select'),null);assert.equal(root.textContent.includes('files deleted'),false);
});
test('failed preflight prevents execution',async()=>{
 const root=setup(),posts=[];const request=async(p,m,b)=>{if(p.endsWith('/catalog'))return {scripts:[{id:'clear-print-spool'}]};if(m==='POST'){posts.push(b);return {};}return p.endsWith('/runs')?{runs:[]}:{run:{mode:'preview',status:'failed',result:{success:false}}};};
 await renderScripts({root,orgId:'o',deviceId:'d',request,status:()=>{},isCurrent:()=>true});await root.querySelector('button').onclick();assert.equal(posts.length,1);assert.equal(root.querySelector('.script-state').textContent,'Failed');
});
test('uncertain submission reuses its request ID before continuing',async()=>{
 const root=setup(),posts=[];let latest;
 const request=async(p,m,b)=>{if(p.endsWith('/catalog'))return {scripts:[{id:'clear-print-spool'}]};if(m==='POST'){posts.push(b);latest=b;if(posts.length===1)throw Error('timeout');return {};}return p.endsWith('/runs')?{runs:[]}:{run:{...latest,status:'completed',result:{success:true}}};};
 await renderScripts({root,orgId:'o',deviceId:'d',request,status:()=>{},isCurrent:()=>true});const run=root.querySelector('button');await run.onclick();assert.equal(run.textContent,'Check');await run.onclick();assert.deepEqual(posts[0],posts[1]);assert.equal(posts.filter(p=>p.mode==='execute').length,1);
});
test('reopening resumes existing execution but never starts from an old preview; disposal cancels pending preflight',async()=>{
 const root=setup();let timer,dispose,posts=0;
 const opts={root,orgId:'o',deviceId:'d',status:()=>{},isCurrent:()=>true,setTimer:f=>{timer=f;return 1;},cancelTimer:()=>{},onDispose:f=>dispose=f};
 const request=async(p,m,b)=>{if(p.endsWith('/catalog'))return {scripts:[{id:'clear-print-spool'}]};if(m==='POST'){posts++;return {};}if(p.endsWith('/runs'))return {runs:[{requestId:'prior',mode:'preview',status:'completed'}]};return {run:{requestId:'new',mode:'preview',status:'running'}};};
 await renderScripts({...opts,request});assert.equal(posts,0);await root.querySelector('button').onclick();dispose();await timer();assert.equal(posts,1);
 const root2=setup();await renderScripts({...opts,root:root2,request:async(p,m)=>{assert.notEqual(m,'POST');return p.endsWith('/catalog')?{scripts:[{id:'clear-print-spool'}]}:p.endsWith('/runs')?{runs:[{requestId:'existing',mode:'execute',status:'running'}]}:{run:{requestId:'existing',mode:'execute',status:'running'}};}});assert.equal(root2.querySelector('button').disabled,true);assert.equal(root2.querySelector('.script-state').textContent,'Running…');dispose();
});
