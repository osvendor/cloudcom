import {test} from 'node:test';
import assert from 'node:assert/strict';
import {secureOrigin,toolUrl} from './policy.js';
test('website origins reject plaintext and embedded credentials',()=>{
 for(const value of ['http://site.test','javascript:alert(1)','https://a:b@site.test','invalid'])assert.equal(secureOrigin(value),null);
 assert.equal(secureOrigin('https://SITE.test:443/login?secret=ignored'),'https://site.test');
 assert.notEqual(secureOrigin('https://site.test.evil.test'),'https://site.test');
});
test('remote tool URLs constrain paths and encode device labels',()=>{
 const d={id:'11111111-1111-4111-8111-111111111111',hostname:'test & x#',osType:'windows'};
 const url=new URL(toolUrl('https://breeze.example.test',d,'events'));
 assert.equal(url.pathname,'/remote/tools');assert.equal(url.hash,'#eventlog');assert.equal(url.searchParams.get('deviceName'),d.hostname);
 assert.throws(()=>toolUrl(url.origin,d,'../evil'));assert.throws(()=>toolUrl(url.origin,{...d,id:'../id'},'files'));
});
