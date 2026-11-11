"""Read-only OCI archive validation; output only public image provenance."""
import argparse, hashlib, json, tarfile
from pathlib import Path

p=argparse.ArgumentParser()
p.add_argument('archive')
p.add_argument('source')
p.add_argument('version')
p.add_argument('image_id')
p.add_argument('output')
a=p.parse_args()
records={}
sizes={}
seen=set()
with tarfile.open(a.archive,'r|gz') as t:
    for m in t:
        if m.name in seen: raise RuntimeError('Duplicate archive member')
        seen.add(m.name)
        if not m.isfile(): continue
        f=t.extractfile(m)
        if m.name in ('index.json','oci-layout','manifest.json'):
            records[m.name]=json.load(f); continue
        if not m.name.startswith('blobs/sha256/'): raise RuntimeError('Unexpected archive member')
        h=hashlib.sha256(); small=bytearray()
        while chunk:=f.read(1024*1024):
            h.update(chunk)
            if m.size<2*1024*1024: small.extend(chunk)
        if h.hexdigest()!=m.name.rsplit('/',1)[1]: raise RuntimeError('Blob checksum mismatch')
        sizes['sha256:'+h.hexdigest()]=m.size
        if small:
            try: records[m.name]=json.loads(small)
            except (ValueError,UnicodeError): pass
def blob(d): return records['blobs/sha256/'+d.split(':',1)[1]]
results=[]
def visit(d,tag):
    obj=blob(d)
    if 'manifests' in obj:
        for child in obj['manifests']: visit(child['digest'],tag)
        return
    cfg=blob(obj['config']['digest'])
    for layer in obj['layers']:
        if sizes.get(layer['digest'])!=layer['size']: raise RuntimeError('Referenced layer missing or size mismatch')
    if len(obj['layers'])!=len(cfg['rootfs']['diff_ids']): raise RuntimeError('Filesystem layer count mismatch')
    labels=cfg.get('config',{}).get('Labels',{})
    if labels.get('org.opencontainers.image.revision')!=a.source: raise RuntimeError('Revision mismatch')
    if labels.get('org.opencontainers.image.version')!=a.version: raise RuntimeError('Version mismatch')
    if cfg.get('os')!='linux' or cfg.get('architecture')!='amd64': raise RuntimeError('Platform mismatch')
    results.append({'tag':tag,'manifestDigest':d,'configDigest':obj['config']['digest'],'layers':obj['layers'],'diffIds':cfg['rootfs']['diff_ids'],'sourceCommit':a.source,'version':labels.get('org.opencontainers.image.version')})
for desc in records['index.json']['manifests']:
    visit(desc['digest'],desc.get('annotations',{}).get('org.opencontainers.image.ref.name'))
if len(results)!=1: raise RuntimeError('Expected one candidate OCI image')
if a.image_id not in (results[0]['manifestDigest'],results[0]['configDigest']): raise RuntimeError('Docker identity does not match OCI manifest or config')
results[0]['dockerImageId']=a.image_id
Path(a.output).write_text(json.dumps(results,indent=2)+'\n')
print('Validated candidate archive blobs, manifest, config, filesystem layers and source/version labels.')
