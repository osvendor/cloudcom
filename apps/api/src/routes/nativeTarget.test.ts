import { Hono } from 'hono';
import { afterEach,beforeEach,describe,it,expect,vi } from 'vitest';
const mocks=vi.hoisted(()=>({auth:vi.fn(),consume:vi.fn(),renew:vi.fn(),close:vi.fn(),context:vi.fn(async (_:unknown,fn:()=>unknown)=>fn())}));
vi.mock('../db',()=>({withDbAccessContext:mocks.context}));
vi.mock('../services/portalNativeTarget',()=>({authenticateNativeTarget:mocks.auth}));
vi.mock('../services/portalNativeAdmission',()=>({consumeNativeAdmission:mocks.consume,renewNativeAdmission:mocks.renew,closeNativeAdmission:mocks.close}));
vi.mock('../services/redis',()=>({getRedis:()=>({})}));
vi.mock('../services/rate-limit',()=>({rateLimiter:async()=>({allowed:true})}));
vi.mock('../services/clientIp',()=>({getTrustedClientIp:()=> 'test',rateLimitIpKey:()=> 'test'}));
import { nativeTargetRoutes } from './nativeTarget';
const target={id:'target',deviceId:'device',orgId:'org',generation:1,credentialHash:'secret-hash'};
const id='11111111-1111-4111-8111-111111111111',b=(n:number)=>Buffer.alloc(n,1).toString('base64url');
const request={version:2,sessionId:id,connectionId:id,ticket:b(32),targetChallenge:b(32),channelBinding:b(32),operatorSignature:b(64)};
function post(path:string,body:unknown,authorization='Bearer cct1.'+b(32)) {const app=new Hono();app.route('/',nativeTargetRoutes);return app.request(path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:authorization},body:JSON.stringify(body)});}
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('CLOUDCOM_NATIVE_ADMISSION_ENABLED','true');mocks.auth.mockResolvedValue(target);mocks.consume.mockResolvedValue({version:2});});
afterEach(()=>vi.unstubAllEnvs());
describe('target-only admission endpoints',()=>{
 it('defaults off without attempting authentication',async()=>{vi.stubEnv('CLOUDCOM_NATIVE_ADMISSION_ENABLED',undefined);expect((await post('/admissions',request)).status).toBe(404);expect(mocks.auth).not.toHaveBeenCalled();});
 it('requires target authentication before admission',async()=>{mocks.auth.mockResolvedValue(null);expect((await post('/admissions',request)).status).toBe(401);expect(mocks.consume).not.toHaveBeenCalled();});
 it('sets only the resolved target organization database scope',async()=>{expect((await post('/admissions',request)).status).toBe(200);expect(mocks.context).toHaveBeenCalledWith({scope:'organization',orgId:'org',accessibleOrgIds:['org'],userId:null},expect.any(Function));expect(mocks.consume).toHaveBeenCalledWith(target,request);});
 it('rejects caller-selected organization or v1 proof',async()=>{for(const body of [{...request,orgId:'other'},{...request,version:1},{...request,channelBinding:undefined}])expect((await post('/admissions',body)).status).toBe(400);expect(mocks.consume).not.toHaveBeenCalled();});
 it('routes renewals with exact target/connection/session/lease binding',async()=>{mocks.renew.mockResolvedValue({version:2,revision:2,ttlMs:60000});const result=await post('/sessions/'+id+'/renew',{version:2,connectionId:id,leaseToken:b(32)});expect(result.status).toBe(200);expect(mocks.renew).toHaveBeenCalledWith(target,id,id,b(32));});
 it('never exposes internal errors or credentials',async()=>{mocks.auth.mockRejectedValue(new Error('secret credential'));const response=await post('/admissions',request);expect(response.status).toBe(503);expect(await response.text()).not.toContain('credential');});
});
