import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createCapabilityRegistry } from "@ltm/capabilities";
import { DomainError, LifeTimeMachineRuntime } from "@ltm/core";
import {
  HttpWechatPlatformBroker,
  StaticTokenAuthenticator,
  createApiServer,
} from "../dist/index.js";

const cleanups = [];
const now = new Date("2026-08-28T02:00:00.000Z");

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function intent(overrides = {}) {
  return {
    schemaVersion: "ltm.wechat.payment-intent.v1",
    checkoutId: "checkout-12345678",
    orderId: "order-12345678",
    amountMinor: 1299,
    currency: "CNY",
    expiresAt: "2026-08-28T02:10:00.000Z",
    parameters: {
      timeStamp: String(Math.floor(now.getTime() / 1000)),
      nonceStr: "nonce-12345678",
      package: "prepay_id=prepay_12345678",
      signType: "RSA",
      paySign: "A".repeat(96),
    },
    ...overrides,
  };
}

function projection(overrides = {}) {
  return {
    schemaVersion: "ltm.wechat.payment-projection.v1",
    checkoutId: "checkout-12345678",
    orderId: "order-12345678",
    amountMinor: 1299,
    currency: "CNY",
    state: "paid",
    version: 2,
    updatedAt: "2026-08-28T02:00:00.000Z",
    providerTransactionReference: "wechat-transaction-12345678",
    ...overrides,
  };
}

function offer() {
  return {
    schemaVersion: "ltm.wechat.subscription-offer.v1",
    offerId: "offer-12345678",
    revision: 4,
    templateIds: ["template_identifier_000001", "template_identifier_000002"],
    expiresAt: "2026-08-28T03:00:00.000Z",
  };
}

function authorization() {
  return {
    schemaVersion: "ltm.wechat.subscription-authorization.v1",
    offerId: "offer-12345678",
    revision: 4,
    state: "server_recorded",
    authorizationReferences: ["subscription-authorization-reference-0001"],
  };
}

function grant(overrides = {}) {
  return {
    schemaVersion: "ltm.wechat.customer-service-grant.v1",
    corpId: "ww0123456789abcdef",
    extInfoUrl: "https://service.product.cn/chat?grant=opaque",
    ticketId: "support-ticket-00001",
    expiresAt: "2026-08-28T02:05:00.000Z",
    ...overrides,
  };
}

function context(purpose) {
  return {
    actorId: "consumer-12345678",
    tenantId: "tenant-12345678",
    roles: ["consumer"],
    purpose,
    requestId: "request-12345678",
  };
}

test("HTTP broker sends only a trusted checkout reference and validates every closed WeChat response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-wechat-platform-"));
  const tokenFile = join(directory, "workload-token");
  writeFileSync(tokenFile, "workload-token-value-123456789", { mode: 0o600 });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const values = [intent(), projection(), offer(), authorization(), grant()];
  const broker = new HttpWechatPlatformBroker({
    baseUrl: "http://127.0.0.1:8082",
    workloadTokenFile: tokenFile,
    allowInsecureLoopback: true,
    customerServiceAllowedOrigins: ["https://service.product.cn"],
    clock: () => now,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(values.shift()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(await broker.createPayment(context("commerce"), {
    checkoutId: "checkout-12345678",
    idempotencyKey: "wechat-payment-idempotency-0001",
  }), intent());
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["checkoutId", "principal"]);
  assert.equal(Object.hasOwn(calls[0].body, "amountMinor"), false);
  assert.equal(calls[0].body.principal.tenantId, "tenant-12345678");
  assert.equal(calls[0].init.headers.authorization, "Bearer workload-token-value-123456789");

  assert.equal((await broker.getPayment(context("commerce"), {
    orderId: "order-12345678", requestId: "request-12345678",
  })).state, "paid");
  assert.deepEqual((await broker.getSubscriptionOffer(context("notifications"), {
    requestId: "request-12345678",
  })).templateIds, offer().templateIds);
  assert.equal((await broker.authorizeSubscriptions(context("notifications"), {
    offerId: "offer-12345678",
    revision: 4,
    acceptedTemplateIds: ["template_identifier_000001"],
    idempotencyKey: "wechat-subscribe-idempotency-0001",
  })).authorizationReferences.length, 1);
  assert.equal((await broker.createCustomerServiceGrant(context("customer_support"), {
    idempotencyKey: "wechat-service-idempotency-0001",
  })).ticketId, "support-ticket-00001");
});

test("HTTP broker fails closed on changed checkout binding, invalid terminal proof, or unenrolled customer-service origin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-wechat-platform-negative-"));
  const tokenFile = join(directory, "workload-token");
  writeFileSync(tokenFile, "workload-token-value-123456789", { mode: 0o600 });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const values = [
    intent({ checkoutId: "checkout-attacker-1" }),
    projection({ state: "paid", providerTransactionReference: null }),
    grant({ extInfoUrl: "https://attacker.invalid/chat" }),
  ];
  const broker = new HttpWechatPlatformBroker({
    baseUrl: "http://127.0.0.1:8082",
    workloadTokenFile: tokenFile,
    allowInsecureLoopback: true,
    customerServiceAllowedOrigins: ["https://service.product.cn"],
    clock: () => now,
    fetch: async () => new Response(JSON.stringify(values.shift()), { status: 200 }),
  });
  await assert.rejects(
    broker.createPayment(context("commerce"), { checkoutId: "checkout-12345678", idempotencyKey: "idem-payment-0000001" }),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_ADAPTER_UNAVAILABLE",
  );
  await assert.rejects(
    broker.getPayment(context("commerce"), { orderId: "order-12345678", requestId: "request-12345678" }),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_ADAPTER_UNAVAILABLE",
  );
  await assert.rejects(
    broker.createCustomerServiceGrant(context("customer_support"), { idempotencyKey: "idem-service-0000001" }),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_ADAPTER_UNAVAILABLE",
  );
});

async function apiFixture(wechatPlatform) {
  const directory = mkdtempSync(join(tmpdir(), "ltm-wechat-api-"));
  const runtime = new LifeTimeMachineRuntime({ allowLegacyConsentPolicy: true, databasePath: join(directory, "api.sqlite") });
  const server = createApiServer({
    runtime,
    authenticator: new StaticTokenAuthenticator([{
      token: "wechat-consumer-token-0001",
      actorId: "consumer-12345678",
      tenantId: "tenant-12345678",
      roles: ["consumer"],
      allowedPurposes: ["commerce", "notifications", "customer_support"],
    }]),
    capabilityRegistry: createCapabilityRegistry(),
    staticDirectory: null,
    clientIntegrations: wechatPlatform === undefined ? {} : { wechatPlatform },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  cleanups.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${address.port}`;
}

function headers(purpose, idempotencyKey) {
  return {
    authorization: "Bearer wechat-consumer-token-0001",
    "x-purpose": purpose,
    "content-type": "application/json",
    ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
  };
}

test("public WeChat routes are purpose-bound, price-free, and never invoke B71 from the client", async () => {
  const calls = [];
  const platform = {
    async createPayment(actor, input) { calls.push({ operation: "create", actor, input }); return intent(); },
    async getPayment(actor, input) { calls.push({ operation: "project", actor, input }); return projection(); },
    async getSubscriptionOffer(actor, input) { calls.push({ operation: "offer", actor, input }); return offer(); },
    async authorizeSubscriptions(actor, input) { calls.push({ operation: "authorize", actor, input }); return authorization(); },
    async createCustomerServiceGrant(actor, input) { calls.push({ operation: "grant", actor, input }); return grant(); },
    async readiness() { return { ready: true, dependency: "wechat-platform" }; },
  };
  const baseUrl = await apiFixture(platform);
  const create = await fetch(`${baseUrl}/v1/wechat/payments`, {
    method: "POST",
    headers: headers("commerce", "payment-idempotency-0001"),
    body: JSON.stringify({ checkoutId: "checkout-12345678" }),
  });
  assert.equal(create.status, 201);
  assert.equal((await create.json()).data.amountMinor, 1299);
  assert.deepEqual(calls[0].input, { checkoutId: "checkout-12345678", idempotencyKey: "payment-idempotency-0001" });

  const clientPriced = await fetch(`${baseUrl}/v1/wechat/payments`, {
    method: "POST",
    headers: headers("commerce", "payment-idempotency-0002"),
    body: JSON.stringify({ checkoutId: "checkout-12345678", amountMinor: 1 }),
  });
  assert.equal(clientPriced.status, 422);
  assert.equal(calls.filter((entry) => entry.operation === "create").length, 1);

  const status = await fetch(`${baseUrl}/v1/wechat/payments/order-12345678`, { headers: headers("commerce") });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).data.state, "paid");

  const subscriptionOffer = await fetch(`${baseUrl}/v1/wechat/subscription-offer`, { headers: headers("notifications") });
  assert.equal(subscriptionOffer.status, 200);
  const authorize = await fetch(`${baseUrl}/v1/wechat/subscription-authorizations`, {
    method: "POST",
    headers: headers("notifications", "subscription-idempotency-0001"),
    body: JSON.stringify({ offerId: "offer-12345678", revision: 4, acceptedTemplateIds: ["template_identifier_000001"] }),
  });
  assert.equal(authorize.status, 201);
  const service = await fetch(`${baseUrl}/v1/wechat/customer-service-grants`, {
    method: "POST",
    headers: headers("customer_support", "service-idempotency-0001"),
    body: "{}",
  });
  assert.equal(service.status, 201);
  assert.deepEqual(calls.map((entry) => entry.operation), ["create", "project", "offer", "authorize", "grant"]);
  assert.equal(calls.some((entry) => entry.operation === "B71"), false);
});

test("public WeChat routes fail closed when the production port is absent or purpose is wrong", async () => {
  const baseUrl = await apiFixture(undefined);
  const unavailable = await fetch(`${baseUrl}/v1/wechat/payments`, {
    method: "POST",
    headers: headers("commerce", "payment-idempotency-0001"),
    body: JSON.stringify({ checkoutId: "checkout-12345678" }),
  });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "EXTERNAL_ADAPTER_UNAVAILABLE");

  const platform = {
    async createPayment() { throw new Error("must not be called"); },
    async getPayment() { throw new Error("must not be called"); },
    async getSubscriptionOffer() { throw new Error("must not be called"); },
    async authorizeSubscriptions() { throw new Error("must not be called"); },
    async createCustomerServiceGrant() { throw new Error("must not be called"); },
    async readiness() { return { ready: false, dependency: "wechat-platform" }; },
  };
  const wrongPurposeBaseUrl = await apiFixture(platform);
  const wrongPurpose = await fetch(`${wrongPurposeBaseUrl}/v1/wechat/payments`, {
    method: "POST",
    headers: headers("notifications", "payment-idempotency-0001"),
    body: JSON.stringify({ checkoutId: "checkout-12345678" }),
  });
  assert.equal(wrongPurpose.status, 403);
});
