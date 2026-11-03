import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createNativeAlbumServerless } from './native-album-serverless.mjs';
import { createNativeAlbumNodeEntry } from '../api/native-album.mjs';

test('real HTTP facade authenticates and delivers actual SQLite1+21 originals without extending expiry', {timeout:90000}, async () => {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const app = createNativeAlbumServerless({tokenSha256:createHash('sha256').update(token).digest('hex'), expiresAt});
  const server = createServer(async (req, res) => {
    const response = await app.handle(new Request(`http://127.0.0.1${req.url}`, {method:req.method, headers:req.headers}));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {authorization:`Bearer ${token}`, 'x-purpose':'age_transformation'};
  try {
    assert.equal((await fetch(base + '/native-album/config')).status, 401);
    assert.equal((await fetch(base + '/v1/session', {headers:{...headers, authorization:`Bearer ${randomBytes(32).toString('hex')}`}})).status, 401);
    assert.equal((await fetch(base + '/v1/session', {headers:{...headers, 'x-purpose':'commerce'}})).status, 403);
    assert.equal((await fetch(base + '/v1/session', {headers:{...headers, origin:'https://foreign.invalid'}})).status, 403);
    assert.equal((await fetch(base + '/v1/session', {headers:{...headers, cookie:'session=foreign'}})).status, 403);
    assert.equal((await fetch(base + '/v1/commands', {method:'POST', headers})).status, 404);
    assert.equal((await fetch(base + '/v1/session?token=forbidden', {headers})).status, 404);
    assert.equal((await fetch(base + '/v1/session', {headers})).status, 200);
    const configText = await (await fetch(base + '/native-album/config', {headers})).text();
    assert.equal(configText.includes(token), false);
    assert.equal(JSON.parse(configText).expiresAt, expiresAt);
    for (const [id, count] of [['single-root',1],['root',21]]) {
      const response = await fetch(`${base}/v1/timelines/${id}`, {headers}); assert.equal(response.status, 200);
      const view = (await response.json()).data; assert.equal(view.readyCount, count); assert.equal(view.expectedCount, count);
      const hashes = new Set();
      for (const node of view.nodes) {
        const image = await fetch(base + node.downloadPath, {headers}); assert.equal(image.status, 200);
        const bytes = Buffer.from(await image.arrayBuffer()); assert.equal(bytes.length, node.asset.byteLength);
        const sha = createHash('sha256').update(bytes).digest('hex'); assert.equal(sha, node.asset.sha256); hashes.add(sha);
      }
      assert.equal(hashes.size, count);
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(1, Date.parse(expiresAt) - Date.now() + 20)));
    assert.equal((await fetch(base + '/v1/session', {headers})).status, 401);
    const cold = createNativeAlbumServerless({tokenSha256:createHash('sha256').update(token).digest('hex'), expiresAt});
    assert.equal((await cold.handle(new Request('https://album-test.holiness.uk/v1/session', {headers}))).status, 401);
    await cold.close();
  } finally { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); await app.close(); }
});

test('configuration rejects missing hash and unbounded deadlines', () => {
  assert.throws(() => createNativeAlbumServerless({}), /HASH_REQUIRED/);
  const tokenSha256 = createHash('sha256').update(randomBytes(32)).digest('hex');
  assert.throws(() => createNativeAlbumServerless({tokenSha256, expiresAt:'invalid'}), /DEADLINE_INVALID/);
  assert.throws(() => createNativeAlbumServerless({tokenSha256, expiresAt:new Date(Date.now()+7200000).toISOString()}), /DEADLINE_INVALID/);
});

test('Node deployment entry serves real session and1+21 verified originals through its actual HTTP adapter', {timeout:30000}, async () => {
  const token = randomBytes(32).toString('hex');
  const entry = createNativeAlbumNodeEntry({tokenSha256:createHash('sha256').update(token).digest('hex'), expiresAt:new Date(Date.now()+60000).toISOString()});
  const server = createServer(entry.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {authorization:`Bearer ${token}`, 'x-purpose':'age_transformation'};
  try {
    assert.equal((await fetch(base + '/v1/session')).status, 401);
    assert.equal((await fetch(base + '/v1/session', {headers})).status, 200);
    assert.equal((await fetch(base + '/package.json', {headers})).status, 404);
    assert.equal((await fetch(base + '/v1/commands', {method:'POST',headers})).status, 404);
    assert.equal((await fetch(base + '/v1/session', {headers:{...headers,cookie:'foreign'}})).status, 403);
    for (const [id, count] of [['single-root',1],['root',21]]) {
      const timeline = await fetch(`${base}/v1/timelines/${id}`, {headers}); assert.equal(timeline.status, 200);
      const view = (await timeline.json()).data; assert.equal(view.readyCount, count);
      for (const node of view.nodes) {
        const image = await fetch(base + node.downloadPath, {headers}); assert.equal(image.status, 200);
        assert.equal(image.headers.get('cache-control'), 'no-store');
        const bytes = Buffer.from(await image.arrayBuffer()); assert.equal(bytes.length, node.asset.byteLength);
        assert.equal(image.headers.get('content-length'), String(bytes.length));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), node.asset.sha256);
      }
    }
  } finally { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); await entry.close(); }
});
