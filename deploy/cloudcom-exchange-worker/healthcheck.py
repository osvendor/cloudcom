#!/usr/bin/env python3
"""Probe the private broker without a tenant request or PowerShell session."""
import json
import os
import socket
import stat
import sys

DESCRIPTOR = os.environ.get('CLOUDCOM_EXCHANGE_DESCRIPTOR_FILE', '/run/cloudcom-exchange-private/tenants.json')
SOCKET = os.environ.get('CLOUDCOM_EXCHANGE_SOCKET_PATH', '/run/cloudcom-exchange-private/exchange.sock')


def healthy():
    private_dir = os.lstat(os.path.dirname(DESCRIPTOR))
    endpoint = os.lstat(SOCKET)
    if not stat.S_ISDIR(private_dir.st_mode) or private_dir.st_uid != os.getuid() or stat.S_IMODE(private_dir.st_mode) != 0o700:
        return False
    # Before the first Connect transaction, no tenant descriptor exists yet.
    # Once present, it must retain the API's atomic 0600/UID 1001 contract.
    try:
        descriptor = os.lstat(DESCRIPTOR)
    except FileNotFoundError:
        descriptor = None
    if descriptor and (not stat.S_ISREG(descriptor.st_mode) or stat.S_IMODE(descriptor.st_mode) != 0o600 or descriptor.st_uid != os.getuid()):
        return False
    if not stat.S_ISSOCK(endpoint.st_mode) or endpoint.st_uid != os.getuid() or stat.S_IMODE(endpoint.st_mode) != 0o660:
        return False
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(1.0)
        client.connect(SOCKET)
        client.sendall(b'{}\n')
        response = b''
        while not response.endswith(b'\n') and len(response) < 1024:
            chunk = client.recv(1024 - len(response))
            if not chunk:
                return False
            response += chunk
    if not response.endswith(b'\n'):
        return False
    result = json.loads(response)
    return result.get('ok') is False and result.get('code') == 'invalid_request'


if __name__ == '__main__':
    try:
        sys.exit(0 if healthy() else 1)
    except (OSError, ValueError, json.JSONDecodeError):
        sys.exit(1)
