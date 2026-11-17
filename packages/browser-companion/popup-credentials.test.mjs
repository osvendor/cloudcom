import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from '../ext-credentials/node_modules/happy-dom/lib/index.js';
import {createCredentialsPanel, ACCOUNT_TYPES} from './popup-credentials.js';

const credential = {id:'22222222-2222-4222-8222-222222222222',name:'Email',category:'Email',isAdministration:false,isDraft:true,version:1,hasPassword:true};
function fixture(send) {
  const win=new Window(), root=win.document.createElement('section');
  root.innerHTML='<select id="loginScope"><option value="all">All</option><option value="site">Site</option></select><input id="loginSearch"><div id="loginList"></div>';
  let org='11111111-1111-4111-8111-111111111111';
  const panel=createCredentialsPanel({root,send,context:()=>({orgId:org})});
  return {root,panel,client:value=>{org=value},button:label=>[...root.querySelectorAll('button')].find(b=>b.textContent===label)};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('type-aware editor shows only relevant fields for four account types and sections',async()=>{
  for(const isAdministration of [false,true])for(const category of ACCOUNT_TYPES){
    const f=fixture(async()=>({credentials:[{...credential,category,isAdministration,hasOtp:true}]}));await f.panel.load();if(isAdministration)await f.button('Client administration').onclick();f.button('Email').onclick();
    const visible=isAdministration&&['Email','Application / Cloud'].includes(category);
    assert.equal(f.root.querySelector('[data-field=url]').parentElement.hidden,!visible);
    assert.equal(f.root.querySelector('[data-field=otpSecret]').parentElement.hidden,!visible);
    assert.equal(f.root.querySelector('[data-field=username]').parentElement.querySelector('span').textContent,category==='Local / Domain'?'Username':category==='Network / Wi-Fi'?'Username (optional)':'Username or email');
    f.panel.clear();
  }
});

test('leaving Email clears only known draft default URL and preserves hidden OTP',async()=>{
  for(const url of ['https://admin.microsoft.com','https://custom.example.test']){
    const calls=[];const f=fixture(async m=>{if(m.type==='credentialUpdate'){calls.push(m);return {credential:{...credential,isAdministration:true,url,...m.fields,version:2}}}return {credentials:[{...credential,isAdministration:true,url,hasOtp:true}]}});
    await f.panel.load();await f.button('Client administration').onclick();f.button('Email').onclick();
    const otp=f.root.querySelector('[data-field=otpSecret]');otp.value='unsaved secret';
    const select=f.root.querySelector('[data-field=category]');select.value='Local / Domain';select.onchange();assert.equal(otp.parentElement.hidden,true);assert.equal(otp.value,'unsaved secret');await f.panel.flush();
    assert.equal(calls[0].fields.url,url.includes('microsoft')?'':undefined);assert.equal(Object.hasOwn(calls[0].fields,'otpSecret'),false);f.panel.clear();
  }
});

test('minimal editor uses server email defaults only and preserves full addresses',async()=>{
  const writes=[];const f=fixture(async m=>{
    if(m.type==='credentialCreate')return {credential,value:'Maple!Fox27',emailDefaults:{provider:'google',domain:'example.test'}};
    if(m.type==='credentialUpdate'){writes.push(m);return {credential:{...credential,version:m.version+1,...m.fields}}}return {credentials:[]};
  });
  await f.panel.load();await f.button('＋ Generate password').onclick();
  assert.equal(f.root.querySelector('[data-field=name]'),null);assert.equal(f.root.querySelector('[data-field=isAdministration]'),null);
  assert.match(f.root.textContent,/Google Workspace · @example.test/);
  const input=f.root.querySelector('[data-field=username]');input.value='alice';input.oninput();input.onblur();await f.panel.flush();
  assert.equal(input.value,'alice@example.test');assert.equal(writes.at(-1).fields.username,'alice@example.test');
  input.value='alice@other.test';input.oninput();input.onblur();await f.panel.flush();assert.equal(input.value,'alice@other.test');
  input.value='bob';input.oninput();await f.button('Mark complete').onclick();assert.equal(writes.at(-1).fields.username,'bob@example.test');assert.equal(writes.at(-1).fields.isDraft,false);
  const category=f.root.querySelector('[data-field=category]');category.value='Local / Domain';category.onchange();input.value='localuser';input.oninput();input.onblur();await f.panel.flush();assert.equal(input.value,'localuser');f.panel.clear();
});

test('no email domain is inferred from existing filtered credentials',async()=>{
  const f=fixture(async()=>({credentials:[{...credential,username:'other@other.test'}]}));await f.panel.load();f.button('Email').onclick();
  const input=f.root.querySelector('[data-field=username]');input.value='alice';input.onblur();assert.equal(input.value,'alice');f.panel.clear();
});

test('vault defaults survive filtered lists but clear across clients',async()=>{
  let response={credentials:[credential],emailDefaults:{provider:'microsoft',domain:'example.test'}};
  const f=fixture(async()=>response);await f.panel.load();response={credentials:[credential]};await f.panel.load();f.button('Email').onclick();
  let input=f.root.querySelector('[data-field=username]');input.value='alice';input.onblur();assert.equal(input.value,'alice@example.test');
  f.panel.clear();f.client('other');await f.panel.load();f.button('Email').onclick();input=f.root.querySelector('[data-field=username]');input.value='bob';input.onblur();assert.equal(input.value,'bob');f.panel.clear();
});

test('client switch preparation saves in old org and blocks failure',async()=>{
  for(const fail of [false,true]){
    const calls=[];const f=fixture(async m=>{if(m.type==='credentialUpdate'){calls.push(m);if(fail)throw Error('offline');return {credential:{...credential,version:2}}}return {credentials:[credential]}});
    await f.panel.load();f.button('Email').onclick();const input=f.root.querySelector('[data-field=username]');input.value='Changed';input.oninput();
    assert.equal(await f.panel.prepareClientChange(),!fail);assert.equal(calls[0].expectedOrgId,'11111111-1111-4111-8111-111111111111');
    if(fail)assert.ok(f.button('Reload saved version'));f.panel.clear();
  }
});

test('confirmed regenerate supersedes queued password but preserves later typing',async()=>{
  const calls=[];let finish;const f=fixture(async m=>{if(m.type==='credentialUpdate'){calls.push(m);if(calls.length===1)return new Promise(r=>finish=r);return {credential:{...credential,version:3}}}return {credentials:[credential]}});
  await f.panel.load();f.button('Email').onclick();const input=f.root.querySelector('[data-field=password]');input.value='old typed';input.oninput();
  f.button('Replace password').onclick();assert.deepEqual(calls[0].fields,{generatePassword:true});input.value='new typed';input.oninput();
  finish({credential:{...credential,version:2},value:'Generated!1'});await f.panel.flush();
  assert.equal(input.value,'new typed');assert.equal(calls[1].fields.password,'new typed');f.panel.clear();
});

test('late Show cannot overwrite typing or disclose after hiding panel',async()=>{
  for(const hide of [false,true]){
    let finish;const f=fixture(async m=>m.type==='copySecret'?new Promise(r=>finish=r):{credentials:[credential]});
    await f.panel.load();f.button('Email').onclick();const input=f.root.querySelector('[data-field=password]'),show=f.button('Show');const showing=show.onclick({currentTarget:show});
    if(hide)f.panel.setVisible(false);else {input.value='new typed';input.oninput();}
    finish({value:'Saved!1'});await showing;assert.equal(input.value,hide?'':'new typed');assert.equal(input.type,'password');f.panel.clear();
  }
});

test('editor Copy always copies instead of filling and rejects late client responses',async()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');const copied=[];
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>copied.push(value)}}});
  try {for(const stale of [false,true]){
    const calls=[];let finish;const f=fixture(async m=>{calls.push(m);return m.type==='copySecret'?new Promise(r=>finish=r):{credentials:[credential]}});
    await f.panel.load();f.button('Email').onclick();f.root.querySelector('#loginScope').value='site';const copying=f.button('Copy').onclick();
    if(stale)f.client('different-org');finish({value:'Saved!1'});await copying;
    assert.equal(calls.some(m=>m.type==='fill'),false);assert.equal(copied.length,1);f.panel.clear();
  }}finally{if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;}
});

test('only four types and a generated draft is saved before appearing',async()=>{
  const calls=[];let resolve;
  const f=fixture(async m=>{calls.push(m);if(m.type==='credentialCreate')return new Promise(r=>{resolve=r});return {credentials:[]}});
  await f.panel.load();const creating=f.button('＋ Generate password').onclick();
  assert.equal(f.root.querySelector('.credential-editor').hidden,true);
  resolve({credential,value:'Maple!Fox27'});await creating;
  assert.deepEqual(ACCOUNT_TYPES,['Email','Local / Domain','Application / Cloud','Network / Wi-Fi']);
  assert.equal(f.root.querySelector('[data-field=password]').value,'Maple!Fox27');
  assert.equal(f.root.querySelector('[data-field=password]').type,'password');
  assert.equal(calls[1].isAdministration,false);assert.equal(calls[1].expectedOrgId,'11111111-1111-4111-8111-111111111111');
  f.panel.clear();assert.equal(f.root.innerHTML.includes('Maple!Fox27'),false);assert.equal(f.root.querySelector('[data-field=password]'),null);
});

test('failed create retry preserves request ID rather than generating another password',async()=>{
  const calls=[];let fail=true;
  const f=fixture(async m=>{if(m.type==='credentialCreate'){calls.push(m);if(fail)throw Error('Connection lost');return {credential,value:'Maple!Fox27'}}return {credentials:[]}});
  await f.panel.load();await f.button('＋ Generate password').onclick();assert.match(f.root.textContent,/No new password/);
  fail=false;await f.button('Retry draft').onclick();assert.equal(calls[0].requestId,calls[1].requestId);f.panel.clear();
});

test('autosave serializes revisions and retains edits made during an outstanding save',async()=>{
  const calls=[];let finish;
  const f=fixture(async m=>{if(m.type==='credentialUpdate'){calls.push(m);if(calls.length===1)return new Promise(r=>finish=r);return {credential:{...credential,version:3,...m.fields}}}return {credentials:[credential]}});
  await f.panel.load();f.button('Email').onclick();
  const username=f.root.querySelector('[data-field=username]');username.value='one@example.test';username.oninput();
  const flushing=f.panel.flush();username.value='two@example.test';username.oninput();const waiting=f.panel.flush();assert.equal(calls.length,1);
  finish({credential:{...credential,username:'one@example.test',version:2}});await flushing;await waiting;
  assert.equal(calls.length,2);assert.equal(calls[1].version,2);assert.equal(calls[1].fields.username,'two@example.test');assert.match(f.root.textContent,/✓ Saved/);f.panel.clear();
});

test('failed autosave is visible and blocks automatic overwrites until reload',async()=>{
  let writes=0;const f=fixture(async m=>{if(m.type==='credentialUpdate'){writes++;throw Error('Version changed')}return {credentials:[credential]}});
  await f.panel.load();f.button('Email').onclick();const name=f.root.querySelector('[data-field=username]');name.value='New';name.oninput();await f.panel.flush();
  assert.match(f.root.textContent,/Not saved: Version changed/);name.value='Again';name.oninput();await f.panel.flush();assert.equal(writes,1);
  // Reload is not replaced when an edit is attempted while blocked.
  f.panel.clear();
});

test('client change discards late generated password and old credential response',async()=>{
  let finish;const f=fixture(async m=>m.type==='credentialCreate'?new Promise(r=>finish=r):{credentials:[]});
  await f.panel.load();const creating=f.button('＋ Generate password').onclick();f.client('other');f.panel.clear();finish({credential,value:'Maple!Fox27'});await creating;
  assert.equal(f.root.querySelector('[data-field=password]'),null);assert.equal(f.root.textContent.includes('Draft saved'),false);
});

test('administration selection is explicit and existing passwords regenerate only after confirmation',async()=>{
  const calls=[];const f=fixture(async m=>{calls.push(m);if(m.type==='credentialCreate')return {credential:{...credential,isAdministration:true},value:'Maple!Fox27'};if(m.type==='credentialUpdate')return {credential:{...credential,isAdministration:true,version:2},value:'Pine!Oak39'};return {credentials:[]}});
  await f.panel.load();f.button('Client administration').onclick();await f.button('＋ Generate password').onclick();assert.equal(calls[1].isAdministration,true);
  assert.match(f.root.textContent,/Account \/ tenant administration/);f.button('Regenerate').onclick();assert.equal(calls.length,2);f.button('Replace password').onclick();await tick();assert.equal(calls[2].fields.generatePassword,true);f.panel.clear();
});

test('switching credential sections saves pending edits then clears the secret editor',async()=>{
  let finish;const f=fixture(async m=>m.type==='credentialUpdate'?new Promise(r=>finish=r):{credentials:[{...credential,temporaryPassword:true,isDraft:false}]});
  await f.panel.load();assert.match(f.root.textContent,/Temporary password/);f.button('Email').onclick();
  const input=f.root.querySelector('[data-field=username]');input.value='new@example.test';input.oninput();
  const switching=f.button('Client administration').onclick();assert.equal(f.root.querySelector('.credential-editor').hidden,false);
  finish({credential:{...credential,version:2,username:'new@example.test'}});await switching;
  assert.equal(f.root.querySelector('.credential-editor').hidden,true);assert.equal(f.root.querySelector('[data-field=password]'),null);
  assert.equal(f.button('Client administration').getAttribute('aria-pressed'),'true');f.panel.clear();
});

test('a failed save prevents switching sections and retains reload action',async()=>{
  const f=fixture(async m=>{if(m.type==='credentialUpdate')throw Error('Connection unavailable');return {credentials:[credential]}});
  await f.panel.load();f.button('Email').onclick();const input=f.root.querySelector('[data-field=username]');input.value='Changed';input.oninput();
  await f.button('Client administration').onclick();assert.equal(f.button('User accounts').getAttribute('aria-pressed'),'true');
  assert.equal(f.root.querySelector('.credential-editor').hidden,false);assert.ok(f.button('Reload saved version'));f.panel.clear();
});
