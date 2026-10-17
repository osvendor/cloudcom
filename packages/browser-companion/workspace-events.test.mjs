import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from '../ext-credentials/node_modules/happy-dom/lib/index.js';
import {filterSortEvents,renderEvents} from './workspace-events.js';
const sample=[{recordId:1,eventId:10,timeCreated:'2026-10-01T10:00:00Z',source:'Alpha',level:'information',message:'Started'},{recordId:2,eventId:2,timeCreated:'2026-10-02T10:00:00Z',source:'Beta',level:'error',message:'Failed'}];
test('event page sorting uses numeric IDs, severity order and filtered timestamps',()=>{
 assert.deepEqual(filterSortEvents(sample,{sort:'eventId',direction:1}).map(x=>x.eventId),[2,10]);
 assert.deepEqual(filterSortEvents(sample,{sort:'level',direction:1}).map(x=>x.level),['error','information']);
 assert.equal(filterSortEvents(sample,{search:'fail'})[0].recordId,2);
 assert.equal(filterSortEvents(sample,{from:'2026-10-02T00:00:00Z'})[0].recordId,2);
 assert.equal(filterSortEvents(sample,{to:'2026-10-01T23:59:59Z'}).length,1);
 assert.equal(sample[0].recordId,1);
});
test('event filters encode query and loaded details stay scoped, pagination buttons update',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div'),calls=[];
 const request=async path=>{calls.push(path);if(path.endsWith('eventlogs'))return {data:[{name:'System'},{name:'Application'},{name:'Security'}]};if(path.endsWith('/events/1'))return {data:{...sample[0],message:'<img src=x onerror=alert(1)>',rawXml:'<Event>literal</Event>'}};return {data:sample,meta:{page:path.includes('page=2')?2:1,totalPages:2}};};
 await renderEvents({root,request,devicePath:s=>'/device'+s,status:()=>{},isCurrent:()=>true});
 assert.match(calls.at(-1),/level=warning/);assert.deepEqual([...root.querySelector('select').options].map(x=>x.value),['System','Application']);
 const btn=text=>[...root.querySelectorAll('button')].find(x=>x.textContent===text);
 assert.equal(btn('Previous').disabled,true);assert.equal(btn('Next').disabled,false);
 await btn('Next').onclick();assert.equal(btn('Previous').disabled,false);assert.equal(btn('Next').disabled,true);
 root.querySelector('select').value='Application';
 await [...root.querySelectorAll('.event-message')].find(x=>x.textContent==='Started').onclick();
 assert.equal(calls.at(-1),'/device/eventlogs/System/events/1');assert.equal(root.querySelector('img'),null);assert.match(root.querySelector('.event-full-message').textContent,/<img/);
 root.querySelectorAll('select')[1].value='error';root.querySelector('input[type=number]').value='42';
 await root.querySelectorAll('select')[1].onchange();assert.match(calls.at(-1),/Application\/events\?page=1&limit=50&level=error&eventId=42/);
 assert.equal(root.querySelector('.event-detail').hidden,true);
 const all=root.querySelector('input[type=checkbox]');all.checked=true;await all.onchange();assert.equal(root.querySelector('select').options.length,3);
 root.querySelector('select').value='Security';await root.querySelector('select').onchange();assert.match(calls.at(-1),/Security\/events/);
 assert.equal(btn('Apply filters'),undefined);
});
test('typing filters is debounced and closing the view cancels pending refresh',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div'),calls=[];let dispose,current=true;
 await renderEvents({root,request:async path=>{calls.push(path);return path.endsWith('eventlogs')?{data:[{name:'Application'}]}:{data:[]};},devicePath:s=>'/device'+s,status:()=>{},isCurrent:()=>current,onDispose:fn=>dispose=fn});
 const source=root.querySelector('.event-filters input[type=text]');const baseline=calls.length;source.value='a';source.oninput();source.value='abc';source.oninput();
 await new Promise(resolve=>setTimeout(resolve,460));assert.equal(calls.length,baseline+1);assert.match(calls.at(-1),/source=abc/);
 source.value='abandoned';source.oninput();current=false;dispose();await new Promise(resolve=>setTimeout(resolve,460));assert.equal(calls.length,baseline+1);
});
