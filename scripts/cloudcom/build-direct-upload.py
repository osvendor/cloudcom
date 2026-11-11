#!/usr/bin/env python3
"""Make a transient, hash-checked transport ZIP from the current local build."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FILES = {
    'dist/index.cjs': ROOT / 'apps/api/dist/index.cjs',
    'dist/worker.cjs': ROOT / 'apps/api/dist/worker.cjs',
    'dist/scripts/recover-stuck-agents.cjs': ROOT / 'apps/api/dist/scripts/recover-stuck-agents.cjs',
    'dist/scripts/upgrade-preflight.cjs': ROOT / 'apps/api/dist/scripts/upgrade-preflight.cjs',
    'packages/ext-cloud-command/dist/web/index.js': ROOT / 'packages/ext-cloud-command/dist/web/index.js',
    'worker/exchange-worker.py': ROOT / 'scripts/cloudcom/exchange-worker.py',
    'worker/exchange-persistent.ps1': ROOT / 'scripts/cloudcom/exchange-persistent.ps1',
}


def main(output: Path):
    if output.exists():
        raise RuntimeError('output already exists; choose a new temporary path')
    hashes = {}
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as upload:
        for name, path in FILES.items():
            if not path.is_file() or path.is_symlink():
                raise RuntimeError(f'missing build input: {path}')
            data = path.read_bytes()
            hashes[name] = hashlib.sha256(data).hexdigest()
            upload.writestr(name, data)
        upload.writestr('direct-code-sha256.json', json.dumps(hashes, indent=2) + '\n')
    print(f'{output} {output.stat().st_size} bytes')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: build-direct-upload.py /absolute/temporary/output.zip')
    main(Path(sys.argv[1]).resolve())
