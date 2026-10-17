import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AuthContext } from '../middleware/auth';
import { getRedis } from './redis';
import { createAccessToken, type TokenPayload } from './jwt';
import { revalidateStaffNativePrincipal, staffNativePrincipalFromAuth, staffNativePrincipalSchema } from './staffNativeAuthority';

const digest=(s:string)=>createHash('sha256').update(s,'ascii').digest('base64url');
const nonce=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const requestSchema=z.object({extensionId:z.string().regex(/^[a-p]{32}$/),challenge:nonce,state:nonce}).strict();
const identitySchema=z.object({email:z.string().email(),roleId:z.string().uuid().nullable(),mfaSource:z.enum(['factor','idp','policy']).optional()}).strict();
const sessionSchema=z.object({principal:staffNativePrincipalSchema,identity:identitySchema,extensionId:z.string().regex(/^[a-p]{32}$/)}).strict();
const exchangeSchema=z.object({code:nonce,verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),extensionId:z.string().regex(/^[a-p]{32}$/)}).strict();
const consume="local v=redis.call('GET',KEYS[1]); if v then redis.call('DEL',KEYS[1]); end; return v";
export function companionIds(){return (process.env.CLOUDCOM_BROWSER_COMPANION_IDS??'').split(',').filter(x=>/^[a-p]{32}$/.test(x));}
const redis=()=>{const r=getRedis();if(!r)throw new Error('Companion unavailable');return r;};
const allowed=(id:string)=>{if(!companionIds().includes(id))throw new Error('Companion not registered');};

export async function authorizeBrowserCompanion(auth:AuthContext,input:unknown){
  const request=requestSchema.parse(input);allowed(request.extensionId);
  const principal=staffNativePrincipalFromAuth(auth);
  await revalidateStaffNativePrincipal(principal);
  const identity=identitySchema.parse({email:auth.user.email,roleId:auth.token?.roleId??null,mfaSource:auth.token?.mfa_src});
  const code=randomBytes(32).toString('base64url');
  const expiresAt=Date.now()+60_000;
  const record={principal,identity,extensionId:request.extensionId,challenge:request.challenge,expiresAt};
  if(await redis().set('browser:companion:code:'+digest(code),JSON.stringify(record),'EX',60,'NX')!=='OK')throw new Error('Companion unavailable');
  const callback=new URL(`https://${request.extensionId}.chromiumapp.org/companion`);
  callback.searchParams.set('code',code);callback.searchParams.set('state',request.state);
  return {redirectUri:callback.href};
}

export async function exchangeBrowserCompanion(input:unknown){
  const request=exchangeSchema.parse(input);allowed(request.extensionId);
  const raw=await redis().eval(consume,1,'browser:companion:code:'+digest(request.code));
  if(typeof raw!=='string')throw new Error('Sign-in expired');
  const record=z.object({principal:staffNativePrincipalSchema,identity:identitySchema,extensionId:z.string(),challenge:nonce,expiresAt:z.number().int()}).strict().parse(JSON.parse(raw));
  if(record.extensionId!==request.extensionId||record.expiresAt<=Date.now()||record.expiresAt>Date.now()+60_000||
    !timingSafeEqual(Buffer.from(digest(request.verifier),'ascii'),Buffer.from(record.challenge,'ascii')))throw new Error('Sign-in denied');
  await revalidateStaffNativePrincipal(record.principal);
  const accessToken='ccb1.'+randomBytes(32).toString('base64url');
  const session={principal:record.principal,identity:record.identity,extensionId:record.extensionId};
  const ttl=Math.floor((record.principal.expiresAt-Date.now())/1000);if(ttl<=0)throw new Error('Sign-in expired');
  if(await redis().set('browser:companion:session:'+digest(accessToken),JSON.stringify(session),'EX',ttl,'NX')!=='OK')throw new Error('Companion unavailable');
  return {accessToken,expiresAt:record.principal.expiresAt};
}

export async function authenticateBrowserCompanion(header:string|undefined,extensionId:string){
  allowed(extensionId);if(!header?.match(/^Bearer ccb1\.[A-Za-z0-9_-]{43}$/))throw new Error('Sign in required');
  const key='browser:companion:session:'+digest(header.slice(7));
  const raw=await redis().get(key);if(!raw)throw new Error('Sign in required');
  const session=sessionSchema.parse(JSON.parse(raw));if(session.extensionId!==extensionId)throw new Error('Sign in required');
  const authority=await revalidateStaffNativePrincipal(session.principal);
  return {session,key,authority};
}
export async function endBrowserCompanion(key:string){await redis().del(key);}

/** Only used for a bounded, in-process dispatch to existing API routes.
 * Never returned to the addon. Core authorization and audit still run. */
export async function companionDispatchToken(session:z.infer<typeof sessionSchema>){
  const p=session.principal;
  const payload:Omit<TokenPayload,'type'>={sub:p.userId,email:session.identity.email,roleId:session.identity.roleId,
    scope:'partner',partnerId:p.partnerId,orgId:null,mfa:true,mfa_src:session.identity.mfaSource,
    aep:p.authEpoch,mep:p.mfaEpoch,sid:p.familyId};
  return createAccessToken(payload);
}
