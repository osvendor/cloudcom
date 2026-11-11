import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
const m=vi.hoisted(()=>({store:new Map<string,string>(),validate:vi.fn(),seed:vi.fn(),jwt:vi.fn()}));
vi.mock('./redis',()=>({getRedis:()=>({set:async(k:string,v:string)=>{m.store.set(k,v);return 'OK';},get:async(k:string)=>m.store.get(k),del:async(k:string)=>m.store.delete(k),eval:async(_s:string,_n:number,k:string)=>{const v=m.store.get(k);m.store.delete(k);return v;}})}));
vi.mock('./staffNativeAuthority',async()=>{const {z}=await import('zod');return {staffNativePrincipalSchema:z.object({userId:z.string(),partnerId:z.string(),familyId:z.string(),authEpoch:z.number(),mfaEpoch:z.number(),issuedAt:z.number(),expiresAt:z.number()}),staffNativePrincipalFromAuth:m.seed,revalidateStaffNativePrincipal:m.validate};});
vi.mock('./jwt',()=>({createAccessToken:m.jwt}));
import {authorizeBrowserCompanion,exchangeBrowserCompanion,authenticateBrowserCompanion,endBrowserCompanion} from './browserCompanionSession';
const id='a'.repeat(32),verifier='v'.repeat(43),state='s'.repeat(43);
const challenge=createHash('sha256').update(verifier).digest('base64url');
const auth={user:{email:'staff@example.test'},token:{roleId:null,mfa_src:'factor'}} as any;
beforeEach(()=>{m.store.clear();vi.clearAllMocks();vi.stubEnv('CLOUDCOM_BROWSER_COMPANION_IDS',id);m.seed.mockReturnValue({userId:'u',partnerId:'p',familyId:'f',authEpoch:1,mfaEpoch:0,issuedAt:Math.floor(Date.now()/1000),expiresAt:Date.now()+3600000});m.validate.mockResolvedValue({permissions:{}});});
afterEach(()=>vi.unstubAllEnvs());
async function code(){return new URL((await authorizeBrowserCompanion(auth,{extensionId:id,challenge,state})).redirectUri).searchParams.get('code')!;}
describe('browser companion PKCE sessions',()=>{
  it('returns only an opaque token, stores only its hash, and consumes the code once',async()=>{
    const c=await code(),session=await exchangeBrowserCompanion({code:c,verifier,extensionId:id});
    expect(session.accessToken).toMatch(/^ccb1\.[A-Za-z0-9_-]{43}$/);
    expect([...m.store.keys()].join('')).not.toContain(session.accessToken);
    expect([...m.store.values()].join('')).not.toContain(session.accessToken);
    expect(m.jwt).not.toHaveBeenCalled();
    await expect(exchangeBrowserCompanion({code:c,verifier,extensionId:id})).rejects.toThrow();
    const a=await authenticateBrowserCompanion('Bearer '+session.accessToken,id);
    await endBrowserCompanion(a.key);
    await expect(authenticateBrowserCompanion('Bearer '+session.accessToken,id)).rejects.toThrow();
  });
  it('rejects an incorrect verifier and cannot replay the consumed code',async()=>{
    const c=await code();
    await expect(exchangeBrowserCompanion({code:c,verifier:'w'.repeat(43),extensionId:id})).rejects.toThrow();
    await expect(exchangeBrowserCompanion({code:c,verifier,extensionId:id})).rejects.toThrow();
  });
  it('fails closed when the extension is not registered',async()=>{
    vi.stubEnv('CLOUDCOM_BROWSER_COMPANION_IDS','');
    await expect(code()).rejects.toThrow(/registered/);
  });
  it('revalidates the original identity on every authenticated call',async()=>{
    const session=await exchangeBrowserCompanion({code:await code(),verifier,extensionId:id});
    m.validate.mockRejectedValueOnce(new Error('Revoked'));
    await expect(authenticateBrowserCompanion('Bearer '+session.accessToken,id)).rejects.toThrow('Revoked');
  });
  it('binds sessions to one registered extension and exact callback',async()=>{
    const other='b'.repeat(32);vi.stubEnv('CLOUDCOM_BROWSER_COMPANION_IDS',`${id},${other}`);
    const callback=new URL((await authorizeBrowserCompanion(auth,{extensionId:id,challenge,state})).redirectUri);
    expect(callback.origin).toBe(`https://${id}.chromiumapp.org`);expect(callback.pathname).toBe('/companion');expect(callback.searchParams.get('state')).toBe(state);
    const session=await exchangeBrowserCompanion({code:callback.searchParams.get('code'),verifier,extensionId:id});
    await expect(authenticateBrowserCompanion('Bearer '+session.accessToken,other)).rejects.toThrow();
  });
});
