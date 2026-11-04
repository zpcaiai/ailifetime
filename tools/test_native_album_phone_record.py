import copy
import importlib.util
import json
from pathlib import Path
import secrets
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('phone_record', Path(__file__).with_name('native-album-phone-record.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RecordIntegrity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='album-record-test-')
        self.root = Path(self.temp.name)
        # Serialization input only, not a real phone or model acceptance claim.
        cases = {key: {'label': key, 'status': 'PASS_USER_REPORTED', 'actual_photos_delta': delta,
                      'ui_progress': '21/21' if delta == 21 else None, 'distinct_within_batch': delta == 21,
                      'operator_report': 'Synthetic record input for serializer tests',
                      'execution_time': 'UNKNOWN', 'agent_direct_device_observation': False}
                 for key, delta in zip(module.CASES, [1, 21, 0, 0, 21])}
        self.record = {'schemaVersion': 'ltm.album-main-device-report.v1', 'source_main': 'a' * 40,
                       'preview_version': 'v10', 'native_result': 'PASS_USER_REPORTED', 'cases': cases,
                       'device': {'different_from_previous_phone': True, 'model': 'UNKNOWN', 'os_version': 'UNKNOWN', 'wechat_version': 'UNKNOWN'},
                       'qr_sha256': 'b' * 64, 'recorded_at': '2026-11-04T01:00:00Z', 'pinned_evidence': {},
                       'operator_statement_verbatim': 'Synthetic serializer input, no physical device acceptance',
                       'paid_model_calls_for_this_regression': 0, 'prepared_test_window': 5,
                       'prepared_window_expires_at': '2026-11-04T02:00:00Z',
                       'operator_explicit_credential_window_confirmation': 'NOT_REPORTED'}
        self.source = self.root / 'source.json'

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        self.source.write_text(json.dumps(self.record))

    def test_export_readback_and_immutable_revisions(self):
        self.save()
        first = self.root / 'r1'
        self.assertEqual(module.export_record(self.source, first)['phone_result'], 'PASS_USER_REPORTED')
        before = (first / 'record.json').read_bytes()
        with self.assertRaises(FileExistsError):
            module.export_record(self.source, first)
        self.record['record_revision'] = 2
        self.record['device'].update({'os_name': 'Xiaomi HyperOS', 'os_version': '3.0.308', 'wechat_version': '8.0.80'})
        self.save()
        second = self.root / 'r2'
        module.export_record(self.source, second)
        self.assertEqual((first / 'record.json').read_bytes(), before)
        self.assertEqual(json.loads((second / 'record.json').read_text())['device']['model'], 'UNKNOWN')
        self.assertEqual(module.verify_record(second)['revision'], 2)

    def test_incomplete_observations_and_private_token_fail_before_write(self):
        good = copy.deepcopy(self.record)
        del self.record['cases']['denied_batch']
        self.save()
        output = self.root / 'incomplete'
        with self.assertRaisesRegex(ValueError, 'ALL_FIVE'):
            module.export_record(self.source, output)
        self.assertFalse(output.exists())
        self.record = good
        token = secrets.token_hex(32)
        identity = self.root / 'private.json'
        with identity.open('x') as stream:
            stream.write(json.dumps({'accessToken': token}))
        identity.chmod(0o600)
        self.record['operator_statement_verbatim'] = token
        self.save()
        with self.assertRaisesRegex(ValueError, 'PRIVATE_TOKEN_IN_RECORD'):
            module.export_record(self.source, output, [identity])
        self.assertFalse(output.exists())

    def test_manifest_tampering_and_path_traversal_are_rejected(self):
        self.save()
        output = self.root / 'record'
        module.export_record(self.source, output)
        with (output / 'record.json').open('a') as stream:
            stream.write(' ')
        with self.assertRaisesRegex(ValueError, 'RECORD_DIGEST_MISMATCH'):
            module.verify_record(output)
        (output / 'SHA256SUMS').write_text('a  ../../private.json\nb  report.md\n')
        with self.assertRaisesRegex(ValueError, 'MANIFEST_PATH_INVALID'):
            module.verify_record(output)

    def test_boolean_count_and_manifest_symlink_do_not_pass(self):
        self.record['cases']['single']['actual_photos_delta'] = True
        self.save()
        output = self.root / 'record'
        with self.assertRaisesRegex(ValueError, 'INTEGER_OBSERVATION_COUNTS_REQUIRED'):
            module.export_record(self.source, output)
        self.assertFalse(output.exists())
        self.record['cases']['single']['actual_photos_delta'] = 1
        self.save()
        module.export_record(self.source, output)
        original = output / 'SHA256SUMS'
        elsewhere = self.root / 'manifest'
        original.rename(elsewhere)
        original.symlink_to(elsewhere)
        with self.assertRaisesRegex(ValueError, 'REGULAR_MANIFEST_REQUIRED'):
            module.verify_record(output)


if __name__ == '__main__':
    unittest.main()
