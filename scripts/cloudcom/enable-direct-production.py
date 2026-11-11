#!/usr/bin/env python3
"""Point the running CloudCom API and Exchange worker at one editable host tree.

This is an operator-only transition. It copies the exact running files first,
retains Compose for rollback, and does not build or pull a Docker image.
"""
import copy
import datetime
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path('/opt/cloudcom')
COMPOSE = ROOT / 'deployment/compose.json'
LIVE = ROOT / 'live-code'
TARGETS = {
    'api': {
        '/app/apps/api/dist',
        '/app/packages/ext-cloud-command/dist/web',
        '/app/packages/ext-cloud-command/manifest.json',
        '/app/packages/ext-cloud-command/migrations/2026-09-25-microsoft-directory-layouts.sql',
        '/app/packages/ext-cloud-command/migrations/2026-09-25-microsoft-directory-snapshots.sql',
    },
    'cloudcom-exchange-worker': {'/app/exchange-worker.py', '/app/exchange-persistent.ps1'},
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


def main():
    if os.geteuid() != 0 or LIVE.exists():
        raise RuntimeError('root required and live-code must not already exist')
    original = json.loads(COMPOSE.read_text())
    candidate = copy.deepcopy(original)
    for service, targets in TARGETS.items():
        found = set()
        for volume in candidate['services'][service]['volumes']:
            if volume.get('target') not in targets:
                continue
            if volume.get('type') != 'bind' or not volume.get('read_only'):
                raise RuntimeError(f'unexpected {service} mount')
            source = Path(volume['source'])
            if not source.is_relative_to(ROOT / 'features') or not source.exists() or source.is_symlink():
                raise RuntimeError(f'unexpected source: {source}')
            found.add(volume['target'])
        if found != targets:
            raise RuntimeError(f'incomplete {service} mounts: {targets - found}')
    # Every current override must come from exactly the same running artifact.
    roots = {Path(v['source']).parents[len(Path(v['source']).parts) - len((ROOT / 'features').parts) - 2]
             for service, targets in TARGETS.items()
             for v in candidate['services'][service]['volumes'] if v.get('target') in targets}
    if len(roots) != 1:
        raise RuntimeError('mixed current source trees')
    old = roots.pop()
    if old.parent != ROOT / 'features' or not old.is_dir():
        raise RuntimeError('invalid current source tree')
    shutil.copytree(old, LIVE, symlinks=False)
    for service, targets in TARGETS.items():
        for volume in candidate['services'][service]['volumes']:
            if volume.get('target') in targets:
                volume['source'] = str(LIVE / Path(volume['source']).relative_to(old))
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = ROOT / 'deployment' / f'compose.before-direct-code-{stamp}.json'
    staged = ROOT / 'deployment' / f'compose.direct-code-{stamp}.tmp.json'
    shutil.copy2(COMPOSE, backup)
    staged.write_text(json.dumps(candidate, indent=2) + '\n')
    try:
        run('docker', 'compose', '-f', str(staged), 'config', '--quiet')
        os.replace(staged, COMPOSE)
        run('docker', 'compose', '-f', str(COMPOSE), 'up', '-d', '--no-deps', 'cloudcom-exchange-worker', 'api')
        for _ in range(36):
            if healthy():
                print(f'direct code enabled; backup={backup}; source={LIVE}')
                return
            time.sleep(5)
        raise RuntimeError('services did not become healthy')
    except Exception:
        shutil.copy2(backup, COMPOSE)
        subprocess.run(['docker', 'compose', '-f', str(COMPOSE), 'up', '-d', '--no-deps',
                        'cloudcom-exchange-worker', 'api'], check=False)
        raise
    finally:
        staged.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'direct-code transition failed: {exc}', file=sys.stderr)
        sys.exit(1)
