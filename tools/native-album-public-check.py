"""Read-only transport checks; never a phone album or model-quality certificate."""
import argparse
import hashlib
import json
import os
import re
import ssl
import stat
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPSHandler, HTTPRedirectHandler


class RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('REDIRECT_FORBIDDEN')


def identity(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 8192:
            raise ValueError('PRIVATE_IDENTITY_REQUIRED')
        value = json.load(stream)
    if not re.fullmatch(r'[a-f0-9]{64}', value.get('accessToken', '')):
        raise ValueError('TEST_TOKEN_FORMAT_INVALID')
    return value


def check(origin, current, previous=(), ca_file=None):
    url = urlsplit(origin)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ['', '/']:
        raise ValueError('HTTPS_ORIGIN_REQUIRED')
    origin = origin.rstrip('/')
    context = ssl.create_default_context(cafile=ca_file)
    assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
    client = build_opener(RejectRedirects(), HTTPSHandler(context=context))
    headers = {'Authorization': 'Bearer ' + current['accessToken'], 'X-Purpose': 'age_transformation'}

    def get(path, extra=None):
        if not path.startswith('/') or path.startswith('//'):
            raise ValueError('SAME_ORIGIN_PATH_REQUIRED')
        try:
            response = client.open(Request(origin + path, headers=headers if extra is None else extra), timeout=40)
        except HTTPError as error:
            response = error
        with response:
            data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise ValueError('RESPONSE_TOO_LARGE')
            return response.code, data

    for path in ['/v1/session', '/native-album/config']:
        status, body = get(path)
        if status != 200 or current['accessToken'].encode() in body:
            raise ValueError('AUTHENTICATED_RESPONSE_INVALID')
        if path == '/native-album/config':
            config = json.loads(body)
            if config.get('expiresAt') != current['expiresAt'] or config.get('fixtureKind') != 'synthetic-album-transport-only' or config.get('commands') != {'single': 'single-root', 'batch': 'root'}:
                raise ValueError('SYNTHETIC_CONFIG_MISMATCH')
    denials = [('/v1/session', {}, 401), ('/v1/session', headers | {'X-Purpose': 'commerce'}, 403),
               ('/v1/session', headers | {'Origin': 'https://example.com'}, 403),
               ('/v1/session', headers | {'Cookie': 'unexpected=true'}, 403),
               ('/package.json', headers, 404), ('/v1/session?unexpected=true', headers, 404)]
    for path, extra, expected in denials:
        status, _ = get(path, extra)
        if status != expected:
            raise ValueError('DENIAL_STATUS_MISMATCH')
    for old in previous:
        if old['accessToken'] == current['accessToken']:
            raise ValueError('PREVIOUS_IDENTITY_MUST_DIFFER')
        if get('/v1/session', headers | {'Authorization': 'Bearer ' + old['accessToken']})[0] != 401:
            raise ValueError('PREVIOUS_IDENTITY_NOT_REJECTED')
    results = {}
    for name, count in [('single-root', 1), ('root', 21)]:
        status, body = get('/v1/timelines/' + name)
        if status != 200:
            raise ValueError('TIMELINE_UNAVAILABLE')
        view = json.loads(body)['data']
        if view['readyCount'] != count or view['expectedCount'] != count or len(view['nodes']) != count:
            raise ValueError('TIMELINE_COUNT_MISMATCH')
        hashes = []
        for node in view['nodes']:
            path = node['downloadPath']
            if not re.fullmatch(r'/v1/timelines/' + name + r'/nodes/(?:0|[1-9][0-9]?|100)/image', path):
                raise ValueError('IMAGE_PATH_OUTSIDE_TEST_SCOPE')
            status, data = get(path)
            if status != 200 or len(data) != node['asset']['byteLength'] or not data.startswith(b'\x89PNG\r\n\x1a\n'):
                raise ValueError('IMAGE_RESPONSE_INVALID')
            if int.from_bytes(data[16:20], 'big') != 512 or int.from_bytes(data[20:24], 'big') != 512:
                raise ValueError('TEST_IMAGE_DIMENSIONS_INVALID')
            digest = hashlib.sha256(data).hexdigest()
            if digest != node['asset']['sha256'] or current['accessToken'].encode() in data:
                raise ValueError('IMAGE_INTEGRITY_INVALID')
            hashes.append(digest)
        if len(set(hashes)) != count:
            raise ValueError('TEST_IMAGES_NOT_DISTINCT')
        results[name] = {'downloaded': count, 'unique_sha256': hashes}
    return {'origin': origin, 'tlsValidation': True, 'verified': results,
            'rejected_previous_identities': len(previous), 'nativePhone': 'NOT_RUN', 'paidModelCalls': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--identity', required=True, help='Private0600 JSON file; never put token in arguments')
    parser.add_argument('--previous-identity', action='append', default=[])
    parser.add_argument('--ca-file', help='Optional trusted CA file; hostname/certificate verification stays enabled')
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.origin, identity(args.identity), [identity(p) for p in args.previous_identity], args.ca_file)))
    except Exception as error:
        parser.exit(1, 'ALBUM_PUBLIC_CHECK_FAILED: ' + str(error) + '\n')
