import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from '../ext-credentials/node_modules/happy-dom/lib/index.js';
import {createNotesPanel} from './popup-notes.js';
import {websiteField} from './policy.js';
test('notes show original selectable rows without reveal controls',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div');
 const panel=createNotesPanel({root,context:()=>({orgId:'one'}),send:async m=>m.type==='notesList'?{documents:[{id:'doc',name:'Test notes'}]}:{document:{name:'Test notes'},sheets:[{name:'Page',rows:[{row:1,cells:[{column:'A',text:'Password'},{column:'B',text:'synthetic-secret'}]}]}]}});
 await panel.load();
 assert.ok(root.textContent.includes('synthetic-secret'));
 assert.equal(root.querySelectorAll('.notes-notepad button').length,0);
 assert.equal(root.querySelector('[contenteditable]'),null);
 panel.clear();assert.equal(root.textContent.includes('synthetic-secret'),false);
});
test('notes discard responses from a previous client',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div');let finish;
 const panel=createNotesPanel({root,context:()=>({orgId:'one'}),send:()=>new Promise(r=>finish=r)});const loading=panel.load();panel.clear();finish({documents:[{id:'old',name:'Other tenant'}]});await loading;assert.equal(root.textContent.includes('Other tenant'),false);
});

test('all client documents load directly and a failed document can retry independently',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div');let fail=true;
 const reads=[];
 const panel=createNotesPanel({root,context:()=>({orgId:'one'}),send:async m=>{
  if(m.type==='notesList') return {documents:[{id:'a',name:'First'},{id:'b',name:'Second'},{id:'c',name:'Third'}]};
  reads.push(m.documentId);if(m.documentId==='b'&&fail)throw new Error('unavailable');
  return {sheets:[{name:'Page',rows:[{row:1,cells:[{column:'A',text:`Content ${m.documentId}`}]}]}]};
 }});
 await panel.load();assert.deepEqual(reads,['a','b','c']);assert.match(root.textContent,/Content a/);assert.match(root.textContent,/Content c/);
 assert.equal(root.querySelector('.notes-open'),null);assert.equal(root.textContent.includes('Back to notes'),false);
 fail=false;await root.querySelector('button').onclick();assert.match(root.textContent,/Content b/);assert.match(root.textContent,/Content a/);
});
test('fill selects focused matching field and refuses a cross-origin form',()=>{
 const win=new Window({url:'https://login.example.test/'});Object.assign(globalThis,{document:win.document,location:win.location,HTMLInputElement:win.HTMLInputElement,Event:win.Event,getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})});
 document.body.innerHTML='<form><input type="password"><input type="password"></form>';
 for(const el of document.querySelectorAll('input'))el.getBoundingClientRect=()=>({width:100,height:30});
 document.querySelectorAll('input')[1].focus();
 const inspection=websiteField('inspect',location.href,'password');assert.equal(inspection.ok,true);assert.equal(inspection.index,1);
 assert.equal(websiteField('fill',location.href,'password','synthetic-only',inspection.index).ok,true);
 assert.equal(document.querySelectorAll('input')[0].value,'');assert.equal(document.querySelectorAll('input')[1].value,'synthetic-only');
 document.querySelector('form').action='https://other.example.test/';assert.equal(websiteField('inspect',location.href,'password').ok,false);
});



test('images appear at their source rows and columns with safe image handling and cleanup',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div');
 const create=URL.createObjectURL,revoke=URL.revokeObjectURL,revoked=[];let count=0;
 URL.createObjectURL=()=>`blob:test-${++count}`;URL.revokeObjectURL=url=>revoked.push(url);
 try {
 const panel=createNotesPanel({root,context:()=>({orgId:'one'}),send:async m=>m.type==='notesList'?{documents:[{id:'doc',name:'Example'}]}:{sheets:[{name:'Page',rows:[{row:3,cells:[{column:'A',text:'After image'}]},{row:1,cells:[{column:'A',text:'Before image'}]},{row:2,cells:[{column:'C',text:'Right of image'}]}],images:[{row:2,column:'B',mimeType:'image/png',dataBase64:'iVBORw0KGgo='},{row:4,column:'A',mimeType:'image/svg+xml',dataBase64:'PHN2Zz4='}]}]}});
 await panel.load();
 const rows=root.querySelectorAll('.notes-source-row');assert.equal(rows[0].textContent,'Before image');assert.ok(rows[1].firstElementChild.querySelector('img'));assert.equal(rows[1].lastElementChild.textContent,'Right of image');assert.equal(rows[2].textContent,'After image');assert.match(rows[3].textContent,/unavailable/);assert.equal(count,1);
 panel.setVisible(false);assert.deepEqual(revoked,['blob:test-1']);assert.equal(root.querySelector('img'),null);
 }finally{URL.createObjectURL=create;URL.revokeObjectURL=revoke;}
});

test('opening notes cannot restore content after changing clients',async()=>{
 const win=new Window();globalThis.document=win.document;const root=document.createElement('div');let finish;
 const panel=createNotesPanel({root,context:()=>({orgId:'one'}),send:async m=>m.type==='notesList'?{documents:[{id:'doc',name:'Example'}]}:new Promise(r=>finish=r)});
 const opening=panel.load();await new Promise(r=>setTimeout(r,0));panel.clear();finish({sheets:[{name:'Other client',rows:[{row:1,cells:[{column:'A',text:'Must not appear'}]}]}]});await opening;assert.equal(root.textContent.includes('Must not appear'),false);
});

