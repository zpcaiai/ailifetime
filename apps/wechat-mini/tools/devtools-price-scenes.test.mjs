import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, StaticTokenAuthenticator } from "../../../services/api/dist/index.js";
import { FileTimelineArtifactStore } from "../../../services/api/dist/timeline-artifacts.js";
import { timelineFixture, syntheticPng } from "../../../services/api/test/timeline-fixtures.mjs";
import { preparePriceViews } from "./devtools-price-scenes.mjs";

test("native price views use actual authenticated HTTP/SQLite scopes and create no paid generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ltm-native-prices-")), fixture = await timelineFixture(join(directory, "runtime.sqlite"));
  let server;
  try {
    const store = new FileTimelineArtifactStore(join(directory, "images")), nodes = [];
    for (let i = 0; i < 21; i++) nodes.push(await fixture.readyNode(await store.put("age-" + i, syntheticPng(i), "image/png"), i * 5));
    fixture.runtime.applyExternalBusinessEvent(fixture.service, fixture.callback("root", "succeeded", { schemaVersion: "ltm.timeline-results.v1", sourceAssetId: "source", planVersion: "age-portrait-plan.v1", aiLabel: true, nodes }));
    fixture.runtime.grantConsent(fixture.actor, { participantId: "user", grantorCapacity: "self", purpose: "age_transformation", scope: { resource: "media.asset:source", actions: ["wardrobe"] }, policyVersion: "wardrobe-edit-consent-v1", evidenceHash: "c".repeat(64), idempotencyKey: "price-consent" });
    const token = "native-price-synthetic-token";
    server = createApiServer({ runtime: fixture.runtime, capabilityRegistry: fixture.registry, timelineArtifacts: store, appEnvironment: "test", staticDirectory: null,
      authenticator: new StaticTokenAuthenticator([{ token, actorId: "user", tenantId: "tenant", roles: ["consumer"], allowedPurposes: ["age_transformation"] }]) });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = "http://127.0.0.1:" + server.address().port;
    const before = fixture.runtime.listRecords(fixture.actor, { collection: "generation.timeline-commands", limit: 200 });
    await assert.rejects(preparePriceViews({ base, headers: {} }), /401/);
    const views = await preparePriceViews({ base, headers: { authorization: "Bearer " + token, "x-purpose": "age_transformation" } });
    assert.equal(views.context.participants[0].authorized, true); assert.equal(views.series.expectedCount, 4);
    assert.deepEqual(views.lifespan.items.map(item => item.targetAge), Array.from({ length: 21 }, (_, i) => i * 5));
    assert.equal(views.age.items[0].targetAge, 37);
    assert.equal(views.lifespan.amountMinor,4990);assert.equal(views.lifespan.priceVersion,'photo-retail-cny.v3');
    assert.equal(views.albums.length,4);assert.deepEqual(views.albums.map(p=>[p.expectedCount,p.imageQuality,p.amountMinor]),[[11,'standard',1990],[21,'standard',2990],[11,'hd',2990],[21,'hd',4990]]);
    const home=await readFile(new URL('../miniprogram/pages/home/index.wxml',import.meta.url),'utf8');for(const quote of views.albums)assert.ok(home.includes('¥'+(quote.amountMinor/100).toFixed(2)));
    assert.ok(home.includes('保存 30 天'));
    for (const quote of [views.lifespan, views.age, views.series]) { assert.equal(quote.paymentState, "pending"); assert.equal(quote.checkout, null); assert.ok(quote.items.every(item => item.commandId === null)); }
    const after = fixture.runtime.listRecords(fixture.actor, { collection: "generation.timeline-commands", limit: 200 });
    assert.deepEqual(after, before);
    assert.equal(fixture.runtime.listRecords(fixture.actor, { collection: "commerce.photo-purchases", limit: 200 }).length, 6);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    fixture.runtime.close(); await rm(directory, { recursive: true, force: true });
  }
});
