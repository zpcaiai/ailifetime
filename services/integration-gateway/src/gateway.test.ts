import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { canonicalBusinessClaimsSha256, canonicalBusinessEventSha256 } from "@ltm/core";
import {
  ProductionIntegrationError,
  capabilityEvidenceScope,
  type CallbackDeliveryLease,
  type CallbackDeliveryStateStore,
  type SignedCapabilityEvidence,
} from "@ltm/providers";
import { createIntegrationGatewayServer, type GatewayCallbackHandler } from "./gateway.js";

const fakeBinding = {
  tenantId: "tenant-1",
  batchId: "B66",
  operation: "verifyStoreTransaction",
  kind: "store-transaction",
  provider: "google-play",
  artifactSha256: "a".repeat(64),
  environment: "test",
  subjectId: "gplay:transaction-1",
} as const;
const fakeClaims = { accountId: "account-1", productId: "life.yearly", transactionId: "gplay:transaction-1" };
const fakeClaimsSha256 = canonicalBusinessClaimsSha256(fakeClaims);
const fakeEventWithoutDigest = {
  version: "ltm.external-business-event.v1" as const,
  eventId: "provider-event-1",
  tenantId: "tenant-1",
  batchId: "B66" as const,
  operation: "verifyStoreTransaction",
  provider: "google-play",
  subjectType: "account",
  subjectId: "account-1",
  eventType: "entitlement.granted",
  providerOccurredAt: new Date().toISOString(),
  sequence: 1,
  correlationId: "gplay:transaction-1",
  artifactSha256: "a".repeat(64),
  evidenceId: "evidence-1",
  evidenceScope: capabilityEvidenceScope(fakeBinding),
  canonicalClaims: fakeClaims,
  canonicalClaimsSha256: fakeClaimsSha256,
};
const fakeBusinessEvent = {
  ...fakeEventWithoutDigest,
  businessEventSha256: canonicalBusinessEventSha256(fakeEventWithoutDigest),
};
const fakeEvidence = {
  version: "ltm.external-evidence.v1",
  evidenceId: "evidence-1",
  tenantId: "tenant-1",
  binding: fakeBinding,
  scope: capabilityEvidenceScope(fakeBinding),
  issuer: "test:gateway",
  provider: "google-play",
  artifactSha256: "a".repeat(64),
  canonicalClaimsSha256: fakeClaimsSha256,
  businessEventSha256: fakeBusinessEvent.businessEventSha256,
  issuedAt: new Date(Date.now() - 1_000).toISOString(),
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  nonce: "gateway-test-nonce-1",
  replayPolicy: "single_use",
  algorithm: "Ed25519",
  keyId: "test-key-1",
  signature: "test-signature-non-empty",
} satisfies SignedCapabilityEvidence;

class MemoryCallbackState implements CallbackDeliveryStateStore {
  readonly values = new Map<string, { state: "processing" | "delivering" | "ready" | "completed"; leaseId: string; payload?: Buffer }>();
  nextLease = 0;
  async begin(namespace: string, fingerprint: string) {
    const key = `${namespace}:${fingerprint}`;
    const current = this.values.get(key);
    if (current?.state === "completed") return { state: "completed" as const };
    if (current?.state === "processing" || current?.state === "delivering") return { state: "busy" as const };
    const leaseId = `00000000-0000-0000-0000-${String(++this.nextLease).padStart(12, "0")}`;
    const lease = { key, leaseId };
    if (current?.state === "ready" && current.payload !== undefined) {
      this.values.set(key, { state: "delivering", leaseId, payload: current.payload });
      return { state: "deliver" as const, lease, payload: current.payload };
    }
    this.values.set(key, { state: "processing", leaseId });
    return { state: "process" as const, lease };
  }
  async stageForDelivery(lease: CallbackDeliveryLease, payload: Uint8Array) {
    this.values.set(lease.key, { state: "delivering", leaseId: lease.leaseId, payload: Buffer.from(payload) });
  }
  async releaseForRetry(lease: CallbackDeliveryLease, payload: Uint8Array) {
    this.values.set(lease.key, { state: "ready", leaseId: lease.leaseId, payload: Buffer.from(payload) });
  }
  async complete(lease: CallbackDeliveryLease) {
    this.values.set(lease.key, { state: "completed", leaseId: lease.leaseId });
  }
  async abandon(lease: CallbackDeliveryLease) { this.values.delete(lease.key); }
  isReady() { return true; }
  async close() {}
}

test("gateway preserves exact raw bytes, emits evidence internally, and exposes health checks", async (t) => {
  const exact = Buffer.from("{\n  \"signedPayload\" : \"opaque.payload.signature\"\n}\n", "utf8");
  let observed: Buffer | undefined;
  let published = 0;
  const handler: GatewayCallbackHandler = {
    async process(request) {
      observed = Buffer.from(request.rawBody);
      return {
        disposition: "attested",
        providerEventId: "provider-event-1",
        evidence: fakeEvidence,
        businessEvent: fakeBusinessEvent,
        receipt: { state: "verified" },
      };
    },
  };
  const server = createIntegrationGatewayServer({
    tenantId: "tenant-1",
    routes: new Map([["/v1/callbacks/apple", handler]]),
    evidenceOutput: { async publish() { published += 1; } },
    callbackState: new MemoryCallbackState(),
    bodyLimitBytes: 1_048_576,
    readiness: async () => ({ ready: true, checks: { replayStore: true } }),
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const callback = await fetch(`${base}/v1/callbacks/apple`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: exact,
  });
  assert.equal(callback.status, 204);
  assert.equal(callback.headers.get("strict-transport-security"), "max-age=63072000; includeSubDomains");
  assert.equal(callback.headers.get("x-content-type-options"), "nosniff");
  assert.equal(callback.headers.get("x-frame-options"), "DENY");
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(observed, exact);
  assert.equal(published, 1);
  const live = await fetch(`${base}/health/live`);
  const ready = await fetch(`${base}/health/ready`);
  assert.equal(live.status, 200);
  assert.equal(ready.status, 200);
  assert.equal(live.headers.get("strict-transport-security"), "max-age=63072000; includeSubDomains");
  assert.equal(ready.headers.get("x-content-type-options"), "nosniff");
  assert.equal(ready.headers.get("x-frame-options"), "DENY");
  assert.equal(ready.headers.get("referrer-policy"), "no-referrer");
});

test("gateway rejects unsigned, replayed, rewritten-route, and oversized callbacks", async (t) => {
  let mode: "signature" | "replay" = "signature";
  const server = createIntegrationGatewayServer({
    tenantId: "tenant-1",
    routes: new Map([["/v1/callbacks/partners/tax", {
      maximumBodyBytes: 32,
      async process() {
        throw new ProductionIntegrationError(
          mode === "signature" ? "PROVIDER_SIGNATURE_INVALID" : "PROVIDER_REPLAY_DETECTED",
          "rejected",
        );
      },
    }]]),
    evidenceOutput: { async publish() { throw new Error("must not publish"); } },
    callbackState: new MemoryCallbackState(),
    bodyLimitBytes: 1_024,
    readiness: async () => ({ ready: false, checks: { replayStore: false } }),
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const route = `http://127.0.0.1:${address.port}/v1/callbacks/partners/tax`;
  const send = (url = route, body = "{}") => fetch(url, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  assert.equal((await send()).status, 401);
  mode = "replay";
  assert.equal((await send()).status, 409);
  assert.equal((await send(`${route}?tenantId=attacker`)).status, 400);
  assert.equal((await send(route, JSON.stringify({ payload: "x".repeat(64) }))).status, 413);
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/health/ready`)).status, 503);
});

test("gateway retries cached evidence after API 503 without repeating provider work", async (t) => {
  let providerCalls = 0;
  let sinkCalls = 0;
  const server = createIntegrationGatewayServer({
    tenantId: "tenant-1",
    routes: new Map([["/v1/callbacks/google-play", {
      async process() {
        providerCalls += 1;
        return {
          disposition: "attested" as const,
          providerEventId: "google-message-retry-1",
          evidence: fakeEvidence,
          businessEvent: fakeBusinessEvent,
          receipt: { state: "verified" },
        };
      },
    }]]),
    callbackState: new MemoryCallbackState(),
    evidenceOutput: {
      async publish() {
        sinkCalls += 1;
        if (sinkCalls === 1) throw new ProductionIntegrationError("PROVIDER_REJECTED", "synthetic API 503", true);
      },
    },
    bodyLimitBytes: 1_024,
    readiness: async () => ({ ready: true, checks: { callbackState: true } }),
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/callbacks/google-play`;
  const send = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"event\":1}" });
  assert.equal((await send()).status, 503);
  assert.equal((await send()).status, 204);
  assert.equal(providerCalls, 1);
  assert.equal(sinkCalls, 2);
});

test("gateway discards an expired cached envelope and re-verifies the callback", async (t) => {
  let now = Date.now();
  let providerCalls = 0;
  let sinkCalls = 0;
  const server = createIntegrationGatewayServer({
    tenantId: "tenant-1",
    routes: new Map([["/v1/callbacks/google-play", {
      async process() {
        providerCalls += 1;
        return {
          disposition: "attested" as const,
          providerEventId: "google-message-expiry-1",
          evidence: {
            ...fakeEvidence,
            issuedAt: new Date(now - 1_000).toISOString(),
            expiresAt: new Date(now + 60_000).toISOString(),
            nonce: `gateway-expiry-nonce-${providerCalls}`,
          },
          businessEvent: fakeBusinessEvent,
          receipt: { state: "verified" },
        };
      },
    }]]),
    callbackState: new MemoryCallbackState(),
    evidenceOutput: {
      async publish() {
        sinkCalls += 1;
        if (sinkCalls === 1) throw new ProductionIntegrationError("PROVIDER_REJECTED", "synthetic API 503", true);
      },
    },
    bodyLimitBytes: 1_024,
    readiness: async () => ({ ready: true, checks: { callbackState: true } }),
    clock: () => new Date(now),
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/callbacks/google-play`;
  const send = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"event\":3}" });

  assert.equal((await send()).status, 503);
  now += 61_000;
  assert.equal((await send()).status, 204);
  assert.equal(providerCalls, 2);
  assert.equal(sinkCalls, 2);
});

test("gateway rejects and clears a corrupted cached envelope before allowing re-verification", async (t) => {
  let providerCalls = 0;
  let sinkCalls = 0;
  const callbackState = new MemoryCallbackState();
  const logEntries: Readonly<Record<string, unknown>>[] = [];
  const server = createIntegrationGatewayServer({
    tenantId: "tenant-1",
    routes: new Map([["/v1/callbacks/apple", {
      async process() {
        providerCalls += 1;
        return {
          disposition: "attested" as const,
          providerEventId: "apple-message-corruption-1",
          evidence: { ...fakeEvidence, nonce: `corruption-nonce-${providerCalls}` },
          businessEvent: fakeBusinessEvent,
          receipt: { state: "verified" },
        };
      },
    }]]),
    callbackState,
    evidenceOutput: {
      async publish() {
        sinkCalls += 1;
        if (sinkCalls === 1) throw new ProductionIntegrationError("PROVIDER_REJECTED", "synthetic API 503", true);
      },
    },
    bodyLimitBytes: 1_024,
    readiness: async () => ({ ready: true, checks: { callbackState: true } }),
    logger(entry) { logEntries.push(entry); },
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/callbacks/apple`;
  const send = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"event\":4}" });

  assert.equal((await send()).status, 503);
  const cached = [...callbackState.values.values()][0];
  assert.equal(cached?.state, "ready");
  assert.ok(cached?.payload !== undefined);
  const tampered = JSON.parse(cached.payload.toString("utf8")) as { evidence: { signature: string } };
  tampered.evidence.signature = "";
  cached.payload = Buffer.from(JSON.stringify(tampered));

  assert.equal((await send()).status, 400);
  assert.equal(callbackState.values.size, 0);
  assert.ok(logEntries.some((entry) => entry.event === "callback.rejected" && entry.code === "PROVIDER_RESPONSE_INVALID"));
  assert.equal((await send()).status, 204);
  assert.equal(providerCalls, 2);
  assert.equal(sinkCalls, 2);
});

test("gateway callback lease prevents concurrent provider verification", async (t) => {
  let providerCalls = 0;
  let releaseHandler: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  let handlerStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
  const server = createIntegrationGatewayServer({
    tenantId: "tenant-1",
    routes: new Map([["/v1/callbacks/apple", {
      async process() {
        providerCalls += 1;
        handlerStarted?.();
        await entered;
        return { disposition: "ignored" as const, providerEventId: "apple-event-concurrent-1" };
      },
    }]]),
    callbackState: new MemoryCallbackState(),
    evidenceOutput: { async publish() {} },
    bodyLimitBytes: 1_024,
    readiness: async () => ({ ready: true, checks: { callbackState: true } }),
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/callbacks/apple`;
  const send = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"event\":2}" });
  const first = send();
  await started;
  assert.equal((await send()).status, 503);
  releaseHandler?.();
  assert.equal((await first).status, 204);
  assert.equal(providerCalls, 1);
});
