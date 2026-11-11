import { describe, expect, it, vi } from 'vitest';
import { createExchangeQuarantineClient } from './exchange-contract';
const binding = { organizationId:'22222222-2222-4222-8222-222222222222', tenantId:'33333333-3333-4333-8333-333333333333',clientId:'44444444-4444-4444-8444-444444444444',credentialVersion:'cert-1',connectionGeneration:1 };
const input={messageTraceId:'55555555-5555-4555-8555-555555555555',recipient:'qa@example.test',received:new Date().toISOString()};
const identity='66666666-6666-4666-8666-666666666666\\77777777-7777-4777-8777-777777777777';
const match={identity,messageId:'<message@example.test>',subject:'QA',sender:'sender@example.test',recipient:input.recipient,released:false};
describe('quarantine boundary',()=>{
 it('accepts unmatched reads and typed exact recipient release with readback',async()=>{
  const dispatch=vi.fn(async(req:any)=>({requestId:req.requestId,ok:true,data:{...input,match:null,checkedAt:input.received}}));
  const client=createExchangeQuarantineClient({dispatch});
  await expect(client(binding,input,false)).resolves.toMatchObject({match:null});
  dispatch.mockImplementation(async(req:any)=>({requestId:req.requestId,ok:true,data:{...input,match:{...match,released:true},checkedAt:input.received,accepted:true,verified:true}} as any));
  await expect(client(binding,{...input,identity},true)).resolves.toMatchObject({verified:true});
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({operation:'quarantine.release.set',parameters:{...input,identity}}));
 });
 it.each([{recipient:'other@example.test'},{identity:identity.replace('66666666','88888888')},{released:false}])('rejects false verified readback %j',async(delta)=>{
  const dispatch=vi.fn(async(req:any)=>({requestId:req.requestId,ok:true,data:{...input,match:{...match,released:true,...delta},checkedAt:input.received,accepted:true,verified:true}}));
  await expect(createExchangeQuarantineClient({dispatch})(binding,{...input,identity},true)).rejects.toMatchObject({code:'unknown_write_outcome'});
  expect(dispatch).toHaveBeenCalledTimes(1);
 });
 it('does not replay dispatched failures or broaden recipient scope',async()=>{
  const dispatch=vi.fn(async()=>{throw new Error('timeout')});const client=createExchangeQuarantineClient({dispatch});
  await expect(client(binding,{...input,identity},true)).rejects.toMatchObject({code:'unknown_write_outcome'});
  expect(dispatch).toHaveBeenCalledTimes(1);
  await expect(client(binding,{...input,identity,releaseToAll:true},true)).rejects.toThrow();
  await expect(client(binding,{...input,identity:input.messageTraceId},true)).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledTimes(1);
 });
 it('preserves denied app permissions without retries',async()=>{
  const dispatch=vi.fn(async(req:any)=>({requestId:req.requestId,ok:false,code:'provider_access_denied'}));
  await expect(createExchangeQuarantineClient({dispatch})(binding,input,false)).rejects.toMatchObject({code:'provider_access_denied'});
  expect(dispatch).toHaveBeenCalledTimes(1);
 });
});
