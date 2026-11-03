import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeAlbumService } from './native-album-api.mjs';

test('real isolated SQLite/API delivers one and21 integrity-bound test images with expiring authentication', {timeout:15000}, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ltm-native-album-'));
  let service;
  try {
    service = await createNativeAlbumService({ directory: join(parent, 'service'), syntheticTestImages: true, lifetimeSeconds: 3 });
    const address = await service.listen(0);
    const base = `http://127.0.0.1:${address.port}`;
    const headers = {authorization: `Bearer ${service.identity.accessToken}`, 'x-purpose': 'age_transformation'};
    assert.equal((await fetch(base + '/native-album/config')).status, 401);
    assert.equal((await fetch(base + '/native-album/config', {headers: {...headers, 'x-purpose': 'commerce'}})).status, 403);
    const config = await (await fetch(base + '/native-album/config', {headers})).json();
    assert.equal(config.fixtureKind, 'synthetic-album-transport-only');
    assert.equal(config.expiresAt, service.identity.expiresAt);
    assert.equal(config.commands.single, 'single-root'); assert.equal(config.commands.batch, 'root');
    assert.equal('accessToken' in config, false);
    assert.equal((await fetch(base + '/v1/session', {headers})).status, 200);
    assert.equal((await fetch(base + '/v1/commands', {method:'POST', headers})).status, 404);
    assert.equal((await fetch(base + '/v1/timelines/other', {headers})).status, 404);
    assert.equal((await fetch(base + '/v1/timelines/root', {headers: {...headers, origin:'https://foreign.invalid'}})).status, 403);
    for (const [id, count] of [['single-root', 1], ['root', 21]]) {
      const response = await fetch(`${base}/v1/timelines/${id}`, {headers});
      assert.equal(response.status, 200);
      const view = (await response.json()).data; assert.equal(view.expectedCount, count); assert.equal(view.readyCount, count);
      const digests = new Set();
      for (const node of view.nodes) {
        const image = await fetch(base + node.downloadPath, {headers}); assert.equal(image.status, 200);
        const bytes = Buffer.from(await image.arrayBuffer());
        assert.equal(bytes.length, node.asset.byteLength);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), node.asset.sha256);
        digests.add(node.asset.sha256);
      }
      assert.equal(digests.size, count);
    }
    assert.equal(statSync(join(parent, 'service/identity.json')).mode & 0o077, 0);
    assert.equal(statSync(join(parent, 'service/runtime.sqlite')).size > 0, true);
    assert.equal(JSON.parse(readFileSync(join(parent, 'service/manifest.json'))).nativeAcceptance, 'NOT_RUN');
    await new Promise(resolve => setTimeout(resolve, Math.max(1, Date.parse(service.identity.expiresAt) - Date.now() + 20)));
    assert.equal((await fetch(base + '/native-album/config', {headers})).status, 401);
    assert.equal((await fetch(base + '/v1/timelines/root', {headers})).status, 401);
  } finally { if (service) await service.close(); rmSync(parent, {recursive:true, force:true}); }
});

test('service requires explicit synthetic-image scope and a new isolated directory', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ltm-native-scope-'));
  try {
    await assert.rejects(createNativeAlbumService({directory: join(parent, 'none')}), /EXPLICIT_SYNTHETIC_TEST_IMAGES_REQUIRED/);
    await assert.rejects(createNativeAlbumService({directory: parent, syntheticTestImages:true}), /OUTPUT_MUST_NOT_EXIST/);
    await assert.rejects(createNativeAlbumService({directory: 'relative', syntheticTestImages:true}), /ABSOLUTE_OUTPUT_REQUIRED/);
  } finally { rmSync(parent, {recursive:true, force:true}); }
});
