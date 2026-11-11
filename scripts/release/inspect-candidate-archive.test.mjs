import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const inspector = fileURLToPath(new URL('./inspect-candidate-archive.py', import.meta.url));
const source = 'a'.repeat(40);
const fixture = `import hashlib,io,json,sys,tarfile
entries={}
def add(obj):
 b=json.dumps(obj).encode();d=hashlib.sha256(b).hexdigest();entries['blobs/sha256/'+d]=b;return 'sha256:'+d
layer=add({'synthetic':'layer'})
cfg=add({'architecture':'amd64','os':'linux','config':{'Labels':{'org.opencontainers.image.revision':'a'*40,'org.opencontainers.image.version':'0.128.5'}},'rootfs':{'diff_ids':[layer]}})
man=add({'config':{'digest':cfg},'layers':[{'digest':layer,'size':len(entries['blobs/sha256/'+layer.split(':')[1]])}]})
entries['index.json']=json.dumps({'manifests':[{'digest':man,'annotations':{'org.opencontainers.image.ref.name':'candidate'}}]}).encode()
if sys.argv[2]=='corrupt':entries['blobs/sha256/'+cfg.split(':')[1]]=b'wrong bytes'
with tarfile.open(sys.argv[1],'w:gz') as t:
 for name,data in entries.items():
  info=tarfile.TarInfo(name);info.size=len(data);t.addfile(info,io.BytesIO(data))
 if sys.argv[2]=='duplicate':
  data=entries['index.json'];info=tarfile.TarInfo('index.json');info.size=len(data);t.addfile(info,io.BytesIO(data))
print(json.dumps({'manifest':man,'config':cfg}))`;
function run(mode, identity, revision = source, version = '0.128.5') {
 const dir=mkdtempSync(join(tmpdir(),'cloudcom-archive-'));
 try {
  const archive=join(dir,'image.tar.gz'), output=join(dir,'proof.json');
  const ids=JSON.parse(execFileSync('python3',['-c',fixture,archive,mode],{encoding:'utf8'}));
  const result=spawnSync('python3',[inspector,archive,revision,version,ids[identity]??identity,output],{encoding:'utf8'});
  return {...result, proof:result.status===0?JSON.parse(readFileSync(output,'utf8')):null,ids};
 } finally {rmSync(dir,{recursive:true,force:true});}
}
test('records exact manifest/config provenance for either Docker image-store identity',()=>{
 for(const identity of ['manifest','config']) {
  const result=run('valid',identity);assert.equal(result.status,0,result.stderr);
  assert.equal(result.proof[0].manifestDigest,result.ids.manifest);
  assert.equal(result.proof[0].configDigest,result.ids.config);
  assert.equal(result.proof[0].dockerImageId,result.ids[identity]);
  assert.equal(result.proof[0].sourceCommit,source);assert.equal(result.proof[0].version,'0.128.5');
 }
});
test('refuses changed archive blob bytes',()=>assert.notEqual(run('corrupt','manifest').status,0));
test('refuses unexplained Docker ID, source or version mismatch',()=>{
 assert.notEqual(run('valid','sha256:'+'f'.repeat(64)).status,0);
 assert.notEqual(run('valid','manifest','b'.repeat(40)).status,0);
 assert.notEqual(run('valid','manifest',source,'0.127.5').status,0);
});

test('refuses duplicate archive member names',()=>assert.notEqual(run('duplicate','manifest').status,0));
