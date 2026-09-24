import { readFileSync } from 'node:fs';
import { randomBytes,randomUUID,generateKeyPairSync,sign } from 'node:crypto';
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { eq,sql } from 'drizzle-orm';
import { getTestDb,getAppDb } from './setup';
import { db,withDbAccessContext } from '../../db';
import { partners,organizations,sites,devices,users,portalUsers,portalRemoteSettings,portalRemoteAssignments,
  portalRemoteSessions,portalNativeTargets,portalNativeAdmissions } from '../../db/schema';
import { enrollNativeTarget,authenticateNativeTarget } from '../../services/portalNativeTarget';
import { issueNativeAdmission,consumeNativeAdmission,renewNativeAdmission,touchNativePresence,endNativeAdmission,nativeSessionHash,expireStaleNativeSessionsForDevice } from '../../services/portalNativeAdmission';
import { encodeNativeAdmissionV2,hashNativeTicket } from '../../services/portalNativeProof';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import type { NativeTarget } from '../../services/portalNativeAdmissionSchemas';
const controls=vi.hoisted(()=>({prompt:'off',allowed:true}));
vi.mock('../../services/portalRemoteFeature',()=>({isPortalRemoteFeatureEnabled:async()=>true}));
vi.mock('../../services/tenantStatus',()=>({getActiveOrgTenant:async()=>({partnerId:'partner'})}));
vi.mock('../../services/remoteAccessPolicy',()=>({checkRemoteAccess:async()=>({allowed:controls.allowed}),resolveDesktopSessionPolicy:async()=>({maxSessionDurationHours:1,idleTimeoutMinutes:5})}));
vi.mock('../../routes/remote/helpers',()=>({resolveRemoteSessionPromptConfig:async()=>({mode:controls.prompt})}));
vi.mock('../../config/partnerTrustMode',()=>({partnerTrustMode:()=> 'off'}));
const secret=()=>randomBytes(32).toString('base64url');
beforeEach(()=>{vi.stubEnv('CLOUDCOM_NATIVE_ADMISSION_ENABLED','true');controls.prompt='off';controls.allowed=true;});
afterEach(()=>vi.unstubAllEnvs());
async function fixture() {
 const admin=getTestDb();
 const [partner]=await admin.insert(partners).values({name:'Native QA',slug:randomUUID(),type:'msp'}).returning();
 const [a,b]=await admin.insert(organizations).values(['A','B'].map(name=>({name,partnerId:partner!.id,slug:randomUUID(),currencyCode:'USD'}))).returning();
 const [staff]=await admin.insert(users).values({partnerId:partner!.id,email:randomUUID()+'@example.test',name:'Admin'}).returning();
 const [sa,sb]=await admin.insert(sites).values([{orgId:a!.id,name:'A'},{orgId:b!.id,name:'B'}]).returning();
 const [da,dbb]=await admin.insert(devices).values([[a!.id,sa!.id],[b!.id,sb!.id]].map(([orgId,siteId])=>({orgId:orgId!,siteId:siteId!,agentId:randomUUID(),hostname:'Target',osType:'windows' as const,osVersion:'11',architecture:'amd64',agentVersion:'0.115.0',status:'online' as const,agentTokenHash:'a'.repeat(64)}))).returning();
 const [alice,bob]=await admin.insert(portalUsers).values([{orgId:a!.id,email:'alice@example.test',accessMode:'remote_only' as const},{orgId:a!.id,email:'bob@example.test',accessMode:'remote_only' as const}]).returning();
 await admin.insert(portalRemoteSettings).values([{orgId:a!.id,enabled:true,rustdeskEnabled:true},{orgId:b!.id,enabled:true,rustdeskEnabled:true}]);
 const [grant]=await admin.insert(portalRemoteAssignments).values({orgId:a!.id,portalUserId:alice!.id,deviceId:da!.id,createdByUserId:staff!.id}).returning();
 const context={scope:'organization' as const,orgId:a!.id,accessibleOrgIds:[a!.id]};
 const scoped=<T>(fn:()=>Promise<T>)=>withDbAccessContext(context,fn);
 const agent={deviceId:da!.id,orgId:a!.id,role:'agent',authTokenHash:'a'.repeat(64)} as AgentAuthContext;
 const enrollment={version:2 as const,installationId:randomUUID(),targetPublicKey:secret(),targetCredential:secret(),rustdeskId:'123456789'};
 const enrolled=await scoped(()=>enrollNativeTarget(agent,enrollment));
 const target:NativeTarget={id:enrolled.targetId,orgId:a!.id,deviceId:da!.id,generation:1,credentialHash:hashNativeTicket(enrollment.targetCredential)};
 const operator={id:alice!.id,orgId:a!.id,authEpoch:1,sessionHash:nativeSessionHash('ccn1.'+secret()),expiresAt:Date.now()+120000};
 const pair=generateKeyPairSync('ed25519');const publicKey=pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64url');
 const issue=()=>scoped(()=>issueNativeAdmission(operator,da!.id,publicKey));
 const proof=(issued:Awaited<ReturnType<typeof issue>>)=>{
  const connectionId=randomUUID(),targetChallenge=secret(),channelBinding=secret();
  const binding={orgId:a!.id,deviceId:da!.id,sessionId:issued.sessionId,connectionId,targetGeneration:issued.targetGeneration,ticketHash:hashNativeTicket(issued.ticket),targetChallenge,operatorPublicKey:publicKey,targetPublicKey:enrollment.targetPublicKey,channelBinding};
  return {version:2 as const,sessionId:issued.sessionId,ticket:issued.ticket,connectionId,targetChallenge,channelBinding,operatorSignature:sign(null,encodeNativeAdmissionV2(binding),pair.privateKey).toString('base64url')};
 };
 return {admin,a:a!,b:b!,da:da!,dbb:dbb!,alice:alice!,bob:bob!,grant:grant!,context,scoped,agent,enrollment,target,operator,issue,proof,publicKey};
}
describe('native admission real SQL boundaries',()=>{
 it('retires an expired native lease without disconnecting a live session on the same device',async()=>{
  const f=await fixture();
  const expired=await f.issue(),expiredInput=f.proof(expired);
  await f.scoped(()=>consumeNativeAdmission(f.target,expiredInput));
  const live=await f.issue(),liveInput=f.proof(live);
  await f.scoped(()=>consumeNativeAdmission(f.target,liveInput));
  await f.admin.update(portalNativeAdmissions).set({presenceUntil:new Date(0),leaseExpiresAt:new Date(0)})
    .where(eq(portalNativeAdmissions.sessionId,expired.sessionId));
  await f.scoped(()=>expireStaleNativeSessionsForDevice(f.a.id,f.da.id));
  const [staleRow]=await f.admin.select({status:portalRemoteSessions.status,endedAt:portalRemoteSessions.endedAt})
    .from(portalRemoteSessions).where(eq(portalRemoteSessions.id,expired.sessionId));
  const [liveRow]=await f.admin.select({status:portalRemoteSessions.status,endedAt:portalRemoteSessions.endedAt})
    .from(portalRemoteSessions).where(eq(portalRemoteSessions.id,live.sessionId));
  expect(staleRow).toMatchObject({status:'disconnected'});
  expect(staleRow!.endedAt).not.toBeNull();
  expect(liveRow).toMatchObject({status:'active',endedAt:null});
 });
 it('is idempotent only for exact enrollment, and revokes old target credentials on explicit rotation',async()=>{
  const f=await fixture();
  expect(await f.scoped(()=>enrollNativeTarget(f.agent,f.enrollment))).toMatchObject({targetGeneration:1,targetId:f.target.id});
  await expect(f.scoped(()=>enrollNativeTarget(f.agent,{...f.enrollment,targetCredential:secret()}))).rejects.toThrow();
  expect(await authenticateNativeTarget('Bearer cct1.'+f.enrollment.targetCredential)).toMatchObject({id:f.target.id});
  const next={...f.enrollment,targetCredential:secret()};
  expect(await f.scoped(()=>enrollNativeTarget(f.agent,next,1))).toMatchObject({targetGeneration:2});
  expect(await authenticateNativeTarget('Bearer cct1.'+f.enrollment.targetCredential)).toBeNull();
  await expect(f.scoped(()=>enrollNativeTarget(f.agent,{...next,targetCredential:secret()},1))).rejects.toThrow();
  await expect(f.scoped(()=>enrollNativeTarget({...f.agent,authTokenHash:'b'.repeat(64)},next))).rejects.toThrow();
 });
 it('atomically consumes a ticket once under eight concurrent redemptions and binds subsequent leases',async()=>{
  const f=await fixture(),issued=await f.issue(),input=f.proof(issued);
  expect(issued.ticketExpiresAt-Date.now()).toBeGreaterThan(0);
  expect(issued.ticketExpiresAt-Date.now()).toBeLessThanOrEqual(50_000);
  const results=await Promise.allSettled(Array.from({length:8},()=>f.scoped(()=>consumeNativeAdmission(f.target,input))));
  const winners=results.filter((r):r is PromiseFulfilledResult<Awaited<ReturnType<typeof consumeNativeAdmission>>>=>r.status==='fulfilled');
  expect(winners).toHaveLength(1);
  const lease=winners[0]!.value;
  expect(lease).toMatchObject({revision:1,deviceId:f.da.id,targetGeneration:1,graceSec:0,policy:{clipboard:false,fileTransfer:false,audio:false,tunnel:false,idleTimeoutSeconds:300}});
  expect(lease.ttlMs).toBeGreaterThan(0);expect(lease.ttlMs).toBeLessThanOrEqual(60000);
  const renewed=await f.scoped(()=>renewNativeAdmission(f.target,issued.sessionId,input.connectionId,lease.leaseToken!));
  expect(renewed.revision).toBe(2);
  await expect(f.scoped(()=>renewNativeAdmission(f.target,issued.sessionId,randomUUID(),lease.leaseToken!))).rejects.toThrow();
  await expect(f.scoped(()=>renewNativeAdmission(f.target,issued.sessionId,input.connectionId,secret()))).rejects.toThrow();
  await f.scoped(()=>endNativeAdmission(f.operator,issued.sessionId));
  await expect(f.scoped(()=>renewNativeAdmission(f.target,issued.sessionId,input.connectionId,lease.leaseToken!))).rejects.toThrow();
 });
 it('denies cross-device/org and modified stream proofs without consuming the valid ticket',async()=>{
  const f=await fixture(),issued=await f.issue(),input=f.proof(issued);
  for(const target of [{...f.target,orgId:f.b.id},{...f.target,deviceId:f.dbb.id},{...f.target,generation:2}])await expect(f.scoped(()=>consumeNativeAdmission(target,input))).rejects.toThrow();
  await expect(f.scoped(()=>consumeNativeAdmission(f.target,{...input,channelBinding:secret()}))).rejects.toThrow();
  expect((await f.scoped(()=>consumeNativeAdmission(f.target,input))).revision).toBe(1);
 });
 it('binds the exact personal native session and never grants same-org users inherited access',async()=>{
  const f=await fixture();
  await expect(f.scoped(()=>issueNativeAdmission({...f.operator,id:f.bob.id},f.da.id,f.publicKey))).rejects.toThrow();
  await expect(f.scoped(()=>issueNativeAdmission(f.operator,f.dbb.id,f.publicKey))).rejects.toThrow();
  const issued=await f.issue(),input=f.proof(issued);await f.scoped(()=>consumeNativeAdmission(f.target,input));
  for(const operator of [{...f.operator,id:f.bob.id},{...f.operator,orgId:f.b.id},{...f.operator,sessionHash:nativeSessionHash('another')},{...f.operator,authEpoch:2}]) {
   await expect(f.scoped(()=>touchNativePresence(operator,issued.sessionId,input.connectionId))).rejects.toThrow();
   await expect(f.scoped(()=>endNativeAdmission(operator,issued.sessionId))).rejects.toThrow();
  }
 });
 it.each(['grant','account','target','presence','policy','duration'])('denies renewal after %s revocation',async change=>{
  const f=await fixture(),issued=await f.issue(),input=f.proof(issued),lease=await f.scoped(()=>consumeNativeAdmission(f.target,input));
  if(change==='grant')await f.admin.update(portalRemoteAssignments).set({enabled:false}).where(eq(portalRemoteAssignments.id,f.grant.id));
  if(change==='account')await f.admin.update(portalUsers).set({authEpoch:2}).where(eq(portalUsers.id,f.alice.id));
  if(change==='target')await f.scoped(()=>enrollNativeTarget(f.agent,{...f.enrollment,targetCredential:secret()},1));
  if(change==='presence')await f.admin.update(portalNativeAdmissions).set({presenceUntil:new Date(0)}).where(eq(portalNativeAdmissions.sessionId,issued.sessionId));
  if(change==='policy')controls.prompt='consent';
  if(change==='duration')await f.admin.update(portalRemoteSessions).set({createdAt:new Date(Date.now()-2*3600_000)}).where(eq(portalRemoteSessions.id,issued.sessionId));
  await expect(f.scoped(()=>renewNativeAdmission(f.target,issued.sessionId,input.connectionId,lease.leaseToken!))).rejects.toThrow();
 });
 it('does not revive expired leases or permit unsupported prompt modes',async()=>{
  const f=await fixture();controls.prompt='notify';await expect(f.issue()).rejects.toThrow();controls.prompt='off';
  const issued=await f.issue(),input=f.proof(issued);await f.scoped(()=>consumeNativeAdmission(f.target,input));
  await f.admin.update(portalNativeAdmissions).set({leaseExpiresAt:new Date(0)}).where(eq(portalNativeAdmissions.sessionId,issued.sessionId));
  await expect(f.scoped(()=>touchNativePresence(f.operator,issued.sessionId,input.connectionId))).rejects.toThrow();
 });
 it('is migration-idempotent and advances generation for direct SQL credential changes',async()=>{
  const f=await fixture();
  await f.admin.execute(sql.raw(readFileSync('migrations/2026-09-22-native-admission.sql','utf8')));
  const [before]=await f.admin.select().from(portalNativeTargets).where(eq(portalNativeTargets.id,f.target.id));
  expect(before!.generation).toBe(1);
  await f.admin.update(portalNativeTargets).set({publicKey:secret()}).where(eq(portalNativeTargets.id,f.target.id));
  const [after]=await f.admin.select().from(portalNativeTargets).where(eq(portalNativeTargets.id,f.target.id));
  expect(after!.generation).toBe(2);
  await expect(f.admin.update(portalNativeTargets).set({generation:1}).where(eq(portalNativeTargets.id,f.target.id))).rejects.toThrow();
 });
 it('forces RLS and composite identity constraints for both new tables',async()=>{
  const f=await fixture(),issued=await f.issue();
  const flags=await f.admin.execute(sql`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('portal_native_targets','portal_native_admissions')`);
  expect(flags).toHaveLength(2);for(const row of flags)expect(row).toMatchObject({relrowsecurity:true,relforcerowsecurity:true});
  await withDbAccessContext({scope:'organization',orgId:f.b.id,accessibleOrgIds:[f.b.id]},async()=>{
   expect(await db.select().from(portalNativeTargets)).toHaveLength(0);
   expect(await db.update(portalNativeAdmissions).set({presenceUntil:new Date(0)}).where(eq(portalNativeAdmissions.sessionId,issued.sessionId)).returning()).toHaveLength(0);
  });
  expect(await getAppDb().select().from(portalNativeAdmissions)).toHaveLength(0);
  await expect(f.admin.update(portalNativeAdmissions).set({portalUserId:f.bob.id}).where(eq(portalNativeAdmissions.sessionId,issued.sessionId))).rejects.toThrow();
  await expect(f.admin.update(portalNativeTargets).set({deviceId:f.dbb.id}).where(eq(portalNativeTargets.id,f.target.id))).rejects.toThrow();
  await expect(f.admin.update(devices).set({orgId:f.b.id}).where(eq(devices.id,f.da.id))).rejects.toThrow();
 });
});
