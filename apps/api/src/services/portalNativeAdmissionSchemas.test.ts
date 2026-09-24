import { describe,it,expect } from 'vitest';
import { nativeConsumeSchema,targetEnrollmentSchema,targetRotationSchema,nativeBytes } from './portalNativeAdmissionSchemas';
const id='11111111-1111-4111-8111-111111111111';
const bytes=(n:number)=>Buffer.alloc(n,1).toString('base64url');
describe('native wire schemas',()=>{
 it('accepts only canonical fixed width secrets and v2 transport proof',()=>{
  const request={version:2,sessionId:id,ticket:bytes(32),connectionId:id,targetChallenge:bytes(32),channelBinding:bytes(32),operatorSignature:bytes(64)};
  expect(nativeConsumeSchema.safeParse(request).success).toBe(true);
  for(const delta of [{version:1},{channelBinding:undefined},{ticket:bytes(32)+'='},{orgId:id},{operatorSignature:bytes(32)},{connectionId:id.toUpperCase()}]) {
   // UUID consists solely of digits in this fixture; use an actually uppercase UUID.
   if('connectionId' in delta) delta.connectionId='AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
   expect(nativeConsumeSchema.safeParse({...request,...delta}).success).toBe(false);
  }
  for(const value of ['',bytes(32)+'=',bytes(31),'!'.repeat(43),'A'.repeat(42)+'B'])expect(nativeBytes(32).safeParse(value).success).toBe(false);
 });
 it('enrolls target-generated secrets and requires explicit compare-and-swap rotation',()=>{
  const request={version:2,installationId:id,targetPublicKey:bytes(32),targetCredential:bytes(32),rustdeskId:'123456789'};
  expect(targetEnrollmentSchema.safeParse(request).success).toBe(true);
  expect(targetEnrollmentSchema.safeParse({...request,expectedGeneration:1}).success).toBe(false);
  expect(targetRotationSchema.safeParse({...request,expectedGeneration:1}).success).toBe(true);
  expect(targetRotationSchema.safeParse({...request,expectedGeneration:0}).success).toBe(false);
 });
});
