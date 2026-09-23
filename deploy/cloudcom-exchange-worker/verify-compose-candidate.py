#!/usr/bin/env python3
"""Render and validate the Exchange overlay without printing Compose secrets."""
import json
import os
import pathlib
import re
import subprocess
import sys

PRIVATE_TARGET = '/run/cloudcom-exchange-private'
CERT_TARGET = '/run/cloudcom-microsoft'
SOCKET = f'{PRIVATE_TARGET}/exchange.sock'
DESCRIPTOR = f'{PRIVATE_TARGET}/tenants.json'


def verify(base: pathlib.Path, overlay: pathlib.Path) -> None:
    result = subprocess.run(
        ['docker', 'compose', '-f', str(base), '-f', str(overlay), 'config', '--format', 'json'],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise ValueError('Compose render failed; inspect it locally without printing protected environment values')
    rendered = json.loads(result.stdout)
    services = rendered['services']
    api = services['api']
    worker = services['cloudcom-exchange-worker']
    image = worker.get('image', '')
    if not re.fullmatch(r'cloudcom-candidate/exchange-worker@sha256:[0-9a-f]{64}', image):
        raise ValueError('Worker image must be an immutable CloudCom candidate digest')
    if api['environment'].get('CLOUDCOM_EXCHANGE_DESCRIPTOR_FILE') != DESCRIPTOR or api['environment'].get('CLOUDCOM_EXCHANGE_SOCKET_PATH') != SOCKET:
        raise ValueError('API Exchange paths do not match the worker image')
    expected_private_source = os.environ.get('CLOUDCOM_EXCHANGE_PRIVATE_DIR')
    if not expected_private_source or not pathlib.PurePosixPath(expected_private_source).is_absolute():
        raise ValueError('Private host directory must be absolute')

    def mount(service: dict, target: str) -> dict:
        matches = [entry for entry in service.get('volumes', []) if entry.get('target') == target]
        if len(matches) != 1:
            raise ValueError(f'{target} must have one mount')
        return matches[0]

    for service in (api, worker):
        private = mount(service, PRIVATE_TARGET)
        if private.get('type') != 'bind' or private.get('source') != expected_private_source or private.get('read_only') is True:
            raise ValueError('Private socket/descriptor mount must be a shared writable bind')
    for service in (api, worker):
        cert = mount(service, CERT_TARGET)
        if cert.get('type') != 'bind' or cert.get('source') != '/opt/cloudcom/deployment/microsoft-admin' or cert.get('read_only') is not True:
            raise ValueError('Certificate bind must stay at its original read-only path')
    if worker.get('user') != '1001:1001' or worker.get('read_only') is not True or worker.get('ports') or worker.get('labels'):
        raise ValueError('Worker identity, root filesystem, or exposure differs from contract')
    if 'ALL' not in worker.get('cap_drop', []) or 'no-new-privileges:true' not in worker.get('security_opt', []):
        raise ValueError('Worker container hardening is incomplete')
    if 'breeze' not in worker.get('networks', {}):
        raise ValueError('Worker must use the existing private application network')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: verify-compose-candidate.py BASE_COMPOSE OVERLAY')
    try:
        verify(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
    except (ValueError, KeyError, TypeError) as error:
        raise SystemExit(f'Exchange Compose candidate rejected: {error}')
    print('Exchange Compose candidate contract passed (no configuration values printed).')
