"""Inspect an existing synthetic album test project; create is an explicit separate mode."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess

KEYS = {'LTM_NATIVE_ALBUM_TOKEN_SHA256', 'LTM_NATIVE_ALBUM_EXPIRES_AT'}


def private_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, indent=2)


def read_identity(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 8192:
            raise ValueError('PRIVATE_IDENTITY_REQUIRED')
        return json.load(stream)


def validate_scope(user, team, project, expected):
    if user.get('email', '').lower() != expected['email'].lower():
        raise ValueError('ACCOUNT_MISMATCH')
    if team.get('id') != expected['team'] or team.get('billing', {}).get('plan') != 'hobby':
        raise ValueError('TEST_TEAM_OR_PLAN_MISMATCH')
    if project.get('id') != expected['project'] or project.get('accountId') != expected['team'] or project.get('name') != expected['name']:
        raise ValueError('TEST_PROJECT_MISMATCH')
    if project.get('nodeVersion') != '26.x' or 'album' not in expected['name'] or 'test' not in expected['name']:
        raise ValueError('DEDICATED_ALBUM_TEST_PROJECT_REQUIRED')


def select_envs(response):
    selected = {item['key']: item for item in response['envs'] if item['key'] in KEYS}
    if len([item for item in response['envs'] if item['key'] in KEYS]) != 2 or set(selected) != KEYS:
        raise ValueError('EXACT_TWO_EXISTING_TEST_VARIABLES_REQUIRED')
    if any(item['target'] != ['production'] or item['type'] not in ['plain', 'encrypted', 'sensitive'] for item in selected.values()):
        raise ValueError('ENV_SCOPE_OR_TYPE_MISMATCH')
    return selected


def prepare_window(directory, window, previous, response):
    now = datetime.datetime.now(datetime.timezone.utc)
    selected = select_envs(response)
    expiry = datetime.datetime.fromisoformat(previous['expiresAt'].replace('Z', '+00:00'))
    if expiry.tzinfo is None or expiry >= now or window <= previous.get('window', 0):
        raise ValueError('EXPIRED_PREVIOUS_WINDOW_AND_NEW_VERSION_REQUIRED')
    if selected['LTM_NATIVE_ALBUM_EXPIRES_AT']['value'] != previous['expiresAt']:
        raise ValueError('CONCURRENT_WINDOW_CHANGE')
    token = secrets.token_hex(32)
    expires = (now + datetime.timedelta(minutes=60)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    identity = directory / ('identity-window-' + str(window) + '.json')
    private_json(directory / 'env-preimage.json', response)
    private_json(identity, {'accessToken': token, 'createdAt': now.isoformat(), 'expiresAt': expires,
                            'window': window, 'scope': 'synthetic-album-transport-only'})
    values = {'LTM_NATIVE_ALBUM_TOKEN_SHA256': hashlib.sha256(token.encode()).hexdigest(),
              'LTM_NATIVE_ALBUM_EXPIRES_AT': expires}
    payloads = {}
    for index, (key, value) in enumerate(values.items()):
        path = directory / ('env-update-' + str(index) + '.json')
        private_json(path, {'value': value, 'type': selected[key]['type'], 'target': ['production']})
        payloads[key] = path
    return identity, expires, selected, payloads


def same_env(current, original):
    return all(current.get(key) == original.get(key) for key in ['id', 'key', 'type', 'target', 'updatedAt'])


class VercelApi:
    def __init__(self, directory):
        self.directory = directory
        self.events = []

    def __call__(self, path, method='GET', payload=None):
        index = len(self.events)
        stdout = self.directory / ('api-' + str(index) + '.stdout')
        stderr = self.directory / ('api-' + str(index) + '.stderr')
        command = ['vercel', 'api', path, '--method', method]
        if payload is not None:
            command += ['--input', str(payload)]
        fd = os.open(stdout, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        ef = os.open(stderr, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as output, os.fdopen(ef, 'wb') as error:
            child = subprocess.Popen(command, stdout=output, stderr=error)
            code = child.wait()
        event = {'pid': child.pid, 'executed': True, 'exit_code': code, 'path': path,
                 'method': method, 'raw_file': stdout.name,
                 'sha256': hashlib.sha256(stdout.read_bytes()).hexdigest()}
        self.events.append(event)
        private_json(self.directory / ('event-' + str(index) + '.json'), event)
        if code != 0:
            raise ValueError('API_FAILED_RECONCILE_PRIVATE_OUTPUT_BEFORE_RETRY')
        return json.loads(stdout.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['inspect', 'create'])
    parser.add_argument('--state-directory', type=Path, required=True, help='New absolute private directory outside the repository')
    parser.add_argument('--team-id', required=True)
    parser.add_argument('--project-id', required=True)
    parser.add_argument('--expected-project-name', required=True)
    parser.add_argument('--expected-account-email', required=True)
    parser.add_argument('--previous-identity', type=Path)
    parser.add_argument('--window', type=int)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    directory = args.state_directory
    if not directory.is_absolute() or directory.resolve().is_relative_to(root) or directory.exists():
        parser.error('NEW_PRIVATE_DIRECTORY_OUTSIDE_REPOSITORY_REQUIRED')
    if not re.fullmatch(r'team_[A-Za-z0-9]+', args.team_id) or not re.fullmatch(r'prj_[A-Za-z0-9]+', args.project_id):
        parser.error('EXPLICIT_PROJECT_AND_TEAM_IDS_REQUIRED')
    if args.mode == 'create' and (not args.previous_identity or not args.window or args.window < 1):
        parser.error('CREATE_REQUIRES_PREVIOUS_IDENTITY_AND_WINDOW')
    directory.mkdir(mode=0o700)
    api = VercelApi(directory)
    prefix = '/v10/projects/' + args.project_id + '/env?teamId=' + args.team_id
    try:
        expected = {'email': args.expected_account_email, 'team': args.team_id,
                    'project': args.project_id, 'name': args.expected_project_name}
        validate_scope(api('/v2/user')['user'], api('/v2/teams/' + args.team_id),
                       api('/v9/projects/' + args.project_id + '?teamId=' + args.team_id), expected)
        response = api(prefix)
        selected = select_envs(response)
        result = {'mode': args.mode, 'account_matches': True, 'plan': 'hobby',
                  'test_project_matches': True, 'nativePhone': 'NOT_RUN', 'paidModelCalls': 0}
        if args.mode == 'create':
            identity, expires, selected, payloads = prepare_window(directory, args.window, read_identity(args.previous_identity), response)
            for key, payload in payloads.items():
                fresh = select_envs(api(prefix))[key]
                if not same_env(fresh, selected[key]):
                    raise ValueError('CONCURRENT_ENV_CHANGE')
                value = api('/v9/projects/' + args.project_id + '/env/' + selected[key]['id'] + '?teamId=' + args.team_id, 'PATCH', payload)
                if value.get('id') != selected[key]['id'] or value.get('key') != key:
                    raise ValueError('ENV_UPDATE_RESPONSE_MISMATCH_RECONCILE_BEFORE_RETRY')
            result.update({'window': args.window, 'identity_file': str(identity), 'expiresAt': expires,
                           'deployment': 'NOT_RUN_REQUIRES_SEPARATE_EXPLICIT_DEPLOYMENT'})
        result['events'] = api.events
        print(json.dumps(result))
    except Exception as error:
        parser.exit(1, 'ALBUM_WINDOW_FAILED: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
