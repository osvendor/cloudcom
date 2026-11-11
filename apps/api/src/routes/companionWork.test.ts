import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({org:'11111111-1111-4111-8111-111111111111',can:true,site:false,tenant:true,ensure:vi.fn(),list:vi.fn()}));
vi.mock('../middleware/auth',()=>({authMiddleware:async(c:any,next:any)=>{c.set('auth',{user:{id:'33333333-3333-4333-8333-333333333333'},partnerId:'partner',canAccessOrg:()=>m.can});c.set('permissions',{allowedSiteIds:m.site?[]:undefined});await next();},requireScope:()=>async(_c:any,n:any)=>n(),requireInteractiveSession:()=>async(_c:any,n:any)=>n(),requireMfa:()=>async(_c:any,n:any)=>n(),requirePermission:()=>async(_c:any,n:any)=>n(),withAuthDbAccessContext:(_a:any,f:any)=>f()}));
vi.mock('../services/tenantStatus',()=>({getActiveOrgTenant:()=>m.tenant?{partnerId:'partner'}:null}));
vi.mock('../services/companionWork',()=>({ensureWork:m.ensure,listWork:m.list,findWork:vi.fn(),syncWork:vi.fn(),workView:vi.fn(),mutateWork:vi.fn()}));
import {companionWorkRoutes} from './companionWork';
beforeEach(()=>{vi.clearAllMocks();process.env.CLOUDCOM_CREDENTIALS_ENABLED='true';m.can=true;m.site=false;m.tenant=true;m.list.mockResolvedValue([]);m.ensure.mockResolvedValue({id:'work'});});
describe('Work exact client route gates',()=>{
 it('guards the exact GET base path, not just descendants',async()=>{m.can=false;expect((await companionWorkRoutes.request(`/orgs/${m.org}`)).status).toBe(404);expect(m.list).not.toHaveBeenCalled();});
 it('guards exact POST when site scoped or inactive tenant',async()=>{for(const cause of ['site','tenant']){m.site=cause==='site';m.tenant=cause!=='tenant';expect((await companionWorkRoutes.request(`/orgs/${m.org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:m.org})})).status).toBe(404);}expect(m.ensure).not.toHaveBeenCalled();});
 it('requires enabled extension and UUID scope',async()=>{process.env.CLOUDCOM_CREDENTIALS_ENABLED='false';expect((await companionWorkRoutes.request(`/orgs/${m.org}`)).status).toBe(503);process.env.CLOUDCOM_CREDENTIALS_ENABLED='true';expect((await companionWorkRoutes.request('/orgs/not-a-uuid')).status).toBe(404);});
 it('lists only authenticated actor within client and rejects extra create fields',async()=>{expect((await companionWorkRoutes.request(`/orgs/${m.org}`)).status).toBe(200);expect(m.list).toHaveBeenCalledWith(m.org,'33333333-3333-4333-8333-333333333333');expect((await companionWorkRoutes.request(`/orgs/${m.org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:m.org,actorId:'someone-else'})})).status).toBe(400);});
});
