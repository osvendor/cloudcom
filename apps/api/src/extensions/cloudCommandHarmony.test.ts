import { beforeEach,describe,it,expect,vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const state=vi.hoisted(()=>({inDb:false,execute:vi.fn(),fetch:vi.fn(),audit:vi.fn()}));
vi.mock('../db',()=>({db:{execute:state.execute},runOutsideDbContext:(fn:()=>unknown)=>fn(),withSystemDbAccessContext:async(fn:()=>Promise<unknown>)=>{state.inDb=true;try{return await fn();}finally{state.inDb=false;}}}));
vi.mock('../middleware/auth',()=>({withAuthDbAccessContext:async(_auth:unknown,fn:()=>Promise<unknown>)=>{state.inDb=true;try{return await fn();}finally{state.inDb=false;}}}));
vi.mock('../services/secretCrypto',()=>({encryptSecret:()=> 'enc:v3:test',decryptForColumn:()=>JSON.stringify({clientId:'test-client',accessKey:'test-key'})}));
vi.mock('../services/auditService',()=>({createAuditLog:state.audit}));
vi.mock('../services/urlSafety',()=>({safeFetch:vi.fn()}));
vi.mock('@cloudcom/ext-cloud-command',async original=>({...await original<object>(),createHarmonyProvider:()=>({administrativeInventory:state.fetch})}));
import { authorizeHarmony,nativeHarmonyServices } from './cloudCommandHarmony';
import type { HarmonyRequest } from '@cloudcom/ext-cloud-command';
const org='11111111-1111-4111-8111-111111111111',partner='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const row={id,partner_id:partner,region:'us',credentials_encrypted:'enc:v3:test',enabled:true,version:1,last_status:'ready',checked_at:new Date('2026-10-15T12:00:00Z')};
function request():HarmonyRequest{return{orgId:org,auth:{scope:'system',principal:{kind:'user_session'},partnerId:null,user:{id:org,isPlatformAdmin:true},canAccessOrg:()=>true},authorization:{hasPermission:()=>true,mfaSatisfied:true} as never};}
const sqlText=(s:unknown)=>new PgDialect().sqlToQuery(s as never).sql;
beforeEach(()=>{vi.clearAllMocks();state.inDb=false;state.fetch.mockImplementation(async()=>{expect(state.inDb).toBe(false);return{groups:[],computers:[],checkedAt:'2026-10-15T12:00:00.000Z'};});});
describe('Harmony host authority',()=>{
  it('permits ordinary scoped readers but reserves shared discovery for the platform owner',()=>{const r=request();Object.assign(r.auth as object,{scope:'organization',orgId:org,user:{id:org}});expect(()=>authorizeHarmony(r)).not.toThrow();expect(()=>authorizeHarmony(r,true)).toThrow('harmony_owner_setup_required');});
  it.each(['sites','no-org','wrong-org','fake-system','no-read','ai'])('rejects %s',kind=>{const r=request();const a=r.auth as any;if(kind==='sites')a.allowedSiteIds=[];if(kind==='no-org')a.canAccessOrg=()=>false;if(kind==='wrong-org'){a.scope='organization';a.orgId=partner;}if(kind==='fake-system')a.user.isPlatformAdmin=false;if(kind==='no-read')r.authorization.hasPermission=()=>false;if(kind==='ai')a.principal={kind:'ai_agent'};expect(()=>authorizeHarmony(r)).toThrow('harmony_access_denied');});
  it('requires MFA and organization write permission even for the platform owner',()=>{const r=request();r.authorization.mfaSatisfied=false;expect(()=>authorizeHarmony(r,true)).toThrow();});
  it('accepts the platform owner through a full partner membership',()=>{const r=request();Object.assign(r.auth as object,{scope:'partner',partnerId:partner,partnerOrgAccess:'all'});expect(()=>authorizeHarmony(r,true)).not.toThrow();});
  it.each(['selected','none',undefined])('refuses partial partner setup even for a platform owner: %s',partnerOrgAccess=>{const r=request();Object.assign(r.auth as object,{scope:'partner',partnerId:partner,partnerOrgAccess});expect(()=>authorizeHarmony(r,true)).toThrow('harmony_owner_setup_required');});
  it('does not elevate an API or missing principal into owner setup',()=>{const r=request();Object.assign(r.auth as object,{principal:undefined});expect(()=>authorizeHarmony(r,true)).toThrow('harmony_owner_setup_required');});
});
describe('Harmony publication lifecycle',()=>{
  it('does not contact the provider when the sync lease cannot be acquired',async()=>{
    state.execute.mockImplementation(async statement=>sqlText(statement).includes('FROM organizations')?[{partner_id:partner}]:[]);
    await expect(nativeHarmonyServices.sync(request())).rejects.toThrow('harmony_sync_busy_or_disabled');expect(state.fetch).not.toHaveBeenCalled();
  });
  it('claims and commits before network I/O, and refuses a stale publication',async()=>{
    const statements:string[]=[];
    state.execute.mockImplementation(async statement=>{const s=sqlText(statement);statements.push(s);expect(state.inDb).toBe(true);if(s.includes('FROM organizations'))return[{partner_id:partner}];if(s.includes("lease_expires_at=now()+interval"))return[row];return[];});
    await expect(nativeHarmonyServices.sync(request())).rejects.toThrow('harmony_configuration_changed');
    expect(state.fetch).toHaveBeenCalledOnce();expect(statements.some(s=>s.includes('DELETE FROM cloudcommand_harmony_clients'))).toBe(false);
    expect(statements.find(s=>s.includes("last_status='ready'"))).toMatch(/enabled=true AND version=.*AND lease_id=.*AND lease_expires_at>now()/s);
  });
  it('clears all cached clients and mappings when replacing credentials',async()=>{
    const statements:string[]=[];state.execute.mockImplementation(async statement=>{const s=sqlText(statement);statements.push(s);if(s.includes('FROM organizations'))return[{partner_id:partner}];if(s.includes('SELECT * FROM harmony_integrations'))return[row];if(s.includes('UPDATE harmony_integrations'))return[{id}];return[];});
    await nativeHarmonyServices.configure(request(),{version:1,region:'us',clientId:'new',accessKey:'new-key',enabled:true});
    expect(statements.some(s=>s.includes('DELETE FROM cloudcommand_harmony_clients WHERE integration_id='))).toBe(true);
    expect(statements.some(s=>s.includes('DELETE FROM cloudcommand_harmony_scopes WHERE integration_id='))).toBe(true);
  });
  it('a reader only loads its cached projection, never the shared credential row',async()=>{
    const r=request();Object.assign(r.auth as object,{scope:'organization',orgId:org,user:{id:org}});
    const statements:string[]=[];state.execute.mockImplementation(async statement=>{const s=sqlText(statement);statements.push(s);return s.includes('FROM organizations')?[{partner_id:partner}]:[];});
    expect(await nativeHarmonyServices.inventory(r)).toEqual({computers:[],devices:[],checkedAt:null,stale:true});
    expect(statements.some(s=>s.includes('harmony_integrations'))).toBe(false);expect(state.fetch).not.toHaveBeenCalled();
  });
  it('disabling still works when the provider is unavailable',async()=>{
    state.fetch.mockRejectedValue(new Error('unavailable'));state.execute.mockImplementation(async statement=>{const s=sqlText(statement);if(s.includes('FROM organizations'))return[{partner_id:partner}];if(s.includes('SELECT * FROM harmony_integrations'))return[row];if(s.includes('UPDATE harmony_integrations'))return[{id}];return[];});
    await nativeHarmonyServices.configure(request(),{version:1,region:'us',enabled:false});expect(state.fetch).not.toHaveBeenCalled();
  });
});
