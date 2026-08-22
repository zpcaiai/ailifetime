import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeMobileDeepLink,
  MobileCapabilityError,
  MobileOfflineQueue,
  MobileStorePurchaseCoordinator,
  preflightMobileCapture,
  type SecureStorage,
} from "./index.js";

class MemoryStorage implements SecureStorage {
  value: string | null = null;
  async get(): Promise<string | null> { return this.value; }
  async set(_key: string, value: string): Promise<void> { this.value = value; }
  async delete(): Promise<void> { this.value = null; }
}

test("deep links reject authority and policy assertions", () => {
  assert.equal(authorizeMobileDeepLink("https://app.example.test/library", ["app.example.test"]).path, "/library");
  assert.throws(() => authorizeMobileDeepLink("https://evil.example/library", ["app.example.test"]), /origin/);
  assert.throws(() => authorizeMobileDeepLink("https://app.example.test/library?role=admin", ["app.example.test"]), /role/);
});

test("offline queue deduplicates and preserves failed commands", async () => {
  const storage = new MemoryStorage();
  const queue = new MobileOfflineQueue(storage);
  const command = { id: "one", batchId: "B64", idempotencyKey: "idem-one", payload: {}, createdAt: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z" };
  await queue.enqueue(command);
  await queue.enqueue(command);
  const outcome = await queue.flush({ execute: async () => { throw new Error("offline"); } } as never, new Date("2026-02-01T00:00:00Z"));
  assert.deepEqual(outcome, { sent: [], retained: ["one"], dropped: [] });
});

test("offline queue refuses sensitive or non-allowlisted work and drops permanent failures", async () => {
  const storage = new MemoryStorage();
  const queue = new MobileOfflineQueue(storage);
  await assert.rejects(queue.enqueue({
    id: "pay", batchId: "B66", idempotencyKey: "idem-pay", payload: {},
    createdAt: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z",
  }), /not permitted/);
  await assert.rejects(queue.enqueue({
    id: "media", batchId: "B64", idempotencyKey: "idem-media", payload: { rawMedia: "secret" },
    createdAt: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z",
  }), /prohibited/);
  await queue.enqueue({
    id: "safe", batchId: "B64", idempotencyKey: "idem-safe", payload: { uploadSessionId: "upload-1" },
    createdAt: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z",
  });
  assert.deepEqual(await queue.flush({ execute: async () => {
    throw new MobileCapabilityError("AUTH_FORBIDDEN", "denied", false);
  } }, new Date("2026-02-01T00:00:00Z")), {
    sent: [], retained: [], dropped: [{ id: "safe", reason: "permanent" }],
  });
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
