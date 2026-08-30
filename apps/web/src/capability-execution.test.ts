import assert from "node:assert/strict";
import test from "node:test";
import {
  StableCapabilityIdempotency,
  parseCapabilityInput,
  readBoundedJsonResponse,
  validateCapabilityExecutionResponse,
} from "./capability-execution.js";

test("capability execution input is a bounded safe JSON object", () => {
  assert.deepEqual(parseCapabilityInput('{"assetId":"asset-1","participants":["p1"]}'), {
    assetId: "asset-1", participants: ["p1"],
  });
  assert.throws(() => parseCapabilityInput("[]"), /JSON object/);
  assert.throws(() => parseCapabilityInput("{"), /valid JSON/);
  assert.throws(() => parseCapabilityInput('{"constructor":{"prototype":true}}'), /forbidden key/);
  assert.throws(() => parseCapabilityInput(`{"value":"${"x".repeat(70_000)}"}`), /64 KiB/);
});

test("same capability draft retains one idempotency key while edits rotate it", () => {
  let counter = 0;
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
  const keys = new StableCapabilityIdempotency(() => ids[counter++] ?? "00000000-0000-4000-8000-000000000003");
  const first = keys.forDraft("B25", '{"priceId":"p1"}');
  assert.equal(keys.forDraft("B25", '{"priceId":"p1"}'), first);
  assert.notEqual(keys.forDraft("B25", '{"priceId":"p2"}'), first);
  keys.reset();
  assert.notEqual(keys.forDraft("B25", '{"priceId":"p2"}'), first);
});

test("capability response binds the exact requested batch and closed metadata", () => {
  assert.deepEqual(validateCapabilityExecutionResponse("B25", {
    data: { state: "persisted" }, meta: { requestId: "request-1", batchId: "B25" },
  }), { data: { state: "persisted" }, meta: { requestId: "request-1", batchId: "B25" } });
  assert.throws(() => validateCapabilityExecutionResponse("B25", {
    data: {}, meta: { requestId: "request-1", batchId: "B26" },
  }), /invalid capability/);
  assert.throws(() => validateCapabilityExecutionResponse("B25", {
    data: {}, meta: { requestId: "request-1", batchId: "B25", accepted: true },
  }), /invalid capability/);
});

test("browser response reader rejects non-JSON and oversized streams", async () => {
  assert.deepEqual(await readBoundedJsonResponse(new Response('{"ok":true}', {
    headers: { "content-type": "application/json; charset=utf-8" },
  })), { ok: true });
  await assert.rejects(() => readBoundedJsonResponse(new Response("not-json", {
    headers: { "content-type": "text/plain" },
  })), /not JSON/);
  await assert.rejects(() => readBoundedJsonResponse(new Response(JSON.stringify({ value: "x".repeat(128) }), {
    headers: { "content-type": "application/json" },
  }), 32), /exceeds/);
});
