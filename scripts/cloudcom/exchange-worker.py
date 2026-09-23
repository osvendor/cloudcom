#!/usr/bin/env python3
"""Private, bounded Unix-socket broker for the CloudCom Exchange PowerShell worker.

Deployment owns the socket path, permitted API uid, config file and certificate mounts. This
process deliberately never listens on TCP and never accepts PowerShell, certificate paths, or
tenant configuration from a client. It is a service-side companion, not an API endpoint.
"""
import argparse, datetime, json, os, select, socket, socketserver, stat, struct, subprocess, threading, time, uuid
from pathlib import Path
try: import pwd
except ModuleNotFoundError: pwd = None

MAX_REQUEST = 64 * 1024
MAX_RESPONSE = 1024 * 1024
MAX_PAGE_SIZE = 200
COMMAND_TIMEOUT_SECONDS = 45
ALLOWED_OPERATIONS = frozenset(('mailbox.inventory', 'mailbox.forwarding.get', 'mailbox.forwarding.set',
    'mailbox.autoreply.get', 'mailbox.autoreply.set', 'mailbox.addresses.get', 'mailbox.primary.set',
    'mailbox.alias.add', 'mailbox.alias.remove', 'mailbox.delegation.get', 'mailbox.delegation.set'))
def is_write(operation): return operation.endswith(('.set', '.add', '.remove'))
SAFE_FAILURES = frozenset(('access_denied', 'connection_mismatch', 'credential_unavailable', 'invalid_request',
                            'provider_access_denied', 'provider_rejected', 'provider_unreachable', 'response_too_large', 'worker_busy', 'unknown_write_outcome'))
PEERCRED = getattr(socket, 'SO_PEERCRED', 17) # Linux value; main rejects non-Linux runtimes.

def fail(request_id, code): return {'requestId': request_id, 'ok': False, 'code': code if code in SAFE_FAILURES else 'provider_unreachable'}
def normalized_uuid(value): return str(uuid.UUID(str(value))).lower()
def peer_allowed(connection, allowed_uid):
    _pid, uid, _gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, PEERCRED, 12))
    return uid == allowed_uid
def secure_file(path, private=False):
    entry = Path(path).lstat()
    mode = stat.S_IMODE(entry.st_mode)
    if not Path(path).is_absolute() or not stat.S_ISREG(entry.st_mode) or mode & 0o007 or mode & 0o020 or (private and mode & 0o004):
        raise ValueError('unsafe file permissions')
def valid_success_response(result, request_id, operation):
    if not isinstance(result, dict) or result.get('requestId') != request_id or result.get('ok') is not True: return 'provider_unreachable'
    data = result.get('data')
    if operation == 'mailbox.inventory':
        if not isinstance(data, dict) or set(data) != {'records', 'partial', 'collectedAt'} or not isinstance(data['records'], list) or not isinstance(data['partial'], bool) or not isinstance(data['collectedAt'], str): return 'provider_unreachable'
        if len(data['records']) > MAX_PAGE_SIZE: return 'response_too_large'
    elif operation.startswith('mailbox.forwarding.'):
        expected = {'mailboxId', 'smtpAddress', 'keepCopy', 'internalRecipient'}
        if operation == 'mailbox.forwarding.set': expected.update(('accepted', 'verified'))
        if not isinstance(data, dict) or set(data) != expected: return 'provider_unreachable'
        try: normalized_uuid(data['mailboxId'])
        except Exception: return 'provider_unreachable'
        if data['smtpAddress'] is not None and (not isinstance(data['smtpAddress'], str) or len(data['smtpAddress']) > 320): return 'provider_unreachable'
        if data['internalRecipient'] is not None and (not isinstance(data['internalRecipient'], str) or len(data['internalRecipient']) > 320): return 'provider_unreachable'
        if type(data['keepCopy']) is not bool: return 'provider_unreachable'
        if operation == 'mailbox.forwarding.set' and (data['accepted'] is not True or type(data['verified']) is not bool): return 'provider_unreachable'
    elif operation.startswith('mailbox.autoreply.'):
        expected = {'mailboxId', 'state', 'internalMessage', 'externalMessage', 'externalAudience', 'start', 'end'}
        if operation == 'mailbox.autoreply.set': expected.update(('accepted', 'verified'))
        if not isinstance(data, dict) or set(data) != expected: return 'provider_unreachable'
        try: normalized_uuid(data['mailboxId'])
        except Exception: return 'provider_unreachable'
        if data['state'] not in ('Disabled', 'Enabled', 'Scheduled') or data['externalAudience'] not in ('None', 'Known', 'All'): return 'provider_unreachable'
        if not all(isinstance(data[key], str) and len(data[key]) <= 16384 for key in ('internalMessage', 'externalMessage')): return 'provider_unreachable'
        if not all(data[key] is None or isinstance(data[key], str) and len(data[key]) <= 64 for key in ('start', 'end')): return 'provider_unreachable'
        if operation == 'mailbox.autoreply.set' and (data['accepted'] is not True or type(data['verified']) is not bool): return 'provider_unreachable'
    elif operation.startswith('mailbox.delegation.'):
        expected = {'mailboxId', 'delegateId', 'delegateAddress', 'fullAccess', 'sendAs', 'sendOnBehalf'}
        if is_write(operation): expected.update(('accepted', 'verified'))
        if not isinstance(data, dict) or set(data) != expected: return 'provider_unreachable'
        try: normalized_uuid(data['mailboxId']); normalized_uuid(data['delegateId'])
        except Exception: return 'provider_unreachable'
        if data['mailboxId'] == data['delegateId']: return 'provider_unreachable'
        if not isinstance(data['delegateAddress'], str) or len(data['delegateAddress']) > 320 or '@' not in data['delegateAddress']: return 'provider_unreachable'
        if any(type(data[key]) is not bool for key in ('fullAccess', 'sendAs', 'sendOnBehalf')): return 'provider_unreachable'
        if is_write(operation) and (data['accepted'] is not True or type(data['verified']) is not bool): return 'provider_unreachable'
    else:
        expected = {'mailboxId', 'primarySmtpAddress', 'aliases', 'policyEnabled'}
        if is_write(operation): expected.update(('accepted', 'verified'))
        if not isinstance(data, dict) or set(data) != expected: return 'provider_unreachable'
        try: normalized_uuid(data['mailboxId'])
        except Exception: return 'provider_unreachable'
        if not isinstance(data['primarySmtpAddress'], str) or len(data['primarySmtpAddress']) > 320 or '@' not in data['primarySmtpAddress']: return 'provider_unreachable'
        if not isinstance(data['aliases'], list) or len(data['aliases']) > 500 or any(not isinstance(a, str) or len(a) > 320 or '@' not in a for a in data['aliases']): return 'provider_unreachable'
        if type(data['policyEnabled']) is not bool: return 'provider_unreachable'
        if is_write(operation) and (data['accepted'] is not True or type(data['verified']) is not bool): return 'provider_unreachable'
    return None
def read_config(path):
    secure_file(path)
    parsed = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(parsed, dict) or not isinstance(parsed.get('tenants'), dict): raise ValueError('invalid configuration')
    for descriptor in parsed['tenants'].values():
        if not isinstance(descriptor, dict): raise ValueError('invalid configuration')
        for key in ('certificatePath', 'privateKeyPath'):
            if key in descriptor: secure_file(descriptor[key], private=(key == 'privateKeyPath'))
    return parsed['tenants']

def validate_request(value, tenants):
    if not isinstance(value, dict) or set(value) != {'requestId','organizationId','tenantId','clientId','credentialVersion','connectionGeneration','operation','parameters'}: raise ValueError()
    request_id = normalized_uuid(value['requestId']); tenant_id = normalized_uuid(value['tenantId'])
    org_id, client_id = normalized_uuid(value['organizationId']), normalized_uuid(value['clientId'])
    version, generation, params = value['credentialVersion'], value['connectionGeneration'], value['parameters']
    operation = value['operation']
    if operation not in ALLOWED_OPERATIONS or not isinstance(version, str) or not version or len(version) > 128 or type(generation) is not int or generation < 1: raise ValueError()
    if not isinstance(params, dict): raise ValueError()
    if operation == 'mailbox.inventory':
        if set(params) != {'pageSize'} or type(params['pageSize']) is not int or not 1 <= params['pageSize'] <= MAX_PAGE_SIZE: raise ValueError()
    elif operation.startswith('mailbox.forwarding.'):
        if set(params) != ({'mailboxId'} if operation == 'mailbox.forwarding.get' else {'mailboxId', 'smtpAddress', 'keepCopy'}): raise ValueError()
        normalized_uuid(params['mailboxId'])
        if operation == 'mailbox.forwarding.set':
            address = params['smtpAddress']
            if address is not None and (not isinstance(address, str) or len(address) > 320 or '@' not in address or any(c.isspace() for c in address)): raise ValueError()
            if type(params['keepCopy']) is not bool: raise ValueError()
    elif operation.startswith('mailbox.autoreply.'):
        if set(params) != ({'mailboxId'} if operation == 'mailbox.autoreply.get' else {'mailboxId', 'state', 'message', 'start', 'end'}): raise ValueError()
        normalized_uuid(params['mailboxId'])
        if operation == 'mailbox.autoreply.set':
            if params['state'] not in ('Disabled', 'Enabled', 'Scheduled') or not isinstance(params['message'], str) or len(params['message']) > 8192: raise ValueError()
            if params['state'] == 'Scheduled':
                try:
                    start = datetime.datetime.fromisoformat(params['start'].replace('Z', '+00:00'))
                    end = datetime.datetime.fromisoformat(params['end'].replace('Z', '+00:00'))
                    if start.tzinfo is None or end.tzinfo is None or end <= start: raise ValueError()
                except (AttributeError, TypeError, ValueError): raise ValueError()
            elif params['start'] is not None or params['end'] is not None: raise ValueError()
    elif operation.startswith('mailbox.delegation.'):
        if set(params) != ({'mailboxId', 'delegateId'} if operation == 'mailbox.delegation.get' else {'mailboxId', 'delegateId', 'right', 'enabled'}): raise ValueError()
        mailbox_id, delegate_id = normalized_uuid(params['mailboxId']), normalized_uuid(params['delegateId'])
        if mailbox_id == delegate_id: raise ValueError()
        if operation == 'mailbox.delegation.set' and (params['right'] not in ('FullAccess', 'SendAs', 'SendOnBehalf') or type(params['enabled']) is not bool): raise ValueError()
    else:
        if set(params) != ({'mailboxId'} if operation == 'mailbox.addresses.get' else {'mailboxId', 'address'}): raise ValueError()
        normalized_uuid(params['mailboxId'])
        if operation != 'mailbox.addresses.get':
            address = params['address']
            if not isinstance(address, str) or not 3 <= len(address) <= 320 or '@' not in address or any(c.isspace() for c in address): raise ValueError()
    descriptor = tenants.get(tenant_id)
    if not isinstance(descriptor, dict) or descriptor.get('enabled') is not True: return request_id, None
    # All values below are compared to host-only configuration. A browser cannot substitute them.
    if descriptor.get('organizationId') != org_id or descriptor.get('tenantId', tenant_id) != tenant_id or descriptor.get('clientId') != client_id or descriptor.get('credentialVersion') != version or descriptor.get('connectionGeneration') != generation: return request_id, None
    for key in ('exchangeOrganization', 'certificatePath', 'privateKeyPath'):
        if not isinstance(descriptor.get(key), str) or not descriptor[key]: return request_id, None
    return request_id, descriptor

class PersistentPowerShell:
    def __init__(self, request, descriptor, script):
        self.tenant_id = request['tenantId']; self.descriptor = descriptor; self.used = time.monotonic(); self.lock = threading.RLock()
        env = {**os.environ, 'CLOUDCOM_EXCHANGE_CONFIG': json.dumps(descriptor, separators=(',', ':'))}
        self.buffer = b''
        self.process = subprocess.Popen(['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, env=env)
    def close(self):
        if self.process.poll() is None: self.process.kill()
        try: self.process.wait(timeout=3)
        except subprocess.TimeoutExpired: pass
    def run(self, request):
        if request['tenantId'] != self.tenant_id: return fail(request['requestId'], 'connection_mismatch')
        with self.lock:
            try:
                self.process.stdin.write((json.dumps(request, separators=(',', ':')) + '\n').encode('utf-8')); self.process.stdin.flush()
                deadline = time.monotonic() + COMMAND_TIMEOUT_SECONDS
                while b'\n' not in self.buffer:
                    remaining = deadline - time.monotonic()
                    ready, _, _ = select.select([self.process.stdout.fileno()], [], [], max(remaining, 0))
                    if not ready: self.close(); return fail(request['requestId'], 'unknown_write_outcome' if is_write(request['operation']) else 'provider_unreachable')
                    chunk = os.read(self.process.stdout.fileno(), min(8192, MAX_RESPONSE + 1 - len(self.buffer)))
                    if not chunk: self.close(); return fail(request['requestId'], 'unknown_write_outcome' if is_write(request['operation']) else 'provider_unreachable')
                    self.buffer += chunk
                    if len(self.buffer) > MAX_RESPONSE: self.close(); return fail(request['requestId'], 'unknown_write_outcome' if is_write(request['operation']) else 'response_too_large')
                line, self.buffer = self.buffer.split(b'\n', 1)
                result = json.loads(line.decode('utf-8')); self.used = time.monotonic()
                if not isinstance(result, dict) or result.get('requestId') != request['requestId'] or result.get('ok') not in (True, False): return fail(request['requestId'], 'provider_unreachable')
                if result.get('ok') is False: return fail(request['requestId'], result.get('code'))
                invalid = valid_success_response(result, request['requestId'], request['operation'])
                if invalid: return fail(request['requestId'], 'unknown_write_outcome' if is_write(request['operation']) else invalid)
                return result
            except Exception:
                self.close(); return fail(request['requestId'], 'unknown_write_outcome' if is_write(request['operation']) else 'provider_unreachable')

class Broker:
    def __init__(self, config, script): self.config, self.script, self.pool, self.lock = config, script, {}, threading.Lock()
    def execute(self, raw):
        request_id = raw.get('requestId') if isinstance(raw, dict) else None
        try: tenants = read_config(self.config); request_id, descriptor = validate_request(raw, tenants)
        except Exception: return fail(request_id if isinstance(request_id, str) else '00000000-0000-4000-8000-000000000000', 'invalid_request')
        if descriptor is None: return fail(request_id, 'connection_mismatch')
        with self.lock:
            worker = self.pool.get(raw['tenantId'])
            if worker is None or worker.process.poll() is not None or worker.descriptor != descriptor or time.monotonic() - worker.used > 300:
                if worker:
                    # A replacement waits for an in-flight request. This stops a rotated
                    # descriptor from killing a read and returning a stale response.
                    with worker.lock: worker.close()
                worker = self.pool[raw['tenantId']] = PersistentPowerShell(raw, descriptor, self.script)
            # Take the per-worker lock before releasing the pool lock so a concurrent
            # descriptor rotation cannot close this process before run() starts.
            worker.lock.acquire()
        try: return worker.run(raw)
        finally: worker.lock.release()

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            if not peer_allowed(self.request, self.server.allowed_uid): return
            body = self.rfile.readline(MAX_REQUEST + 1)
            if not body or len(body) > MAX_REQUEST: result = fail('00000000-0000-4000-8000-000000000000', 'invalid_request')
            else: result = self.server.broker.execute(json.loads(body))
        except Exception: result = fail('00000000-0000-4000-8000-000000000000', 'invalid_request')
        self.wfile.write(json.dumps(result, separators=(',', ':')).encode('utf-8') + b'\n')
# The fallback only allows contract tests to import this Linux-only service on Windows.
UnixServerBase = getattr(socketserver, 'ThreadingUnixStreamServer', socketserver.TCPServer)
class Server(UnixServerBase): allow_reuse_address = True; daemon_threads = True

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--socket', required=True); parser.add_argument('--config', required=True); parser.add_argument('--script', required=True); parser.add_argument('--api-user', required=True)
    args = parser.parse_args(); socket_path = Path(args.socket)
    if pwd is None: raise RuntimeError('this worker requires Linux peer credentials')
    if socket_path.exists() and stat.S_ISSOCK(socket_path.stat().st_mode): socket_path.unlink()
    elif socket_path.exists(): raise RuntimeError('socket path is not a socket')
    socket_path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    broker = Broker(args.config, args.script)
    with Server(str(socket_path), Handler) as server:
        server.allowed_uid = pwd.getpwnam(args.api_user).pw_uid; server.broker = broker
        os.chmod(socket_path, 0o660); server.serve_forever()
if __name__ == '__main__': main()
