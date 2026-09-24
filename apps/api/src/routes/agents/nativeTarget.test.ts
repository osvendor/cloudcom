import { Hono } from 'hono';
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
const mocks=vi.hoisted(()=>({enroll:vi.fn()}));
vi.mock('../../services/portalNativeTarget',()=>({enrollNativeTarget:mocks.enroll}));
import { nativeTargetEnrollmentRoutes } from './nativeTarget';
const id='11111111-1111-4111-8111-111111111111',b=Buffer.alloc(32,1).toString('base64url');
const body={version:2,installationId:id,targetPublicKey:b,targetCredential:b,rustdeskId:'123456789'};
async function post(overrides:Record<string,unknown>={},flags:Record<string,boolean>={},rotation=false) {
 const app=new Hono();app.use('*',async(c,next)=>{c.set('agent',{role:'agent',authTokenHash:'hash',deviceId:id,orgId:id,...overrides} as never);for(const [k,v]of Object.entries(flags))c.set(k as never,v as never);await next();});app.route('/',nativeTargetEnrollmentRoutes);
 return app.request('/agent/native-target/'+(rotation?'rotate':'enroll'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(rotation?{...body,expectedGeneration:1}:body)});
}
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('CLOUDCOM_NATIVE_ADMISSION_ENABLED','true');mocks.enroll.mockResolvedValue({version:2,targetGeneration:1});});afterEach(()=>vi.unstubAllEnvs());
describe('main-agent-only target provisioning',()=>{
 it.each([{role:'watchdog'},{authTokenHash:undefined},{tenantDraining:true},{deviceUninstallDraining:true}])('denies non-current or draining agent contexts',async overrides=>{expect((await post(overrides)).status).toBe(403);expect(mocks.enroll).not.toHaveBeenCalled();});
 it.each(['agentTokenRotationRequired','agentPendingTokenPresented'])('denies previous and staged credentials',async flag=>{expect((await post({}, {[flag]:true})).status).toBe(403);expect(mocks.enroll).not.toHaveBeenCalled();});
 it('enrolls and explicitly rotates without returning generated credentials',async()=>{expect((await post()).status).toBe(200);expect(mocks.enroll).toHaveBeenCalledWith(expect.objectContaining({role:'agent'}),body);expect((await post({}, {},true)).status).toBe(200);expect(mocks.enroll).toHaveBeenLastCalledWith(expect.anything(),{...body,expectedGeneration:1},1);});
 it('stays unavailable when disabled',async()=>{vi.stubEnv('CLOUDCOM_NATIVE_ADMISSION_ENABLED','false');expect((await post()).status).toBe(404);expect(mocks.enroll).not.toHaveBeenCalled();});
});
