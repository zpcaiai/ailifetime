import assert from "node:assert/strict";
import test from "node:test";
import { MobileApiClient } from "./api-client";
import type { RuntimeConfig } from "./runtime";

const config = {
  appEnvironment: "test",
  apiOrigin: "https://api.example.test",
  apiHost: "api.example.test",
  oidcIssuer: "https://id.example.test/",
  oidcClientId: "mobile-client",
  remoteConfigPublicKey: "A".repeat(44),
  remoteConfigDocument: "{\"schemaVersion\":\"ltm.mobile.remote-config.v1\",\"revision\":1}",
  remoteConfigSignature: "A".repeat(86) + "==",
  apiPrimaryPins: ["A".repeat(43) + "="],
  apiBackupPins: ["B".repeat(43) + "="],
  pinValidFrom: "2026-01-01T00:00:00.000Z",
  pinValidUntil: "2030-01-01T00:00:00.000Z",
  projectId: "project-12345678",
  appVersion: "2.0.0",
} satisfies RuntimeConfig;

const tokens = { accessToken: async () => "access-token-1234567890", invalidate: async () => undefined };

test("binary requests carry exact resumable-upload headers and unencoded bytes", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit | undefined } | undefined;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ nextOffset: 3 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new MobileApiClient(config, tokens);
    const bytes = new Uint8Array([97, 98, 99]);
    assert.deepEqual(await client.request("/v1/uploads/upload-1/chunks", {
      purpose: "age_transformation",
      idempotencyKey: "mobile-upload:chunk:0001",
      binaryBody: bytes,
      contentRange: "bytes 0-2/3",
      contentSha256: "a".repeat(64),
    }), { nextOffset: 3 });
    assert.equal(captured?.url, "https://api.example.test/v1/uploads/upload-1/chunks");
    const headers = captured?.init?.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/octet-stream");
    assert.equal(headers["Content-Range"], "bytes 0-2/3");
    assert.equal(headers["X-Chunk-Sha256"], "a".repeat(64));
    assert.deepEqual([...new Uint8Array(captured?.init?.body as ArrayBuffer)], [...bytes]);
  } finally { globalThis.fetch = originalFetch; }
});

test("query unwraps only the authenticated API data envelope", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ id: "job-1" }],
    meta: { requestId: "request-12345678", query: "record.list" },
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const client = new MobileApiClient(config, tokens);
    assert.deepEqual(await client.query("record.list", { collection: "generation.timeline-commands", limit: 50 }, "age_transformation"), [{ id: "job-1" }]);
  } finally { globalThis.fetch = originalFetch; }
});

test("client rejects malformed binary ranges and malformed envelopes before trust", async () => {
  const client = new MobileApiClient(config, tokens);
  await assert.rejects(client.request("/v1/uploads/upload-1/chunks", {
    purpose: "age_transformation",
    idempotencyKey: "mobile-upload:chunk:0002",
    binaryBody: new Uint8Array([1, 2, 3]),
    contentRange: "bytes 0-1/3",
    contentSha256: "a".repeat(64),
  }), /API_CONTENT_RANGE_INVALID/);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [], requestId: "request-12345678" }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  try {
    await assert.rejects(client.query("record.list", { collection: "generation.timeline-commands" }, "age_transformation"), /API_ENVELOPE_INVALID/);
  } finally { globalThis.fetch = originalFetch; }
});
