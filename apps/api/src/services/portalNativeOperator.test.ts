import { afterEach,beforeEach,describe,it,expect,vi } from 'vitest';
import type { PortalAuthContext } from '../routes/portal/schemas';
const mocks=vi.hoisted(()=>({get:vi.fn()}));
vi.mock('../db',()=>({runOutsideDbContext:(fn:()=>unknown)=>fn()}));
vi.mock('./redis',()=>({getRedis:()=>({get:mocks.get})}));
vi.mock('./portalNativeAdmission',()=>({nativeSessionHash:()=> 'session-hash'}));
import { authenticateNativeOperator } from './portalNativeOperator';
import { NATIVE_CLIENT_ID } from './portalNativeLogin';
const auth={authMethod:'bearer',token:'ccn1.'+'A'.repeat(43),user:{id:'user',orgId:'org',authEpoch:2,accessMode:'remote_only'}} as PortalAuthContext;
const native=()=>({portalUserId:'user',orgId:'org',authEpoch:2,nativeClientId:NATIVE_CLIENT_ID,
 companyOrgId:'org',companyExpiresAt:Date.now()+30000,nativeExpiresAt:Date.now()+20000});
beforeEach(()=>{vi.stubEnv('CLOUDCOM_COMPANY_GATEWAY_ENABLED','true');mocks.get.mockResolvedValue(JSON.stringify(native()));});
afterEach(()=>vi.unstubAllEnvs());
describe('native operator still requires personal and company authentication',()=>{
 it('bounds presence by the browser-verified company expiry bound into its session',async()=>{
  const result=await authenticateNativeOperator(auth);
  expect(result.expiresAt).toBeLessThanOrEqual(Date.now()+30000);
  expect(result).toMatchObject({id:'user',orgId:'org',authEpoch:2,sessionHash:'session-hash'});
 });
 it.each([{companyOrgId:'other'},{companyOrgId:null},{companyExpiresAt:null},{companyExpiresAt:0},
  {companyExpiresAt:Date.now()-1},{nativeExpiresAt:Date.now()+60_000,companyExpiresAt:Date.now()+30_000}])('denies missing, expired, or wrong company binding',async changes=>{
  mocks.get.mockResolvedValue(JSON.stringify({...native(),...changes}));
  await expect(authenticateNativeOperator(auth)).rejects.toThrow();
 });
 it('never uses the company-disabled shortcut',async()=>{vi.stubEnv('CLOUDCOM_COMPANY_GATEWAY_ENABLED','false');await expect(authenticateNativeOperator(auth)).rejects.toThrow();});
 it.each([{portalUserId:'other'},{orgId:'other'},{authEpoch:1},{nativeExpiresAt:0},{nativeClientId:'other'}])('rejects revoked or rebound native identity',async changes=>{
  mocks.get.mockResolvedValue(JSON.stringify({...native(),...changes}));await expect(authenticateNativeOperator(auth)).rejects.toThrow();
 });
 it('rejects browser sessions and removed native sessions',async()=>{
  await expect(authenticateNativeOperator({...auth,authMethod:'cookie'})).rejects.toThrow();
  mocks.get.mockResolvedValue(null);await expect(authenticateNativeOperator(auth)).rejects.toThrow();
 });
});
