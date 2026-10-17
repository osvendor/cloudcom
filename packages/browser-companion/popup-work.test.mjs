import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from '../ext-credentials/node_modules/happy-dom/lib/index.js';
import {createWorkPanel,timelineSummary} from './popup-work.js';
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('compact work row expands, closes, and toggles auto-close without exposing activity by default',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div'),calls=[];let timer;
 const item={id:'ticket',subject:'Printer stuck',ticketNumber:'3000',status:'open',autoClose:false,activities:[{label:'Spooler restarted',at:'2026-10-08T12:00:00Z',state:'success'}]};
 const view=createWorkPanel({root,context:()=>({orgId:'org',deviceId:'device'}),send:async m=>{calls.push(m);return {items:[item]};},message:()=>{},setTimer:f=>{timer=f;return 1},cancelTimer:()=>{timer=null}});
 await view.load();assert.equal(root.querySelectorAll('.work-row').length,1);assert.equal(root.querySelector('.work-detail'),null);assert.match(root.querySelector('.work-summary').textContent,/Spooler restarted/);
 root.querySelector('.work-open').click();assert.equal(root.querySelector('.work-open').getAttribute('aria-expanded'),'true');const auto=root.querySelector('.work-auto input');auto.checked=true;await auto.onchange();assert.ok(calls.some(m=>m.type==='workUpdate'&&m.action==='autoClose'&&m.enabled));
 await root.querySelector('.work-close').onclick();assert.ok(calls.some(m=>m.action==='close'));view.setVisible(false);assert.equal(timer,null);view.dispose();
});
test('client switch drops late work response and problem content is rendered as text',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div');let finish;const view=createWorkPanel({root,context:()=>({orgId:'org'}),send:()=>new Promise(r=>finish=r),message:()=>{},setTimer:()=>1,cancelTimer:()=>{}});
 const loading=view.load();view.clear('Other client');finish({items:[{id:'old',subject:'Old client',status:'open'}]});await loading;assert.equal(root.textContent.includes('Old client'),false);view.dispose();
 assert.match(timelineSummary([{label:'Stopped',state:'failure',at:'invalid'}]),/failed/);
});
test('new work requires selected device and uses its explicit context',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div');let context={orgId:'org'},notice;const calls=[];
 const view=createWorkPanel({root,context:()=>context,send:async m=>{calls.push(m);return {items:[]}},message:m=>notice=m,setTimer:()=>1,cancelTimer:()=>{}});
 root.querySelector('input').value='Printer stuck';await root.querySelector('form').onsubmit({preventDefault(){}});assert.match(notice,/device first/);assert.equal(calls.length,0);
 context.deviceId='device';await root.querySelector('form').onsubmit({preventDefault(){}});assert.deepEqual(calls[0],{type:'workCreate',deviceId:'device',subject:'Printer stuck'});view.dispose();
});
test('failed auto-close restores server value and a pending mutation suppresses polling',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div');let finish,timer,reads=0,notice;
 const item={id:'ticket',subject:'Issue',status:'open',autoClose:false,activities:[]};
 const view=createWorkPanel({root,context:()=>({orgId:'org'}),send:async m=>{if(m.type==='workUpdate')return new Promise((_r,reject)=>finish=reject);reads++;return {items:[item]};},message:m=>notice=m,setTimer:f=>{timer=f;return 1},cancelTimer:()=>{timer=null}});
 await view.load();root.querySelector('.work-open').click();const auto=root.querySelector('.work-auto input');auto.checked=true;const pending=auto.onchange();await view.load();assert.equal(reads,1);assert.equal(timer,null);finish(Error('Denied'));await pending;assert.equal(auto.checked,false);assert.equal(notice,'Denied');view.dispose();
});
