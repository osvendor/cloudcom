"""Focused unit tests for the local Exchange broker. Run with python3 -m unittest."""
import importlib.util, json, pathlib, struct, threading, time, unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('exchange_worker', pathlib.Path(__file__).with_name('exchange-worker.py'))
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)

REQUEST = {
    'requestId': '11111111-1111-4111-8111-111111111111', 'organizationId': '22222222-2222-4222-8222-222222222222',
    'tenantId': '33333333-3333-4333-8333-333333333333', 'clientId': '44444444-4444-4444-8444-444444444444',
    'credentialVersion': 'cert-1', 'connectionGeneration': 1, 'operation': 'mailbox.inventory', 'parameters': {'pageSize': 10},
}
DESCRIPTOR = {'enabled': True, 'organizationId': REQUEST['organizationId'], 'tenantId': REQUEST['tenantId'],
              'clientId': REQUEST['clientId'], 'credentialVersion': 'cert-1', 'exchangeOrganization': 'example.onmicrosoft.com',
              'connectionGeneration': 1, 'certificatePath': '/private/cert.pem', 'privateKeyPath': '/private/key.pem'}

class FakeConnection:
    def __init__(self, uid): self.uid = uid
    def getsockopt(self, *_args): return struct.pack('3i', 99, self.uid, 99)
class FakeProcess:
    def __init__(self, line):
        self.stdin = self; self.stdout = self; self.line = line; self.killed = False
    def write(self, _value): pass
    def flush(self): pass
    def fileno(self): return 0
    def poll(self): return None
    def kill(self): self.killed = True
    def wait(self, timeout=None): pass

class ExchangeBrokerTests(unittest.TestCase):
    def test_peer_identity_requires_api_uid(self):
        self.assertTrue(worker.peer_allowed(FakeConnection(123), 123))
        self.assertFalse(worker.peer_allowed(FakeConnection(124), 123))
    def test_malformed_or_injected_request_is_rejected_before_process_start(self):
        broker = worker.Broker('/unused', '/unused.ps1')
        with patch.object(worker, 'read_config', return_value={REQUEST['tenantId']: DESCRIPTOR}), patch.object(worker, 'PersistentPowerShell') as process:
            response = broker.execute({**REQUEST, 'command': 'Get-Mailbox'})
        self.assertEqual(response['code'], 'invalid_request'); process.assert_not_called()
    def test_foreign_organization_is_rejected_without_provider_detail(self):
        broker = worker.Broker('/unused', '/unused.ps1')
        with patch.object(worker, 'read_config', return_value={REQUEST['tenantId']: DESCRIPTOR}), patch.object(worker, 'PersistentPowerShell') as process:
            response = broker.execute({**REQUEST, 'organizationId': '55555555-5555-4555-8555-555555555555'})
        self.assertEqual(response['code'], 'connection_mismatch'); self.assertNotIn('private', json.dumps(response)); process.assert_not_called()
    def test_stale_generation_and_booleans_are_rejected_before_process_start(self):
        broker = worker.Broker('/unused', '/unused.ps1')
        with patch.object(worker, 'read_config', return_value={REQUEST['tenantId']: DESCRIPTOR}), patch.object(worker, 'PersistentPowerShell') as process:
            stale = broker.execute({**REQUEST, 'connectionGeneration': 2})
            boolean = broker.execute({**REQUEST, 'parameters': {'pageSize': True}})
        self.assertEqual(stale['code'], 'connection_mismatch'); self.assertEqual(boolean['code'], 'invalid_request'); process.assert_not_called()
    def test_unknown_worker_failure_is_redacted(self):
        response = worker.fail(REQUEST['requestId'], 'certificate at /private/key.pem failed')
        self.assertEqual(response, {'requestId': REQUEST['requestId'], 'ok': False, 'code': 'provider_unreachable'})
        self.assertNotIn('key.pem', json.dumps(response))
    def test_timeout_kills_powershell_and_returns_safe_failure(self):
        process = FakeProcess('')
        with patch.object(worker.subprocess, 'Popen', return_value=process), patch.object(worker.select, 'select', return_value=([], [], [])):
            result = worker.PersistentPowerShell(REQUEST, DESCRIPTOR, '/unused.ps1').run(REQUEST)
        self.assertEqual(result['code'], 'provider_unreachable'); self.assertTrue(process.killed)
    def test_forwarding_write_requires_fixed_fields_and_timeout_is_uncertain(self):
        mailbox_id = '55555555-5555-4555-8555-555555555555'
        forward = {**REQUEST, 'operation': 'mailbox.forwarding.set', 'parameters': {
            'mailboxId': mailbox_id, 'smtpAddress': 'next@example.com', 'keepCopy': True}}
        broker = worker.Broker('/unused', '/unused.ps1')
        with patch.object(worker, 'read_config', return_value={REQUEST['tenantId']: DESCRIPTOR}), patch.object(worker, 'PersistentPowerShell') as process:
            invalid = broker.execute({**forward, 'parameters': {**forward['parameters'], 'command': 'Remove-Mailbox'}})
        self.assertEqual(invalid['code'], 'invalid_request'); process.assert_not_called()
        process = FakeProcess('')
        with patch.object(worker.subprocess, 'Popen', return_value=process), patch.object(worker.select, 'select', return_value=([], [], [])):
            result = worker.PersistentPowerShell(forward, DESCRIPTOR, '/unused.ps1').run(forward)
        self.assertEqual(result['code'], 'unknown_write_outcome'); self.assertTrue(process.killed)
    def test_auto_reply_schedule_and_body_are_bounded_before_provider(self):
        reply = {**REQUEST, 'operation': 'mailbox.autoreply.set', 'parameters': {
            'mailboxId': '55555555-5555-4555-8555-555555555555', 'state': 'Scheduled',
            'message': 'Away', 'start': '2026-09-25T00:00:00Z', 'end': '2026-09-24T00:00:00Z'}}
        broker = worker.Broker('/unused', '/unused.ps1')
        with patch.object(worker, 'read_config', return_value={REQUEST['tenantId']: DESCRIPTOR}), patch.object(worker, 'PersistentPowerShell') as process:
            invalid = broker.execute(reply)
            too_large = broker.execute({**reply, 'parameters': {**reply['parameters'], 'message': 'x' * 8193}})
        self.assertEqual(invalid['code'], 'invalid_request'); self.assertEqual(too_large['code'], 'invalid_request'); process.assert_not_called()
    def test_address_write_rejects_injected_parameters_and_lost_alias_result_is_uncertain(self):
        address = {**REQUEST, 'operation': 'mailbox.alias.add', 'parameters': {
            'mailboxId': '55555555-5555-4555-8555-555555555555', 'address': 'alias@example.com'}}
        broker = worker.Broker('/unused', '/unused.ps1')
        with patch.object(worker, 'read_config', return_value={REQUEST['tenantId']: DESCRIPTOR}), patch.object(worker, 'PersistentPowerShell') as process:
            invalid = broker.execute({**address, 'parameters': {**address['parameters'], 'command': 'Remove-Mailbox'}})
        self.assertEqual(invalid['code'], 'invalid_request'); process.assert_not_called()
        process = FakeProcess('')
        with patch.object(worker.subprocess, 'Popen', return_value=process), patch.object(worker.select, 'select', return_value=([], [], [])):
            result = worker.PersistentPowerShell(address, DESCRIPTOR, '/unused.ps1').run(address)
        self.assertEqual(result['code'], 'unknown_write_outcome'); self.assertTrue(process.killed)
    def test_delegation_requires_two_different_mailbox_ids_and_one_right(self):
        delegated = {**REQUEST, 'operation': 'mailbox.delegation.set', 'parameters': {
            'mailboxId': '55555555-5555-4555-8555-555555555555', 'delegateId': '66666666-6666-4666-8666-666666666666',
            'right': 'SendAs', 'enabled': True}}
        broker = worker.Broker('/unused', '/unused.ps1')
        with patch.object(worker, 'read_config', return_value={REQUEST['tenantId']: DESCRIPTOR}), patch.object(worker, 'PersistentPowerShell') as process:
            self_delegate = broker.execute({**delegated, 'parameters': {**delegated['parameters'], 'delegateId': delegated['parameters']['mailboxId']}})
            injected = broker.execute({**delegated, 'parameters': {**delegated['parameters'], 'command': 'Remove-Mailbox'}})
        self.assertEqual(self_delegate['code'], 'invalid_request'); self.assertEqual(injected['code'], 'invalid_request'); process.assert_not_called()
    def test_mailbox_response_cannot_exceed_contract_bound(self):
        oversized = {'requestId': REQUEST['requestId'], 'ok': True, 'data': {'records': [{}] * 201, 'partial': True, 'collectedAt': '2026-09-22T00:00:00Z'}}
        process = FakeProcess(json.dumps(oversized).encode('utf-8') + b'\n')
        with patch.object(worker.subprocess, 'Popen', return_value=process), patch.object(worker.select, 'select', return_value=([0], [], [])), patch.object(worker.os, 'read', return_value=process.line):
            result = worker.PersistentPowerShell(REQUEST, DESCRIPTOR, '/unused.ps1').run(REQUEST)
        self.assertEqual(result['code'], 'response_too_large')
    def test_sequential_requests_keep_a_buffered_second_response(self):
        first = {'requestId': REQUEST['requestId'], 'ok': True, 'data': {'records': [], 'partial': True, 'collectedAt': '2026-09-22T00:00:00Z'}}
        second_request = {**REQUEST, 'requestId': '55555555-5555-4555-8555-555555555555'}
        second = {'requestId': second_request['requestId'], 'ok': True, 'data': {'records': [], 'partial': True, 'collectedAt': '2026-09-22T00:00:00Z'}}
        process = FakeProcess(b'')
        combined = (json.dumps(first) + '\n' + json.dumps(second) + '\n').encode('utf-8')
        with patch.object(worker.subprocess, 'Popen', return_value=process), patch.object(worker.select, 'select', return_value=([0], [], [])), patch.object(worker.os, 'read', return_value=combined):
            persistent = worker.PersistentPowerShell(REQUEST, DESCRIPTOR, '/unused.ps1')
            self.assertTrue(persistent.run(REQUEST)['ok'])
            self.assertTrue(persistent.run(second_request)['ok'])
    def test_descriptor_rotation_waits_for_the_in_flight_worker(self):
        entered, release, second_done = threading.Event(), threading.Event(), threading.Event()
        active = {REQUEST['tenantId']: DESCRIPTOR}
        class BlockingWorker:
            def __init__(self, _request, descriptor, _script):
                self.descriptor = descriptor; self.lock = threading.RLock(); self.process = FakeProcess(b''); self.closed = False
            def close(self): self.closed = True
            def run(self, raw):
                entered.set(); release.wait(2)
                return {'requestId': raw['requestId'], 'ok': True, 'data': {'records': [], 'partial': True, 'collectedAt': '2026-09-22T00:00:00Z'}}
        broker = worker.Broker('/unused', '/unused.ps1')
        rotated = {**DESCRIPTOR, 'connectionGeneration': 2}
        second_request = {**REQUEST, 'requestId': '55555555-5555-4555-8555-555555555555', 'connectionGeneration': 2}
        with patch.object(worker, 'read_config', side_effect=lambda _path: active), patch.object(worker, 'PersistentPowerShell', BlockingWorker):
            first = threading.Thread(target=lambda: broker.execute(REQUEST)); first.start(); self.assertTrue(entered.wait(1))
            active[REQUEST['tenantId']] = rotated
            second = threading.Thread(target=lambda: (broker.execute(second_request), second_done.set())); second.start()
            time.sleep(0.05); self.assertFalse(second_done.is_set())
            release.set(); first.join(1); second.join(1)
        self.assertTrue(second_done.is_set())
    def test_trace_rejects_out_of_window_or_injected_continuation_before_powershell(self):
        now = worker.datetime.datetime.now(worker.datetime.timezone.utc)
        start = (now - worker.datetime.timedelta(days=2)).isoformat()
        end = (now - worker.datetime.timedelta(days=1)).isoformat()
        params = {'start': start, 'end': end, 'sender': None, 'recipient': None, 'status': None, 'cursor': None}
        search = {**REQUEST, 'operation': 'trace.search', 'parameters': params}
        broker = worker.Broker('/unused', '/unused.ps1')
        with patch.object(worker, 'read_config', return_value={REQUEST['tenantId']: DESCRIPTOR}), patch.object(worker, 'PersistentPowerShell') as process:
            self.assertEqual(broker.execute({**search, 'parameters': {**params, 'end': (now + worker.datetime.timedelta(days=11)).isoformat()}})['code'], 'invalid_request')
            self.assertEqual(broker.execute({**search, 'parameters': {**params, 'cursor': {'received': end, 'recipient': 'ok@example.com', 'command': 'Remove-Mailbox'}}})['code'], 'invalid_request')
            self.assertEqual(broker.execute({**search, 'parameters': {**params, 'status': 'NotAStatus'}})['code'], 'invalid_request')
            process.assert_not_called()
    def test_trace_response_requires_matching_page_cursor_and_bounded_rows(self):
        row = {'messageTraceId': '55555555-5555-4555-8555-555555555555', 'received': '2026-09-22T12:00:00Z',
               'sender': 'sender@example.com', 'recipient': 'recipient@example.com', 'subject': 'Test', 'status': 'Delivered'}
        result = {'requestId': REQUEST['requestId'], 'ok': True, 'data': {'rows': [row], 'next': {'received': row['received'], 'recipient': 'other@example.com'},
                  'partial': True, 'checkedAt': '2026-09-22T12:01:00Z'}}
        self.assertEqual(worker.valid_success_response(result, REQUEST['requestId'], 'trace.search'), 'provider_unreachable')
        result['data']['next']['recipient'] = row['recipient']
        self.assertIsNone(worker.valid_success_response(result, REQUEST['requestId'], 'trace.search'))
        result['data']['rows'] *= 1001
        self.assertEqual(worker.valid_success_response(result, REQUEST['requestId'], 'trace.search'), 'response_too_large')

if __name__ == '__main__': unittest.main()
