import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createNativeAlbumNodeEntry } from '../api/native-album.mjs';

const run = promisify(execFile);
test('curl transport verifies real TLS/SQLite originals, retains private process receipts and rejects unsafe transitions', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'album-curl-'));
  const token = randomBytes(32).toString('hex'), oldToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 120000).toISOString();
  const entry = createNativeAlbumNodeEntry({ tokenSha256: createHash('sha256').update(token).digest('hex'), expiresAt });
  const cert = join(directory, 'ca.pem'), key = join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  let redirect = false, trapHits = 0;
  const server = https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    if (req.url === '/redirect-trap') { trapHits++; res.end(); return; }
    if (redirect) { res.writeHead(302, { location: '/redirect-trap' }); res.end(); return; }
    entry.handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://localhost:${server.address().port}`;
  const current = join(directory, 'current.json'), previous = join(directory, 'previous.json');
  writeFileSync(current, JSON.stringify({ accessToken: token, expiresAt }), { mode: 0o600 });
  writeFileSync(previous, JSON.stringify({ accessToken: oldToken, expiresAt }), { mode: 0o600 });
  const argumentsFor = name => ['tools/native-album-curl-check.py', '--origin', origin, '--identity', current, '--previous-identity', previous, '--capture-directory', join(directory, name), '--ca-file', cert];
  try {
    const { stdout } = await run('python3', argumentsFor('good'));
    const result = JSON.parse(stdout);
    assert.equal(result.tlsValidation, true); assert.equal(result.nativePhone, 'NOT_RUN');
    assert.equal(result.verified['single-root'].downloaded, 1); assert.equal(result.verified.root.downloaded, 21);
    assert.equal(new Set(result.verified.root.unique_sha256).size, 21); assert.equal(result.rejected_previous_identities, 1);
    assert.equal(result.actual_child_processes, 33); assert.equal(result.failed_connection_attempts_retained, 0);
    const receiptReadback = JSON.parse((await run('python3', ['tools/native-album-curl-receipts.py', '--capture-directory', join(directory, 'good')])).stdout);
    assert.equal(receiptReadback.receipt_integrity, 'PASS');
    assert.equal(receiptReadback.successful_requests, 33); assert.equal(receiptReadback.preserved_failed_attempts, 0);
    assert.equal(receiptReadback.custom_ca_requests, 33); assert.equal(receiptReadback.verified_pngs, 22);
    assert.ok(!stdout.includes(token) && !stdout.includes(oldToken));
    assert.equal(statSync(join(directory, 'good')).mode & 0o777, 0o700);
    const files = readdirSync(join(directory, 'good'));
    for (const name of files) assert.equal(statSync(join(directory, 'good', name)).mode & 0o777, 0o600);
    const events = files.filter(name => name.endsWith('.event.json')).map(name => JSON.parse(readFileSync(join(directory, 'good', name))));
    assert.equal(events.length, 33); assert.ok(events.every(event => event.pid > 0 && event.executed && event.exit_code === 0));
    assert.ok(events.every(event => event.command.includes('--no-insecure') && !event.command.includes('-k') && !JSON.stringify(event).includes(token)));
    await assert.rejects(run('python3', argumentsFor('good')), error => /CAPTURE_DIRECTORY_MUST_BE_NEW/.test(error.stderr));
    assert.equal(readdirSync(join(directory, 'good')).length, files.length);
    await assert.rejects(run('python3', argumentsFor('untrusted').slice(0, -2)), error => /CURL_FAILED/.test(error.stderr));
    const rejected = readdirSync(join(directory, 'untrusted')).filter(name => name.endsWith('.event.json'));
    assert.equal(rejected.length, 1);
    assert.equal(JSON.parse(readFileSync(join(directory, 'untrusted', rejected[0]))).exit_code, 60);
    chmodSync(current, 0o644);
    await assert.rejects(run('python3', argumentsFor('public-identity')), error => /PRIVATE_IDENTITY_REQUIRED/.test(error.stderr));
    chmodSync(current, 0o600);
    symlinkSync(join(directory, 'good'), join(directory, 'capture-link'));
    await assert.rejects(run('python3', argumentsFor('capture-link')), error => /CAPTURE_DIRECTORY_MUST_BE_NEW/.test(error.stderr));
    redirect = true;
    await assert.rejects(run('python3', argumentsFor('redirect')), error => /REDIRECT_FORBIDDEN/.test(error.stderr));
    assert.equal(trapHits, 0);
  } finally {
    server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); await entry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
