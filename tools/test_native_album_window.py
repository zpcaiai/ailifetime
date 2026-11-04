import datetime
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('album_window', Path(__file__).with_name('native-album-window.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WindowSafety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='album-window-test-')
        self.directory = Path(self.temp.name)
        self.previous = {'expiresAt': '2020-01-01T00:00:00.000Z', 'window': 4}
        # Provider input metadata only. These are not a Vercel runtime or remote PATCH proof.
        self.envs = {'envs': [
            {'id': 'hashenv', 'key': 'LTM_NATIVE_ALBUM_TOKEN_SHA256', 'value': 'encrypted', 'type': 'encrypted', 'target': ['production'], 'updatedAt': 1},
            {'id': 'expiryenv', 'key': 'LTM_NATIVE_ALBUM_EXPIRES_AT', 'value': self.previous['expiresAt'], 'type': 'plain', 'target': ['production'], 'updatedAt': 2},
        ]}

    def tearDown(self):
        self.temp.cleanup()

    def test_real_private_files_randomness_fixed_deadline_and_exclusivity(self):
        before = datetime.datetime.now(datetime.timezone.utc)
        path, expires, selected, payloads = module.prepare_window(self.directory, 5, self.previous, self.envs)
        identity = module.read_identity(path)
        self.assertEqual(identity['window'], 5)
        self.assertEqual(len(identity['accessToken']), 64)
        remaining = (datetime.datetime.fromisoformat(expires.replace('Z', '+00:00')) - before).total_seconds()
        self.assertGreaterEqual(remaining, 3599)
        self.assertLessEqual(remaining, 3601)
        for file in self.directory.iterdir():
            self.assertEqual(file.stat().st_mode & 0o077, 0)
        hash_payload = json.loads(payloads['LTM_NATIVE_ALBUM_TOKEN_SHA256'].read_text())
        self.assertNotEqual(hash_payload['value'], identity['accessToken'])
        self.assertEqual(hash_payload['type'], selected['LTM_NATIVE_ALBUM_TOKEN_SHA256']['type'])
        saved = path.read_bytes()
        with self.assertRaises(FileExistsError):
            module.prepare_window(self.directory, 5, self.previous, self.envs)
        self.assertEqual(path.read_bytes(), saved)
        os.chmod(path, 0o644)
        with self.assertRaisesRegex(ValueError, 'PRIVATE_IDENTITY_REQUIRED'):
            module.read_identity(path)

    def test_unexpired_or_concurrent_window_does_not_write(self):
        future = {'expiresAt': '2100-01-01T00:00:00Z', 'window': 4}
        with self.assertRaisesRegex(ValueError, 'EXPIRED_PREVIOUS'):
            module.prepare_window(self.directory, 5, future, self.envs)
        self.envs['envs'][1]['value'] = 'different'
        with self.assertRaisesRegex(ValueError, 'CONCURRENT_WINDOW_CHANGE'):
            module.prepare_window(self.directory, 5, self.previous, self.envs)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_scope_validation_and_concurrency_fields(self):
        expected = {'email': 'operator@example.invalid', 'team': 'team_scope', 'project': 'prj_scope', 'name': 'native-album-test'}
        user = {'email': expected['email']}
        team = {'id': expected['team'], 'billing': {'plan': 'hobby'}}
        project = {'id': expected['project'], 'accountId': expected['team'], 'name': expected['name'], 'nodeVersion': '26.x'}
        module.validate_scope(user, team, project, expected)
        with self.assertRaisesRegex(ValueError, 'ACCOUNT_MISMATCH'):
            module.validate_scope({'email': 'someone@example.invalid'}, team, project, expected)
        with self.assertRaisesRegex(ValueError, 'TEST_PROJECT_MISMATCH'):
            module.validate_scope(user, team, project | {'accountId': 'other'}, expected)
        original = self.envs['envs'][0]
        self.assertTrue(module.same_env(dict(original), original))
        self.assertFalse(module.same_env(original | {'updatedAt': 3}, original))
        self.envs['envs'][0]['target'] = ['preview']
        with self.assertRaisesRegex(ValueError, 'ENV_SCOPE_OR_TYPE_MISMATCH'):
            module.select_envs(self.envs)


if __name__ == '__main__':
    unittest.main()
