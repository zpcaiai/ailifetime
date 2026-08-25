import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeMobileDeepLink,
  MobileCapabilityError,
  MobileHttpApiClient,
  MobileOfflineQueue,
  MobileStorePurchaseCoordinator,
  preflightMobileCapture,
  type SecureStorage,
} from "./index.js";

class MemoryStorage implements SecureStorage {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

const OFFLINE_NOW = new Date("2026-02-01T00:00:00.000Z");
const offlineOptions = { now: () => new Date(OFFLINE_NOW) } as const;

function offlineCommand(id: string) {
  return {
    id,
    batchId: "B64",
    idempotencyKey: `idem-${id}`,
    payload: {},
    createdAt: "2026-02-01T00:00:00.000Z",
    expiresAt: "2026-02-02T00:00:00.000Z",
  };
}

test("deep links reject authority and policy assertions", () => {
  assert.equal(authorizeMobileDeepLink("https://app.example.test/library", ["app.example.test"]).path, "/library");
  assert.throws(() => authorizeMobileDeepLink("https://evil.example/library", ["app.example.test"]), /origin/);
  assert.throws(() => authorizeMobileDeepLink("https://app.example.test/library?role=admin", ["app.example.test"]), /role/);
});

test("offline queue deduplicates and preserves failed commands", async () => {
  const storage = new MemoryStorage();
  const queue = new MobileOfflineQueue(storage, undefined, offlineOptions);
  await queue.activate({ tenantId: "tenant-1", actorId: "actor-1" });
  const command = offlineCommand("one");
  await queue.enqueue(command);
  await queue.enqueue(command);
  const outcome = await queue.flush({ execute: async () => { throw new Error("offline"); } } as never, OFFLINE_NOW);
  assert.deepEqual(outcome, { sent: [], retained: ["one"], dropped: [] });
});

test("offline queue refuses sensitive or non-allowlisted work and drops permanent failures", async () => {
  const storage = new MemoryStorage();
  const queue = new MobileOfflineQueue(storage, undefined, offlineOptions);
  await queue.activate({ tenantId: "tenant-1", actorId: "actor-1" });
  await assert.rejects(queue.enqueue({
    id: "pay", batchId: "B66", idempotencyKey: "idem-pay", payload: {},
    createdAt: "2026-02-01T00:00:00.000Z", expiresAt: "2026-02-02T00:00:00.000Z",
  }), /not permitted/);
  await assert.rejects(queue.enqueue({
    id: "media", batchId: "B64", idempotencyKey: "idem-media", payload: { rawMedia: "secret" },
    createdAt: "2026-02-01T00:00:00.000Z", expiresAt: "2026-02-02T00:00:00.000Z",
  }), /prohibited/);
  await queue.enqueue({
    id: "safe", batchId: "B64", idempotencyKey: "idem-safe", payload: { uploadSessionId: "upload-1" },
    createdAt: "2026-02-01T00:00:00.000Z", expiresAt: "2026-02-02T00:00:00.000Z",
  });
  assert.deepEqual(await queue.flush({ execute: async () => {
    throw new MobileCapabilityError("AUTH_FORBIDDEN", "denied", false);
  } }, OFFLINE_NOW), {
    sent: [], retained: [], dropped: [{ id: "safe", reason: "permanent" }],
  });
});

test("offline queue fails closed across account changes and missing server authorization", async () => {
  const storage = new MemoryStorage();
  const queue = new MobileOfflineQueue(storage, undefined, offlineOptions);
  await assert.rejects(queue.enqueue({
    id: "unbound", batchId: "B64", idempotencyKey: "idem-unbound", payload: {},
    createdAt: "2026-02-01T00:00:00.000Z", expiresAt: "2026-02-02T00:00:00.000Z",
  }), /server-verified authorization binding/);
  await queue.activate({ tenantId: "tenant-1", actorId: "actor-1" });
  await queue.enqueue({
    id: "first-account", batchId: "B64", idempotencyKey: "idem-first-account", payload: {},
    createdAt: "2026-02-01T00:00:00.000Z", expiresAt: "2026-02-02T00:00:00.000Z",
  });
  await queue.activate({ tenantId: "tenant-1", actorId: "actor-2" });
  let executions = 0;
  assert.deepEqual(await queue.flush({ execute: async () => { executions += 1; } } as never, OFFLINE_NOW), {
    sent: [], retained: [], dropped: [],
  });
  assert.equal(executions, 0);
});

test("offline queue enforces closed command keys and exact time boundaries", async () => {
  const storage = new MemoryStorage();
  const queue = new MobileOfflineQueue(storage, undefined, offlineOptions);
  await queue.activate({ tenantId: "tenant-1", actorId: "actor-1" });

  await assert.doesNotReject(queue.enqueue(offlineCommand("boundary-valid")));
  await assert.rejects(queue.enqueue({
    ...offlineCommand("future"),
    createdAt: "2026-02-01T00:00:00.001Z",
  }), /createdAt <= now < expiresAt/);
  await assert.rejects(queue.enqueue({
    ...offlineCommand("expired"),
    expiresAt: "2026-02-01T00:00:00.000Z",
  }), /TTL|createdAt <= now < expiresAt/);
  await assert.rejects(queue.enqueue({
    ...offlineCommand("excessive-ttl"),
    expiresAt: "2026-02-02T00:00:00.001Z",
  }), /TTL/);
  await assert.rejects(queue.enqueue({
    ...offlineCommand("unknown-field"),
    tenantId: "caller-asserted-tenant",
  } as never), /unknown field/);
});

test("real HTTP adapter makes 4xx terminal while retaining retryable 5xx and network failures", async () => {
  const context = { accessToken: "ephemeral-mobile-access-token", purpose: "product_operation" } as const;
  const cases = [
    {
      id: "client-error",
      fetch: async () => Response.json({
        error: { code: "CONFLICT", message: "stale version", retryable: true, details: {} },
        requestId: "req-409",
      }, { status: 409 }),
      expected: { sent: [], retained: [], dropped: [{ id: "client-error", reason: "permanent" }] },
    },
    {
      id: "server-error",
      fetch: async () => Response.json({
        error: { code: "UNAVAILABLE", message: "try later", retryable: true, details: {} },
        requestId: "req-503",
      }, { status: 503 }),
      expected: { sent: [], retained: ["server-error"], dropped: [] },
    },
    {
      id: "network-error",
      fetch: async () => { throw new TypeError("connection reset"); },
      expected: { sent: [], retained: ["network-error"], dropped: [] },
    },
  ] as const;
  for (const scenario of cases) {
    const storage = new MemoryStorage();
    const queue = new MobileOfflineQueue(storage, undefined, offlineOptions);
    await queue.activate({ tenantId: "tenant-1", actorId: "actor-1" });
    await queue.enqueue(offlineCommand(scenario.id));
    const http = new MobileHttpApiClient({
      baseUrl: "https://api.product.com",
      allowedOrigins: ["https://api.product.com"],
      fetch: scenario.fetch,
    });
    const result = await queue.flush({
      execute: <T>(batchId: string, payload: Record<string, unknown>, idempotencyKey: string) => (
        http.executeCapability(context, batchId, payload, idempotencyKey) as Promise<T>
      ),
    }, OFFLINE_NOW);
    assert.deepEqual(result, scenario.expected);
  }
});

test("native store result stays pending until a matching server entitlement projection exists", async () => {
  let providerPayloadSeen = "";
  const coordinator = new MobileStorePurchaseCoordinator({
    purchase: async (productId) => ({
      platform: "ios", productId, transactionReference: "transaction-1", providerPayload: "signed-provider-transaction-payload",
    }),
    restorePurchases: async () => [],
  }, {
    submitPurchase: async (input) => {
      providerPayloadSeen = input.providerPayload;
      return { verificationId: "verification-1", state: "verification_pending" };
    },
    getEntitlementProjection: async () => ({
      verificationId: "verification-1",
      productId: "premium.yearly",
      state: "active",
      version: 2,
      updatedAt: "2026-08-20T00:00:00Z",
    }),
  });
  assert.deepEqual(await coordinator.purchase("premium.yearly", "purchase-idem-1"), {
    verificationId: "verification-1", state: "verification_pending",
  });
  assert.equal(providerPayloadSeen, "signed-provider-transaction-payload");
  assert.equal((await coordinator.refresh("verification-1")).state, "active");
});

test("restore deduplicates native transactions and still waits for server verification", async () => {
  let submissions = 0;
  const restored = {
    platform: "android" as const,
    productId: "premium.yearly",
    transactionReference: "purchase-reference-1",
    providerPayload: "opaque-google-purchase-token",
  };
  const coordinator = new MobileStorePurchaseCoordinator({
    purchase: async () => restored,
    restorePurchases: async () => [restored, restored],
  }, {
    submitPurchase: async () => ({ verificationId: `verification-${++submissions}`, state: "verification_pending" }),
    getEntitlementProjection: async () => ({
      verificationId: "verification-1", productId: "premium.yearly", state: "active", version: 1,
      updatedAt: "2026-08-20T00:00:00Z",
    }),
  });
  assert.deepEqual(await coordinator.restore("restore-1"), [{ verificationId: "verification-1", state: "verification_pending" }]);
  assert.equal(submissions, 1);
});

test("capture preflight enforces type, size and resolution", () => {
  assert.deepEqual(preflightMobileCapture({ mimeType: "image/jpeg", byteLength: 1_000_000, width: 1400, height: 1400 }), { accepted: true, warnings: [] });
  assert.throws(() => preflightMobileCapture({ mimeType: "text/html", byteLength: 100, width: 1000, height: 1000 }), /format/);
});
