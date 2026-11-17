import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { MicrosoftRequest } from '@cloudcom/ext-cloud-command';
import { generateCredentialPassword } from '@cloudcom/ext-credentials';
import { db } from '../db';
import { withAuthDbAccessContext, type AuthContext } from '../middleware/auth';
import { getUserPermissions, hasPermission } from '../services/permissions';
import { encryptSecret } from '../services/secretCrypto';
import { createAuditLog } from '../services/auditService';
import { authorizeCloudCommandAdministration } from './cloudCommandAdminAuthorization';

const base = z.object({executionId:z.string().uuid(),connectionId:z.string().uuid(),tenantId:z.string().uuid(),username:z.string().email().max(320)});
const prepareSchema=base.extend({password:z.string().min(1).max(4096),temporaryPassword:z.boolean()}).strict();
const completeSchema=base.extend({providerUserId:z.string().uuid()}).strict();
const failureSchema=base.extend({state:z.enum(['rejected','unknown'])}).strict();
const rows=<T>(v:unknown):T[]=>{if(!Array.isArray(v))throw Error('Credential storage unavailable');return v;};
async function scoped<T>(request:MicrosoftRequest,input:z.infer<typeof base>,fn:(auth:AuthContext)=>Promise<T>):Promise<T>{
  if(process.env.CLOUDCOM_CREDENTIALS_ENABLED!=='true')throw Error('Credential storage unavailable');
  if(!await authorizeCloudCommandAdministration(request,request.orgId,true))throw Error('Credential capture denied');
  const auth=request.auth as AuthContext;
  // Separate caller-scoped commit before Graph. Never retain an ambient request
  // transaction across a remote mutation, and never escalate to system scope.
  return withAuthDbAccessContext(auth,async()=>{
    const permissions=await getUserPermissions(auth.user.id,{scope:auth.scope,partnerId:auth.partnerId??undefined,orgId:auth.orgId??undefined},{bypassCache:true});
    if(!permissions||permissions.allowedSiteIds!==undefined||!hasPermission(permissions,'credentials','import')||!hasPermission(permissions,'credentials','read'))throw Error('Credential capture denied');
    if(permissions.scope==='organization'&&permissions.orgId!==request.orgId)throw Error('Credential capture denied');
    if(permissions.scope==='partner'&&permissions.orgAccess!=='all'
      &&!(permissions.orgAccess==='selected'&&permissions.allowedOrgIds?.includes(request.orgId)))throw Error('Credential capture denied');
    const connection=rows(await db.execute(sql`SELECT id FROM cloudcommand_microsoft_admin_connections WHERE org_id=${request.orgId}::uuid AND id=${input.connectionId}::uuid AND tenant_id=${input.tenantId}::uuid AND enabled=true`));
    if(!connection.length)throw Error('Credential connection changed');
    return fn(auth);
  });
}
export const cloudCommandCredentialCapture={
  generatePassword:generateCredentialPassword,
  async prepare(request:MicrosoftRequest,raw:z.infer<typeof prepareSchema>){
    const input=prepareSchema.parse(raw);
    await scoped(request,input,async auth=>{
      const id=input.executionId,orgId=request.orgId;
      const encrypted=encryptSecret(JSON.stringify({version:1,orgId,id,password:input.password,otpSecret:'',notes:''}),{aad:`credentials_records.secret_ciphertext:${id}`});
      if(!encrypted?.startsWith('enc:v3:'))throw Error('Credential encryption unavailable');
      await db.execute(sql`UPDATE credentials_records SET archived=true,source_id=source_id||':rejected:'||id::text,version=version+1,updated_at=now() WHERE org_id=${orgId}::uuid AND source_organization=${'microsoft:'+input.tenantId} AND source_id=${input.username.toLowerCase()} AND creation_state='rejected' AND archived=false`);
      const inserted=rows(await db.execute(sql`INSERT INTO credentials_records (id,org_id,name,category,username,email,url,secret_ciphertext,has_password,is_draft,is_administration,temporary_password,creation_state,source_organization,source_id)
        VALUES (${id}::uuid,${orgId}::uuid,'Microsoft 365','Email',${input.username},${input.username},'https://login.microsoftonline.com',${encrypted},true,true,false,${input.temporaryPassword},'pending',${'microsoft:'+input.tenantId},${input.username.toLowerCase()})
        ON CONFLICT (org_id,source_organization,source_id) DO NOTHING RETURNING id`));
      // A previous attempt must be reconciled, not silently replayed with a new password.
      if(!inserted.length)throw Error('A credential or pending creation already exists for this account');
      await createAuditLog({orgId,actorId:auth.user.id,actorType:'user',action:'credentials.microsoft.prepared',resourceType:'credential',resourceId:id,result:'success',details:{executionId:id}});
    });
  },
  async complete(request:MicrosoftRequest,raw:z.infer<typeof completeSchema>){
    const input=completeSchema.parse(raw);
    await scoped(request,input,async auth=>{
      const updated=rows(await db.execute(sql`UPDATE credentials_records SET is_draft=false,creation_state='accepted',provider_user_id=${input.providerUserId},version=version+1,updated_at=now()
        WHERE org_id=${request.orgId}::uuid AND id=${input.executionId}::uuid AND source_organization=${'microsoft:'+input.tenantId} AND source_id=${input.username.toLowerCase()} AND creation_state='pending' AND version=1 AND archived=false RETURNING id`));
      if(!updated.length){
        const prior=rows(await db.execute(sql`SELECT id FROM credentials_records WHERE org_id=${request.orgId}::uuid AND id=${input.executionId}::uuid AND creation_state='accepted' AND provider_user_id=${input.providerUserId} AND source_organization=${'microsoft:'+input.tenantId} AND source_id=${input.username.toLowerCase()} AND archived=false`));
        if(!prior.length)throw Error('Account created; credential completion requires review');
      }
      await createAuditLog({orgId:request.orgId,actorId:auth.user.id,actorType:'user',action:'credentials.microsoft.completed',resourceType:'credential',resourceId:input.executionId,result:'success',details:{executionId:input.executionId}});
    });
  },
  async fail(request:MicrosoftRequest,raw:z.infer<typeof failureSchema>){
    const input=failureSchema.parse(raw);
    await scoped(request,input,async()=>{
      await db.execute(sql`UPDATE credentials_records SET creation_state=${input.state},updated_at=now() WHERE org_id=${request.orgId}::uuid AND id=${input.executionId}::uuid AND source_organization=${'microsoft:'+input.tenantId} AND source_id=${input.username.toLowerCase()} AND creation_state='pending' AND archived=false`);
    });
  },
};
