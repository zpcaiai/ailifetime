import assert from "node:assert/strict";
import test from "node:test";
import {
  createServiceMessageRequest,
  createWechatShareCard,
  WechatPaymentCoordinator,
  type WechatCommerceApi,
  type WechatPaymentIntent,
  type WechatPaymentProjection,
} from "./index.js";

const intent: WechatPaymentIntent = {
  orderId: "order-1",
  checkoutId: "checkout-1",
  amountMinor: 100,
  currency: "CNY",
  expiresAt: "2026-08-20T01:00:00.000Z",
  parameters: {
    timeStamp: "1787184000",
    nonceStr: "nonce_value_1234",
    package: "prepay_id=wx-prepay-12345678",
    signType: "RSA",
    paySign: "A".repeat(96),
  },
};

test("native payment success remains verification_pending until the server projects paid", async () => {
  let nativeCalls = 0;
  let projection: WechatPaymentProjection = {
    orderId: intent.orderId,
    checkoutId: intent.checkoutId,
    amountMinor: intent.amountMinor,
    currency: "CNY",
    state: "pending",
    version: 1,
    updatedAt: "2026-08-20T00:00:05.000Z",
  };
  const api: WechatCommerceApi = {
    createPaymentIntent: async () => intent,
    getPaymentProjection: async () => projection,
  };
  const coordinator = new WechatPaymentCoordinator(api, {
    requestPayment: async () => { nativeCalls += 1; },
  }, () => new Date("2026-08-20T00:00:00.000Z"));

  assert.deepEqual(await coordinator.start("checkout-1", "idem-1"), {
    orderId: "order-1",
    clientSignal: "native_sheet_resolved",
    state: "verification_pending",
  });
  assert.equal(nativeCalls, 1);
  assert.equal((await coordinator.refresh("order-1")).state, "pending");
  projection = { ...projection, state: "paid", version: 2, providerTransactionReference: "wechat-tx-1" };
  assert.equal((await coordinator.refresh("order-1")).state, "paid");
});

test("payment projection cannot change the checkout or server-priced amount", async () => {
  const coordinator = new WechatPaymentCoordinator({
    createPaymentIntent: async () => intent,
    getPaymentProjection: async () => ({
      orderId: "order-1", checkoutId: "checkout-1", amountMinor: 1, currency: "CNY",
      state: "paid", version: 2, updatedAt: "2026-08-20T00:00:05.000Z",
    }),
  }, { requestPayment: async () => undefined }, () => new Date("2026-08-20T00:00:00.000Z"));
  await coordinator.start("checkout-1", "idem-2");
  await assert.rejects(coordinator.refresh("order-1"), /original intent/);
});

test("sharing accepts only an unexpired opaque server grant", () => {
  const card = createWechatShareCard({
    grantId: "opaque_grant_token_123456789",
    path: "/pages/share/index?grant=opaque_grant_token_123456789",
    title: "家庭时光 · AI 艺术化示意",
    aiLabel: "AI_GENERATED_ILLUSTRATION",
    expiresAt: "2026-08-20T01:00:00.000Z",
    indexable: false,
  }, new Date("2026-08-20T00:00:00.000Z"));
  assert.equal(card.indexable, false);
  assert.throws(() => createWechatShareCard({
    ...card,
    grantId: "opaque_grant_token_123456789",
    path: "/pages/work/index?id=work-1",
    expiresAt: "2026-08-20T01:00:00.000Z",
  }, new Date("2026-08-20T00:00:00.000Z")), /opaque server grant/);
});

test("service messages carry only a live opaque authorization reference", () => {
  assert.deepEqual(createServiceMessageRequest({
    authorizationId: "message-auth-1",
    templateId: "template-1",
    channel: "wechat",
    status: "authorized",
    remainingUses: 1,
    expiresAt: "2026-08-20T01:00:00.000Z",
  }, new Date("2026-08-20T00:00:00.000Z")), {
    authorizationId: "message-auth-1",
    templateId: "template-1",
  });
  assert.throws(() => createServiceMessageRequest({
    authorizationId: "message-auth-1",
    templateId: "template-1",
    channel: "wechat",
    status: "authorized",
    remainingUses: 0,
    expiresAt: "2026-08-20T01:00:00.000Z",
  }), /remaining use/);
});
