"""Export immutable portable operator records; verification checks files, not phone writes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat

CASES = ['single', 'batch', 'denied_batch', 'settings_no_auto_write', 'manual_batch_retry']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate_cases(cases):
    if set(cases) != set(CASES):
        raise ValueError('ALL_FIVE_DEVICE_CASES_REQUIRED')
    if any(type(case.get('actual_photos_delta')) is not int for case in cases.values()):
        raise ValueError('INTEGER_OBSERVATION_COUNTS_REQUIRED')
    if [cases[key].get('actual_photos_delta') for key in CASES] != [1, 21, 0, 0, 21]:
        raise ValueError('DEVICE_OBSERVATION_COUNTS_INVALID')
    for case in cases.values():
        if case.get('status') != 'PASS_USER_REPORTED' or case.get('agent_direct_device_observation') is not False or not case.get('operator_report'):
            raise ValueError('OPERATOR_EVIDENCE_BOUNDARY_REQUIRED')
    for key in ['batch', 'manual_batch_retry']:
        if cases[key].get('ui_progress') != '21/21' or cases[key].get('distinct_within_batch') is not True:
            raise ValueError('BATCH_READBACK_REQUIRED')


def tokens(paths):
    result = []
    for path in paths:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 8192:
                raise ValueError('PRIVATE_IDENTITY_REQUIRED')
            token = json.load(stream)['accessToken']
        if not re.fullmatch(r'[a-f0-9]{64}', token):
            raise ValueError('TEST_TOKEN_FORMAT_INVALID')
        result.append(token.encode())
    return result


def export_record(source, output, private_identities=()):
    if source.is_symlink() or source.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('BOUNDED_REGULAR_RECORD_REQUIRED')
    data = source.read_bytes()
    original = json.loads(data)
    if original.get('schemaVersion') != 'ltm.album-main-device-report.v1' or original.get('native_result') != 'PASS_USER_REPORTED':
        raise ValueError('OPERATOR_RECORD_SCHEMA_REQUIRED')
    validate_cases(original['cases'])
    if not re.fullmatch(r'[a-f0-9]{40}', original['source_main']) or not re.fullmatch(r'v[0-9]+', original['preview_version']):
        raise ValueError('SOURCE_AND_PREVIEW_REQUIRED')
    if type(original.get('paid_model_calls_for_this_regression')) is not int or original['paid_model_calls_for_this_regression'] != 0:
        raise ValueError('SYNTHETIC_ONLY_RECORD_REQUIRED')
    case_fields = ['label', 'status', 'actual_photos_delta', 'ui_progress', 'distinct_within_batch',
                   'operator_report', 'execution_time', 'agent_direct_device_observation']
    device_fields = ['different_from_previous_phone', 'model', 'os_name', 'os_version', 'wechat_version', 'android_base_version']
    evidence = []
    for path, digest in original['pinned_evidence'].items():
        if not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('EVIDENCE_DIGEST_REQUIRED')
        evidence.append({'name': Path(path).name, 'sha256': digest, 'availability': 'LOCAL_RAW_ARCHIVE'})
    record = {'schemaVersion': 'ltm.album-device-public-record.v1',
              'revision': original.get('record_revision', 1), 'source_main': original['source_main'],
              'preview_version': original['preview_version'], 'qr_sha256': original['qr_sha256'],
              'source_record_name': source.name, 'source_record_sha256': sha(data),
              'supersedes_source_record_sha256': original.get('supersedes_report', {}).get('sha256'),
              'recorded_at': original['recorded_at'], 'metadata_updated_at': original.get('metadata_updated_at'),
              'device': {key: original['device'].get(key, 'UNKNOWN') for key in device_fields},
              'cases': {key: {field: original['cases'][key].get(field) for field in case_fields} for key in CASES},
              'operator_statement_verbatim': original['operator_statement_verbatim'],
              'metadata_user_report_verbatim': original.get('metadata_user_report_verbatim'),
              'evidence_class': 'PASS_USER_REPORTED', 'paid_model_calls': 0,
              'boundary': 'Operator-reported phone observations. Host verification checks records/backend only; no independent device or production certification.',
              'host_evidence': evidence, 'prepared_test_window': original['prepared_test_window'],
              'prepared_window_expires_at': original['prepared_window_expires_at'],
              'operator_explicit_credential_window_confirmation': original['operator_explicit_credential_window_confirmation']}
    def cell(value):
        return str(value).replace('|', '\\|').replace('\n', ' ')
    body = '# ' + record['preview_version'] + ' 真机保存记录 · revision ' + str(record['revision']) + '\n\n'
    body += '测试代码：`' + record['source_main'] + '`。结果：5/5 PASS_USER_REPORTED（用户相册核对反馈）。本轮付费模型调用为0。\n\n'
    body += '| 检查 | 用户反馈 | 相册新增 |\n|---|---|---:|\n'
    for key in CASES:
        case = record['cases'][key]
        body += '| ' + cell(case['label']) + ' | ' + cell(case['operator_report']) + ' | ' + str(case['actual_photos_delta']) + ' |\n'
    body += '\n设备信息：`' + json.dumps(record['device'], ensure_ascii=False) + '`。UNKNOWN表示未提供；未推定Android底层版本或实际操作时间。两批各21张不同，不声称跨批次43张图案均不同。\n\n'
    body += '用户原文：\n\n> ' + cell(record['operator_statement_verbatim']) + '\n\n'
    body += '证据边界：用户实际反馈，非代理独立真机认证。`host_evidence`保存原始日志名称和SHA256，未随仓库提供的日志仍在本地原始归档。部分安全JSONL另见仓库索引。\n\n'
    body += '用配套相对路径`SHA256SUMS`验证本目录记录完整性。原始完整记录SHA256：`' + record['source_record_sha256'] + '`。\n'
    files = {'record.json': (json.dumps(record, ensure_ascii=False, indent=2) + '\n').encode(), 'report.md': body.encode()}
    forbidden = tokens(private_identities)
    if any(token in content for token in forbidden for content in files.values()):
        raise ValueError('PRIVATE_TOKEN_IN_RECORD')
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
    if (directory / 'SHA256SUMS').is_symlink():
        raise ValueError('REGULAR_MANIFEST_REQUIRED')
    lines = (directory / 'SHA256SUMS').read_text().splitlines()
    if len(lines) != 2:
        raise ValueError('MANIFEST_ENTRY_COUNT_INVALID')
    names = set()
    for line in lines:
        digest, name = line.split('  ', 1)
        if name not in ['record.json', 'report.md'] or name in names:
            raise ValueError('MANIFEST_PATH_INVALID')
        path = directory / name
        if path.is_symlink() or sha(path.read_bytes()) != digest:
            raise ValueError('RECORD_DIGEST_MISMATCH')
        names.add(name)
    record = json.loads((directory / 'record.json').read_text())
    if record.get('schemaVersion') != 'ltm.album-device-public-record.v1' or record.get('evidence_class') != 'PASS_USER_REPORTED':
        raise ValueError('PUBLIC_RECORD_BOUNDARY_REQUIRED')
    validate_cases(record['cases'])
    forbidden = tokens(private_identities)
    if any(token in path.read_bytes() for token in forbidden for path in directory.iterdir()):
        raise ValueError('PRIVATE_TOKEN_IN_RECORD')
    return {'record_integrity': 'PASS', 'case_count': len(record['cases']), 'phone_result': 'PASS_USER_REPORTED',
            'independent_device_certification': False, 'source_main': record['source_main'], 'revision': record['revision']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['export', 'verify'])
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', type=Path, required=True, help='New output directory for export, existing record directory for verify')
    parser.add_argument('--private-identity', type=Path, action='append', default=[])
    args = parser.parse_args()
    try:
        if args.mode == 'export' and not args.input:
            raise ValueError('INPUT_RECORD_REQUIRED')
        result = export_record(args.input, args.output, args.private_identity) if args.mode == 'export' else verify_record(args.output, args.private_identity)
        print(json.dumps(result))
    except Exception as error:
        parser.exit(1, 'ALBUM_RECORD_FAILED: ' + str(error) + '\n')
