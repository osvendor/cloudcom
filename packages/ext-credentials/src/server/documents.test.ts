import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { createRoutes } from './index';
const ORG='11111111-1111-4111-8111-111111111111', PARTNER='22222222-2222-4222-8222-222222222222', ID='33333333-3333-4333-8333-333333333333';
const original=Buffer.from('synthetic workbook');
const payload={version:1,originalBase64:original.toString('base64'),sheets:[{name:'Sheet',rows:[{row:1,cells:[{column:'A',text:'<script>synthetic</script>'}]}],imageCount:0}],previewTruncated:false};
const meta={id:ID,name:'Workbook',filename:'synthetic.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',sourceOrganization:'Synthetic',sourceId:'source',sha256:createHash('sha256').update(original).digest('hex'),sizeBytes:original.length,sheetCount:1,createdAt:'2026-01-01T00:00:00Z'};
function harness(options:{authenticated?:boolean;access?:boolean;denied?:string[];mfa?:boolean;sites?:string[];partner?:string;results?:unknown[];auditFails?:boolean;boundOrg?:string}={}) {
  const queued=[...(options.results??[[{partner_id:PARTNER}],[{...meta,payload_ciphertext:'enc:v3:synthetic'}]])];
  const execute=vi.fn(async(_query:unknown)=>queued.shift()??[]), decryptForColumn=vi.fn(()=>JSON.stringify({orgId:options.boundOrg??ORG,id:ID,payload}));
  const audit=vi.fn(async()=>{if(options.auditFails)throw new Error('secret audit error');});
  const app=new Hono<{Variables:Record<string,unknown>}>();
  app.use('*',async(c,next)=>{if(options.authenticated!==false){c.set('auth',{user:{id:ID},partnerId:options.partner??PARTNER,canAccessOrg:()=>options.access!==false});c.set('extensionAuthorization',{hasPermission:(_r:string,a:string)=>!(options.denied??[]).includes(a),mfaSatisfied:options.mfa!==false,allowedSiteIds:options.sites});}await next();});
  app.route('/',createRoutes({db:{execute},secrets:{decryptForColumn},log:vi.fn()} as never,audit));
  return {request:(suffix='')=>app.request(`http://test/orgs/${ORG}/documents${suffix}`),execute,decryptForColumn,audit};
}
describe('client documentation boundary',()=>{
  it.each([{authenticated:false,status:401},{access:false,status:403},{denied:['read'],status:403},{denied:['reveal'],status:403},{mfa:false,status:403},{sites:[],status:403}])('fails closed before database for %j',async options=>{
    const h=harness(options); expect((await h.request(`/${ID}`)).status).toBe(options.status);expect(h.execute).not.toHaveBeenCalled();
  });
  it('permits metadata without MFA/reveal and never decrypts',async()=>{
    const h=harness({mfa:false,denied:['reveal'],results:[[{partner_id:PARTNER}],[meta]]});const response=await h.request('?q=Work');expect(response.status).toBe(200);expect(await response.json()).toEqual({documents:[meta]});expect(h.decryptForColumn).not.toHaveBeenCalled();
    const query=new PgDialect().sqlToQuery(h.execute.mock.calls[1]![0] as never);expect(query.sql).not.toContain('payload_ciphertext');expect(query.params).toContain(ORG);
  });
  it('returns only preview with a durable audit and no-store',async()=>{
    const h=harness();const response=await h.request(`/${ID}`);expect(response.status).toBe(200);expect(await response.json()).toEqual({document:meta,sheets:payload.sheets.map(sheet=>({...sheet,images:[],imagesOmitted:0})),previewTruncated:false});expect(response.headers.get('cache-control')).toBe('no-store');expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({orgId:ORG,resourceId:ID,action:'credentials.document.read'}));
  });
  it('streams original as a safe attachment only after audit',async()=>{
    const h=harness();const response=await h.request(`/${ID}/download`);expect(response.status).toBe(200);expect(await response.text()).toBe(original.toString());expect(response.headers.get('content-disposition')).toContain('attachment;');expect(response.headers.get('x-content-type-options')).toBe('nosniff');expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({action:'credentials.document.download'}));
  });
  it.each(['', '/download'])('suppresses content on audit failure %s',async suffix=>{
    const response=await harness({auditFails:true}).request(`/${ID}${suffix}`);expect(response.status).toBe(500);expect(await response.text()).not.toContain('synthetic');
  });
  it.each([{results:[[]]},{partner:'other'},{results:[[{partner_id:PARTNER}],[]]}])('hides absent/foreign client or record %j',async options=>{
    const h=harness(options);expect((await h.request(`/${ID}`)).status).toBe(404);expect(h.decryptForColumn).not.toHaveBeenCalled();
  });
  it('rejects ciphertext transplanted across clients',async()=>{expect((await harness({boundOrg:'other'}).request(`/${ID}`)).status).toBe(500);});
  it('rejects corrupt metadata/content pairing',async()=>{expect((await harness({results:[[{partner_id:PARTNER}],[{...meta,sizeBytes:1,payload_ciphertext:'enc:v3:test'}]]}).request(`/${ID}/download`)).status).toBe(500);});
  it('ignores caller org overrides and binds exact record query',async()=>{
    const h=harness();await h.request(`/${ID}?orgId=other`);const query=new PgDialect().sqlToQuery(h.execute.mock.calls[1]![0] as never);expect(query.params).toEqual([ORG,ID]);
  });
});
