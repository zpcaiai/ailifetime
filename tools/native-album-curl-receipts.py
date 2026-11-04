"""Read-only integrity checks for private curl captures; does not execute network or phone actions."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
from urllib.parse import urlsplit


def require(condition, code):
    if not condition:
        raise ValueError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private_read(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077 and info.st_size <= limit,
                'BOUNDED_PRIVATE_FILE_REQUIRED')
        data = stream.read(limit + 1)
        require(len(data) <= limit, 'BOUNDED_PRIVATE_FILE_REQUIRED')
        return data


def same_capture_file(recorded, expected):
    path = Path(recorded)
    return path.is_absolute() and '..' not in path.parts and not path.is_symlink() and path.resolve() == expected


def verify(directory):
    info = directory.lstat()
    require(stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o077, 'PRIVATE_CAPTURE_DIRECTORY_REQUIRED')
    directory = directory.resolve()
    summary_bytes = private_read(directory / 'summary.json', 2 * 1024 * 1024)
    summary = json.loads(summary_bytes)
    require(summary.get('transport') == 'ACTUAL_CURL_VERIFIED_HTTPS' and summary.get('tlsValidation') is True
            and summary.get('nativePhone') == 'NOT_RUN' and type(summary.get('paidModelCalls')) is int
            and summary['paidModelCalls'] == 0, 'SYNTHETIC_HOST_TRANSPORT_REQUIRED')
    origin = summary.get('origin', '')
    parsed = urlsplit(origin)
    require(parsed.scheme == 'https' and bool(parsed.hostname) and not parsed.username and not parsed.password
            and not parsed.query and not parsed.fragment and parsed.path == '', 'HTTPS_ORIGIN_REQUIRED')
    for key in ['actual_child_processes', 'failed_connection_attempts_retained', 'rejected_previous_identities']:
        require(type(summary.get(key)) is int and summary[key] >= 0, 'INTEGER_PROCESS_COUNTS_REQUIRED')
    count = summary['actual_child_processes']
    require(0 < count <= 4096, 'BOUNDED_PROCESS_COUNT_REQUIRED')
    expected_files = {'summary.json'} | {f'{n}.{suffix}' for n in range(count)
        for suffix in ['event.json', 'headers', 'body', 'stdout', 'stderr']}
    require({p.name for p in directory.iterdir()} == expected_files, 'EXACT_CAPTURE_INVENTORY_REQUIRED')
    images = []
    records = []
    manifest = {'summary.json': digest(summary_bytes)}
    custom_ca_requests = 0
    for number in range(count):
        files = {}
        for suffix, limit in [('event.json', 32768), ('headers', 8192), ('body', 4 * 1024 * 1024),
                              ('stdout', 8192), ('stderr', 65536)]:
            name = f'{number}.{suffix}'
            files[suffix] = private_read(directory / name, limit)
            manifest[name] = digest(files[suffix])
        event = json.loads(files['event.json'])
        require(event.get('executed') is True and type(event.get('pid')) is int and event['pid'] > 0
                and type(event.get('exit_code')) is int and type(event.get('attempt')) is int,
                'EXECUTED_PROCESS_RECEIPT_REQUIRED')
        require(event.get('body_sha256') == digest(files['body'])
                and event.get('metadata_sha256') == digest(files['stdout']), 'CAPTURE_DIGEST_MISMATCH')
        command = event.get('command')
        require(isinstance(command, list) and len(command) in [20, 22]
                and all(isinstance(v, str) for v in command), 'CANONICAL_CURL_GET_REQUIRED')
        require(command[:7] == ['curl', '-q', '--silent', '--show-error', '--no-insecure', '--proto', '=https']
                and command[7] == '--connect-timeout' and command[9] == '--max-time'
                and command[11:14] == ['--max-filesize', '4194304', '--header']
                and command[15] == '--output' and command[17:19] == ['--write-out', '%{http_code} %{ssl_verify_result}'],
                'CANONICAL_CURL_GET_REQUIRED')
        require(0 < float(command[8]) <= 10 and float(command[8]) <= float(command[10]) <= 40,
                'BOUNDED_CURL_TIMEOUT_REQUIRED')
        require(command[14].startswith('@')
                and same_capture_file(command[14][1:], directory / f'{number}.headers')
                and same_capture_file(command[16], directory / f'{number}.body'), 'CAPTURE_COMMAND_PATH_MISMATCH')
        if len(command) == 22:
            require(command[19] == '--cacert' and bool(command[20]), 'EXPLICIT_CA_OPTION_REQUIRED')
            custom_ca_requests += 1
        url = urlsplit(command[-1])
        require(url.scheme + '://' + url.netloc == origin and not url.username and not url.password
                and not url.fragment, 'SAME_ORIGIN_GET_REQUIRED')
        if event['exit_code'] == 0:
            metadata = files['stdout'].decode().split()
            require(len(metadata) == 2 and re.fullmatch(r'[0-9]{3}', metadata[0]) is not None
                    and metadata[1] == '0' and 200 <= int(metadata[0]) < 500
                    and not 300 <= int(metadata[0]) < 400, 'VERIFIED_TLS_STATUS_REQUIRED')
            if files['body'].startswith(b'\x89PNG\r\n\x1a\n'):
                require(len(files['body']) >= 24 and files['body'][12:16] == b'IHDR'
                        and struct.unpack('>II', files['body'][16:24]) == (512, 512), 'PNG_DIMENSIONS_REQUIRED')
                images.append(digest(files['body']))
        else:
            require(event['exit_code'] in [28, 35, 56] and event['attempt'] == 0, 'BOUNDED_CONNECTION_RETRY_REQUIRED')
        records.append((event, files['headers']))
    failures = []
    for number, (event, headers) in enumerate(records):
        if event['exit_code'] != 0:
            require(number + 1 < len(records), 'RECOVERED_RETRY_REQUIRED')
            retry, retry_headers = records[number + 1]
            require(retry['exit_code'] == 0 and retry['attempt'] == 1 and headers == retry_headers
                    and retry['command'][-1] == event['command'][-1], 'RECOVERED_RETRY_REQUIRED')
            failures.append(event['exit_code'])
        elif event['attempt'] == 1:
            require(number > 0 and records[number - 1][0]['exit_code'] != 0, 'RETRY_PREDECESSOR_REQUIRED')
        else:
            require(event['attempt'] == 0, 'BOUNDED_ATTEMPT_REQUIRED')
    successful = count - len(failures)
    require(len(failures) == summary['failed_connection_attempts_retained']
            and successful == 32 + summary['rejected_previous_identities'], 'SUMMARY_PROCESS_COUNTS_MISMATCH')
    verified = summary.get('verified', {})
    expected_images = []
    for name, expected_count in [('single-root', 1), ('root', 21)]:
        item = verified.get(name, {})
        values = item.get('unique_sha256', [])
        require(type(item.get('downloaded')) is int and item['downloaded'] == expected_count
                and isinstance(values, list) and len(values) == expected_count
                and all(isinstance(v, str) and re.fullmatch(r'[a-f0-9]{64}', v) for v in values)
                and len(set(values)) == expected_count, 'VERIFIED_IMAGE_COUNTS_REQUIRED')
        expected_images.extend(values)
    require(sorted(images) == sorted(expected_images), 'CAPTURED_IMAGE_DIGESTS_MISMATCH')
    return {'receipt_integrity': 'PASS', 'actual_process_receipts': count, 'successful_requests': successful,
            'preserved_failed_attempts': len(failures), 'failed_exit_codes': failures,
            'verified_pngs': len(images), 'previous_identities_rejected': summary['rejected_previous_identities'],
            'custom_ca_requests': custom_ca_requests, 'summary_sha256': digest(summary_bytes),
            'private_capture_manifest_sha256': digest(json.dumps(manifest, sort_keys=True).encode()),
            'boundary': 'READ_ONLY_RECEIPT_INTEGRITY_NO_NEW_NETWORK_OR_PHONE_EXECUTION_NOT_INDEPENDENT_CERTIFICATION'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture-directory', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.capture_directory)))
    except (ValueError, OSError, KeyError, TypeError, OverflowError) as error:
        message = str(error) if isinstance(error, ValueError) else type(error).__name__
        parser.exit(1, 'ALBUM_RECEIPTS_FAILED: ' + message + '\n')
