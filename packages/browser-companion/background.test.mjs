import {test} from 'node:test';
import assert from 'node:assert/strict';
test('worker permits only popup, binds client and document, and never returns secrets to popup',async()=>{
 let listener,removed,stored={companionSession:{accessToken:'ccb1.'+'t'.repeat(43),expiresAt:Date.now()+3600000}},active={id:2,url:'https://login.example.test/signin'},secretReads=0,executions=[],opened=[];
 const id='a'.repeat(32),org='11111111-1111-4111-8111-111111111111',credential='22222222-2222-4222-8222-222222222222';
 globalThis.chrome={runtime:{id,getURL:p=>'chrome-extension://'+id+'/'+p,onMessage:{addListener:f=>listener=f}},storage:{session:{get:async()=>stored,set:async v=>{stored={...stored,...v}},remove:async k=>{delete stored[k]},clear:async()=>{stored={}}}},tabs:{onRemoved:{addListener:f=>removed=f},query:async q=>q.active?[active]:[{id:1,url:'https://breeze.example.invalid/extensions/credentials/browser-companion'}],remove:async()=>removed(),update:async()=>{},create:async v=>{opened.push(v)}},scripting:{executeScript:async input=>{executions.push(input);return [{documentId:'document-1',result:input.args[0]==='inspect'?{ok:true,index:0,url:active.url}:{ok:true}}];}}};
 globalThis.fetch=async(url,options)=>{
  const r=JSON.parse(options.body);
  if(url.endsWith('/logout'))return Response.json({success:true});
  if(r.path==='/credentials/browser/clients')return Response.json({clients:[{id:org,name:'Synthetic'}]});
  if(r.path.startsWith('/companion-work/'))return Response.json({item:{id:'work'}});
  if(r.path.includes('/devices?'))return Response.json({devices:[{id:'33333333-3333-4333-8333-333333333333',hostname:'Test',status:'online',osType:'windows'}],canRemote:true,canTools:true});
  if(r.path.includes('/documents'))return Response.json({documents:[]});
  if(r.path.endsWith('/reveal'))return Response.json({value:'synthetic-copy'});
  if(r.path.includes('/fill')){secretReads++;return Response.json({value:'synthetic-only'});}
  if(r.path.includes('/credentials?'))return Response.json({credentials:[{id:credential,hasPassword:true}]});
  throw new Error('Unexpected route');
 };
 await import('./background.js');
 const sender={id,url:chrome.runtime.getURL('popup.html')};
 const send=message=>new Promise(resolve=>listener(message,sender,resolve));
 assert.equal(listener({type:'fill'},{...sender,tab:{id:9}},()=>{}),false);
 assert.equal(listener({type:'status'},{id:'evil',url:sender.url},()=>{}),false);
 assert.equal((await send({type:'credentials'})).ok,false);
 assert.equal((await send({type:'selectClient',clientId:org})).ok,true);
 assert.equal((await send({type:'credentials'})).ok,true);
 active={...active,url:'https://evil.example.test'};
 assert.equal((await send({type:'fill',credentialId:credential,field:'password'})).ok,false);assert.equal(secretReads,0);
 active={id:2,url:'https://login.example.test/signin'};
 const filled=await send({type:'fill',credentialId:credential,field:'password'});
 assert.deepEqual(filled,{ok:true,data:{ok:true}});assert.equal(secretReads,1);
 assert.deepEqual(executions[1].target,{tabId:2,documentIds:['document-1']});
 assert.equal(executions[1].args[3],'synthetic-only');
 assert.equal(JSON.stringify(stored).includes('synthetic-only'),false);
 active={id:2,url:'https://breeze.example.invalid/'};
 assert.equal((await send({type:'vaultList',query:''})).ok,true);
 assert.equal((await send({type:'notesList',query:''})).ok,true);
 assert.deepEqual(await send({type:'copySecret',credentialId:credential,field:'password'}),{ok:true,data:{value:'synthetic-copy',expiresAt:undefined}});
 assert.equal((await send({type:'copySecret',credentialId:'foreign',field:'password'})).ok,false);
 assert.equal(JSON.stringify(stored).includes('synthetic-copy'),false);
 await send({type:'selectClient',clientId:org});
 assert.equal((await send({type:'copySecret',credentialId:credential,field:'password'})).ok,false);
 await send({type:'devices',query:''});
 assert.equal((await send({type:'openTool',deviceId:'33333333-3333-4333-8333-333333333333',tool:'webrtc'})).ok,true);
 assert.equal(new URL(opened[0].url).searchParams.get('next'),'/remote/desktop/33333333-3333-4333-8333-333333333333');
 assert.equal((await send({type:'openTool',deviceId:'44444444-4444-4444-8444-444444444444',tool:'webrtc'})).ok,false);
 assert.equal(opened.length,1);
 stored.deviceCache.expires=0;
 assert.equal((await send({type:'openTool',deviceId:'33333333-3333-4333-8333-333333333333',tool:'webrtc'})).ok,true);
 assert.equal(opened.length,2);
 await send({type:'lock'});assert.deepEqual(stored,{});assert.equal((await send({type:'fill',credentialId:credential,field:'password'})).ok,false);
});


