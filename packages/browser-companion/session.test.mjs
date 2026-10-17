import {test} from 'node:test';
import assert from 'node:assert/strict';
import {signIn,signOut,apiRequest} from './session.js';
test('PKCE browser session survives worker reload and rejects stale or tampered authorization',async()=>{
  let stored={},calls=[],badState=false;
  const id='a'.repeat(32),token='ccb1.'+'b'.repeat(43);
  globalThis.chrome={runtime:{id},storage:{session:{get:async()=>stored,set:async v=>{stored={...stored,...v}},clear:async()=>{stored={}},remove:async k=>{delete stored[k]}}},identity:{getRedirectURL:p=>`https://${id}.chromiumapp.org/${p}`,launchWebAuthFlow:async({url})=>{
    const login=new URL(url);assert.equal(login.pathname,'/login');
    const u=new URL(login.searchParams.get('next'),login.origin);assert.equal(u.pathname,'/extensions/credentials/browser-companion');assert.equal(u.searchParams.get('extensionId'),id);assert.equal(u.searchParams.get('challenge').length,43);
    return `https://${id}.chromiumapp.org/companion?code=${'c'.repeat(43)}&state=${badState?'wrong':u.searchParams.get('state')}`;
  }}};
  globalThis.fetch=async(url,options)=>{
    calls.push({url,options});
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);
    if(url.endsWith('/exchange')){assert.equal(body.verifier.length,43);return Response.json({accessToken:token,expiresAt:Date.now()+3600000});}
    assert.equal(options.headers.Authorization,'Bearer '+token);
    return Response.json({clients:[]});
  };
  await signIn();assert.equal(stored.companionSession.accessToken,token);
  const reloaded=await import('./session.js?worker-restarted');
  assert.deepEqual(await reloaded.apiRequest({path:'/credentials/browser/clients'}),{clients:[]});
  await signOut();assert.deepEqual(stored,{});
  await assert.rejects(apiRequest({path:'/credentials/browser/clients'}),/Sign in/);
  badState=true;const before=calls.length;await assert.rejects(signIn(),/Invalid sign-in/);assert.equal(calls.length,before);
});
test('logout during a request prevents returning its result',async()=>{
  let stored={companionSession:{accessToken:'ccb1.'+'b'.repeat(43),expiresAt:Date.now()+3600000}};
  chrome.storage.session.get=async()=>stored;
  globalThis.fetch=async()=>{stored={};return Response.json({value:'synthetic'});};
  await assert.rejects(apiRequest({path:'/credentials/browser/clients'}),/account changed/);
});
test('timed out identity flow can be retried and late callback cannot exchange or store',async()=>{
  let stored={},exchangeCalls=0,resolveLate;const realSetTimeout=globalThis.setTimeout;
  const id='c'.repeat(32);globalThis.chrome={runtime:{id},storage:{session:{get:async()=>stored,set:async v=>{stored={...stored,...v}},clear:async()=>{stored={}}}},identity:{getRedirectURL:p=>`https://${id}.chromiumapp.org/${p}`,launchWebAuthFlow:async()=>new Promise(r=>{resolveLate=r})}};
  globalThis.fetch=async()=>{exchangeCalls++;return Response.json({accessToken:'ccb1.'+'x'.repeat(43),expiresAt:Date.now()+1000});};
  globalThis.setTimeout=(fn)=>{fn();return 1};
  await assert.rejects(signIn(),/timed out/i);assert.deepEqual(stored,{});assert.equal(exchangeCalls,0);
  globalThis.setTimeout=realSetTimeout;resolveLate?.(`https://${id}.chromiumapp.org/companion?code=${'d'.repeat(43)}&state=late`);await new Promise(r=>realSetTimeout(r,0));assert.deepEqual(stored,{});assert.equal(exchangeCalls,0);
  globalThis.chrome.identity.launchWebAuthFlow=async()=>{throw new Error('retry cancelled')};await assert.rejects(signIn(),/retry cancelled/);globalThis.setTimeout=realSetTimeout;
});
test('accepts one second server skew on a full grant but rejects excessive lifetime',async()=>{
  let stored={},expiresOffset=12*60*60*1000+1000;const id='e'.repeat(32),token='ccb1.'+'z'.repeat(43);
  globalThis.chrome={runtime:{id},storage:{session:{get:async()=>stored,set:async v=>{stored={...stored,...v}},clear:async()=>{stored={}}}},identity:{getRedirectURL:p=>`https://${id}.chromiumapp.org/${p}`,launchWebAuthFlow:async({url})=>{const u=new URL(new URL(url).searchParams.get('next'), url);return `https://${id}.chromiumapp.org/companion?code=${'q'.repeat(43)}&state=${u.searchParams.get('state')}`}}};
  globalThis.fetch=async()=>Response.json({accessToken:token,expiresAt:Date.now()+expiresOffset});
  const started=Date.now();await signIn();assert.ok(stored.companionSession.expiresAt<=started+12*60*60*1000+2500);await signOut();expiresOffset=12*60*60*1000+61000;await assert.rejects(signIn(),/session|expiry|lifetime/i);assert.deepEqual(stored,{});
});
