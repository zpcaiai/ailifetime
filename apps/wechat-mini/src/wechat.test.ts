import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createWechatShareCard, normalizeWechatPaymentCallback, serviceMessageEligibility, verifyWechatCallback } from "./index.js";

test("payment callbacks require valid signature and normalized money", () => {
  const body = Buffer.from('{"eventId":"evt-1"}');
  const secret = "sandbox-wechat-secret";
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyWechatCallback(body, signature, secret), true);
  assert.equal(normalizeWechatPaymentCallback({ eventId: "evt-1", transactionId: "tx-1", merchantOrderId: "order-1", status: "SUCCESS", amountMinor: 100, currency: "CNY", occurredAt: "2026-08-20T00:00:00Z" }).status, "SUCCESS");
});

test("minor sharing and service messaging fail closed", () => {
  assert.throws(() => createWechatShareCard({ workId: "work-1", title: "家庭时光", containsMinor: true, publicConsent: false }), /minor/);
  assert.equal(serviceMessageEligibility({ serviceConsent: true, suppressed: false, quietHours: true, templateApproved: true }), false);
});
