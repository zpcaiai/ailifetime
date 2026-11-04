import copy
import importlib.util
import json
from pathlib import Path
import secrets
import tempfile
import unittest


class SevenCaseArchive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('regression_record', Path(__file__).with_name('native-album-regression-record.py'))
        cls.tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.tool)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='album-seven-record-')
        self.root = Path(self.temp.name)
        # These are serialization inputs, not physical phone evidence.
        actual = {
            'single': {'page_result': '保存成功', 'album_delta': 1},
            'batch': {'progress': '21/21', 'album_delta': 21, 'batch_distinct': True},
            'denial': {'fresh_batch_page': True, 'permission_disabled': True, 'permission_message': True, 'settings_button': True, 'album_delta': 0},
            'restore_without_save': {'settings_opened_via_page': True, 'permission_restored': True, 'save_clicked': False, 'album_delta': 0},
            'manual_retry': {'manual_retry': True, 'progress': '21/21', 'album_delta': 21, 'batch_distinct': True},
            'library': {'no_http404': True, 'labelled_test_counts': [1, 21], 'timeline_opens': True},
            'progress': {'loading_feedback': True, 'updated_feedback': True, 'ready_count': True},
        }
        self.raw = {'schema_version': 'native-album-full-regression/1', 'revision': 1,
                    'source_main': 'a' * 40, 'preview': 'v14', 'qr_sha256': 'b' * 64,
                    'source_provenance_sha256': 'c' * 64, 'source_clean': True,
                    'fixture': 'synthetic-album-transport-only', 'paid_model_calls': 0,
                    'recorded_at': '2026-11-04T09:00:00Z', 'expires_at': '2026-11-04T10:00:00Z', 'window': 9,
                    'status': 'PASS_USER_REPORTED', 'agent_direct_phone_observation': False,
                    'target_device': {'os': 'HyperOS', 'version': '3.0.308', 'wechat': '8.0.80'},
                    'reported_device': {'model': 'UNKNOWN', 'os_name': 'HyperOS', 'os_version': '3.0.308', 'wechat_version': '8.0.80', 'execution_time': 'UNKNOWN'},
                    'native_cases': {name: {'status': 'PASS_USER_REPORTED', 'evidence_kind': 'CURRENT_OPERATOR_CONFIRMATION', 'actual': value, 'feedback_item_index': 0} for name, value in actual.items()},
                    'operator_feedback_verbatim': [{'question': 'Synthetic seven-case serialization input; no actual phone acceptance.', 'answer': 'Synthetic serializer fixture, not physical observations.'}],
                    'host_receipts': {}, 'preserved_history_sha256': {},
                    'private_env': {'account_email': 'private@example.org'}}
        self.source = self.root / 'raw.json'

    def tearDown(self):
        self.temp.cleanup()

    def export(self, name='out', identities=()):
        self.source.write_text(json.dumps(self.raw, ensure_ascii=False))
        return self.tool.export_record(self.source, self.root / name, identities)

    def test_pending_and_confirmed_revisions_remain_distinct_and_immutable(self):
        confirmed = copy.deepcopy(self.raw)
        self.raw.update(revision=0, status='HOST_VERIFIED_PHONE_NOT_RUN')
        self.raw.pop('operator_feedback_verbatim')
        for case in self.raw['native_cases'].values():
            case.update(status='NOT_RUN', evidence_kind='AWAITING_CURRENT_OPERATOR_REPORT', actual='UNKNOWN')
            case.pop('feedback_item_index')
        result = self.export('prepared')
        self.assertEqual(result['operator_confirmed_cases'], 0)
        before = (self.root / 'prepared/record.json').read_bytes()
        self.raw = confirmed
        result = self.export('confirmed')
        self.assertEqual(result['operator_confirmed_cases'], 7)
        self.assertFalse(result['independent_device_certification'])
        record = json.loads((self.root / 'confirmed/record.json').read_text())
        self.assertEqual(record['reported_device']['model'], 'UNKNOWN')
        self.assertNotIn('private_env', record)
        with self.assertRaises(FileExistsError):
            self.export('prepared')
        self.assertEqual((self.root / 'prepared/record.json').read_bytes(), before)

    def test_incomplete_counts_booleans_and_boundary_forgery_fail_before_export(self):
        good = copy.deepcopy(self.raw)
        mutations = [lambda r: r['native_cases'].pop('library'),
                     lambda r: r['native_cases']['single']['actual'].update(album_delta=True),
                     lambda r: r['native_cases']['batch']['actual'].update(batch_distinct=False),
                     lambda r: r['native_cases']['restore_without_save']['actual'].update(save_clicked=True),
                     lambda r: r.update(agent_direct_phone_observation=True),
                     lambda r: r.update(paid_model_calls=True),
                     lambda r: r['operator_feedback_verbatim'].clear()]
        for change in mutations:
            self.raw = copy.deepcopy(good); change(self.raw)
            with self.assertRaises(ValueError):
                self.export()
            self.assertFalse((self.root / 'out').exists())

    def test_known_secret_and_private_metadata_cannot_enter_public_record(self):
        token = secrets.token_hex(32)
        identity = self.root / 'identity.json'
        identity.write_text(json.dumps({'accessToken': token})); identity.chmod(0o600)
        self.raw['operator_feedback_verbatim'][0]['answer'] = token
        with self.assertRaisesRegex(ValueError, 'PRIVATE_TOKEN_IN_RECORD'):
            self.export(identities=[identity])
        self.assertFalse((self.root / 'out').exists())
        self.raw['operator_feedback_verbatim'][0]['answer'] = '/Users/private/operator/data.json'
        with self.assertRaisesRegex(ValueError, 'PRIVATE_METADATA_IN_RECORD'):
            self.export()

    def test_manifest_tampering_traversal_and_symlinks_fail(self):
        self.export()
        output = self.root / 'out'
        record = output / 'record.json'
        original = record.read_bytes(); record.write_bytes(original + b' ')
        with self.assertRaisesRegex(ValueError, 'RECORD_DIGEST_MISMATCH'):
            self.tool.verify_record(output)
        record.write_bytes(original)
        manifest = output / 'SHA256SUMS'
        content = manifest.read_bytes()
        manifest.write_text('a  ../../private.json\nb  report.md\n')
        with self.assertRaisesRegex(ValueError, 'MANIFEST_PATH_INVALID'):
            self.tool.verify_record(output)
        manifest.write_bytes(content)
        elsewhere = self.root / 'manifest'; manifest.rename(elsewhere); manifest.symlink_to(elsewhere)
        with self.assertRaises(ValueError):
            self.tool.verify_record(output)


if __name__ == '__main__':
    unittest.main()
