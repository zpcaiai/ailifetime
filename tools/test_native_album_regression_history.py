"""Filesystem archive tests use retained public records; they do not execute phone saves."""
import hashlib
import importlib.util
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import unittest


class RegressionHistory(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo = Path(__file__).resolve().parent.parent
        cls.script = cls.repo / 'tools/native-album-regression-history.py'
        spec = importlib.util.spec_from_file_location('history', cls.script)
        cls.tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.tool)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='album-history-')
        self.root = Path(self.temp.name)
        for number in [0, 1]:
            shutil.copytree(self.repo / f'docs/evidence/native-album-v14/revision-{number}', self.root / str(number))

    def tearDown(self):
        self.temp.cleanup()

    def read(self, number):
        return json.loads((self.root / str(number) / 'record.json').read_text())

    def change(self, number, update):
        path = self.root / str(number) / 'record.json'
        record = self.read(number)
        update(record)
        path.write_text(json.dumps(record, ensure_ascii=False))
        # Rehash deliberately: semantic checks must reject a self-consistent bad packet.
        directory = path.parent
        (directory / 'SHA256SUMS').write_text(''.join(
            hashlib.sha256((directory / name).read_bytes()).hexdigest() + '  ' + name + '\n'
            for name in ['record.json', 'report.md']))

    def verify(self, **kwargs):
        return self.tool.verify_history(self.root / '0', self.root / '1', **kwargs)

    def test_retained_history_and_cli_preserve_operator_boundary(self):
        result = self.verify()
        self.assertEqual(result['operator_confirmed_cases'], 7)
        self.assertFalse(result['independent_device_certification'])
        child = subprocess.run([sys.executable, str(self.script), '--prepared', str(self.root / '0'),
                                '--confirmed', str(self.root / '1')], capture_output=True, text=True)
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertEqual(json.loads(child.stdout), result)

    def test_rehashed_source_preview_qr_window_evidence_and_device_drift_rejected(self):
        mutations = {'source_main': 'f' * 40, 'preview': 'v999', 'qr_sha256': 'e' * 64, 'window': 999,
                     'expires_at': '2099-01-01T00:00:00Z', 'source_provenance_sha256': 'd' * 64,
                     'source_clean': False, 'host_evidence': []}
        original = (self.root / '1/record.json').read_bytes()
        for field, value in mutations.items():
            with self.subTest(field=field):
                (self.root / '1/record.json').write_bytes(original)
                self.change(1, lambda r: r.update({field: value}))
                with self.assertRaisesRegex(ValueError, 'HISTORY_FIELD_DRIFT'):
                    self.verify()
        (self.root / '1/record.json').write_bytes(original)
        self.change(1, lambda r: r['reported_device'].update(os_version='different'))
        with self.assertRaisesRegex(ValueError, 'TARGET_DEVICE_MISMATCH'):
            self.verify()

    def test_broken_chain_missing_history_and_nonconsecutive_revision_rejected(self):
        original = (self.root / '1/record.json').read_bytes()
        for mutation, code in [(lambda r: r.update(supersedes_source_record_sha256='f' * 64), 'SOURCE_RECORD_CHAIN_BROKEN'),
                               (lambda r: r.update(preserved_history_sha256={}), 'PREPARATION_HISTORY_DIGEST_REQUIRED'),
                               (lambda r: r.update(revision=9), 'CONSECUTIVE_REVISIONS_REQUIRED')]:
            (self.root / '1/record.json').write_bytes(original)
            self.change(1, mutation)
            with self.assertRaisesRegex(ValueError, code):
                self.verify()

    def test_manifest_symlink_and_known_private_material_rejected(self):
        token = secrets.token_hex(32)
        identity = self.root / 'identity.json'
        identity.write_text(json.dumps({'accessToken': token})); identity.chmod(0o600)
        self.change(1, lambda r: r['operator_feedback_verbatim'][0].update(answer=token))
        with self.assertRaisesRegex(ValueError, 'PRIVATE_TOKEN_IN_RECORD'):
            self.verify(private_identities=[identity])
        manifest = self.root / '1/SHA256SUMS'
        content = manifest.read_bytes()
        manifest.unlink(); (self.root / 'manifest').write_bytes(content); manifest.symlink_to(self.root / 'manifest')
        with self.assertRaises(ValueError):
            self.verify()

    def test_optional_source_proof_checks_real_git_blobs_and_rejects_drift(self):
        # Use an available Git object in shallow CI; mutated packets are test inputs only.
        pinned = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=self.repo, text=True).strip()
        for number in [0, 1]:
            self.change(number, lambda r: r.update(source_main=pinned))
        name = 'tools/native-album-preview.mjs'
        blob = subprocess.check_output(['git', 'show', pinned + ':' + name], cwd=self.repo)
        proof = {'source_main': pinned, 'source_clean': True, 'fixture': 'synthetic-album-transport-only',
                 'paid_model_calls': 0, 'source_sha256': {name: hashlib.sha256(blob).hexdigest()}}
        path = self.root / 'source.json'
        path.write_text(json.dumps(proof))
        for number in [0, 1]:
            self.change(number, lambda r: r.update(source_provenance_sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
        self.assertEqual(self.verify(source_proof=path, repo=self.repo)['source_files_verified'], 1)
        proof['source_sha256'][name] = '0' * 64; path.write_text(json.dumps(proof))
        with self.assertRaisesRegex(ValueError, 'SOURCE_PROOF_DIGEST_MISMATCH'):
            self.verify(source_proof=path, repo=self.repo)
        for number in [0, 1]:
            self.change(number, lambda r: r.update(source_provenance_sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
        with self.assertRaisesRegex(ValueError, 'PINNED_SOURCE_BLOB_MISMATCH'):
            self.verify(source_proof=path, repo=self.repo)
        proof['source_sha256'] = {'../private': '0' * 64}; path.write_text(json.dumps(proof))
        for number in [0, 1]:
            self.change(number, lambda r: r.update(source_provenance_sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
        with self.assertRaisesRegex(ValueError, 'RELATIVE_SOURCE_PATH_REQUIRED'):
            self.verify(source_proof=path, repo=self.repo)


if __name__ == '__main__':
    unittest.main()
