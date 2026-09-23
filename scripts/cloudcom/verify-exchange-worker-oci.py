"""Verify the Exchange worker OCI candidate without extracting paths or running code."""
import argparse, hashlib, json, pathlib, re, tarfile

def sha256_stream(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(chunk)
    return digest.hexdigest()

def verify(archive, commit, component):
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or component != 'exchange-worker':
        raise ValueError('Invalid candidate identity')
    with open(archive,'rb') as stream:
        archive_sha=sha256_stream(stream)
    with tarfile.open(archive,'r:*') as tf:
        members={}
        for member in tf:
            name=member.name.removeprefix('./').rstrip('/')
            if name in members or name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts:
                raise ValueError('Unsafe or duplicate archive member')
            if not member.isfile() and not member.isdir():
                raise ValueError('Nonregular archive member')
            members[name]=member
        def read(name, limit=4*1024*1024):
            member=members[name]
            if not member.isfile() or member.size>limit:
                raise ValueError('Invalid metadata member')
            return tf.extractfile(member).read()
        def descriptor(desc, metadata=False):
            digest=desc.get('digest','')
            if not re.fullmatch(r'sha256:[0-9a-f]{64}',digest):
                raise ValueError('Unsupported digest')
            member=members['blobs/sha256/'+digest[7:]]
            if not member.isfile() or member.size!=desc['size']:
                raise ValueError('Descriptor size mismatch')
            with tf.extractfile(member) as stream:
                actual=sha256_stream(stream)
            if actual!=digest[7:]:
                raise ValueError('Descriptor digest mismatch')
            return json.loads(read(member.name.removeprefix('./'))) if metadata else None
        if json.loads(read('oci-layout'))!={'imageLayoutVersion':'1.0.0'}:
            raise ValueError('Invalid OCI layout')
        index=json.loads(read('index.json'))
        if index.get('schemaVersion')!=2 or len(index.get('manifests',[]))!=1:
            raise ValueError('Expected exactly one image manifest')
        selected=index['manifests'][0]
        if selected.get('mediaType')!='application/vnd.oci.image.manifest.v1+json':
            raise ValueError('Expected OCI image manifest')
        platform=selected.get('platform',{})
        if platform and (platform.get('os')!='linux' or platform.get('architecture')!='amd64'):
            raise ValueError('Wrong manifest platform')
        manifest=descriptor(selected,True)
        if manifest.get('schemaVersion')!=2 or manifest['config']['mediaType']!='application/vnd.oci.image.config.v1+json':
            raise ValueError('Invalid image manifest/config')
        config=descriptor(manifest['config'],True)
        if config.get('os')!='linux' or config.get('architecture')!='amd64':
            raise ValueError('Wrong config platform')
        if config.get('config',{}).get('Labels',{}).get('org.opencontainers.image.revision')!=commit:
            raise ValueError('Wrong source revision')
        layers=manifest['layers']
        if not layers or len(config.get('rootfs',{}).get('diff_ids',[]))!=len(layers):
            raise ValueError('Layer inventory mismatch')
        for layer in layers:
            if layer['mediaType'] not in ('application/vnd.oci.image.layer.v1.tar+gzip','application/vnd.oci.image.layer.v1.tar','application/vnd.oci.image.layer.v1.tar+zstd'):
                raise ValueError('Unsupported layer media type')
            descriptor(layer)
        return {'sourceCommit':commit,'component':component,'archiveSha256':archive_sha,
                'manifestDigest':selected['digest'],'configDigest':manifest['config']['digest'],
                'platform':'linux/amd64','layerCount':len(layers),'diffIds':config['rootfs']['diff_ids']}

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('archive');parser.add_argument('commit');parser.add_argument('component')
    parser.add_argument('--output')
    args=parser.parse_args()
    result=verify(args.archive,args.commit,args.component)
    text=json.dumps(result,indent=2)+'\n'
    if args.output:pathlib.Path(args.output).write_text(text,encoding='utf-8')
    print(text,end='')
