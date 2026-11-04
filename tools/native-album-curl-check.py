"""Run the existing read-only album verifier through real certificate-verified curl GETs."""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit

CHECKER = Path(__file__).with_name('native-album-public-check.py')
ROOT = Path(__file__).resolve().parent.parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)


class CurlResponse(io.BytesIO):
    def __init__(self, code, data):
        super().__init__(data)
        self.code = code


class CurlTransport:
    def __init__(self, origin, directory, ca_file=None):
        self.origin = origin
        self.directory = directory
        self.ca_file = ca_file
        self.events = []

    def open(self, request, timeout):
        url = urlsplit(request.full_url)
        if request.get_method() != 'GET' or url.scheme != 'https' or url.username or url.password or url.fragment or (url.scheme + '://' + url.netloc) != self.origin:
            raise ValueError('SAME_ORIGIN_HTTPS_GET_REQUIRED')
        for attempt in range(2):
            number = len(self.events)
            paths = {name: self.directory / f'{number}.{name}' for name in ['headers', 'body', 'stdout', 'stderr']}
            lines = []
            for key, value in request.header_items():
                if '\r' in key + value or '\n' in key + value:
                    raise ValueError('INVALID_REQUEST_HEADER')
                lines.append(key + ': ' + value)
            private_write(paths['headers'], ('\n'.join(lines) + '\n').encode())
            for name in ['body', 'stdout', 'stderr']:
                private_write(paths[name], b'')
            command = ['curl', '-q', '--silent', '--show-error', '--no-insecure', '--proto', '=https',
                       '--connect-timeout', str(min(timeout, 10)), '--max-time', str(timeout),
                       '--max-filesize', str(4 * 1024 * 1024), '--header', '@' + str(paths['headers']),
                       '--output', str(paths['body']), '--write-out', '%{http_code} %{ssl_verify_result}']
            if self.ca_file is not None:
                command += ['--cacert', str(self.ca_file)]
            command.append(request.full_url)
            with paths['stdout'].open('wb') as output, paths['stderr'].open('wb') as error:
                child = subprocess.Popen(command, stdout=output, stderr=error)
                code = child.wait()
            event = {'command': command, 'attempt': attempt, 'executed': True, 'pid': child.pid,
                     'exit_code': code, 'body_sha256': digest(paths['body'].read_bytes()),
                     'metadata_sha256': digest(paths['stdout'].read_bytes())}
            self.events.append(event)
            private_write(self.directory / f'{number}.event.json', json.dumps(event).encode())
            if code != 0:
                if attempt == 0 and code in [28, 35, 56]:
                    continue
                raise ValueError(f'CURL_FAILED_SEE_PRIVATE_CAPTURE_{number}')
            metadata = paths['stdout'].read_text().split()
            if len(metadata) != 2 or not metadata[0].isdigit() or metadata[1] != '0':
                raise ValueError('CURL_TLS_OR_STATUS_METADATA_INVALID')
            status = int(metadata[0])
            if 300 <= status < 400:
                raise ValueError('REDIRECT_FORBIDDEN')
            data = paths['body'].read_bytes()
            if len(data) > 4 * 1024 * 1024:
                raise ValueError('RESPONSE_TOO_LARGE')
            return CurlResponse(status, data)
        raise ValueError('CURL_ATTEMPTS_EXHAUSTED')


def check(origin, current_path, directory, previous_paths=(), ca_file=None):
    url = urlsplit(origin)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ['', '/']:
        raise ValueError('HTTPS_ORIGIN_REQUIRED')
    origin = origin.rstrip('/')
    if not directory.is_absolute() or directory.resolve().is_relative_to(ROOT):
        raise ValueError('CAPTURE_OUTSIDE_REPOSITORY_REQUIRED')
    if directory.exists() or directory.is_symlink():
        raise ValueError('CAPTURE_DIRECTORY_MUST_BE_NEW')
    checker_sha256 = digest(CHECKER.read_bytes())
    spec = importlib.util.spec_from_file_location('native_album_public_check', CHECKER)
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    current = verifier.identity(current_path)
    previous = [verifier.identity(path) for path in previous_paths]
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError as error:
        raise ValueError('CAPTURE_DIRECTORY_MUST_BE_NEW') from error
    transport = CurlTransport(origin, directory, ca_file)
    original_opener = verifier.build_opener
    verifier.build_opener = lambda *handlers: transport
    try:
        result = verifier.check(origin, current, previous)
    finally:
        verifier.build_opener = original_opener
    if digest(CHECKER.read_bytes()) != checker_sha256:
        raise ValueError('AUTHORITATIVE_CHECKER_CHANGED')
    result.update({'transport': 'ACTUAL_CURL_VERIFIED_HTTPS', 'authoritative_checker_sha256': checker_sha256,
                   'actual_child_processes': len(transport.events),
                   'failed_connection_attempts_retained': sum(event['exit_code'] != 0 for event in transport.events)})
    data = json.dumps(result).encode()
    if any(identity['accessToken'].encode() in data for identity in [current, *previous]):
        raise ValueError('PRIVATE_TOKEN_IN_SUMMARY')
    private_write(directory / 'summary.json', data)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--identity', type=Path, required=True)
    parser.add_argument('--previous-identity', type=Path, action='append', default=[])
    parser.add_argument('--capture-directory', type=Path, required=True, help='New absolute private directory outside Git')
    parser.add_argument('--ca-file', type=Path, help='Explicit trusted CA; certificate/hostname verification remains enabled')
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.origin, args.identity, args.capture_directory, args.previous_identity, args.ca_file)))
    except Exception as error:
        parser.exit(1, 'ALBUM_CURL_CHECK_FAILED: ' + str(error) + '\n')
