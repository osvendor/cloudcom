import {describe,it,expect} from 'vitest';
import {companionCallSchema,classifyCompanionCall} from './browserCompanionPolicy';
const orgId='11111111-1111-4111-8111-111111111111',deviceId='22222222-2222-4222-8222-222222222222';
const classify=(path:string,method='GET',body?:unknown)=>classifyCompanionCall(companionCallSchema.parse({orgId,deviceId,path,method,body}));
describe('companion transport allowlist',()=>{
  it('binds tool paths to the explicitly selected device',()=>{
    expect(classify(`/system-tools/devices/${deviceId}/processes?limit=500`)?.kind).toBe('device');
    expect(classify(`/system-tools/devices/${orgId}/processes`)).toBeNull();
    expect(classify(`/staff-native/launch/${deviceId}`,'POST')?.kind).toBe('device');
  });
  it.each(['//evil.example/path','/../auth','/system-tools/../auth','/auth','/scripts','/browser-companion/request',`/system-tools/devices/${deviceId}/processes#x`,`/system-tools/devices/${deviceId}/processes?orgId=${orgId}`])('rejects unapproved path %s',path=>expect(classify(path)).toBeNull());
  it('permits only explicit terminal creation, not desktop or another device',()=>{
    expect(classify('/remote/sessions','POST',{deviceId,type:'terminal'})?.kind).toBe('device');
    expect(classify('/remote/sessions','POST',{deviceId:orgId,type:'terminal'})).toBeNull();
    expect(classify('/remote/sessions','POST',{deviceId,type:'desktop'})).toBeNull();
    expect(classify('/remote/sessions','POST',{deviceId,type:'terminal',orgId})).toBeNull();
  });
  it('does not allow workspace requests to read credentials',()=>{
    expect(classify(`/credentials/browser/orgs/${orgId}/credentials`)).toBeNull();
    expect(classifyCompanionCall({orgId,method:'GET',path:`/credentials/browser/orgs/${deviceId}/credentials`})).toBeNull();
    expect(classifyCompanionCall({orgId,method:'GET',path:`/credentials/browser/orgs/${orgId}/credentials`})?.kind).toBe('client');
  });
  it('restricts destructive operations to named methods and routes',()=>{
    expect(classify(`/system-tools/devices/${deviceId}/services/Spooler/stop`,'POST')?.kind).toBe('device');
    expect(classify(`/system-tools/devices/${deviceId}/services/Spooler/stop`)).toBeNull();
    expect(classify(`/system-tools/devices/${deviceId}/files/trash/purge`,'POST')).toBeNull();
  });
});

it('bounds companion scripts to the envelope client/device and exact operations',()=>{
 const base=`/companion-scripts/orgs/${orgId}/devices/${deviceId}`;
 expect(classify(base+'/runs','POST')?.kind).toBe('device');
 expect(classify(base+'/catalog')?.kind).toBe('device');
 expect(classify(base+'/service-startup','POST')?.kind).toBe('device');
 expect(classify(base+'/service-startup','GET')).toBeNull();
 expect(classify(base.replace(orgId,deviceId)+'/service-startup','POST')).toBeNull();
 expect(classify(base.replace(orgId,deviceId)+'/runs','POST')).toBeNull();
 expect(classify(base+'/runs/'+orgId,'DELETE')).toBeNull();
});

it('limits Work requests to the selected client and exact endpoints',()=>{
 const base=`/companion-work/orgs/${orgId}`;
 for(const method of ['GET','POST'] as const){
  expect(classifyCompanionCall({orgId,method,path:base})?.kind).toBe('client');
  expect(classifyCompanionCall({orgId,method,path:base+'/'+deviceId})?.kind).toBe('client');
 }
 expect(classifyCompanionCall({orgId,method:'DELETE',path:base+'/'+deviceId})).toBeNull();
 expect(classifyCompanionCall({orgId,method:'GET',path:base.replace(orgId,deviceId)})).toBeNull();
 expect(classifyCompanionCall({orgId,deviceId,method:'GET',path:base})).toBeNull();
 expect(classifyCompanionCall({orgId,method:'GET',path:base+'/anything/else'})).toBeNull();
});

 it('allows only selected-client vault disclosure and document reads',()=>{
 const base=`/credentials/orgs/${orgId}`;
 for(const path of [base+'/credentials',base+'/documents',base+'/documents/'+deviceId])expect(classifyCompanionCall({orgId,method:'GET',path})?.kind).toBe('client');
 for(const action of ['reveal','otp'])expect(classifyCompanionCall({orgId,method:'POST',path:base+'/credentials/'+deviceId+'/'+action})?.kind).toBe('client');
 for(const path of [base+'/import/commit',base+'/documents/'+deviceId+'/download',`/credentials/orgs/${deviceId}/documents`])expect(classifyCompanionCall({orgId,method:'GET',path})).toBeNull();
 expect(classify(base+'/credentials')).toBeNull();
 });

it('allows only selected-device network scan routes',()=>{
 const base=`/system-tools/devices/${deviceId}/network-scan`;
 expect(classify(base+'/networks')?.kind).toBe('device');
 expect(classify(base,'POST')?.kind).toBe('device');
 expect(classify(base+'/runs/'+orgId)?.kind).toBe('device');
 expect(classify(base+'/networks','POST')).toBeNull();
 expect(classify(base+'/runs/not-a-run')).toBeNull();
 expect(classify(`/system-tools/devices/${orgId}/network-scan`,'POST')).toBeNull();
});
