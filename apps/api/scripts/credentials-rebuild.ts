/** Operator-only. Default is read-only planning. Never emits secrets or usernames. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { db, closeDb, withSystemDbAccessContext } from '../src/db';
import { auditLogs } from '../src/db/schema/audit';
import { encryptSecret, decryptSecret } from '../src/services/secretCrypto';
import { seal, unseal } from '../../../packages/ext-credentials/src/server/secrets';
import { sealDocument, unsealDocument } from '../../../packages/ext-credentials/src/server/documentSecrets';
import { extractNoteCredentials } from '../../../packages/ext-credentials/src/import/extractNoteCredentials';
import { digest, identity, secretIdentity, inferredEmailProvider, normalizePreservingSecrets, preservedNote } from './credentials-rebuild-plan';

const crypto={encryptForColumn:(t:string,c:string,v:string)=>encryptSecret(v,{aad:`${t}.${c}`})??'',decryptForColumn:(t:string,c:string,v:string)=>decryptSecret(v,{aad:`${t}.${c}`,strict:true})??''};
type RecordRow={id:string;org_id:string;name:string;category:string;username:string;email:string;url:string;secret_ciphertext:string;creation_state:string;version:number;is_draft:boolean;is_administration:boolean;[key:string]:unknown};
type DocRow={id:string;org_id:string;payload_ciphertext:string;[key:string]:unknown};
function flag(name:string){const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];}
async function verifyBackup(){
  const file=flag('--backup-file'),expected=flag('--backup-sha256');
  if(!file||!expected||!/^[a-f0-9]{64}$/.test(expected))throw Error('Verified backup required');
  const metadata=await stat(file);if(!metadata.isFile()||metadata.size===0)throw Error('Empty backup');
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
  if(hash.digest('hex')!==expected)throw Error('Backup digest mismatch');
  return expected;
}
async function main(){
  const apply=process.argv.includes('--apply');
  const allowed=new Set(['--apply','--dry-run','--expected-digest','--backup-file','--backup-sha256','--exclude-org','--overrides-file']);
  for(let i=2;i<process.argv.length;i++){const key=process.argv[i]!;if(!allowed.has(key))throw Error('Unknown argument');if(!['--apply','--dry-run'].includes(key)){if(!process.argv[++i]||process.argv[i]!.startsWith('--'))throw Error('Missing argument');}}
  if(apply&&process.argv.includes('--dry-run'))throw Error('Conflicting mode');
  const excludedIds=process.argv.flatMap((v,i)=>v==='--exclude-org'?[process.argv[i+1]!]:[]);
  if(excludedIds.some(id=>!/^[a-f0-9-]{36}$/i.test(id)))throw Error('Invalid exclusion');
  const overrides:Record<string,{emailProvider:'google'|'microsoft';microsoftAppsOnly?:boolean}>=flag('--overrides-file')?JSON.parse(await readFile(flag('--overrides-file')!,'utf8')):{};
  for(const [id,value] of Object.entries(overrides))if(!/^[a-f0-9-]{36}$/i.test(id)||!value||!['google','microsoft'].includes(value.emailProvider)||Object.keys(value).some(k=>!['emailProvider','microsoftAppsOnly'].includes(k))||(value.microsoftAppsOnly!==undefined&&typeof value.microsoftAppsOnly!=='boolean'))throw Error('Invalid overrides');
  const backup=apply?await verifyBackup():undefined;
  if(apply&&!/^[a-f0-9]{64}$/.test(flag('--expected-digest')??''))throw Error('Source digest required');
  const result=await withSystemDbAccessContext(async()=>{
    await db.execute(sql`SET LOCAL lock_timeout='5s'`);
    await db.execute(sql`SET LOCAL statement_timeout='60s'`);
    // Share-row-exclusive fences inserts as well as updates/deletes. Acquire all
    // tables in a fixed order; no network I/O occurs while this lock is held.
    if(apply)await db.execute(sql`LOCK TABLE organizations,credentials_documents,credentials_records IN SHARE ROW EXCLUSIVE MODE`);
    const organizations=await db.execute(sql`SELECT id,name FROM organizations WHERE deleted_at IS NULL ORDER BY id`);
    const allRecords=await db.execute(sql`SELECT * FROM credentials_records WHERE archived=false ORDER BY org_id,id`) as unknown as RecordRow[];
    const excluded=new Set([...organizations.filter(o=>excludedIds.includes(String(o.id))||String(o.name).toLowerCase()==='store review').map(o=>String(o.id)),...allRecords.filter(r=>r.category==='Review fixture').map(r=>r.org_id)]);
    const records=allRecords.filter(r=>!excluded.has(r.org_id));
    const docs=(await db.execute(sql`SELECT * FROM credentials_documents ORDER BY org_id,id`) as unknown as DocRow[]).filter(d=>!excluded.has(d.org_id));
    const sourceDigest=digest({organizations,records,docs,excluded:[...excluded].sort(),overrides});
    if(apply&&sourceDigest!==flag('--expected-digest'))throw Error('Source changed');
    if(records.some(r=>['pending','unknown'].includes(r.creation_state)))throw Error('Unreconciled Microsoft creation');
    const report:{id:string;orgId:string;name:string;category:string;action:string;reasons:string[]}[]=[];
    const identities=new Set<string>(),knownSecrets=new Set<string>();
    const providerEvidence=new Map<string,{name:string;category:string}[]>();
    let preserved=0,proposed=0,moved=0,leftInNotes=0;
    for(const r of records){
      const secret=unseal(crypto,r.org_id,r.id,r.secret_ciphertext);
      const original={name:r.name,category:r.category,username:r.username,email:r.email,url:r.url,...secret};
      const normalized=normalizePreservingSecrets(original);
      if(overrides[r.org_id]?.microsoftAppsOnly&&normalized.name==='Microsoft 365'){normalized.name='Microsoft 365 Apps';normalized.category='Application / Cloud';}
      identities.add(identity(r.org_id,normalized));
      if(normalized.disposition==='credential')knownSecrets.add(secretIdentity(r.org_id,normalized));
      if(normalized.disposition!=='note')providerEvidence.set(r.org_id,[...(providerEvidence.get(r.org_id)??[]),{name:normalized.name,category:normalized.category}]);
      report.push({id:r.id,orgId:r.org_id,name:normalized.name,category:normalized.category,action:normalized.disposition==='note'?'move_to_notes':'normalize',reasons:normalized.reasons});
      if(normalized.disposition==='note'){
        const payload=await preservedNote(original),id=randomUUID();
        const encrypted=sealDocument(crypto,r.org_id,id,payload);
        const verified=unsealDocument(crypto,r.org_id,id,encrypted);
        if(JSON.stringify(verified)!==JSON.stringify(payload))throw Error('Note preservation failed');
        for(const key of ['password','otpSecret','notes'] as const)if(!verified.sheets[0]!.rows.some(row=>row.cells[0]?.text===key&&row.cells[1]?.text===secret[key]))throw Error('Secret preservation failed');
        if(apply){
          const bytes=Buffer.from(payload.originalBase64,'base64');
          await db.execute(sql`INSERT INTO credentials_documents(id,org_id,name,filename,mime_type,source_organization,source_id,sha256,size_bytes,sheet_count,payload_ciphertext) VALUES(${id}::uuid,${r.org_id}::uuid,${normalized.name.slice(0,500)},'preserved-note.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','credential-rebuild',${r.id},${createHash('sha256').update(bytes).digest('hex')},${bytes.length},1,${encrypted})`);
          const changed=await db.execute(sql`UPDATE credentials_records SET archived=true,version=version+1,updated_at=now() WHERE id=${r.id}::uuid AND version=${r.version} AND archived=false RETURNING id`);
          if(changed.length!==1)throw Error('Archive CAS failed');
        }
        moved++;
      }else if(apply){
        const needsDetails=(!normalized.username&&normalized.category!=='Network / Wi-Fi')||!normalized.password;
        const changed=await db.execute(sql`UPDATE credentials_records SET name=${normalized.name},category=${normalized.category},is_administration=${r.is_administration||normalized.isAdministration},is_draft=${r.is_draft||normalized.disposition==='review'||needsDetails},version=version+1,updated_at=now() WHERE id=${r.id}::uuid AND version=${r.version} AND archived=false AND secret_ciphertext=${r.secret_ciphertext} RETURNING secret_ciphertext`);
        if(changed.length!==1||changed[0]!.secret_ciphertext!==r.secret_ciphertext)throw Error('Secret preservation CAS failed');
      }
      preserved++;
    }
    for(const d of docs){
      const payload=unsealDocument(crypto,d.org_id,d.id,d.payload_ciphertext);
      for(const candidate of extractNoteCredentials(payload.sheets,{emailProvider:overrides[d.org_id]?.emailProvider??inferredEmailProvider(providerEvidence.get(d.org_id)??[])})){
        const normalized=normalizePreservingSecrets(candidate.fields);
        if(overrides[d.org_id]?.microsoftAppsOnly&&normalized.name==='Microsoft 365'){normalized.name='Microsoft 365 Apps';normalized.category='Application / Cloud';}
        const key=identity(d.org_id,normalized);
        if(identities.has(key)||normalized.disposition==='note')continue;identities.add(key);
        if(candidate.reviewReasons.some(reason=>['account_type_and_service_need_review','conflicting_account_context'].includes(reason))){
          if(knownSecrets.has(secretIdentity(d.org_id,normalized)))continue;
          report.push({id:d.id,orgId:d.org_id,name:normalized.name,category:normalized.category,action:'needs_source_review',reasons:[...normalized.reasons,...candidate.reviewReasons]});
          leftInNotes++;continue;
        }
        const sourceId=digest([d.id,candidate.source]);
        // Stable source provenance makes applying the operator plan repeat-safe.
        const prior=await db.execute(sql`SELECT id FROM credentials_records WHERE org_id=${d.org_id}::uuid AND source_organization='note-extraction' AND source_id=${sourceId}`);
        if(prior.length)continue;
        const id=randomUUID(),secret={password:normalized.password,otpSecret:normalized.otpSecret,notes:normalized.notes};
        const encrypted=seal(crypto,d.org_id,id,secret);
        if(JSON.stringify(unseal(crypto,d.org_id,id,encrypted))!==JSON.stringify(secret))throw Error('Draft preservation failed');
        if(apply)await db.execute(sql`INSERT INTO credentials_records(id,org_id,name,category,username,email,url,secret_ciphertext,has_password,has_otp,is_draft,is_administration,source_organization,source_id) VALUES(${id}::uuid,${d.org_id}::uuid,${normalized.name},${normalized.category},${normalized.username},${normalized.email},${normalized.url},${encrypted},${Boolean(secret.password)},${Boolean(secret.otpSecret)},true,${normalized.isAdministration},'note-extraction',${sourceId})`);
        report.push({id:d.id,orgId:d.org_id,name:normalized.name,category:normalized.category,action:'draft_from_note',reasons:[...normalized.reasons,...candidate.reviewReasons]});proposed++;
      }
    }
    if(preserved!==records.length)throw Error('Incomplete preservation');
    if(apply){
      const runId=randomUUID();
      for(const orgId of new Set(report.map(r=>r.orgId))){
        const items=report.filter(r=>r.orgId===orgId);
        await db.insert(auditLogs).values({orgId,actorType:'system',actorId:runId,action:'credentials.operator_rebuild.committed',resourceType:'organization',resourceId:orgId,result:'success',initiatedBy:'manual',details:{sourceDigest,backupSha256:backup,normalized:items.filter(r=>r.action==='normalize').length,movedToNotes:items.filter(r=>r.action==='move_to_notes').length,drafts:items.filter(r=>r.action==='draft_from_note').length,leftInNotes:items.filter(r=>r.action==='needs_source_review').length}});
      }
    }
    return {dryRun:!apply,sourceDigest,backupSha256:backup,excludedOrgIds:[...excluded],existing:records.length,preserved,movedToNotes:moved,draftCandidates:proposed,leftInNotes,report};
  },'credentials-rebuild');
  process.stdout.write(JSON.stringify(result)+'\n');
}
main().catch(()=>{process.stderr.write('Credential rebuild failed closed; no record contents logged.\n');process.exitCode=1;}).finally(async()=>{await closeDb();process.exit(process.exitCode??0);});
