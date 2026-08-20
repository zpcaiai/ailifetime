import assert from "node:assert/strict";
import test from "node:test";
import { authorizeMobileDeepLink, MobileOfflineQueue, preflightMobileCapture, type SecureStorage } from "./index.js";

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
  assert.deepEqual(outcome, { sent: [], retained: ["one"] });
});

test("capture preflight enforces type, size and resolution", () => {
  assert.deepEqual(preflightMobileCapture({ mimeType: "image/jpeg", byteLength: 1_000_000, width: 1400, height: 1400 }), { accepted: true, warnings: [] });
  assert.throws(() => preflightMobileCapture({ mimeType: "text/html", byteLength: 100, width: 1000, height: 1000 }), /format/);
});
