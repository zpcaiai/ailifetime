import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(new URL('../package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../src/services/real-photo-upload.ts', import.meta.url), 'utf8');
const program = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function platform(path, declaredSize) {
  return {
    chooseImage: ({ success }) => success({ tempFilePaths: [path] }),
    compressImage: ({ success }) => success({ tempFilePath: path }),
    getImageInfo: ({ success }) => success({ type: 'jpeg', width: 600, height: 600 }),
    getFileSystemManager: () => ({
      getFileInfo({ filePath, digestAlgorithm, success }) {
        assert.equal(digestAlgorithm, 'sha256');
        const bytes = readFileSync(filePath);
        success({ size: declaredSize ?? bytes.length, digest: createHash('sha256').update(bytes).digest('hex') });
      },
      readFile({ filePath, position, length, success }) {
        success({ data: Uint8Array.from(readFileSync(filePath).subarray(position, position + length)).buffer });
      },
    }),
  };
}

function load(xhs) {
  const exports = {};
  runInNewContext(program, { exports, xhs, ArrayBuffer, Uint8Array });
  return exports.chooseAndUploadXhsPhoto;
}

function loadGeneration() {
  const generationSource = readFileSync(new URL('../src/services/real-photo-generation.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(generationSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(output, { exports });
  return exports;
}

test('XHS file bytes, checksum and range reach a real HTTP receiver; loss of visibility cancels', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-xhs-upload-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fixture.jpg');
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  writeFileSync(path, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ route: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    const result = req.url === '/v1/uploads' ? { uploadId: 'upload_fixture', chunkBytes: 5242880, nextOffset: 0 }
      : req.url.endsWith('/chunks') ? { nextOffset: bytes.length }
      : req.url.endsWith('/complete') ? { uploadId: 'upload_fixture', assetId: 'asset_fixture', state: 'available' }
      : { cancelled: true };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  let visible = true;
  let cancelOnChunk = false;
  const request = async (route, options) => {
    const binary = options.body instanceof ArrayBuffer;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: binary ? options.body : JSON.stringify(options.body),
    });
    if (cancelOnChunk && route.endsWith('/chunks')) visible = false;
    return response.json();
  };
  const upload = load(platform(path));
  assert.deepEqual({ ...await upload(request, 'xhs-upload-unique-key', () => visible) }, { assetId: 'asset_fixture' });
  assert.equal(JSON.parse(requests[0].body).fileDigest, digest);
  assert.deepEqual(requests[1].body, bytes);
  assert.equal(requests[1].headers['content-type'], 'application/octet-stream');
  assert.equal(requests[1].headers['content-range'], `bytes 0-${bytes.length - 1}/${bytes.length}`);
  assert.equal(requests[1].headers['x-chunk-sha256'], digest);
  assert.equal(JSON.parse(requests[2].body).fileDigest, digest);
  cancelOnChunk = true;
  await assert.rejects(upload(request, 'xhs-upload-cancel-key', () => visible), { message: 'PHOTO_UPLOAD_CANCELLED' });
  assert.deepEqual(requests.slice(3).map(row => row.route), [
    '/v1/uploads', '/v1/uploads/upload_fixture/chunks', '/v1/uploads/upload_fixture/cancel',
  ]);
  const oversized = load(platform(path, 4 * 1024 * 1024 + 1));
  await assert.rejects(oversized(() => assert.fail('oversized data reached network'), 'large-key', () => true),
    { message: 'PHOTO_SIZE_OR_DIGEST_INVALID' });
});

test('XHS sends self-consent, media intake and server quote over HTTP, and fulfills only a paid order', async t => {
  const journey = loadGeneration();
  const purchaseId = 'photo-' + '1'.repeat(64);
  const orderPath = '/v1/photo-purchases/' + purchaseId;
  const calls = [];
  let paymentState = 'pending';
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const bytes = Buffer.concat(parts);
    calls.push({ path: req.url, method: req.method, idempotency: req.headers['idempotency-key'],
      body: bytes.length ? JSON.parse(bytes) : null });
    const data = { schemaVersion: 'ltm.photo-purchase.v1', purchaseId, sku: 'selected-age', currency: 'CNY',
      amountMinor: 590, state: paymentState === 'paid' ? 'processing' : 'awaiting_payment', paymentState, readyCount: 0 };
    const response = req.url === '/v1/session' ? { session: {
      authenticationState: 'server_verified', roles: ['consumer'], actorId: 'fixture-consumer', purpose: 'age_transformation',
    } } : req.url === '/v1/capabilities/B07' ? { data: { state: 'persisted' } } : { data };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: options.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return response.json();
  };
  const actorId = await journey.verifiedPhotoActor(request);
  const input = { actorId, assetId: 'available-asset', currentAge: 34, targetAge: 62 };
  await assert.rejects(journey.createXhsPhotoPurchase(request, { ...input, currentAge: 16 }, 'quote-key', () => true),
    { message: 'PHOTO_INPUT_INVALID' });
  const order = await journey.createXhsPhotoPurchase(request, input, 'quote-key', () => true);
  assert.equal(order.amountMinor, 590);
  assert.deepEqual(calls.map(call => call.path), ['/v1/session', '/v1/commands', '/v1/capabilities/B07',
    '/v1/capabilities/B08', '/v1/photo-purchases']);
  assert.deepEqual(calls[1].body.input.scope, { resource: 'media.asset:available-asset', actions: ['ingest', 'transform'] });
  assert.equal(calls[1].body.input.participantId, actorId);
  assert.deepEqual(calls[4].body.generation.targetAges, [62]);
  assert.equal(calls[4].body.amountMinor, undefined);
  assert.equal(calls[4].idempotency, 'quote-key-purchase');
  await assert.rejects(journey.fulfillXhsPhotoPurchase(request, purchaseId), { message: 'PHOTO_PAYMENT_NOT_CONFIRMED' });
  assert.equal(calls.at(-1).path, orderPath);
  assert.ok(calls.every(call => !call.path.endsWith('/fulfill')));
  paymentState = 'paid';
  assert.equal((await journey.fulfillXhsPhotoPurchase(request, purchaseId)).state, 'processing');
  assert.deepEqual(calls.slice(-2).map(call => [call.method, call.path]), [
    ['GET', orderPath], ['POST', orderPath + '/fulfill'],
  ]);
});
