import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { FailClosedProviderPorts, ProviderUnavailableError, SandboxProviderPorts } from "./index.js";

test("unconfigured providers fail closed", async () => {
  const providers = new FailClosedProviderPorts();
  await assert.rejects(
    providers.authorizePayment({
      requestId: "req-1", tenantId: "tenant-1", idempotencyKey: "idem-1", region: "CN",
      consentReceiptIds: ["consent-1"], synthetic: true, paymentToken: "tok_synthetic_ok", amountMinor: 100, currency: "CNY",
    }),
    ProviderUnavailableError,
  );
});

test("sandbox is deterministic and refuses real data", async () => {
  const providers = new SandboxProviderPorts("test");
  const request = {
    requestId: "req-1", tenantId: "tenant-1", idempotencyKey: "idem-1", region: "CN",
    consentReceiptIds: ["consent-1"], synthetic: true, sourceAssetId: "asset-1",
    targetAges: [0, 25, 100], promptPolicyVersion: "1", seed: "seed-1",
  } as const;
  assert.deepEqual(await providers.generateMedia(request), await providers.generateMedia(request));
  await assert.rejects(providers.generateMedia({ ...request, synthetic: false }), /non-synthetic/);
  assert.throws(() => new SandboxProviderPorts("production"), /cannot run in production/);
});

test("webhook verification uses an exact HMAC", () => {
  const providers = new SandboxProviderPorts("local");
  const secret = "synthetic-secret-value";
  const payload = Buffer.from("event-body");
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  assert.equal(providers.verifyWebhook(payload, signature, secret), true);
  assert.equal(providers.verifyWebhook(Buffer.from("changed"), signature, secret), false);
});
