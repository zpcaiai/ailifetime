"""Serialized receipt fixtures test the reader; actual TLS integration is in native-album-curl-check.test.mjs."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib


class CurlReceiptIntegrity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = Path(__file__).with_name('native-album-curl-receipts.py')
        spec = importlib.util.spec_from_file_location('receipt_reader', cls.script)
        cls.tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.tool)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='album-receipt-reader-')
        self.root = Path(self.temp.name)
        self.capture = self.root / 'capture'; self.capture.mkdir(mode=0o700)
        self.events = []
        self.hashes = []
        for number in range(33):
            logical = max(0, number - 1)
            body = self.png(logical) if logical >= 10 else b'{"serialization_fixture":true}'
            if logical >= 10:
                self.hashes.append(self.sha(body))
            command = ['curl','-q','--silent','--show-error','--no-insecure','--proto','=https',
                '--connect-timeout','10','--max-time','40','--max-filesize','4194304','--header',
                '@' + str(self.capture / f'{number}.headers'),'--output',str(self.capture / f'{number}.body'),
                '--write-out','%{http_code} %{ssl_verify_result}',f'https://example.invalid/fixture/{logical}']
            event = {'command':command,'attempt':1 if number == 1 else 0,'executed':True,
                     'pid':os.getpid(),'exit_code':35 if number == 0 else 0}
            body = b'' if number == 0 else body
            stdout = b'000 0' if number == 0 else b'200 0'
            self.write(f'{number}.headers', b'X-Serialization-Fixture: true\n')
            self.write(f'{number}.body', body); self.write(f'{number}.stdout', stdout)
            self.write(f'{number}.stderr', b'fixture handshake failure' if number == 0 else b'')
            event.update(body_sha256=self.sha(body), metadata_sha256=self.sha(stdout))
            self.write(f'{number}.event.json', json.dumps(event).encode())
            self.events.append(event)
        self.summary = {'origin':'https://example.invalid','transport':'ACTUAL_CURL_VERIFIED_HTTPS',
            'tlsValidation':True,'nativePhone':'NOT_RUN','paidModelCalls':0,'actual_child_processes':33,
            'failed_connection_attempts_retained':1,'rejected_previous_identities':0,
            'verified':{'single-root':{'downloaded':1,'unique_sha256':self.hashes[:1]},
                        'root':{'downloaded':21,'unique_sha256':self.hashes[1:]}}}
        self.write('summary.json', json.dumps(self.summary).encode())

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def sha(data):
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def png(number):
        def chunk(kind, data):
            return struct.pack('>I',len(data)) + kind + data + struct.pack('>I',zlib.crc32(kind + data))
        ihdr = struct.pack('>IIBBBBB',512,512,8,2,0,0,0)
        pixels = (b'\0' + bytes([number,0,0]) * 512) * 512
        return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR',ihdr) + chunk(b'IDAT',zlib.compress(pixels)) + chunk(b'IEND',b'')

    def write(self, name, body):
        p = self.capture / name; p.write_bytes(body); p.chmod(0o600)

    def event(self, number, change):
        value = copy.deepcopy(self.events[number]); change(value)
        self.write(f'{number}.event.json',json.dumps(value).encode())

    def test_reader_and_cli_preserve_failure_and_evidence_boundary(self):
        result = self.tool.verify(self.capture)
        self.assertEqual((result['actual_process_receipts'],result['successful_requests']), (33,32))
        self.assertEqual(result['failed_exit_codes'],[35]); self.assertEqual(result['verified_pngs'],22)
        self.assertIn('NO_NEW_NETWORK_OR_PHONE_EXECUTION',result['boundary'])
        child = subprocess.run([sys.executable,str(self.script),'--capture-directory',str(self.capture)],capture_output=True,text=True)
        self.assertEqual(child.returncode,0,child.stderr)
        self.assertEqual(json.loads(child.stdout),result)
        self.assertNotIn(str(self.capture),child.stdout)

    def test_digest_and_rehashed_tls_metadata_forgery_are_rejected(self):
        body = self.capture / '1.body'; before = body.read_bytes(); body.write_bytes(before + b' ')
        with self.assertRaisesRegex(ValueError,'CAPTURE_DIGEST_MISMATCH'):self.tool.verify(self.capture)
        body.write_bytes(before)
        for metadata in [b'200 1',b'302 0',b'500 0']:
            self.write('1.stdout',metadata)
            self.event(1,lambda e:e.update(metadata_sha256=self.sha(metadata)))
            with self.assertRaisesRegex(ValueError,'VERIFIED_TLS_STATUS_REQUIRED'):self.tool.verify(self.capture)

    def test_retry_requires_allowed_failure_same_headers_and_successful_successor(self):
        self.event(0,lambda e:e.update(exit_code=7))
        with self.assertRaisesRegex(ValueError,'BOUNDED_CONNECTION_RETRY_REQUIRED'):self.tool.verify(self.capture)
        self.event(0,lambda e:e.update(exit_code=35))
        self.write('1.headers',b'X-Serialization-Fixture: changed\n')
        with self.assertRaisesRegex(ValueError,'RECOVERED_RETRY_REQUIRED'):self.tool.verify(self.capture)

    def test_protocol_paths_process_counts_and_private_permissions_are_enforced(self):
        mutations=[(lambda e:e['command'].append('--insecure'),'CANONICAL_CURL_GET_REQUIRED'),
                   (lambda e:e['command'].__setitem__(-1,'https://foreign.invalid/'),'SAME_ORIGIN_GET_REQUIRED'),
                   (lambda e:e['command'].__setitem__(14,'@outside.headers'),'CAPTURE_COMMAND_PATH_MISMATCH'),
                   (lambda e:e.update(pid=True),'EXECUTED_PROCESS_RECEIPT_REQUIRED')]
        for change, code in mutations:
            self.event(1,change)
            with self.assertRaisesRegex(ValueError,code):self.tool.verify(self.capture)
        self.event(1,lambda e:None)
        self.summary['actual_child_processes']=True;self.write('summary.json',json.dumps(self.summary).encode())
        with self.assertRaisesRegex(ValueError,'INTEGER_PROCESS_COUNTS_REQUIRED'):self.tool.verify(self.capture)
        self.summary['actual_child_processes']=33;self.write('summary.json',json.dumps(self.summary).encode())
        (self.capture/'0.headers').chmod(0o644)
        with self.assertRaisesRegex(ValueError,'BOUNDED_PRIVATE_FILE_REQUIRED'):self.tool.verify(self.capture)

    def test_symlinks_extra_files_and_image_digest_drift_are_rejected(self):
        self.write('unexpected',b'anything')
        with self.assertRaisesRegex(ValueError,'EXACT_CAPTURE_INVENTORY_REQUIRED'):self.tool.verify(self.capture)
        (self.capture/'unexpected').unlink()
        path=self.capture/'0.headers';path.rename(self.root/'headers');path.symlink_to(self.root/'headers')
        with self.assertRaises(OSError):self.tool.verify(self.capture)
        path.unlink();(self.root/'headers').rename(path)
        self.summary['verified']['root']['unique_sha256'][0]='f'*64
        self.write('summary.json',json.dumps(self.summary).encode())
        with self.assertRaisesRegex(ValueError,'CAPTURED_IMAGE_DIGESTS_MISMATCH'):self.tool.verify(self.capture)


if __name__ == '__main__':
    unittest.main()
