import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Window} from '../ext-credentials/node_modules/happy-dom/lib/index.js';
test('primary tabs preserve the device workspace and client changes discard it',async()=>{
 const win=new Window({url:'chrome-extension://test/popup.html'});globalThis.document=win.document;globalThis.Option=function(text,value){const o=document.createElement('option');o.textContent=text;o.value=value;return o;};
 document.write(await readFile(new URL('./popup.html',import.meta.url),'utf8'));
 const originalTimer=globalThis.setTimeout;globalThis.setTimeout=()=>0;
 const org='one',device={id:'device',hostname:'OS-TEST',status:'online',osType:'windows'};
 globalThis.chrome={windows:{getLastFocused:async()=>({id:1})},runtime:{getURL:p=>'chrome-extension://test'+p,sendMessage:(m,cb)=>cb({ok:true,data:m.type==='status'?{connected:true,clientId:org,clients:[{id:org,name:'One'},{id:'two',name:'Two'}]}:m.type==='devices'?{devices:[device]}:m.type==='openTool'?{workspaceUrl:'chrome-extension://test/workspace.html?workspace=test'}:m.type==='workList'?{items:[]}:m.type==='vaultList'?{credentials:[]}:{}})},tabs:{onActivated:{addListener(){}},onUpdated:{addListener(){}}}};
 try{
 await import('./popup.js');for(let i=0;i<20;i++)await Promise.resolve();
 const tabs=[...document.querySelectorAll('[data-tab]')];assert.deepEqual(tabs.map(x=>x.textContent),['Work','Logins','Devices','Notes']);assert.equal(document.getElementById('backDevices'),null);
 document.getElementById('deviceSelect').value='device';document.getElementById('deviceSelect').onchange();for(let i=0;i<20;i++)await Promise.resolve();
 const frame=document.getElementById('toolFrame'),src=frame.getAttribute('src');assert.ok(src,document.getElementById('message').textContent+' options '+document.getElementById('deviceSelect').innerHTML);
 tabs.find(x=>x.dataset.tab==='logins').click();assert.equal(frame.getAttribute('src'),src);assert.ok(document.getElementById('toolPanel').classList.contains('hidden'));
 tabs.find(x=>x.dataset.tab==='devices').click();assert.equal(frame.getAttribute('src'),src);assert.equal(document.getElementById('toolPanel').classList.contains('hidden'),false);
 document.getElementById('client').value='two';await document.getElementById('client').onchange();assert.equal(frame.getAttribute('src'),null);
 }finally{globalThis.setTimeout=originalTimer;}
});


