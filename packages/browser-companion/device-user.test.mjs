import {test} from 'node:test';import assert from 'node:assert/strict';import {deviceUser} from './device-user.js';
test('current online user takes precedence; offline and logged-out devices use last seen',()=>{
 assert.deepEqual(deviceUser({status:'online',currentUser:'DOMAIN\\Alice',lastUser:'Bob'}),{name:'DOMAIN\\Alice',label:'Current user'});
 assert.deepEqual(deviceUser({status:'online',currentUser:null,lastUser:'Bob'}),{name:'Bob',label:'Last seen user'});
 assert.equal(deviceUser({status:'offline',currentUser:'Alice',lastUser:'Bob'}).label,'Last seen user');
 assert.equal(deviceUser({}).name,'User not reported');
});
