"""Verify immutable pending/confirmed album archives, never independent phone acceptance."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import subprocess


def record_tool():
    spec = importlib.util.spec_from_file_location('album_seven_record', Path(__file__).with_name('native-album-regression-record.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require(condition, code):
    if not condition:
        raise ValueError(code)


def verify_history(prepared, confirmed, private_identities=(), source_proof=None, repo=None):
    tool = record_tool()
    before = tool.verify_record(prepared, private_identities)
    after = tool.verify_record(confirmed, private_identities)
    left = json.loads(tool.regular(prepared / 'record.json'))
    right = json.loads(tool.regular(confirmed / 'record.json'))
    require(before['operator_confirmed_cases'] == 0 and after['operator_confirmed_cases'] == 7,
            'PENDING_TO_CONFIRMED_REQUIRED')
    require(right['revision'] == left['revision'] + 1, 'CONSECUTIVE_REVISIONS_REQUIRED')
    for field in ['source_main', 'source_clean', 'source_provenance_sha256', 'qr_sha256', 'preview',
                  'fixture', 'window', 'expires_at', 'target_device', 'host_evidence']:
        require(field in left and field in right and left[field] == right[field], 'HISTORY_FIELD_DRIFT:' + field)
    require(left['source_clean'] is True and type(left['window']) is int and left['window'] > 0,
            'CLEAN_PINNED_TEST_WINDOW_REQUIRED')
    require(re.fullmatch(r'[a-f0-9]{64}', left.get('source_record_sha256', '')) is not None,
            'SOURCE_RECORD_DIGEST_REQUIRED')
    require(right.get('supersedes_source_record_sha256') == left['source_record_sha256'],
            'SOURCE_RECORD_CHAIN_BROKEN')
    require(right.get('preserved_history_sha256', {}).get(left['source_record_name']) == left['source_record_sha256'],
            'PREPARATION_HISTORY_DIGEST_REQUIRED')
    for field, target in [('os_name', 'os'), ('os_version', 'version'), ('wechat_version', 'wechat')]:
        require(right['reported_device'].get(field) == left['target_device'].get(target), 'TARGET_DEVICE_MISMATCH')
    source_files = 0
    if source_proof is not None:
        data = tool.regular(source_proof)
        tool.reject_private([data], tool.identity_tokens(private_identities))
        require(hashlib.sha256(data).hexdigest() == left['source_provenance_sha256'], 'SOURCE_PROOF_DIGEST_MISMATCH')
        proof = json.loads(data)
        require(proof.get('source_main') == left['source_main'] and proof.get('source_clean') is True,
                'SOURCE_PROOF_REVISION_MISMATCH')
        require(proof.get('fixture') == left['fixture'] and type(proof.get('paid_model_calls')) is int
                and proof['paid_model_calls'] == 0, 'SYNTHETIC_SOURCE_PROOF_REQUIRED')
        if repo is not None:
            files = proof.get('source_sha256', {})
            require(isinstance(files, dict) and bool(files), 'SOURCE_FILE_DIGESTS_REQUIRED')
            for name, expected in files.items():
                path = PurePosixPath(name)
                require(not path.is_absolute() and '..' not in path.parts and path.as_posix() == name
                        and '\\' not in name, 'RELATIVE_SOURCE_PATH_REQUIRED')
                require(isinstance(expected, str) and re.fullmatch(r'[a-f0-9]{64}', expected) is not None,
                        'SOURCE_FILE_DIGEST_REQUIRED')
                result = subprocess.run(['git', 'show', left['source_main'] + ':' + name], cwd=repo,
                                        capture_output=True, check=False)
                require(result.returncode == 0, 'PINNED_SOURCE_BLOB_UNAVAILABLE')
                require(hashlib.sha256(result.stdout).hexdigest() == expected, 'PINNED_SOURCE_BLOB_MISMATCH')
                source_files += 1
    else:
        require(repo is None, 'SOURCE_PROOF_REQUIRED_WITH_REPO')
    return {'history_integrity': 'PASS', 'case_denominator': 7, 'operator_confirmed_cases': 7,
            'source_main': left['source_main'], 'preview': left['preview'],
            'revisions': [left['revision'], right['revision']], 'source_files_verified': source_files,
            'phone_result': 'PASS_USER_REPORTED', 'independent_device_certification': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepared', type=Path, required=True)
    parser.add_argument('--confirmed', type=Path, required=True)
    parser.add_argument('--private-identity', type=Path, action='append', default=[])
    parser.add_argument('--source-proof', type=Path)
    parser.add_argument('--repo', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(verify_history(args.prepared, args.confirmed, args.private_identity, args.source_proof, args.repo)))
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, 'ALBUM_HISTORY_FAILED: ' + str(error) + '\n')
