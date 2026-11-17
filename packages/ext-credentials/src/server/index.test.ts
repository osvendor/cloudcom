import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createRoutes } from './index';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ID = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const DEVICE = '66666666-6666-4666-8666-666666666666';
const syntheticPassword = 'SYNTHETIC-private-password';
const dialect = new PgDialect();

function harness(options: {
  results?: unknown[]; authenticated?: boolean; access?: boolean; denied?: string[];
  mfa?: boolean; sites?: string[]; partnerId?: string; auditFails?: boolean;
  decryptedOrg?: string; remote?: boolean;
} = {}) {
  const queued = [...(options.results ?? [[{ partner_id: PARTNER }]])];
  const execute = vi.fn(async (_query: unknown) => queued.shift() ?? []);
  const decryptForColumn = vi.fn(() => JSON.stringify({ version: 1, orgId: options.decryptedOrg ?? ORG, id: ID, password: syntheticPassword, otpSecret: 'JBSWY3DPEHPK3PXP', notes: 'SYNTHETIC-private-notes' }));
  const encryptForColumn = vi.fn((_table: string, _column: string, _plaintext: string) => 'enc:v3:test-key:ciphertext');
  const audit = vi.fn(async () => { if (options.auditFails) throw new Error('SYNTHETIC-audit-failure'); });
  const log = vi.fn();
  const context = { db: { execute }, secrets: { decryptForColumn, encryptForColumn }, audit, log };
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => {
    if (options.authenticated !== false) {
      c.set('auth', { user: { id: USER }, partnerId: options.partnerId ?? PARTNER, canAccessOrg: () => options.access !== false });
      c.set('extensionAuthorization', {
        hasPermission: (resource: string, action: string) => resource === 'remote' ? options.remote !== false : resource === 'credentials' && !(options.denied ?? []).includes(action),
        mfaSatisfied: options.mfa !== false,
        allowedSiteIds: options.sites,
      });
    }
    await next();
  });
  app.route('/', createRoutes(context as never, audit));
  const request = (path: string, body?: unknown) => app.request(`http://local/orgs/${ORG}/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const queries = () => execute.mock.calls.map(call => dialect.sqlToQuery(call[0] as never));
  return { app, request, execute, queries, decryptForColumn, encryptForColumn, audit, log };
}

const headers = ['id', 'organization', 'name', 'password_category', 'resource_type', 'resource_id', 'username', 'password', 'one_time_password', 'archived', 'url', 'notes', 'otp_secret', 'shareable'];
const fixtureCsv = (records: Array<Record<string, string>>) => [headers.join(','), ...records.map(record => headers.map(key => `"${(({ id: '1', organization: 'Client A', name: 'Synthetic record', username: 'test@example.invalid', password: syntheticPassword, ...record } as Record<string, string>)[key] ?? '').replaceAll('"', '""')}"`).join(','))].join('\r\n');

describe('credential draft writes', () => {
  it.each([['https://admin.microsoft.com',''],['https://accounts.google.com',''],['https://custom.example.test','https://custom.example.test']])('clears only generated email URLs on draft category changes %s',async(url,expected)=>{
    const h=harness({results:[[{partner_id:PARTNER}],[{id:ID,version:1,name:'Microsoft 365',category:'Email',username:'person',url,isDraft:true,isAdministration:true,secret_ciphertext:'enc:v3:synthetic'}],[{id:ID,version:2}]]});
    const response=await h.app.request(`http://local/orgs/${ORG}/credentials/${ID}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,fields:{category:'Local / Domain'}})});
    expect(response.status).toBe(200);expect(h.queries()[2]!.params[4]).toBe(expected);
    const sealed=JSON.parse(h.encryptForColumn.mock.calls[0]![2] as string);
    expect(sealed.password).toBe(syntheticPassword);expect(sealed.otpSecret).toBe('JBSWY3DPEHPK3PXP');
  });
  it('restores provider defaults when a generic draft enters Email',async()=>{
    const h=harness({results:[[{partner_id:PARTNER}],[{id:ID,version:1,name:'Local / Domain',category:'Local / Domain',username:'person',url:'',isDraft:true,isAdministration:false,secret_ciphertext:'enc:v3:synthetic'}],[{name:'Google Workspace',username:'existing@company.test',email:''}],[{id:ID,version:2}]]});
    const response=await h.app.request(`http://local/orgs/${ORG}/credentials/${ID}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,fields:{category:'Email'}})});
    expect(response.status).toBe(200);expect(h.queries()[3]!.params[0]).toBe('Google Workspace');expect(h.queries()[3]!.params[4]).toBe('https://accounts.google.com');
  });
  it.each([
    [[{name:'Google Workspace',username:'alice@company.test',email:'ALICE@company.test'}],{provider:'google',domain:'company.test'}],
    [[{name:'Microsoft 365',username:'alice@one.test',email:'alice@two.test'}],{provider:'microsoft',domain:null}],
    [[{name:'Google Workspace',username:'alice@gmail.com',email:''}],{provider:'google',domain:null}],
    [[{name:'Microsoft 365',username:'alice@company.test'},{name:'Google Workspace',username:'bob@company.test'}],{provider:null,domain:null}],
  ])('returns conservative client email defaults %j',async(records,expected)=>{
    const h=harness({results:[[{partner_id:PARTNER}],records,[{id:ID,version:1,isDraft:true}]]});
    const response=await h.request('credentials',{requestId:ID,category:'Email',isAdministration:false});
    expect((await response.json()).emailDefaults).toEqual(expected);
    const query=h.queries()[1]!;
    expect(query.params).toEqual([ORG]);
    expect(query.sql).toContain("archived=false AND is_draft=false AND category='Email'");
    expect(query.sql).not.toContain('secret_ciphertext');
  });
  it('returns unfiltered same-org defaults when searching the vault',async()=>{
    const h=harness({results:[[{partner_id:PARTNER}],[],[{name:'Google Workspace',username:'alice@company.test',email:''}]]});
    const response=await h.request('credentials?q=unmatched');
    expect((await response.json()).emailDefaults).toEqual({provider:'google',domain:'company.test'});
    expect(h.queries()[2]!.params).toEqual([ORG]);
  });
  it.each([['Microsoft 365',true,'Network / Wi-Fi'],['Special service',true,'Special service'],['Google Workspace',false,'Google Workspace']])('updates default draft labels without overwriting specific names %s',async(name,isDraft,expected)=>{
    const h=harness({results:[[{partner_id:PARTNER}],[{id:ID,version:1,name,category:'Email',username:'person',url:'',isDraft,isAdministration:false,secret_ciphertext:'enc:v3:synthetic'}],[{id:ID,version:2}]]});
    const response=await h.app.request(`http://local/orgs/${ORG}/credentials/${ID}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,fields:{category:'Network / Wi-Fi'}})});
    expect(response.status).toBe(200);expect(h.queries()[2]!.params[0]).toBe(expected);
  });
  it.each([{denied:['import']},{denied:['reveal']},{mfa:false},{access:false},{sites:[]}])('denies unauthorized generation %j',async options=>{
    const h=harness(options);const r=await h.request('credentials',{requestId:ID,category:'Email',isAdministration:false});
    expect(r.status).toBe(403);expect(h.encryptForColumn).not.toHaveBeenCalled();
  });
  it('persists a generated password encrypted before returning the draft',async()=>{
    const h=harness({results:[[{partner_id:PARTNER}],[],[{id:ID,version:1,isDraft:true}]]});
    const r=await h.request('credentials',{requestId:ID,category:'Email',isAdministration:false});
    expect(r.status).toBe(200);const result=await r.json();expect(result.value).toMatch(/^[A-Z][a-z]{2,3}[!@#$%*?][a-z]{3,4}\d{2}$/);
    expect(h.queries()[2]!.sql).toContain('ON CONFLICT');expect(h.queries()[2]!.params).not.toContain(result.value);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(result.value);
  });
  it.each([[['Google Workspace'],'Google Workspace'],[['Microsoft 365','Google Workspace'],'Email']])('uses only an unambiguous client mail provider %j',async(names,expected)=>{
    const h=harness({results:[[{partner_id:PARTNER}],(names as string[]).map(name=>({name})),[{id:ID,version:1,isDraft:true}]]});
    expect((await h.request('credentials',{requestId:ID,category:'Email',isAdministration:true})).status).toBe(200);
    expect(h.queries()[2]!.params[2]).toBe(expected);
    expect(h.queries()[1]!.params).toContain(ORG);
  });
  it('rejects categories outside the concise list',async()=>{
    const h=harness();expect((await h.request('credentials',{requestId:ID,category:'Vendor',isAdministration:false})).status).toBe(400);
  });
  it('does not mutate or generate on stale edits',async()=>{
    const h=harness({results:[[{partner_id:PARTNER}],[{id:ID,version:4}]]});
    const r=await h.app.request(`http://local/orgs/${ORG}/credentials/${ID}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({version:3,fields:{generatePassword:true}})});
    expect(r.status).toBe(409);expect(h.encryptForColumn).not.toHaveBeenCalled();expect(h.execute).toHaveBeenCalledTimes(2);
  });
  it.each([['Network / Wi-Fi',200],['Email',422]])('completion handles password-only %s accounts',async(category,status)=>{
    const h=harness({results:[[{partner_id:PARTNER}],[{id:ID,version:1,name:'Guest network',category,username:'',url:'',isDraft:true,isAdministration:false,secret_ciphertext:'enc:v3:synthetic'}],[{id:ID,version:2,isDraft:false}]]});
    const r=await h.app.request(`http://local/orgs/${ORG}/credentials/${ID}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,fields:{isDraft:false}})});
    expect(r.status).toBe(status);
    if(status===422)expect(h.encryptForColumn).not.toHaveBeenCalled();
  });
});

describe('live remote session credential boundaries', () => {
  const sessionResult = [{ org_id: ORG, device_id: DEVICE }];
  const sessionRequest = (h: ReturnType<typeof harness>, action = '', body?: unknown) => h.app.request(`http://local/sessions/${SESSION}/credentials${action}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  it('derives organization from the owned live desktop and ignores client query overrides', async () => {
    const h = harness({ results: [sessionResult, [{ partner_id: PARTNER }], [{ id: ID, name: 'Synthetic record' }]] });
    const response = await sessionRequest(h, `?orgId=${OTHER_ORG}&deviceId=${OTHER_ORG}`);
    expect(response.status).toBe(200);
    const queries = h.queries();
    expect(queries[0]!.params).toEqual([SESSION, USER]);
    expect(queries[0]!.sql).toContain('d.org_id=s.org_id');
    for (const predicate of ["s.type='desktop'", "s.status='active'", 's.ended_at IS NULL', "s.termination_phase='none'", 's.terminal_generation IS NULL', 's.permissions_epoch_snapshot=u.permissions_epoch', "u.status='active'"]) expect(queries[0]!.sql).toContain(predicate);
    expect(queries[2]!.params).toContain(ORG);
    expect(queries[2]!.sql).toContain('AND EXISTS (SELECT s.org_id,s.device_id');
    expect(queries[2]!.params).toContain(SESSION);
    expect(queries.flatMap(q => q.params)).not.toContain(OTHER_ORG);
    expect(h.decryptForColumn).not.toHaveBeenCalled();
  });
  it.each([{ authenticated: false, status: 401 }, { remote: false, status: 403 }, { mfa: false, status: 403 }, { sites: [], status: 403 }, { denied: ['read'], status: 403 }])('rejects missing session permissions before reading data %j', async options => {
    const h = harness(options);
    expect((await sessionRequest(h)).status).toBe(options.status);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('fails closed for absent, other-owner, ended, revoked or moved-device sessions', async () => {
    // Every invalid state is excluded by the guarded SQL predicate above.
    const h = harness({ results: [[]] });
    expect((await sessionRequest(h, `/${ID}/reveal`, { field: 'password' })).status).toBe(404);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.decryptForColumn).not.toHaveBeenCalled();
  });
  it.each([{ access: false }, { denied: ['reveal'] }, { denied: ['otp'] }, { partnerId: OTHER_ORG }])('preserves tenant and action boundaries %j', async options => {
    const h = harness({ ...options, results: [sessionResult, [{ partner_id: PARTNER }]] });
    const action = options.denied?.includes('otp') ? 'otp' : 'reveal';
    expect([403, 404]).toContain((await sessionRequest(h, `/${ID}/${action}`, action === 'reveal' ? { field: 'password' } : {})).status);
    expect(h.decryptForColumn).not.toHaveBeenCalled();
  });
  it.each(['reveal', 'otp'])('binds %s audit to session and device before disclosure', async action => {
    const h = harness({ results: [sessionResult, [{ partner_id: PARTNER }], [{ secret_ciphertext: 'enc:v3:synthetic' }], sessionResult] });
    expect((await sessionRequest(h, `/${ID}/${action}`, action === 'reveal' ? { field: 'password' } : {})).status).toBe(200);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, actorId: USER, resourceId: ID, action: `credentials.${action}`, details: { sessionId: SESSION, deviceId: DEVICE } }));
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(syntheticPassword);
  });
  it('does not reveal on audit failure or a cross-client record lookup', async () => {
    for (const auditFails of [true, false]) {
      const h = harness({ auditFails, results: [sessionResult, [{ partner_id: PARTNER }], auditFails ? [{ secret_ciphertext: 'enc:v3:synthetic' }] : []] });
      const response = await sessionRequest(h, `/${ID}/reveal`, { field: 'password' });
      expect(response.status).toBe(auditFails ? 500 : 404);
      expect(await response.text()).not.toContain(syntheticPassword);
      expect(h.queries()[2]!.params).toEqual([ORG, ID, SESSION, USER, ORG, DEVICE]);
      expect(h.queries()[2]!.sql).toContain("s.status='active'");
    }
  });
  it.each(['reveal', 'otp'])('suppresses %s if session ends during durable audit', async action => {
    const h = harness({ results: [sessionResult, [{ partner_id: PARTNER }], [{ secret_ciphertext: 'enc:v3:synthetic' }], []] });
    const response = await sessionRequest(h, `/${ID}/${action}`, action === 'reveal' ? { field: 'password' } : {});
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Session unavailable' });
    expect(h.audit).toHaveBeenCalledOnce();
    expect(h.queries()[3]!.params).toEqual([SESSION, USER, ORG, DEVICE]);
    expect(h.queries()[3]!.sql).toContain('s.permissions_epoch_snapshot=u.permissions_epoch');
  });
  it('does not expose import through session routes', async () => {
    const h = harness({ results: [sessionResult, [{ partner_id: PARTNER }]] });
    expect((await h.app.request(`http://local/sessions/${SESSION}/import/commit`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect(h.encryptForColumn).not.toHaveBeenCalled();
  });
});

describe('credential API boundaries', () => {
  it.each([
    { authenticated: false, expected: 401 },
    { access: false, expected: 403 },
    { sites: [], expected: 403 },
    { sites: ['site'], expected: 403 },
    { denied: ['read'], expected: 403 },
    { denied: ['reveal'], expected: 403 },
    { mfa: false, expected: 403 },
  ])('denies unauthorized secret access before database/crypto for %j', async options => {
    const h = harness(options);
    const response = await h.request(`credentials/${ID}/reveal`, { field: 'password' });
    expect(response.status).toBe(options.expected);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.decryptForColumn).not.toHaveBeenCalled();
    expect(h.encryptForColumn).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('checks action-specific OTP/import permission and denies different partner', async () => {
    for (const [path, denied] of [[`credentials/${ID}/otp`, 'otp'], ['import/preview', 'import']] as const) {
      const h = harness({ denied: [denied] });
      expect((await h.request(path, {})).status).toBe(403);
      expect(h.execute).not.toHaveBeenCalled();
    }
    const h = harness({ partnerId: OTHER_ORG });
    expect((await h.request(`credentials/${ID}/reveal`, { field: 'password' })).status).toBe(404);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.decryptForColumn).not.toHaveBeenCalled();
  });
  it('lists explicit metadata columns under an exact client predicate and escaped search', async () => {
    const h = harness({ results: [[{ partner_id: PARTNER }], [{ id: ID, name: 'Synthetic record', hasPassword: true, hasOtp: false }]] });
    const response = await h.request('credentials?q=%25_%5C');
    expect(response.status).toBe(200);
    const query = h.queries()[1]!;
    expect(query.sql).toMatch(/WHERE org_id=\$\d+::uuid/);
    expect(query.params).toContain(ORG);
    expect(query.params).toContain('%\\%\\_\\\\%');
    expect(query.sql).not.toMatch(/SELECT\s+\*|secret_ciphertext|otp_secret|notes/i);
    expect(h.decryptForColumn).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('returns not found for a record absent under the current client without decrypting', async () => {
    const h = harness({ results: [[{ partner_id: PARTNER }], []] });
    const response = await h.request(`credentials/${ID}/reveal`, { field: 'password' });
    expect(response.status).toBe(404);
    const query = h.queries()[1]!;
    expect(query.sql).toMatch(/WHERE org_id=\$\d+::uuid AND id=\$\d+::uuid/);
    expect(query.params).toEqual([ORG, ID]);
    expect(h.decryptForColumn).not.toHaveBeenCalled();
  });
  it('rejects ciphertext whose decrypted client binding differs', async () => {
    const h = harness({ results: [[{ partner_id: PARTNER }], [{ secret_ciphertext: 'enc:v3:synthetic' }]], decryptedOrg: OTHER_ORG });
    const response = await h.request(`credentials/${ID}/reveal`, { field: 'password' });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(syntheticPassword);
    expect(h.audit).not.toHaveBeenCalled();
  });
  it('does not return decrypted values when mandatory audit fails', async () => {
    const h = harness({ results: [[{ partner_id: PARTNER }], [{ secret_ciphertext: 'enc:v3:synthetic' }]], auditFails: true });
    const response = await h.request(`credentials/${ID}/reveal`, { field: 'password' });
    expect(h.decryptForColumn).toHaveBeenCalledOnce();
    expect(h.audit).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(syntheticPassword);
    expect(JSON.stringify(h.log.mock.calls)).not.toMatch(/SYNTHETIC|ciphertext/);
  });
  it('audits reveal metadata while returning only the requested password', async () => {
    const h = harness({ results: [[{ partner_id: PARTNER }], [{ secret_ciphertext: 'enc:v3:synthetic' }]] });
    const response = await h.request(`credentials/${ID}/reveal`, { field: 'password' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: syntheticPassword });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, actorId: USER, resourceId: ID, action: 'credentials.reveal' }));
    expect(JSON.stringify(h.audit.mock.calls)).not.toMatch(/SYNTHETIC|JBSWY3/);
  });
  it.each(['preview', 'commit'])('rejects mixed source organizations during import %s', async action => {
    const h = harness();
    const response = await h.request(`import/${action}`, { sourceOrganization: 'Client A', csv: fixtureCsv([{}, { id: '2', organization: 'Client B' }]) });
    expect(response.status).toBe(400);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.encryptForColumn).not.toHaveBeenCalled();
  });
  it('rejects the entire standalone-secret batch before writing or encrypting', async () => {
    const h = harness();
    const response = await h.request('import/commit', { sourceOrganization: 'Client A', csv: fixtureCsv([{ name: 'Microsoft 365' }, { id: '2', name: 'Widget API key' }]) });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'NOTES_REQUIRED', count: 1, error: expect.stringContaining('client Notes') });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.encryptForColumn).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
  it('inserts normalized metadata and saves ambiguity as a draft', async () => {
    const h = harness();
    const response = await h.request('import/commit', { sourceOrganization: 'Client A', csv: fixtureCsv([{ name: '<b>Microsoft 365 tenant admin</b>' }, { id: '2', name: 'Unrecognized widget' }]) });
    expect(response.status).toBe(200);
    const insert = h.queries().find(query => query.sql.includes('INSERT INTO credentials_records'))!;
    expect(insert.sql).toContain('is_administration,is_draft');
    expect(insert.params.slice(2, 4)).toEqual(['Microsoft 365', 'Email']);
    expect(insert.params.slice(13, 15)).toEqual([true, false]);
    expect(insert.params.slice(28, 30)).toEqual([false, true]);
    expect(insert.params).not.toContain(syntheticPassword);
  });
  it.each<Record<string, string>>([{ otp_secret: 'invalid!' }, { one_time_password: '123456' }])('blocks committing invalid or missing OTP seed %j', async value => {
    const h = harness();
    const response = await h.request('import/commit', { sourceOrganization: 'Client A', csv: fixtureCsv([value]) });
    expect(response.status).toBe(422);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.encryptForColumn).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
  it('previews invalid OTP counts without revealing any values or writing secrets', async () => {
    const h = harness();
    const response = await h.request('import/preview', { sourceOrganization: 'Client A', csv: fixtureCsv([{ otp_secret: 'invalid-SYNTHETIC-seed', notes: 'SYNTHETIC-note' }]) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.issueCounts.invalid_otp_secret).toBe(1);
    expect(JSON.stringify(data)).not.toMatch(/SYNTHETIC|test@example|Synthetic record/);
    expect(h.encryptForColumn).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});
