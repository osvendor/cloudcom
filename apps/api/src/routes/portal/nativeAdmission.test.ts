import { Hono } from 'hono';
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
const mocks=vi.hoisted(()=>({auth:vi.fn(),issue:vi.fn(),presence:vi.fn(),end:vi.fn()}));
vi.mock('../../services/portalNativeOperator',()=>({authenticateNativeOperator:mocks.auth}));
vi.mock('../../services/portalNativeAdmission',()=>({issueNativeAdmission:mocks.issue,touchNativePresence:mocks.presence,endNativeAdmission:mocks.end}));
vi.mock('./remoteRateLimit',()=>({portalRemoteStartRateLimit:async(_:unknown,next:()=>unknown)=>next()}));
import { portalNativeAdmissionRoutes } from './nativeAdmission';
import { NativeAdmissionError } from '../../services/portalNativeAdmissionSchemas';
const id='11111111-1111-4111-8111-111111111111';const operator={id:'user',orgId:'org',authEpoch:2,sessionHash:'hash',expiresAt:Date.now()+60000};
function post(path:string,body:unknown){const app=new Hono();app.use('*',async(c,next)=>{c.set('portalAuth',{token:'native'} as never);await next();});app.route('/',portalNativeAdmissionRoutes);return app.request(path,{method:'POST',headers:{'Content-Type':'application/json','Cf-Access-Jwt-Assertion':'assertion'},body:JSON.stringify(body)});}
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('CLOUDCOM_NATIVE_ADMISSION_ENABLED','true');mocks.auth.mockResolvedValue(operator);mocks.issue.mockResolvedValue({version:2,sessionId:id});});afterEach(()=>vi.unstubAllEnvs());
describe('customer native admission endpoints',()=>{
 const body={version:2,deviceId:id,operatorPublicKey:Buffer.alloc(32,1).toString('base64url')};
 it('requires fresh individual+company authority before issuing',async()=>{expect((await post('/remote/native/sessions',body)).status).toBe(201);expect(mocks.auth).toHaveBeenCalledWith({token:'native'});expect(mocks.issue).toHaveBeenCalledWith(operator,id,body.operatorPublicKey);});
 it('rejects wrong company without issuing any ticket',async()=>{mocks.auth.mockRejectedValue(new NativeAdmissionError(403));expect((await post('/remote/native/sessions',body)).status).toBe(403);expect(mocks.issue).not.toHaveBeenCalled();});
 it('does not accept caller-selected owner/org/expiry',async()=>{for(const extra of [{orgId:id},{portalUserId:id},{expiresAt:9999999999999}])expect((await post('/remote/native/sessions',{...body,...extra})).status).toBe(400);expect(mocks.issue).not.toHaveBeenCalled();});
 it('passes exact owner on presence and end',async()=>{mocks.presence.mockResolvedValue({expiresAt:1});mocks.end.mockResolvedValue({ended:true});expect((await post('/remote/native/sessions/'+id+'/presence',{version:2,connectionId:id})).status).toBe(200);expect(mocks.presence).toHaveBeenCalledWith(operator,id,id);expect((await post('/remote/native/sessions/'+id+'/end',{version:2})).status).toBe(200);expect(mocks.end).toHaveBeenCalledWith(operator,id);});
 it('stays off without authenticating or issuing',async()=>{vi.stubEnv('CLOUDCOM_NATIVE_ADMISSION_ENABLED',undefined);expect((await post('/remote/native/sessions',body)).status).toBe(404);expect(mocks.auth).not.toHaveBeenCalled();});
});
