import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({authenticate:vi.fn(),dispatchToken:vi.fn(),tenant:vi.fn(),access:vi.fn(),rows:[] as any[][],ip:vi.fn(),dispatch:vi.fn()}));
vi.mock('../db',()=>({withDbAccessContext:(_c:unknown,f:()=>unknown)=>f(),db:{select:()=>({from:()=>({where:()=>({limit:async()=>m.rows.shift()??[]})})})}}));
vi.mock('../middleware/auth',()=>({computeAccessibleOrgIds:async()=>({orgIds:[]})}));
vi.mock('../middleware/ipAllowlistGuard',()=>({ipAllowlistGuard:m.ip}));
vi.mock('../services/redis',()=>({getRedis:()=>({})}));
vi.mock('../services/rate-limit',()=>({rateLimiter:async()=>({allowed:true})}));
vi.mock('../services/clientIp',()=>({getTrustedClientIp:()=> '127.0.0.1',rateLimitIpKey:(x:string)=>x}));
vi.mock('../services/browserCompanionSession',()=>({companionIds:()=>['a'.repeat(32)],exchangeBrowserCompanion:vi.fn(),authenticateBrowserCompanion:m.authenticate,endBrowserCompanion:vi.fn(),companionDispatchToken:m.dispatchToken}));
vi.mock('../services/permissions',()=>({canAccessOrg:m.access}));
vi.mock('../services/tenantStatus',()=>({getActiveOrgTenant:m.tenant}));
import {createBrowserCompanionTransport} from './browserCompanion';
const orgId='11111111-1111-4111-8111-111111111111',deviceId='22222222-2222-4222-8222-222222222222';
beforeEach(()=>{vi.clearAllMocks();m.rows=[];m.authenticate.mockResolvedValue({session:{principal:{partnerId:'p',userId:'u'},identity:{email:'staff@example.test'}},authority:{permissions:{}}});m.dispatchToken.mockResolvedValue('internal-only');m.tenant.mockResolvedValue({partnerId:'p'});m.access.mockReturnValue(true);m.ip.mockResolvedValue(undefined);m.dispatch.mockResolvedValue(Response.json({data:[]}));});
const request=(body:unknown,origin='chrome-extension://'+'a'.repeat(32))=>createBrowserCompanionTransport(m.dispatch).request('/request',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer opaque','x-organization-id':'wrong',Cookie:'should-not-forward=1'},body:JSON.stringify(body)});
describe('browser companion transport boundary',()=>{
  it('preserves server socket context for core proxy trust and terminal ticket binding',async()=>{
    const env={incoming:{socket:{remoteAddress:'127.0.0.1'}}};m.rows.push([{id:deviceId}]);
    const response=await createBrowserCompanionTransport(m.dispatch).request('/request',{method:'POST',headers:{Origin:'chrome-extension://'+'a'.repeat(32),'Content-Type':'application/json',Authorization:'Bearer opaque'},body:JSON.stringify({orgId,deviceId,path:`/system-tools/devices/${deviceId}/processes`})},env);
    expect(response.status).toBe(200);expect(m.dispatch.mock.calls[0]![1]).toBe(env);
  });
  it('encodes binary downloads without corrupting bytes',async()=>{
    m.rows.push([{id:deviceId}]);m.dispatch.mockResolvedValueOnce(new Response(new Uint8Array([0,255,128,10])));
    const response=await request({orgId,deviceId,path:`/system-tools/devices/${deviceId}/files/download?path=test.bin`});
    expect(response.status).toBe(200);expect(await response.json()).toEqual({content:'AP+ACg==',encoding:'base64'});
  });
  it('accepts file upload envelopes above the ordinary API body limit',async()=>{
    m.rows.push([{id:deviceId}]);
    const body={path:'C:\\test.bin',content:'A'.repeat(2*1024*1024)};
    const response=await request({orgId,deviceId,method:'POST',path:`/system-tools/devices/${deviceId}/files/upload`,body});
    expect(response.status).toBe(200);expect(await (m.dispatch.mock.calls[0]![0] as Request).json()).toEqual(body);
  });
  it('forwards an authorized operation while retaining separate CORS and no-store',async()=>{
    m.rows.push([{id:deviceId}]);
    const response=await request({orgId,deviceId,path:`/system-tools/devices/${deviceId}/processes`});
    expect(response.status).toBe(200);expect(await response.json()).toEqual({data:[]});
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('chrome-extension://'+'a'.repeat(32));
    const forwarded=m.dispatch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get('Authorization')).toBe('Bearer internal-only');
    for(const name of ['Cookie','Origin','x-organization-id'])expect(forwarded.headers.get(name)).toBeNull();
  });
  it('denies unregistered callers before authentication',async()=>{
    expect((await request({path:'/credentials/browser/clients'},'https://evil.test')).status).toBe(403);
    expect(m.authenticate).not.toHaveBeenCalled();
  });
  it('denies cross-partner, missing device, or revoked client access before dispatch',async()=>{
    const input={orgId,deviceId,path:`/system-tools/devices/${deviceId}/processes`};
    m.tenant.mockResolvedValueOnce({partnerId:'other'});expect((await request(input)).status).toBe(404);
    m.access.mockReturnValueOnce(false);expect((await request(input)).status).toBe(404);
    expect((await request(input)).status).toBe(404);expect(m.dispatch).not.toHaveBeenCalled();
  });
  it('enforces the IP restriction before device access',async()=>{
    m.ip.mockResolvedValue(Response.json({error:'denied'},{status:403}));
    expect((await request({path:'/credentials/browser/clients'})).status).toBe(403);expect(m.dispatch).not.toHaveBeenCalled();
  });
  it('rejects a remote session not owned by this actor/device',async()=>{
    m.rows.push([{id:deviceId}],[]);
    expect((await request({orgId,deviceId,method:'POST',path:`/remote/sessions/${orgId}/end`})).status).toBe(404);
    expect(m.dispatch).not.toHaveBeenCalled();
  });
});
