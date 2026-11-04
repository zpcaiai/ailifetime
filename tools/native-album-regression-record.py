"""Immutable portable seven-case records; verifies archive integrity, never certifies phone writes."""
import argparse
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat

PUBLIC_SCHEMA = 'ltm.album-seven-case-public-record.v1'
CASES = {
    'single': {'page_result': '保存成功', 'album_delta': 1},
    'batch': {'progress': '21/21', 'album_delta': 21, 'batch_distinct': True},
    'denial': {'fresh_batch_page': True, 'permission_disabled': True, 'permission_message': True, 'settings_button': True, 'album_delta': 0},
    'restore_without_save': {'settings_opened_via_page': True, 'permission_restored': True, 'save_clicked': False, 'album_delta': 0},
    'manual_retry': {'manual_retry': True, 'progress': '21/21', 'album_delta': 21, 'batch_distinct': True},
    'library': {'no_http404': True, 'labelled_test_counts': [1, 21], 'timeline_opens': True},
    'progress': {'loading_feedback': True, 'updated_feedback': True, 'ready_count': True},
}
BOUNDARY = 'Current operator-reported observations only. Host commands verify archives/transport, not phone writes or independent production certification. Unknown model/time stay UNKNOWN; earlier v12 initial0/21cause remains UNKNOWN.'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ValueError('BOUNDED_REGULAR_RECORD_REQUIRED') from error
        raise
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 2 * 1024 * 1024:
            raise ValueError('BOUNDED_REGULAR_RECORD_REQUIRED')
        data = stream.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ValueError('BOUNDED_REGULAR_RECORD_REQUIRED')
        return data


def identity_tokens(paths):
    spec = importlib.util.spec_from_file_location('album_phone_record', Path(__file__).with_name('native-album-phone-record.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.tokens(paths)


def same_type_value(actual, expected):
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, list):
        return len(actual) == len(expected) and all(same_type_value(a, e) for a, e in zip(actual, expected))
    return actual == expected


def validate(record):
    if record.get('schema_version') not in ['native-album-full-regression/1', PUBLIC_SCHEMA]:
        raise ValueError('REGRESSION_RECORD_SCHEMA_REQUIRED')
    if type(record.get('revision')) is not int or record['revision'] < 0 or not re.fullmatch(r'[a-f0-9]{40}', record.get('source_main', '')) or not re.fullmatch(r'v[0-9]+', record.get('preview', '')):
        raise ValueError('SOURCE_PREVIEW_REVISION_REQUIRED')
    if not re.fullmatch(r'[a-f0-9]{64}', record.get('qr_sha256', '')):
        raise ValueError('QR_DIGEST_REQUIRED')
    if record.get('fixture') != 'synthetic-album-transport-only' or type(record.get('paid_model_calls')) is not int or record['paid_model_calls'] != 0:
        raise ValueError('SYNTHETIC_ONLY_RECORD_REQUIRED')
    if record.get('agent_direct_phone_observation') is not False:
        raise ValueError('OPERATOR_EVIDENCE_BOUNDARY_REQUIRED')
    confirmed = record.get('status') == 'PASS_USER_REPORTED'
    if not confirmed and record.get('status') != 'HOST_VERIFIED_PHONE_NOT_RUN':
        raise ValueError('HONEST_PENDING_OR_OPERATOR_STATUS_REQUIRED')
    cases = record.get('native_cases', {})
    if set(cases) != set(CASES):
        raise ValueError('ALL_SEVEN_CASES_REQUIRED')
    feedback = record.get('operator_feedback_verbatim', [])
    if confirmed and (not feedback or any(not isinstance(item.get('question'), str) or not item['question'].strip() or not isinstance(item.get('answer'), str) or not item['answer'].strip() for item in feedback)):
        raise ValueError('EXPLICIT_OPERATOR_FEEDBACK_REQUIRED')
    for name, expected in CASES.items():
        case = cases[name]
        if not confirmed:
            if case.get('status') != 'NOT_RUN' or case.get('actual') != 'UNKNOWN':
                raise ValueError('PENDING_CANNOT_CLAIM_OBSERVATIONS')
            continue
        if case.get('status') != 'PASS_USER_REPORTED' or case.get('evidence_kind') != 'CURRENT_OPERATOR_CONFIRMATION':
            raise ValueError('CURRENT_OPERATOR_CONFIRMATION_REQUIRED')
        actual = case.get('actual')
        if not isinstance(actual, dict) or any(not same_type_value(actual.get(key), value) for key, value in expected.items()):
            raise ValueError('NATIVE_OBSERVATION_MISMATCH')
        index = case.get('feedback_item_index')
        if type(index) is not int or not 0 <= index < len(feedback):
            raise ValueError('CASE_FEEDBACK_REFERENCE_REQUIRED')
    return confirmed


def reject_private(contents, forbidden):
    for data in contents:
        if any(token in data for token in forbidden):
            raise ValueError('PRIVATE_TOKEN_IN_RECORD')
        if any(marker in data for marker in [b'/Users/', b'Bearer ', b'-----BEGIN ' + b'PRIVATE KEY-----', b'@gmail.com', b'prj_', b'team_']):
            raise ValueError('PRIVATE_METADATA_IN_RECORD')


def export_record(source, output, private_identities=()):
    data = regular(source)
    original = json.loads(data)
    confirmed = validate(original)
    fields = ['revision', 'recorded_at', 'status', 'preview', 'source_main', 'source_clean', 'qr_sha256',
              'source_provenance_sha256', 'fixture', 'paid_model_calls', 'window', 'expires_at', 'agent_direct_phone_observation']
    record = {key: original.get(key) for key in fields}
    record.update({'schema_version': PUBLIC_SCHEMA, 'source_record_name': source.name, 'source_record_sha256': sha(data),
                   'supersedes_source_record_sha256': original.get('supersedes_record_sha256'), 'boundary': BOUNDARY})
    device_fields = ['model', 'os_name', 'os_version', 'wechat_version', 'android_base_version', 'execution_time']
    record['reported_device'] = {key: original.get('reported_device', {}).get(key, 'UNKNOWN') for key in device_fields}
    record['target_device'] = {key: original.get('target_device', {}).get(key, 'UNKNOWN') for key in ['os', 'version', 'wechat']}
    record['operator_feedback_verbatim'] = [{key: item[key] for key in ['question', 'answer']} for item in original.get('operator_feedback_verbatim', [])]
    record['native_cases'] = {}
    for name, expected in CASES.items():
        case = original['native_cases'][name]
        public = {key: case.get(key) for key in ['status', 'evidence_kind']}
        public['actual'] = {key: case['actual'][key] for key in expected} if confirmed else 'UNKNOWN'
        if confirmed:
            public['feedback_item_index'] = case['feedback_item_index']
        record['native_cases'][name] = public
    evidence = []
    for receipt in original.get('host_receipts', {}).values():
        name = receipt['local_raw_basename']
        if Path(name).name != name or not re.fullmatch(r'[a-f0-9]{64}', receipt['sha256']) or receipt['executed'] is not True or type(receipt['pid']) is not int or receipt['pid'] <= 0 or receipt['exit_code'] != 0:
            raise ValueError('EXECUTED_HOST_RECEIPT_REQUIRED')
        evidence.append({key: receipt[key] for key in ['local_raw_basename', 'sha256', 'executed', 'pid', 'exit_code']} | {'availability': 'LOCAL_RAW_ARCHIVE'})
    record['host_evidence'] = evidence
    record['preserved_history_sha256'] = {}
    for name, digest in original.get('preserved_history_sha256', {}).items():
        if Path(name).name != name or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('RELATIVE_HISTORY_DIGEST_REQUIRED')
        record['preserved_history_sha256'][name] = digest
    validate(record)
    body = '# ' + record['preview'] + ' 真机回归记录 · revision ' + str(record['revision']) + '\n\n'
    body += '源码：`' + record['source_main'] + '`。结果：**' + record['status'] + '**。付费模型调用：0。\n\n'
    body += '| 检查 | 本轮记录 |\n|---|---|\n'
    for name, case in record['native_cases'].items():
        value = json.dumps(case['actual'], ensure_ascii=False) if confirmed else 'NOT_RUN / UNKNOWN'
        body += '| ' + name + ' | ' + value.replace('|', '\\|').replace('\n', ' ') + ' |\n'
    body += '\n设备：`' + json.dumps(record['reported_device'], ensure_ascii=False) + '`。UNKNOWN不由归档时间推定。\n\n'
    body += '七项均保留；主机记录校验不等于代理直接操作手机或独立认证。两次批量各自21张不同，不声称跨批次图案均不同。首次授权弹窗不在本轮七项中。原v12首次0/21原因仍为UNKNOWN。\n\n'
    for item in record['operator_feedback_verbatim']:
        body += '原始问题：' + item['question'].replace('\n', ' ') + '\n\n用户原文：' + item['answer'].replace('\n', ' ') + '\n\n'
    body += '原始源记录SHA256：`' + record['source_record_sha256'] + '`。相对路径SHA256SUMS校验本目录；原始日志保持LOCAL_RAW_ARCHIVE。\n'
    files = {'record.json': (json.dumps(record, ensure_ascii=False, indent=2) + '\n').encode(), 'report.md': body.encode()}
    reject_private(files.values(), identity_tokens(private_identities))
    output.mkdir(mode=0o755)
    for name, content in files.items():
        with (output / name).open('xb') as stream:
            stream.write(content)
    with (output / 'SHA256SUMS').open('x') as stream:
        stream.write(''.join(sha(content) + '  ' + name + '\n' for name, content in files.items()))
    return verify_record(output, private_identities)


def verify_record(directory, private_identities=()):
    if directory.is_symlink() or {path.name for path in directory.iterdir()} != {'record.json', 'report.md', 'SHA256SUMS'}:
        raise ValueError('EXACT_PUBLIC_RECORD_FILES_REQUIRED')
    lines = regular(directory / 'SHA256SUMS').decode().splitlines()
    if len(lines) != 2:
        raise ValueError('MANIFEST_ENTRY_COUNT_INVALID')
    names = set()
    for line in lines:
        digest, name = line.split('  ', 1)
        if name not in ['record.json', 'report.md'] or name in names:
            raise ValueError('MANIFEST_PATH_INVALID')
        if sha(regular(directory / name)) != digest:
            raise ValueError('RECORD_DIGEST_MISMATCH')
        names.add(name)
    record = json.loads(regular(directory / 'record.json'))
    if record.get('schema_version') != PUBLIC_SCHEMA or record.get('boundary') != BOUNDARY:
        raise ValueError('PUBLIC_RECORD_BOUNDARY_REQUIRED')
    confirmed = validate(record)
    reject_private([regular(directory / name) for name in ['record.json', 'report.md', 'SHA256SUMS']], identity_tokens(private_identities))
    return {'record_integrity': 'PASS', 'case_count': 7, 'operator_confirmed_cases': 7 if confirmed else 0,
            'phone_result': record['status'], 'independent_device_certification': False,
            'source_main': record['source_main'], 'revision': record['revision']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['export', 'verify'])
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--private-identity', type=Path, action='append', default=[])
    args = parser.parse_args()
    try:
        if args.mode == 'export' and args.input is None:
            raise ValueError('INPUT_RECORD_REQUIRED')
        result = export_record(args.input, args.output, args.private_identity) if args.mode == 'export' else verify_record(args.output, args.private_identity)
        print(json.dumps(result))
    except Exception as error:
        parser.exit(1, 'ALBUM_REGRESSION_RECORD_FAILED: ' + str(error) + '\n')
