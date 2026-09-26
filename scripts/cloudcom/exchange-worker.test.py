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
    def test_group_external_write_rejects_injected_fields_and_wrong_readback(self):
        group_id = '55555555-5555-4555-8555-555555555555'
        request = {**REQUEST, 'operation': 'group.external.set', 'parameters': {'groupId': group_id, 'allowExternalSenders': True}}
        self.assertEqual(worker.validate_request(request, {REQUEST['tenantId']: DESCRIPTOR})[1], DESCRIPTOR)
        with self.assertRaises(ValueError):
            worker.validate_request({**request, 'parameters': {**request['parameters'], 'command': 'Set-UnifiedGroup'}},
                                    {REQUEST['tenantId']: DESCRIPTOR})
        data = {'groupId': group_id, 'allowExternalSenders': True, 'accepted': True, 'verified': True, 'changed': True}
        self.assertIsNone(worker.valid_success_response({'requestId': request['requestId'], 'ok': True, 'data': data},
                                                         request['requestId'], 'group.external.set'))
        self.assertEqual(worker.valid_success_response({'requestId': request['requestId'], 'ok': True,
                                                         'data': {**data, 'allowExternalSenders': 'true'}},
                                                        request['requestId'], 'group.external.set'), 'provider_unreachable')

    def test_group_settings_read_is_typed_and_rejects_injected_fields(self):
        group_id = '55555555-5555-4555-8555-555555555555'
        request = {**REQUEST, 'operation': 'group.settings.get', 'parameters': {'groupId': group_id}}
        self.assertEqual(worker.validate_request(request, {REQUEST['tenantId']: DESCRIPTOR})[1], DESCRIPTOR)
        with self.assertRaises(ValueError):
            worker.validate_request({**request, 'parameters': {'groupId': group_id, 'command': 'Remove-DistributionGroup'}},
                                    {REQUEST['tenantId']: DESCRIPTOR})
        data = {'groupId': group_id, 'kind': 'distribution', 'displayName': 'QA',
                'primarySmtpAddress': 'qa@example.com', 'requireSenderAuthenticationEnabled': True,
                'emailAddressPolicyEnabled': False, 'aliases': ['old@example.com']}
        self.assertIsNone(worker.valid_success_response({'requestId': request['requestId'], 'ok': True, 'data': data},
                                                         request['requestId'], 'group.settings.get'))
        self.assertEqual(worker.valid_success_response({'requestId': request['requestId'], 'ok': True,
                                                         'data': {**data, 'requireSenderAuthenticationEnabled': 'true'}},
                                                        request['requestId'], 'group.settings.get'), 'provider_unreachable')

    def test_distribution_name_write_is_exact_and_typed(self):
        group_id = '55555555-5555-4555-8555-555555555555'
        request = {**REQUEST, 'operation': 'distribution.name.set', 'parameters': {'groupId': group_id, 'displayName': 'QA Renamed'}}
        self.assertEqual(worker.validate_request(request, {REQUEST['tenantId']: DESCRIPTOR})[1], DESCRIPTOR)
        with self.assertRaises(ValueError):
            worker.validate_request({**request, 'parameters': {**request['parameters'], 'command': 'Remove-DistributionGroup'}},
                                    {REQUEST['tenantId']: DESCRIPTOR})
        data = {'groupId': group_id, 'displayName': 'QA Renamed', 'accepted': True, 'verified': True, 'changed': True}
        self.assertIsNone(worker.valid_success_response({'requestId': request['requestId'], 'ok': True, 'data': data},
                                                         request['requestId'], 'distribution.name.set'))
        self.assertEqual(worker.valid_success_response({'requestId': request['requestId'], 'ok': True,
                                                         'data': {**data, 'verified': 'true'}},
                                                        request['requestId'], 'distribution.name.set'), 'provider_unreachable')

    def test_group_primary_write_is_exact_and_typed(self):
        group_id = '55555555-5555-4555-8555-555555555555'
        request = {**REQUEST, 'operation': 'group.primary.set', 'parameters': {'groupId': group_id, 'address': 'new@example.com'}}
        self.assertEqual(worker.validate_request(request, {REQUEST['tenantId']: DESCRIPTOR})[1], DESCRIPTOR)
        with self.assertRaises(ValueError):
            worker.validate_request({**request, 'parameters': {**request['parameters'], 'command': 'Remove-DistributionGroup'}},
                                    {REQUEST['tenantId']: DESCRIPTOR})
        data = {'groupId': group_id, 'primarySmtpAddress': 'new@example.com', 'accepted': True, 'verified': True, 'changed': True}
        self.assertIsNone(worker.valid_success_response({'requestId': request['requestId'], 'ok': True, 'data': data},
                                                         request['requestId'], 'group.primary.set'))
        self.assertEqual(worker.valid_success_response({'requestId': request['requestId'], 'ok': True,
                                                         'data': {**data, 'verified': 'true'}},
                                                        request['requestId'], 'group.primary.set'), 'provider_unreachable')

    def test_distribution_members_read_is_bounded_and_typed(self):
        group_id = '55555555-5555-4555-8555-555555555555'
        request = {**REQUEST, 'operation': 'distribution.members.get', 'parameters': {'groupId': group_id}}
        self.assertEqual(worker.validate_request(request, {REQUEST['tenantId']: DESCRIPTOR})[1], DESCRIPTOR)
        with self.assertRaises(ValueError):
            worker.validate_request({**request, 'parameters': {'groupId': group_id, 'command': 'Remove-Mailbox'}},
                                    {REQUEST['tenantId']: DESCRIPTOR})
        data = {'groupId': group_id, 'members': [{'id': '66666666-6666-4666-8666-666666666666',
                 'displayName': 'QA', 'primarySmtpAddress': 'qa@example.com'}], 'complete': True}
        self.assertIsNone(worker.valid_success_response({'requestId': request['requestId'], 'ok': True, 'data': data},
                                                         request['requestId'], 'distribution.members.get'))
        self.assertEqual(worker.valid_success_response({'requestId': request['requestId'], 'ok': True,
                                                         'data': {**data, 'members': [{**data['members'][0], 'command': 'x'}]}},
                                                        request['requestId'], 'distribution.members.get'), 'provider_unreachable')

    def test_distribution_create_is_typed_and_lost_write_is_uncertain(self):
        request = {**REQUEST, 'operation': 'distribution.create', 'parameters': {
            'name': 'QA Distribution', 'primarySmtpAddress': 'qa@example.com'}}
        self.assertEqual(worker.validate_request(request, {REQUEST['tenantId']: DESCRIPTOR})[1], DESCRIPTOR)
        with self.assertRaises(ValueError):
            worker.validate_request({**request, 'parameters': {**request['parameters'], 'command': 'Remove-DistributionGroup'}},
                                    {REQUEST['tenantId']: DESCRIPTOR})
        data = {'accepted': True, 'verified': True, 'id': None, 'primarySmtpAddress': 'qa@example.com'}
        self.assertIsNone(worker.valid_success_response({'requestId': request['requestId'], 'ok': True, 'data': data},
                                                         request['requestId'], 'distribution.create'))
        self.assertEqual(worker.valid_success_response({'requestId': request['requestId'], 'ok': True,
                                                         'data': {**data, 'verified': 'true'}}, request['requestId'],
                                                        'distribution.create'), 'provider_unreachable')
        process = FakeProcess('')
        with patch.object(worker.subprocess, 'Popen', return_value=process), patch.object(worker.select, 'select', return_value=([], [], [])):
            result = worker.PersistentPowerShell(request, DESCRIPTOR, '/unused.ps1').run(request)
        self.assertEqual(result['code'], 'unknown_write_outcome')

    def test_shared_create_requires_fixed_fields_and_validated_readback(self):
        request = {**REQUEST, 'operation': 'shared.create', 'parameters': {
            'name': 'QA Shared', 'primarySmtpAddress': 'shared@example.com'}}
        self.assertEqual(worker.validate_request(request, {REQUEST['tenantId']: DESCRIPTOR})[1], DESCRIPTOR)
        with self.assertRaises(ValueError):
            worker.validate_request({**request, 'parameters': {**request['parameters'], 'command': 'Remove-Mailbox'}},
                                    {REQUEST['tenantId']: DESCRIPTOR})
        data = {'accepted': True, 'verified': True, 'id': '55555555-5555-4555-8555-555555555555',
                'primarySmtpAddress': 'shared@example.com'}
        self.assertIsNone(worker.valid_success_response({'requestId': request['requestId'], 'ok': True, 'data': data},
                                                         request['requestId'], 'shared.create'))
        self.assertEqual(worker.valid_success_response({'requestId': request['requestId'], 'ok': True,
                                                         'data': {**data, 'id': 'not-a-uuid'}}, request['requestId'],
                                                        'shared.create'), 'provider_unreachable')

    def test_distribution_membership_requires_exact_ids_and_typed_readback(self):
        group_id = '55555555-5555-4555-8555-555555555555'
        member_id = '66666666-6666-4666-8666-666666666666'
        request = {**REQUEST, 'operation': 'distribution.member.set', 'parameters': {
            'groupId': group_id, 'memberId': member_id, 'enabled': True}}
        self.assertEqual(worker.validate_request(request, {REQUEST['tenantId']: DESCRIPTOR})[1], DESCRIPTOR)
        with self.assertRaises(ValueError):
            worker.validate_request({**request, 'parameters': {**request['parameters'], 'command': 'Remove-Mailbox'}},
                                    {REQUEST['tenantId']: DESCRIPTOR})
        data = {**request['parameters'], 'accepted': True, 'verified': True, 'changed': True}
        self.assertIsNone(worker.valid_success_response({'requestId': request['requestId'], 'ok': True, 'data': data},
                                                         request['requestId'], 'distribution.member.set'))
        self.assertEqual(worker.valid_success_response({'requestId': request['requestId'], 'ok': True,
                                                         'data': {**data, 'enabled': 'true'}}, request['requestId'],
                                                        'distribution.member.set'), 'provider_unreachable')

    def test_single_mailbox_statistics_request_and_response_are_bounded(self):
        mailbox_id = '55555555-5555-4555-8555-555555555555'
        request = {**REQUEST, 'operation': 'mailbox.statistics.get', 'parameters': {'mailboxId': mailbox_id}}
        self.assertEqual(worker.validate_request(request, {REQUEST['tenantId']: DESCRIPTOR})[1], DESCRIPTOR)
        with self.assertRaises(ValueError):
            worker.validate_request({**request, 'parameters': {'mailboxId': mailbox_id, 'command': 'Remove-Mailbox'}}, {REQUEST['tenantId']: DESCRIPTOR})
        row = {'id': mailbox_id, 'primarySmtpAddress': 'shared@example.com', 'recipientType': 'SharedMailbox',
               'archiveEnabled': False, 'mailboxBytes': 123, 'archiveBytes': None,
               'collectedAt': '2026-09-25T00:00:00Z', 'statisticsUnavailable': False}
        response = {'requestId': request['requestId'], 'ok': True, 'data': row}
        self.assertIsNone(worker.valid_success_response(response, request['requestId'], 'mailbox.statistics.get'))
        self.assertEqual(worker.valid_success_response({**response, 'data': {**row, 'mailboxBytes': -1}}, request['requestId'], 'mailbox.statistics.get'), 'provider_unreachable')
    def test_preservation_preflight_cannot_claim_safe_license_removal_with_a_hold(self):
        mailbox_id = '55555555-5555-4555-8555-555555555555'
        request = {**REQUEST, 'operation': 'mailbox.preservation.get', 'parameters': {'mailboxId': mailbox_id}}
        self.assertEqual(worker.validate_request(request, {REQUEST['tenantId']: DESCRIPTOR})[1], DESCRIPTOR)
        with self.assertRaises(ValueError):
            worker.validate_request({**request, 'parameters': {'mailboxId': mailbox_id, 'command': 'Set-Mailbox'}},
                                    {REQUEST['tenantId']: DESCRIPTOR})
        state = {'mailboxId': mailbox_id, 'primarySmtpAddress': 'shared@example.com', 'recipientType': 'SharedMailbox',
                 'mailboxBytes': 123, 'archiveEnabled': False, 'directorySynced': False, 'litigationHoldEnabled': False,
                 'inPlaceHolds': [], 'licenseRemovalEligible': True, 'checkedAt': '2026-09-25T00:00:00Z'}
        response = {'requestId': request['requestId'], 'ok': True, 'data': state}
        self.assertIsNone(worker.valid_success_response(response, request['requestId'], 'mailbox.preservation.get'))
        self.assertEqual(worker.valid_success_response({**response, 'data': {**state, 'inPlaceHolds': ['hold-1']}},
                                                         request['requestId'], 'mailbox.preservation.get'), 'provider_unreachable')
        self.assertEqual(worker.valid_success_response({**response, 'data': {**state, 'directorySynced': True}},
                                                         request['requestId'], 'mailbox.preservation.get'), 'provider_unreachable')
    def test_shared_conversion_accepts_only_fixed_target_and_verified_readback(self):
        mailbox_id = '55555555-5555-4555-8555-555555555555'
        request = {**REQUEST, 'operation': 'mailbox.convert.shared', 'parameters': {'mailboxId': mailbox_id}}
        self.assertEqual(worker.validate_request(request, {REQUEST['tenantId']: DESCRIPTOR})[1], DESCRIPTOR)
        with self.assertRaises(ValueError):
            worker.validate_request({**request, 'parameters': {'mailboxId': mailbox_id, 'command': 'Remove-Mailbox'}},
                                    {REQUEST['tenantId']: DESCRIPTOR})
        state = {'mailboxId': mailbox_id, 'primarySmtpAddress': 'qa@example.test', 'recipientType': 'SharedMailbox',
                 'accepted': True, 'verified': True, 'changed': True}
        response = {'requestId': request['requestId'], 'ok': True, 'data': state}
        self.assertIsNone(worker.valid_success_response(response, request['requestId'], 'mailbox.convert.shared'))
        self.assertEqual(worker.valid_success_response({**response, 'data': {**state, 'recipientType': 'UserMailbox'}},
                                                        request['requestId'], 'mailbox.convert.shared'), 'provider_unreachable')
        self.assertEqual(worker.valid_success_response({**response, 'data': {**state, 'verified': False}},
                                                        request['requestId'], 'mailbox.convert.shared'), 'provider_unreachable')
        process = FakeProcess('')
        with patch.object(worker.subprocess, 'Popen', return_value=process), patch.object(worker.select, 'select', return_value=([], [], [])):
            result = worker.PersistentPowerShell(request, DESCRIPTOR, '/unused.ps1').run(request)
        self.assertEqual(result['code'], 'unknown_write_outcome'); self.assertTrue(process.killed)
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
    def test_delegation_inventory_accepts_only_a_mailbox_id(self):
        mailbox_id = '55555555-5555-4555-8555-555555555555'
        request = {**REQUEST, 'operation': 'mailbox.delegation.list', 'parameters': {'mailboxId': mailbox_id}}
        self.assertEqual(worker.validate_request(request, {REQUEST['tenantId']: DESCRIPTOR})[1], DESCRIPTOR)
        with self.assertRaises(ValueError):
            worker.validate_request({**request, 'parameters': {'mailboxId': mailbox_id, 'command': 'Remove-Mailbox'}},
                                    {REQUEST['tenantId']: DESCRIPTOR})
        data = {'mailboxId': mailbox_id, 'entries': [{'delegateAddress': 'qa@example.test',
                'fullAccess': True, 'sendAs': False, 'sendOnBehalf': False}], 'partial': False,
                'checkedAt': '2026-09-25T00:00:00Z'}
        result = {'requestId': REQUEST['requestId'], 'ok': True, 'data': data}
        self.assertIsNone(worker.valid_success_response(result, REQUEST['requestId'], 'mailbox.delegation.list'))
        self.assertEqual(worker.valid_success_response({**result, 'data': {**data, 'entries': [
            {**data['entries'][0], 'sendAs': 'true'}]}}, REQUEST['requestId'], 'mailbox.delegation.list'),
            'provider_unreachable')
    def test_mailbox_response_cannot_exceed_contract_bound(self):
        oversized = {'requestId': REQUEST['requestId'], 'ok': True, 'data': {'records': [{}] * 201, 'partial': True, 'collectedAt': '2026-09-22T00:00:00Z'}}
        process = FakeProcess(json.dumps(oversized).encode('utf-8') + b'\n')
        with patch.object(worker.subprocess, 'Popen', return_value=process), patch.object(worker.select, 'select', return_value=([0], [], [])), patch.object(worker.os, 'read', return_value=process.line):
            result = worker.PersistentPowerShell(REQUEST, DESCRIPTOR, '/unused.ps1').run(REQUEST)
        self.assertEqual(result['code'], 'response_too_large')
    def test_mailbox_continuation_is_bound_to_a_valid_snapshot_cursor(self):
        cursor = '55555555-5555-4555-8555-555555555555:200'
        continuation = {**REQUEST, 'parameters': {'pageSize': 200, 'cursor': cursor}}
        self.assertEqual(worker.validate_request(continuation, {REQUEST['tenantId']: DESCRIPTOR})[1], DESCRIPTOR)
        with self.assertRaises(ValueError):
            worker.validate_request({**continuation, 'parameters': {'pageSize': 200, 'cursor': 'bad:200'}}, {REQUEST['tenantId']: DESCRIPTOR})
        data = {'records': [{'id': 'x'}], 'partial': True, 'collectedAt': '2026-09-22T00:00:00Z', 'next': cursor}
        result = {'requestId': REQUEST['requestId'], 'ok': True, 'data': data}
        self.assertIsNone(worker.valid_success_response(result, REQUEST['requestId'], 'mailbox.inventory'))
        self.assertEqual(worker.valid_success_response({**result, 'data': {**data, 'partial': False}}, REQUEST['requestId'], 'mailbox.inventory'), 'provider_unreachable')
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
