import {Hono} from 'hono';
import {describe,it,expect,vi} from 'vitest';
import {createBrowserCompanionRoutes,websiteOrigin} from './browserCompanion';
import {PgDialect} from 'drizzle-orm/pg-core';
const ORG='11111111-1111-4111-8111-111111111111',ID='22222222-2222-4222-8222-222222222222',PARTNER='33333333-3333-4333-8333-333333333333';
function harness(o:{scope?:string;kind?:string;access?:boolean;mfa?:boolean;denied?:string[];results?:unknown[];auditFails?:boolean;sites?:string[]}={}){
 const values=[...(o.results??[[{id:ORG}],[{url:'https://login.example.test/path',username:'test',email:'',secret_ciphertext:'enc:v3:test'}]])];
 const execute=vi.fn(async(_query:unknown)=>values.shift()),decryptForColumn=vi.fn(()=>JSON.stringify({version:1,orgId:ORG,id:ID,password:'synthetic-password',otpSecret:'',notes:''}));
 const audit=vi.fn(async()=>{if(o.auditFails)throw new Error('synthetic secret');});
 const app=new Hono<{Variables:Record<string,unknown>}>();app.onError((_e,c)=>c.json({error:'unavailable'},500));
 app.use('*',async(c,next)=>{c.set('auth',{scope:o.scope??'partner',principal:{kind:o.kind??'user_session'},partnerId:PARTNER,user:{id:ID},canAccessOrg:()=>o.access!==false});c.set('extensionAuthorization',{hasPermission:(_r:string,a:string)=>!(o.denied??[]).includes(a),mfaSatisfied:o.mfa!==false,allowedSiteIds:o.sites});await next();});
 app.route('/',createBrowserCompanionRoutes({db:{execute},secrets:{decryptForColumn}} as never,audit));
 return {execute,decryptForColumn,audit,request:(path=`/orgs/${ORG}/credentials/${ID}/fill`,body:unknown={origin:'https://login.example.test',field:'password'})=>app.request('http://test'+path,body===null?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})};
}
describe('staff browser companion',()=>{
 it.each([{scope:'organization'},{scope:'system'},{kind:'api_key'},{kind:'ai_agent'},{mfa:false},{sites:[]}])('rejects non-staff/noninteractive/unverified %j',async o=>{const h=harness(o);expect((await h.request()).status).toBe(403);expect(h.execute).not.toHaveBeenCalled();});
 it('denies foreign client before record access',async()=>{const h=harness({access:false});expect((await h.request()).status).toBe(404);expect(h.execute).not.toHaveBeenCalled();});
 it('denies reveal permission without decrypting',async()=>{const h=harness({denied:['reveal']});expect((await h.request()).status).toBe(403);expect(h.decryptForColumn).not.toHaveBeenCalled();});
 it('requires exact HTTPS origin before decrypting',async()=>{const h=harness();expect((await h.request(undefined,{origin:'https://login.example.test.attacker.invalid',field:'password'})).status).toBe(404);expect(h.decryptForColumn).not.toHaveBeenCalled();});
 it('audits every fill with no secret or destination URL in audit',async()=>{const h=harness();const r=await h.request();expect(r.status).toBe(200);expect(await r.json()).toEqual({value:'synthetic-password'});expect(r.headers.get('cache-control')).toBe('no-store');expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({orgId:ORG,action:'credentials.browser.fill',details:{field:'password'}}));});
 it('fails closed on audit failure',async()=>{const h=harness({auditFails:true});const r=await h.request();expect(r.status).toBe(500);expect(await r.text()).not.toContain('synthetic');});
 it('lists credentials only for the exact origin and selected client',async()=>{const h=harness({results:[[{id:ORG}],[{id:ID,url:'https://login.example.test/a',name:'Example',username:'u',email:''},{id:'other',url:'https://evil.example.test',name:'Example',username:'u',email:''}]]});const r=await h.request(`/orgs/${ORG}/credentials?origin=https%3A%2F%2Flogin.example.test`,null);expect((await r.json()).credentials).toHaveLength(1);expect(h.decryptForColumn).not.toHaveBeenCalled();});
 it('does not return devices without device read permission',async()=>{const h=harness({denied:['read']});expect((await h.request(`/orgs/${ORG}/devices`,null)).status).toBe(403);});
 it('searches device identities and last user within the selected client',async()=>{
  const device={id:ID,hostname:'TEST-PC',displayName:'Test workstation',currentUser:'DOMAIN\\technician',lastUser:'DOMAIN\\previous',status:'online'};
  const h=harness({results:[[{id:ORG}],[device]]});
  const r=await h.request(`/orgs/${ORG}/devices?q=technician%25_`,null);
  expect(r.status).toBe(200);expect((await r.json()).devices).toEqual([device]);
  const query=new PgDialect().sqlToQuery(h.execute.mock.calls[1]![0] as Parameters<PgDialect['sqlToQuery']>[0]);
  expect(query.sql).toContain('u.last_user AS "lastUser"');
  expect(query.sql).toContain('u.observed_user AS "currentUser"');
  expect(query.sql).toMatch(/org_id=\$\d+::uuid/);
  expect(query.sql).toMatch(/d.hostname ILIKE.*OR d.display_name ILIKE.*OR u.observed_user ILIKE.*OR u.last_user ILIKE/);
  expect(query.sql).toContain("d.status='online' AND d.last_seen_at > now()-interval '5 minutes'");
  expect(query.sql).toContain('s.device_id=d.id AND s.org_id=d.org_id');
  expect(query.sql).toContain('ORDER BY s.login_at DESC');
  expect(query.params).toEqual([ORG,...Array(4).fill('%technician\\%\\_%')]);
 });
 it('rejects device search for a foreign client before querying',async()=>{
  const h=harness({access:false});expect((await h.request(`/orgs/${ORG}/devices?q=user`,null)).status).toBe(404);expect(h.execute).not.toHaveBeenCalled();
 });
 it.each(['http://login.example.test','javascript:alert(1)','https://user:pass@login.example.test','not a URL'])('rejects unsafe website %s',url=>expect(websiteOrigin(url)).toBeNull());
});
