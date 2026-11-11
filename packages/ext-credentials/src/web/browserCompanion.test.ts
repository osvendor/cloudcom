import {describe,it,expect} from 'vitest';
import {companionRequest} from './browserCompanion';
const orgId='11111111-1111-4111-8111-111111111111';
describe('companion bridge operation allowlist',()=>{
 it('exposes only fixed staff endpoints',()=>{
  expect(companionRequest({action:'clients'})).toEqual({path:'/browser/clients'});
  expect(companionRequest({action:'devices',orgId,query:'a&b'})).toEqual({path:`/browser/orgs/${orgId}/devices?q=a%26b`});
 });
 it.each([{action:'fetch',path:'/auth/refresh'},{action:'devices',orgId:'../other',query:''},{action:'fill',orgId,origin:'http://example.test',credentialId:orgId,field:'password'},{action:'fill',orgId,origin:'https://example.test',credentialId:orgId,field:'notes'},{action:'credentials',orgId,origin:'https://example.test/path',query:''}])('rejects arbitrary requests %j',input=>expect(companionRequest(input)).toBeNull());
 it('passes no arbitrary properties into secret requests',()=>{const r=companionRequest({action:'fill',orgId,origin:'https://example.test',credentialId:orgId,field:'password',headers:{Authorization:'bad'}});expect(r?.init?.body).toBe(JSON.stringify({origin:'https://example.test',field:'password'}));expect(r?.init?.headers).toEqual({'Content-Type':'application/json'});});
});
