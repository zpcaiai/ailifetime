import { createHash } from "node:crypto";
import type { ActorContext } from "@ltm/core";
import { DomainError } from "@ltm/core";
import { BrokerClient, type BrokerClientOptions } from "./client-integrations.js";
import { photoProduct } from "./photo-catalog.js";
import type { PhotoCheckoutRequest, PhotoCheckoutResult } from "./photo-purchases.js";

export interface WechatNativePaymentParameters {
  readonly timeStamp: string;
  readonly nonceStr: string;
  readonly package: string;
  readonly signType: "RSA";
  readonly paySign: string;
}

export interface WechatPaymentIntent {
  readonly schemaVersion: "ltm.wechat.payment-intent.v1";
  readonly checkoutId: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: "CNY";
  readonly expiresAt: string;
  readonly parameters: WechatNativePaymentParameters;
}

export interface WechatPaymentProjection {
  readonly schemaVersion: "ltm.wechat.payment-projection.v1";
  readonly checkoutId: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: "CNY";
  readonly state: "pending" | "paid" | "closed" | "refunded" | "failed";
  readonly version: number;
  readonly updatedAt: string;
  readonly providerTransactionReference: string | null;
}

export interface WechatSubscriptionOffer {
  readonly schemaVersion: "ltm.wechat.subscription-offer.v1";
  readonly offerId: string;
  readonly revision: number;
  readonly templateIds: readonly string[];
  readonly expiresAt: string;
}

export interface WechatSubscriptionAuthorization {
  readonly schemaVersion: "ltm.wechat.subscription-authorization.v1";
  readonly offerId: string;
  readonly revision: number;
  readonly state: "server_recorded";
  readonly authorizationReferences: readonly string[];
}

export interface WechatCustomerServiceGrant {
  readonly schemaVersion: "ltm.wechat.customer-service-grant.v1";
  readonly corpId: string;
  readonly extInfoUrl: string;
  readonly ticketId: string;
  readonly expiresAt: string;
}

export interface WechatPlatformPort {
  preparePhotoCheckout?(context: ActorContext, input: PhotoCheckoutRequest): Promise<PhotoCheckoutResult>;
  createPayment(context: ActorContext, input: {
    readonly checkoutId: string;
    readonly idempotencyKey: string;
  }): Promise<WechatPaymentIntent>;
  getPayment(context: ActorContext, input: {
    readonly orderId: string;
    readonly requestId: string;
  }): Promise<WechatPaymentProjection>;
  getSubscriptionOffer(context: ActorContext, input: {
    readonly requestId: string;
  }): Promise<WechatSubscriptionOffer>;
  authorizeSubscriptions(context: ActorContext, input: {
    readonly offerId: string;
    readonly revision: number;
    readonly acceptedTemplateIds: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<WechatSubscriptionAuthorization>;
  createCustomerServiceGrant(context: ActorContext, input: {
    readonly idempotencyKey: string;
  }): Promise<WechatCustomerServiceGrant>;
  readiness(): Promise<{ readonly ready: boolean; readonly dependency: string }>;
}

export interface WechatPlatformBrokerOptions extends BrokerClientOptions {
  readonly customerServiceAllowedOrigins: readonly string[];
  readonly clock?: () => Date;
}

/**
 * Authenticated API-to-broker boundary for WeChat commercial operations.
 *
 * The browser/Mini Program never supplies a price, merchant identifier, payer
 * openid, notify URL, or provider result. The broker resolves those values from
 * its trusted checkout and identity stores before it calls WeChat Pay. Payment
 * terminal state remains the signed callback projection (B71); this adapter only
 * validates and forwards that server-owned projection.
 */
export class HttpWechatPlatformBroker implements WechatPlatformPort {
  readonly #broker: BrokerClient;
  readonly #clock: () => Date;

  async preparePhotoCheckout(context: ActorContext, input: PhotoCheckoutRequest): Promise<PhotoCheckoutResult> {
    assertPurpose(context, "commerce");
    const product = photoProduct(input.sku, input.priceVersion);
    if (!/^photo-[a-f0-9]{64}$/.test(input.purchaseId) || input.amountMinor !== product.amountMinor || input.currency !== "CNY" || input.priceVersion !== product.priceVersion ||
        !/^[a-f0-9]{64}$/.test(input.scopeSha256) || !Number.isInteger(input.imageCount) || input.imageCount < 1 || (product.imageCount === null ? input.imageCount > 4 : input.imageCount !== product.imageCount)) {
      throw new DomainError("VALIDATION_FAILED", "photo checkout must use the server-owned price and exact delivery count");
    }
    const value = await this.#broker.json("POST", "/v1/wechat/photo-checkouts", { principal: principal(context), purchaseId: input.purchaseId,
      product: { sku: input.sku, priceVersion: input.priceVersion, amountMinor: input.amountMinor, currency: input.currency, imageCount: input.imageCount, scopeSha256: input.scopeSha256 } }, input.idempotencyKey, context.requestId);
    const result = upstreamRecord(value, "photo checkout");
    upstreamExactKeys(result, ["schemaVersion", "checkoutId", "orderId", "amountMinor", "currency", "scopeSha256"], "photo checkout");
    if (result.schemaVersion !== "ltm.photo-checkout.v1" || result.checkoutId !== input.purchaseId || result.amountMinor !== input.amountMinor || result.currency !== "CNY" || result.scopeSha256 !== input.scopeSha256) unavailable("merchant changed the photo checkout price or scope");
    return { schemaVersion: "ltm.photo-checkout.v1", checkoutId: input.purchaseId, orderId: upstreamIdentifier(result.orderId, "orderId"), amountMinor: input.amountMinor, currency: "CNY", scopeSha256: input.scopeSha256 };
  }
  readonly #customerServiceAllowedOrigins: ReadonlySet<string>;

  constructor(options: WechatPlatformBrokerOptions) {
    this.#broker = new BrokerClient(options);
    this.#clock = options.clock ?? (() => new Date());
    if (options.customerServiceAllowedOrigins.length < 1 || options.customerServiceAllowedOrigins.length > 16) {
      throw configuration("customer service allowed origins must contain between one and sixteen HTTPS origins");
    }
    const origins = options.customerServiceAllowedOrigins.map((value) => enrolledHttpsOrigin(value));
    if (new Set(origins).size !== origins.length) throw configuration("customer service allowed origins must be unique");
    this.#customerServiceAllowedOrigins = new Set(origins);
  }

  async createPayment(
    context: ActorContext,
    input: Parameters<WechatPlatformPort["createPayment"]>[1],
  ): Promise<WechatPaymentIntent> {
    assertPurpose(context, "commerce");
    const checkoutId = clientIdentifier(input.checkoutId, "checkoutId");
    const value = await this.#broker.json("POST", "/v1/wechat/payments", {
      principal: principal(context),
      checkoutId,
    }, input.idempotencyKey, context.requestId);
    return paymentIntent(value, checkoutId, this.#clock());
  }

  async getPayment(
    context: ActorContext,
    input: Parameters<WechatPlatformPort["getPayment"]>[1],
  ): Promise<WechatPaymentProjection> {
    assertPurpose(context, "commerce");
    const orderId = clientIdentifier(input.orderId, "orderId");
    const value = await this.#broker.json("POST", "/v1/wechat/payments/project", {
      principal: principal(context),
      orderId,
    }, readIdempotencyKey("payment", context, input.requestId, orderId), input.requestId);
    return paymentProjection(value, orderId, this.#clock());
  }

  async getSubscriptionOffer(
    context: ActorContext,
    input: Parameters<WechatPlatformPort["getSubscriptionOffer"]>[1],
  ): Promise<WechatSubscriptionOffer> {
    assertPurpose(context, "notifications");
    const value = await this.#broker.json("POST", "/v1/wechat/subscriptions/offer", {
      principal: principal(context),
    }, readIdempotencyKey("subscription-offer", context, input.requestId), input.requestId);
    return subscriptionOffer(value, this.#clock());
  }

  async authorizeSubscriptions(
    context: ActorContext,
    input: Parameters<WechatPlatformPort["authorizeSubscriptions"]>[1],
  ): Promise<WechatSubscriptionAuthorization> {
    assertPurpose(context, "notifications");
    const offerId = clientIdentifier(input.offerId, "offerId");
    const revision = clientInteger(input.revision, "revision", 1, 1_000_000);
    const acceptedTemplateIds = templateIds(input.acceptedTemplateIds, "acceptedTemplateIds");
    const value = await this.#broker.json("POST", "/v1/wechat/subscriptions/authorize", {
      principal: principal(context),
      offerId,
      revision,
      acceptedTemplateIds,
    }, input.idempotencyKey, context.requestId);
    return subscriptionAuthorization(value, { offerId, revision, acceptedTemplateIds });
  }

  async createCustomerServiceGrant(
    context: ActorContext,
    input: Parameters<WechatPlatformPort["createCustomerServiceGrant"]>[1],
  ): Promise<WechatCustomerServiceGrant> {
    assertPurpose(context, "customer_support");
    const value = await this.#broker.json("POST", "/v1/wechat/customer-service/grants", {
      principal: principal(context),
    }, input.idempotencyKey, context.requestId);
    return customerServiceGrant(value, this.#clock(), this.#customerServiceAllowedOrigins);
  }

  readiness(): Promise<{ ready: boolean; dependency: string }> {
    return this.#broker.readiness("wechat-platform");
  }
}

function paymentIntent(value: unknown, checkoutId: string, now: Date): WechatPaymentIntent {
  const response = upstreamRecord(value, "payment intent");
  upstreamExactKeys(response, [
    "schemaVersion", "checkoutId", "orderId", "amountMinor", "currency", "expiresAt", "parameters",
  ], "payment intent");
  if (response.schemaVersion !== "ltm.wechat.payment-intent.v1" || response.checkoutId !== checkoutId || response.currency !== "CNY") {
    unavailable("payment broker changed the checkout, schema, or currency binding");
  }
  const parameters = upstreamRecord(response.parameters, "native payment parameters");
  upstreamExactKeys(parameters, ["timeStamp", "nonceStr", "package", "signType", "paySign"], "native payment parameters");
  const timeStamp = upstreamString(parameters.timeStamp, "timeStamp", 10, 10);
  const seconds = Number(timeStamp);
  if (!/^\d{10}$/.test(timeStamp) || !Number.isSafeInteger(seconds) || Math.abs(seconds * 1_000 - now.getTime()) > 5 * 60_000) {
    unavailable("payment broker returned a stale or invalid native signature timestamp");
  }
  const expiresAt = futureTimestamp(response.expiresAt, "expiresAt", now, 15 * 60_000);
  const nonceStr = upstreamString(parameters.nonceStr, "nonceStr", 32, 8);
  const packageValue = upstreamString(parameters.package, "package", 150, 18);
  const paySign = upstreamString(parameters.paySign, "paySign", 1_024, 64);
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(nonceStr) || !/^prepay_id=[A-Za-z0-9_-]{8,128}$/.test(packageValue) ||
      parameters.signType !== "RSA" || !/^[A-Za-z0-9+/=_-]{64,1024}$/.test(paySign)) {
    unavailable("payment broker returned invalid native payment parameters");
  }
  return Object.freeze({
    schemaVersion: "ltm.wechat.payment-intent.v1",
    checkoutId,
    orderId: upstreamIdentifier(response.orderId, "orderId"),
    amountMinor: upstreamInteger(response.amountMinor, "amountMinor", 1, 100_000_000),
    currency: "CNY",
    expiresAt,
    parameters: Object.freeze({ timeStamp, nonceStr, package: packageValue, signType: "RSA", paySign }),
  });
}

function paymentProjection(value: unknown, orderId: string, now: Date): WechatPaymentProjection {
  const response = upstreamRecord(value, "payment projection");
  upstreamExactKeys(response, [
    "schemaVersion", "checkoutId", "orderId", "amountMinor", "currency", "state", "version", "updatedAt",
    "providerTransactionReference",
  ], "payment projection");
  const state = response.state;
  if (response.schemaVersion !== "ltm.wechat.payment-projection.v1" || response.orderId !== orderId || response.currency !== "CNY" ||
      !["pending", "paid", "closed", "refunded", "failed"].includes(String(state))) {
    unavailable("payment broker returned an invalid or differently-bound projection");
  }
  const providerTransactionReference = response.providerTransactionReference === null
    ? null
    : upstreamIdentifier(response.providerTransactionReference, "providerTransactionReference");
  if ((state === "paid" || state === "refunded") !== (providerTransactionReference !== null)) {
    unavailable("payment projection provider reference does not match its terminal state");
  }
  return Object.freeze({
    schemaVersion: "ltm.wechat.payment-projection.v1",
    checkoutId: upstreamIdentifier(response.checkoutId, "checkoutId"),
    orderId,
    amountMinor: upstreamInteger(response.amountMinor, "amountMinor", 1, 100_000_000),
    currency: "CNY",
    state: state as WechatPaymentProjection["state"],
    version: upstreamInteger(response.version, "version", 1, Number.MAX_SAFE_INTEGER),
    updatedAt: pastTimestamp(response.updatedAt, "updatedAt", now),
    providerTransactionReference,
  });
}

function subscriptionOffer(value: unknown, now: Date): WechatSubscriptionOffer {
  const response = upstreamRecord(value, "subscription offer");
  upstreamExactKeys(response, ["schemaVersion", "offerId", "revision", "templateIds", "expiresAt"], "subscription offer");
  if (response.schemaVersion !== "ltm.wechat.subscription-offer.v1") unavailable("subscription broker returned an invalid schema");
  return Object.freeze({
    schemaVersion: "ltm.wechat.subscription-offer.v1",
    offerId: upstreamIdentifier(response.offerId, "offerId"),
    revision: upstreamInteger(response.revision, "revision", 1, 1_000_000),
    templateIds: Object.freeze([...upstreamTemplateIds(response.templateIds, "templateIds")]),
    expiresAt: futureTimestamp(response.expiresAt, "expiresAt", now, 24 * 60 * 60_000),
  });
}

function subscriptionAuthorization(value: unknown, expected: {
  readonly offerId: string;
  readonly revision: number;
  readonly acceptedTemplateIds: readonly string[];
}): WechatSubscriptionAuthorization {
  const response = upstreamRecord(value, "subscription authorization");
  upstreamExactKeys(response, [
    "schemaVersion", "offerId", "revision", "state", "authorizationReferences",
  ], "subscription authorization");
  const references = upstreamIdentifiers(response.authorizationReferences, "authorizationReferences", 3);
  if (response.schemaVersion !== "ltm.wechat.subscription-authorization.v1" || response.offerId !== expected.offerId ||
      response.revision !== expected.revision || response.state !== "server_recorded" ||
      references.length !== expected.acceptedTemplateIds.length) {
    unavailable("subscription broker changed or incompletely persisted the native authorization binding");
  }
  return Object.freeze({
    schemaVersion: "ltm.wechat.subscription-authorization.v1",
    offerId: expected.offerId,
    revision: expected.revision,
    state: "server_recorded",
    authorizationReferences: Object.freeze([...references]),
  });
}

function customerServiceGrant(
  value: unknown,
  now: Date,
  allowedOrigins: ReadonlySet<string>,
): WechatCustomerServiceGrant {
  const response = upstreamRecord(value, "customer service grant");
  upstreamExactKeys(response, ["schemaVersion", "corpId", "extInfoUrl", "ticketId", "expiresAt"], "customer service grant");
  const corpId = upstreamString(response.corpId, "corpId", 18, 18);
  const extInfoUrl = upstreamString(response.extInfoUrl, "extInfoUrl", 2_048, 12);
  let url: URL;
  try { url = new URL(extInfoUrl); } catch { return unavailable("customer service broker returned an invalid URL"); }
  if (response.schemaVersion !== "ltm.wechat.customer-service-grant.v1" || !/^ww[0-9a-f]{16}$/.test(corpId) ||
      url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "" ||
      !allowedOrigins.has(url.origin)) {
    unavailable("customer service grant is outside the enrolled enterprise boundary");
  }
  return Object.freeze({
    schemaVersion: "ltm.wechat.customer-service-grant.v1",
    corpId,
    extInfoUrl: url.toString(),
    ticketId: upstreamIdentifier(response.ticketId, "ticketId"),
    expiresAt: futureTimestamp(response.expiresAt, "expiresAt", now, 10 * 60_000),
  });
}

function assertPurpose(context: ActorContext, expected: "commerce" | "notifications" | "customer_support"): void {
  if (context.purpose !== expected) throw new DomainError("AUTH_FORBIDDEN", `WeChat operation requires ${expected} purpose`);
}

function principal(context: ActorContext): object {
  return { actorId: context.actorId, tenantId: context.tenantId, roles: context.roles, purpose: context.purpose };
}

function readIdempotencyKey(kind: string, context: ActorContext, requestId: string, subject = "no-subject"): string {
  const digest = createHash("sha256").update([
    "ltm-wechat-read-v1",
    kind,
    clientIdentifier(context.tenantId, "tenantId"),
    clientIdentifier(context.actorId, "actorId"),
    clientIdentifier(subject, "subject"),
    clientIdentifier(requestId, "requestId"),
  ].join("\n"), "utf8").digest("hex");
  return `wechat-read-${digest}`;
}

function enrolledHttpsOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw configuration("customer service origin is invalid"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.pathname !== "/" ||
      url.search !== "" || url.hash !== "" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw configuration("customer service origins must be credential-free non-loopback HTTPS origins");
  }
  return url.origin;
}

function clientIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(value)) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid`);
  }
  return value;
}

function clientInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid`);
  }
  return value as number;
}

function templateIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length ||
      value.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9_-]{20,80}$/.test(entry))) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid`);
  }
  return [...value] as string[];
}

function upstreamRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) unavailable(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function upstreamExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) unavailable(`${label} is not a closed response`);
}

function upstreamString(value: unknown, label: string, maximum: number, minimum = 1): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    unavailable(`${label} is invalid`);
  }
  return value;
}

function upstreamIdentifier(value: unknown, label: string): string {
  const result = upstreamString(value, label, 256, 8);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(result)) unavailable(`${label} is invalid`);
  return result;
}

function upstreamInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) unavailable(`${label} is invalid`);
  return value as number;
}

function upstreamTemplateIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length ||
      value.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9_-]{20,80}$/.test(entry))) unavailable(`${label} is invalid`);
  return [...value] as string[];
}

function upstreamIdentifiers(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum || new Set(value).size !== value.length) {
    unavailable(`${label} is invalid`);
  }
  return value.map((entry) => upstreamIdentifier(entry, label));
}

function futureTimestamp(value: unknown, label: string, now: Date, maximumFutureMs: number): string {
  const result = exactUtcTimestamp(value, label);
  const milliseconds = Date.parse(result);
  if (milliseconds <= now.getTime() || milliseconds > now.getTime() + maximumFutureMs) unavailable(`${label} is outside its allowed lifetime`);
  return result;
}

function pastTimestamp(value: unknown, label: string, now: Date): string {
  const result = exactUtcTimestamp(value, label);
  if (Date.parse(result) > now.getTime() + 5 * 60_000) unavailable(`${label} is in the future`);
  return result;
}

function exactUtcTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) unavailable(`${label} is invalid`);
  const milliseconds = Date.parse(value);
  const canonical = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonical) unavailable(`${label} is invalid`);
  return value;
}

function configuration(message: string): DomainError { return new DomainError("CONFIGURATION_INVALID", message); }
function unavailable(message: string): never { throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", message); }
