import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseTimelineResultManifest, bindTimelineResultManifest } from '../dist/index.js';
const node = (age) => ({ nodeId: `age-${age}`, targetAge: age, status: 'ready', qualityResultId: `q-${age}`, safetyResultId: `s-${age}`,
  asset: { id: `image-${age}`, sha256: createHash('sha256').update(`synthetic-${age}`).digest('hex'), mimeType: 'image/png', width: 1024, height: 1024, byteLength: 1000 } });
const full = () => ({ schemaVersion: 'ltm.timeline-results.v1', sourceAssetId: 'source', planVersion: 'age-portrait-plan.v1', aiLabel: true, nodes: Array.from({ length: 21 }, (_, i) => node(i * 5)) });
test('closed 21-node result metadata is source/version/exact-age bound', () => {
  const value = full();
  assert.equal(bindTimelineResultManifest(value, { sourceAssetId: 'source', planVersion: 'age-portrait-plan.v1', targetAges: value.nodes.map(n => n.targetAge) }).nodes.length, 21);
  for (const patch of [{ sourceAssetId: 'other' }, { planVersion: 'other' }, { targetAges: [0, 5] }]) {
    assert.throws(() => bindTimelineResultManifest(value, { sourceAssetId: 'source', planVersion: 'age-portrait-plan.v1', targetAges: value.nodes.map(n => n.targetAge), ...patch }), /original plan/);
  }
});
test('duplicate ages/images, URL/authority injection and unverifiable ready nodes fail closed', () => {
  for (const change of [v => { v.nodes[1] = v.nodes[0]; }, v => { v.nodes[1].asset = v.nodes[0].asset; },
    v => { v.patch = {}; }, v => { v.nodes[0].asset.url = 'https://evil.invalid'; }, v => { delete v.nodes[0].qualityResultId; },
    v => { v.nodes[0].targetAge = NaN; }, v => { v.nodes[0].asset.byteLength = Infinity; }, v => { v.aiLabel = false; }]) {
    const value = full(); change(value); assert.throws(() => parseTimelineResultManifest(value));
  }
  const value = full(); value.nodes[0] = { nodeId: 'age-0', targetAge: 0, status: 'failed', errorCode: 'PROVIDER_TRANSIENT' };
  assert.equal(parseTimelineResultManifest(value).nodes[0].status, 'failed');
});
