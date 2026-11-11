import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from '../ext-credentials/node_modules/happy-dom/lib/index.js';
import {parseRegistryData} from './workspace-ui.js';
import {renderTasks,renderEvents} from './workspace-events-tasks.js';
import {renderFiles} from './workspace-files.js';
const setup=request=>{const win=new Window();globalThis.document=win.document;globalThis.confirm=()=>true;const root=document.createElement('div');document.body.append(root);return {root,request,devicePath:s=>'/device'+s,status:()=>{},isCurrent:()=>true};};
const click=async(root,text)=>{const b=[...root.querySelectorAll('button')].find(b=>b.textContent===text);assert.ok(b,text);await b.onclick();};
test('registry input rejects precision loss and parses binary and multi-string values',()=>{
 assert.throws(()=>parseRegistryData('REG_QWORD','9007199254740992'),/safely/);
 assert.throws(()=>parseRegistryData('REG_DWORD','4294967296'),/large/);
 assert.equal(parseRegistryData('REG_DWORD','4294967295'),4294967295);
 assert.deepEqual(parseRegistryData('REG_BINARY','00 ff 80'),[0,255,128]);
 assert.deepEqual(parseRegistryData('REG_MULTI_SZ','one\ntwo'),['one','two']);
});
test('task history is shown and mutations retain the selected task path',async()=>{
 const calls=[];const opts=setup(async(path,method)=>{calls.push([path,method]);return path.includes('history')?{data:[{result:'Success',time:'test-time'}]}:{data:[{path:'\\Folder\\Task',state:'Ready'}],meta:{totalPages:2}};});
 await renderTasks(opts);await click(opts.root,'History');assert.match(opts.root.textContent,/Success/);
 await click(opts.root,'Run');assert.deepEqual(calls.at(-1),['/device/tasks/%5CFolder%5CTask/run','POST']);
 await click(opts.root,'Next');assert.match(calls.at(-1)[0],/page=2/);
});
test('event details remain bound to their loaded log when dropdown changes',async()=>{
 const calls=[];const opts=setup(async path=>{calls.push(path);return path.endsWith('eventlogs')?{data:[{name:'System'},{name:'Application'}]}:{data:[{recordId:7,message:'hello'}]};});
 await renderEvents(opts);opts.root.querySelector('select').value='Application';await opts.root.querySelector('.event-message').onclick();assert.equal(calls.at(-1),'/device/eventlogs/System/events/7');
});
test('drive browsing renders file names and preserves source paths for copy',async()=>{
 const calls=[];const opts=setup(async(path,method,body)=>{calls.push({path,method,body});if(path.endsWith('drives'))return {data:[{mountPoint:'C:\\',label:'System'}]};return {path:'C:\\',data:[{name:'test.txt',type:'file',size:4}]};});
 await renderFiles(opts);await click(opts.root,'Open');assert.match(opts.root.textContent,/test.txt/);await click(opts.root,'Copy');opts.root.querySelector('form input').value='C:\\copy.txt';await click(opts.root,'Confirm copy');assert.deepEqual(calls.at(-1).body,{items:[{sourcePath:'C:\\test.txt',destPath:'C:\\copy.txt'}]});
});
