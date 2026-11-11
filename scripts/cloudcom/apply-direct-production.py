#!/usr/bin/env python3
"""Apply an exact local build to the live Lightsail code tree, without a release.

The upload is transient. One prior live tree is kept for automatic rollback.
The running image digests and Compose configuration are never changed here.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

LIVE = Path('/opt/cloudcom/live-code')
BACKUP = Path('/opt/cloudcom/live-code.rollback')
COMPOSE = Path('/opt/cloudcom/deployment/compose.json')
FILES = {
    'dist/index.cjs', 'dist/worker.cjs',
    'dist/scripts/recover-stuck-agents.cjs', 'dist/scripts/upgrade-preflight.cjs',
    'packages/ext-cloud-command/dist/web/index.js',
    'worker/exchange-worker.py', 'worker/exchange-persistent.ps1',
}


def run(*args):
    subprocess.run(args, check=True)


def healthy():
    for name in ('cloudcom-api', 'cloudcom-exchange-worker'):
        result = subprocess.run(['docker', 'inspect', '--format', '{{.State.Health.Status}}', name],
                                capture_output=True, text=True)
        if result.returncode or result.stdout.strip() != 'healthy':
            return False
    return True


def restart():
    run('docker', 'compose', '-f', str(COMPOSE), 'up', '-d', '--no-deps', '--force-recreate',
        'cloudcom-exchange-worker', 'api')
    for _ in range(36):
        if healthy():
            return
        time.sleep(5)
    raise RuntimeError('API or Exchange worker did not become healthy')


def replace_file(target: Path, data: bytes):
    temporary = target.with_name(target.name + '.direct-new')
    with temporary.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o644)
    os.replace(temporary, target)


def main(archive: Path):
    if os.geteuid() != 0 or not LIVE.is_dir() or LIVE.is_symlink() or not COMPOSE.is_file():
        raise RuntimeError('root and an initialized live-code directory are required')
    compose = json.loads(COMPOSE.read_text())
    required = {
        'api': {'/app/apps/api/dist', '/app/packages/ext-cloud-command/dist/web'},
        'cloudcom-exchange-worker': {'/app/exchange-worker.py', '/app/exchange-persistent.ps1'},
    }
    for service, targets in required.items():
        mounts = {v['target']: v['source'] for v in compose['services'][service]['volumes'] if v.get('target') in targets}
        if mounts.keys() != targets or any(not Path(path).is_relative_to(LIVE) for path in mounts.values()):
            raise RuntimeError('running code is not mounted from the direct tree')
    with zipfile.ZipFile(archive) as upload:
        if set(upload.namelist()) != FILES | {'direct-code-sha256.json'}:
            raise RuntimeError('unexpected upload file set')
        expected = json.loads(upload.read('direct-code-sha256.json'))
        if set(expected) != FILES:
            raise RuntimeError('incomplete upload hash list')
        payload = {}
        for name in FILES:
            info = upload.getinfo(name)
            target = LIVE / name
            if info.file_size > 64 * 1024 * 1024 or not target.is_file() or target.is_symlink():
                raise RuntimeError(f'invalid live target: {name}')
            data = upload.read(name)
            if hashlib.sha256(data).hexdigest() != expected[name]:
                raise RuntimeError(f'upload hash mismatch: {name}')
            payload[target] = data
    if BACKUP.exists():
        if BACKUP.is_symlink() or BACKUP.resolve() != BACKUP or BACKUP.parent != LIVE.parent:
            raise RuntimeError('unsafe previous rollback path')
        shutil.rmtree(BACKUP)
    shutil.copytree(LIVE, BACKUP, copy_function=os.link)
    try:
        for target, data in payload.items():
            replace_file(target, data)
        restart()
        print('Direct production code applied; API and Exchange worker healthy; one rollback tree retained.')
    except Exception:
        for name in FILES:
            replace_file(LIVE / name, (BACKUP / name).read_bytes())
        try:
            restart()
        except Exception as rollback_error:
            print(f'rollback restart failed: {rollback_error}', file=sys.stderr)
        raise


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise RuntimeError('usage: apply-direct-production.py /absolute/path/to/upload.zip')
        main(Path(sys.argv[1]))
    except Exception as exc:
        print(f'direct production update failed: {exc}', file=sys.stderr)
        sys.exit(1)
