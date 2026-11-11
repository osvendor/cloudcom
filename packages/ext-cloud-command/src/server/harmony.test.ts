import { describe,it,expect,vi } from 'vitest';
import { Hono } from 'hono';
import { createRoutes } from './index';
const org='11111111-1111-4111-8111-111111111111';
function harness(options:{read?:boolean;write?:boolean;mfa?:boolean;access?:boolean;sites?:string[]}={}) {
  const native={connection:vi.fn(async()=>({connected:false})),configure:vi.fn(async()=>({connected:true})),map:vi.fn(async()=>({})),link:vi.fn(async()=>({success:true})),inventory:vi.fn(async()=>({computers:[]})),sync:vi.fn(async()=>({count:0})),discover:vi.fn(async()=>({groups:[],computers:[]}))};
  const runDb=vi.fn(async(_auth:unknown,work:()=>Promise<unknown>)=>work());
  const context={db:{execute:vi.fn(async()=>[{partner_id:'22222222-2222-4222-8222-222222222222'}])},log:vi.fn()};
  const app=new Hono();
  app.use('*',async(c,next)=>{
    c.set('auth' as never,{user:{id:org},partnerId:null,canAccessOrg:()=>options.access!==false} as never);
    c.set('extensionAuthorization' as never,{allowedSiteIds:options.sites,mfaSatisfied:options.mfa!==false,hasPermission:(_r:string,a:string)=>a==='read'?options.read!==false:options.write!==false} as never);
    await next();
  });
  app.route('/',createRoutes(context as never,vi.fn(),undefined,undefined,undefined,undefined,runDb as never,native as never));
  const request=(route:string,method='GET',body?:unknown)=>app.request(`http://test/harmony/${route}?orgId=${org}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  return{native,runDb,request};
}
describe('Harmony routes',()=>{
  it('re-enters a short caller context for the outer organization lookup',async()=>{const h=harness();expect((await h.request('connection')).status).toBe(200);expect(h.runDb).toHaveBeenCalledOnce();expect(h.native.connection).toHaveBeenCalledWith(expect.objectContaining({orgId:org}));});
  it.each([{read:false},{access:false},{sites:[]}])('denies unauthorized inventory %j',async options=>{const h=harness(options);expect((await h.request('inventory')).status).toBe(403);expect(h.native.inventory).not.toHaveBeenCalled();});
  it.each([{write:false},{mfa:false}])('denies mutations %j',async options=>{const h=harness(options);expect((await h.request('sync','POST',{})).status).toBe(403);expect(h.native.sync).not.toHaveBeenCalled();});
  it('rejects organization overrides in a mapping body',async()=>{const h=harness();const r=await h.request('mappings','PUT',{version:1,mappings:[{kind:'endpoint',externalId:'device',orgId:org}]});expect(r.status).toBe(400);expect(h.native.map).not.toHaveBeenCalled();});
  it('rejects arbitrary origins and unexpected credential fields',async()=>{const h=harness();expect((await h.request('connection','PUT',{version:null,region:'us',enabled:true,origin:'https://bad.example'})).status).toBe(400);expect(h.native.configure).not.toHaveBeenCalled();});
  it('passes a strictly validated explicit device link',async()=>{const h=harness();expect((await h.request('link','PUT',{externalId:'ep',deviceId:org,checkedAt:'2026-10-15T12:00:00.000Z'})).status).toBe(200);expect(h.native.link).toHaveBeenCalledWith(expect.objectContaining({orgId:org}),expect.objectContaining({externalId:'ep',deviceId:org}));});
});
