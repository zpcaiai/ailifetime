import {
  X509Certificate,
  createDecipheriv,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import type { VerifiedBusinessEvent } from "@ltm/core";
import type { EvidenceEnvironment, SignedCapabilityEvidence, WechatPaymentEvidenceBinding } from "./evidence.js";
import type { SecretReference } from "./external-evidence-adapters.js";
import type { TrustedCommerceBindingResolver } from "./commerce-bindings.js";
import {
  FetchHttpTransport,
  ProductionIntegrationError,
  attestVerifiedBusinessEvent,
  assertProductionEndpoint,
  identifier,
  parseJsonObject,
  requiredString,
  sha256,
  storeVerifiedArtifact,
  type EvidenceArtifactStore,
  type EvidenceAttestor,
  type HttpTransport,
  type ReplayStore,
  type SecretResolver,
} from "./production-common.js";

export interface WechatPlatformKeyResolver {
  /** Resolve the WeChat platform certificate/public key that exactly matches the callback serial. */
  resolve(serial: string): Promise<string | Buffer>;
}

export interface WechatPayIntegrationOptions {
  readonly merchantId: string;
  readonly apiV3KeyReference: SecretReference;
  readonly maximumClockSkewSeconds?: number;
  readonly clock?: () => Date;
}

export interface VerifyWechatPaymentCallbackInput {
  readonly tenantId: string;
  readonly environment: EvidenceEnvironment;
  readonly accountId?: string;
  readonly headers: {
    readonly timestamp: string;
    readonly nonce: string;
    readonly serial: string;
    readonly signature: string;
  };
  /** Exact, unparsed HTTP request body. Re-serialized JSON is never accepted. */
  readonly rawBody: Uint8Array;
  /** Optional trusted order binding. When used, all three expected fields are required together. */
  readonly expectedOutTradeNo?: string;
  readonly expectedAmountMinor?: number;
  readonly expectedCurrency?: string;
}

export interface WechatPaymentReceipt {
  readonly transactionId: string;
  readonly outTradeNo: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly successTime: string;
  readonly eventId: string;
  readonly eventType: "payment.captured" | "payment.refunded" | "payment.cancelled" | "payment.revoked";
  readonly environment: EvidenceEnvironment;
  readonly accountId: string;
  readonly paymentId: string;
}

export interface VerifiedWechatPayment {
  readonly evidence: SignedCapabilityEvidence<WechatPaymentEvidenceBinding>;
  readonly businessEvent: VerifiedBusinessEvent;
  readonly receipt: WechatPaymentReceipt;
}

export interface WechatPayApiClientOptions {
  readonly merchantId: string;
  readonly appId: string;
  readonly merchantCertificateSerial: string;
  readonly merchantPrivateKeyReference: SecretReference;
  readonly notifyUrl: URL;
  readonly maximumResponseClockSkewSeconds?: number;
  readonly clock?: () => Date;
}

export interface CreateWechatNativeOrderInput {
  readonly outTradeNo: string;
  readonly description: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly expiresAt?: string;
  readonly attachment?: string;
}

export interface WechatNativeOrder {
  readonly outTradeNo: string;
  readonly codeUrl: string;
  readonly providerResponseSha256: string;
}

/** Signed server-to-server Native order creation with mandatory WeChat response verification. */
export class WechatPayApiClient {
  readonly #clock: () => Date;
  readonly #responseClockSkewSeconds: number;
  readonly #endpoint = new URL("https://api.mch.weixin.qq.com/v3/pay/transactions/native");

  constructor(
    private readonly options: WechatPayApiClientOptions,
    private readonly secrets: SecretResolver,
    private readonly platformKeys: WechatPlatformKeyResolver,
    private readonly transport: HttpTransport = new FetchHttpTransport(),
  ) {
    identifier(options.merchantId, "merchantId");
    identifier(options.appId, "appId");
    identifier(options.merchantCertificateSerial, "merchantCertificateSerial");
    assertProductionEndpoint(options.notifyUrl);
    this.#clock = options.clock ?? (() => new Date());
    this.#responseClockSkewSeconds = options.maximumResponseClockSkewSeconds ?? 300;
    if (!Number.isSafeInteger(this.#responseClockSkewSeconds) ||
        this.#responseClockSkewSeconds < 30 || this.#responseClockSkewSeconds > 900) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "WeChat response clock skew must be between 30 and 900 seconds");
    }
  }

  async createNativeOrder(input: CreateWechatNativeOrderInput): Promise<WechatNativeOrder> {
    if (!/^[0-9A-Za-z_-]{6,32}$/.test(input.outTradeNo)) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat outTradeNo is invalid");
    }
    const description = requiredString(input.description, "WeChat order description", 127);
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > 100_000_000_000) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat order amount is invalid");
    }
    if (!/^[A-Z]{3}$/.test(input.currency)) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat order currency is invalid");
    }
    if (input.expiresAt !== undefined) {
      const expires = Date.parse(input.expiresAt);
      const now = this.#clock().getTime();
      if (!Number.isFinite(expires) || expires <= now || expires > now + 24 * 60 * 60_000) {
        throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat order expiration is invalid");
      }
    }
    const body = Buffer.from(JSON.stringify({
      appid: this.options.appId,
      mchid: this.options.merchantId,
      description,
      out_trade_no: input.outTradeNo,
      notify_url: this.options.notifyUrl.toString(),
      amount: { total: input.amountMinor, currency: input.currency },
      ...(input.expiresAt === undefined ? {} : { time_expire: input.expiresAt }),
      ...(input.attachment === undefined ? {} : { attach: requiredString(input.attachment, "WeChat attachment", 128) }),
    }), "utf8");
    const timestamp = String(Math.floor(this.#clock().getTime() / 1_000));
    const nonce = randomBytes(16).toString("hex");
    const requestTarget = `${this.#endpoint.pathname}${this.#endpoint.search}`;
    const signingMessage = Buffer.concat([
      Buffer.from(`POST\n${requestTarget}\n${timestamp}\n${nonce}\n`, "utf8"), body, Buffer.from("\n"),
    ]);
    const merchantKey = Buffer.from(await this.secrets.resolve(this.options.merchantPrivateKeyReference));
    let requestSignature: string;
    try {
      requestSignature = cryptoSign("RSA-SHA256", signingMessage, merchantKey).toString("base64");
    } catch {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "WeChat merchant private key is invalid");
    } finally {
      merchantKey.fill(0);
    }
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${this.options.merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.options.merchantCertificateSerial}",signature="${requestSignature}"`;
    const response = await this.transport.request({
      url: this.#endpoint,
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization },
      body,
      timeoutMs: 10_000,
      maximumResponseBytes: 256 * 1_024,
      acceptedStatuses: [200, 201],
    });
    await verifyWechatSignedResponse(
      response.headers,
      response.body,
      this.platformKeys,
      this.#clock(),
      this.#responseClockSkewSeconds,
    );
    const payload = parseJsonObject(response.body, "WeChat native order response");
    const codeUrl = requiredString(payload.code_url, "WeChat code_url", 2_048);
    if (!codeUrl.startsWith("weixin://wxpay/")) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat native order returned an invalid code_url");
    }
    return { outTradeNo: input.outTradeNo, codeUrl, providerResponseSha256: sha256(response.body) };
  }
}

/** WeChat Pay API v3 RSA-SHA256 callback verification and AES-256-GCM resource decryption. */
export class WechatPayEvidenceIntegration {
  readonly #clock: () => Date;
  readonly #clockSkewSeconds: number;

  constructor(
    private readonly options: WechatPayIntegrationOptions,
    private readonly secrets: SecretResolver,
    private readonly platformKeys: WechatPlatformKeyResolver,
    private readonly replays: ReplayStore,
    private readonly artifacts: EvidenceArtifactStore,
    private readonly attestor: EvidenceAttestor,
    private readonly commerceBindings?: TrustedCommerceBindingResolver,
  ) {
    identifier(options.merchantId, "merchantId");
    this.#clock = options.clock ?? (() => new Date());
    this.#clockSkewSeconds = options.maximumClockSkewSeconds ?? 300;
    if (!Number.isSafeInteger(this.#clockSkewSeconds) || this.#clockSkewSeconds < 30 || this.#clockSkewSeconds > 900) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "WeChat callback clock skew must be between 30 and 900 seconds");
    }
  }

  async verifyAndAttest(input: VerifyWechatPaymentCallbackInput): Promise<VerifiedWechatPayment> {
    identifier(input.tenantId, "tenantId");
    if (input.accountId !== undefined || input.expectedOutTradeNo !== undefined ||
        input.expectedAmountMinor !== undefined || input.expectedCurrency !== undefined) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "WeChat callback bindings cannot be supplied by the callback caller");
    }
    if (this.commerceBindings === undefined) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "WeChat callback requires a trusted commerce binding resolver");
    }
    const timestampSeconds = parseCallbackTimestamp(input.headers.timestamp);
    const nowSeconds = Math.floor(this.#clock().getTime() / 1_000);
    if (Math.abs(nowSeconds - timestampSeconds) > this.#clockSkewSeconds) {
      throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "WeChat callback timestamp is outside the accepted window");
    }
    const nonce = boundedHeader(input.headers.nonce, "Wechatpay-Nonce", 256);
    const serial = boundedHeader(input.headers.serial, "Wechatpay-Serial", 128);
    const signature = decodeBase64Signature(input.headers.signature);
    if (input.rawBody.byteLength === 0 || input.rawBody.byteLength > 1_048_576) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat callback body size is invalid");
    }
    const platformMaterial = await this.platformKeys.resolve(serial);
    let publicKey;
    try {
      const text = typeof platformMaterial === "string" ? platformMaterial : platformMaterial.toString("utf8");
      publicKey = text.includes("BEGIN CERTIFICATE")
        ? new X509Certificate(text).publicKey
        : createPublicKey(platformMaterial);
    } catch {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "WeChat platform key material is invalid");
    }
    const signingMessage = Buffer.concat([
      Buffer.from(input.headers.timestamp, "utf8"), Buffer.from("\n"),
      Buffer.from(nonce, "utf8"), Buffer.from("\n"),
      Buffer.from(input.rawBody), Buffer.from("\n"),
    ]);
    if (!cryptoVerify("RSA-SHA256", signingMessage, publicKey, signature)) {
      throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "WeChat callback RSA-SHA256 signature is invalid");
    }
    const replayValue = sha256(Buffer.concat([
      Buffer.from(serial), Buffer.from("\n"), Buffer.from(input.headers.timestamp), Buffer.from("\n"),
      Buffer.from(nonce), Buffer.from("\n"), signature,
    ]));
    const callback = parseJsonObject(input.rawBody, "WeChat callback");
    const eventId = requiredString(callback.id, "WeChat callback id", 128);
    const eventType = requiredString(callback.event_type, "WeChat callback event_type", 128);
    const resource = objectField(callback.resource, "WeChat callback resource");
    if (resource.algorithm !== "AEAD_AES_256_GCM") {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat callback encryption algorithm is not supported");
    }
    const apiKey = Buffer.from(await this.secrets.resolve(this.options.apiV3KeyReference));
    let plaintext: Buffer;
    try {
      if (apiKey.byteLength !== 32) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", "WeChat API v3 key must be exactly 32 bytes");
      }
      plaintext = decryptWechatResource(resource, apiKey);
    } finally {
      apiKey.fill(0);
    }
    const transaction = parseJsonObject(plaintext, "decrypted WeChat payment event");
    plaintext.fill(0);
    const normalized = normalizeWechatBusinessCallback(eventType, transaction, callback, timestampSeconds);
    const { merchantId, outTradeNo, transactionId } = normalized;
    if (merchantId !== this.options.merchantId) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat callback does not match the configured merchant");
    }
    const commerceBinding = await this.commerceBindings.resolveWechat({
      merchantId,
      outTradeNo,
      transactionId,
    });
    if (commerceBinding.tenantId !== input.tenantId) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat order belongs to a different tenant");
    }
    if ((normalized.orderAmountMinor !== undefined && normalized.orderAmountMinor !== commerceBinding.expectedAmountMinor) ||
        (normalized.currency !== undefined && normalized.currency !== commerceBinding.expectedCurrency)) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat callback does not match the trusted order amount/currency");
    }
    const amountMinor = normalized.eventAmountMinor ?? commerceBinding.expectedAmountMinor;
    const currency = normalized.currency ?? commerceBinding.expectedCurrency;
    const binding: WechatPaymentEvidenceBinding = {
      tenantId: input.tenantId,
      batchId: "B71",
      operation: "recordWechatCommercialAction",
      kind: "wechat-payment-callback",
      provider: "wechat-pay",
      artifactSha256: sha256(input.rawBody),
      environment: input.environment,
      subjectId: transactionId ?? outTradeNo,
    };
    await storeVerifiedArtifact(this.artifacts, binding, input.rawBody, "financial");
    const attested = await attestVerifiedBusinessEvent(this.attestor, binding, input.rawBody, {
      eventId,
      subjectType: "payment",
      subjectId: commerceBinding.paymentId,
      eventType: normalized.businessEventType,
      providerOccurredAt: normalized.occurredAt,
      sequence: Date.parse(normalized.occurredAt),
      correlationId: outTradeNo,
      canonicalClaims: {
        accountId: commerceBinding.accountId,
        outTradeNo,
        amountMinor,
        currency,
        providerEventType: eventType,
        ...(transactionId === null ? {} : { providerTransactionId: transactionId }),
        ...(normalized.refundId === undefined ? {} : { refundId: normalized.refundId }),
      },
    });
    const claimed = await this.replays.claimOnce(
      `wechat-pay:${this.options.merchantId}`,
      replayValue,
      new Date((timestampSeconds + this.#clockSkewSeconds * 2) * 1_000),
    );
    if (!claimed) throw new ProductionIntegrationError("PROVIDER_REPLAY_DETECTED", "WeChat callback has already been processed");
    return {
      evidence: attested.evidence,
      businessEvent: attested.event,
      receipt: {
        transactionId: transactionId ?? outTradeNo,
        outTradeNo,
        amountMinor,
        currency,
        successTime: normalized.occurredAt,
        eventId,
        eventType: normalized.businessEventType,
        environment: input.environment,
        accountId: commerceBinding.accountId,
        paymentId: commerceBinding.paymentId,
      },
    };
  }
}

interface NormalizedWechatBusinessCallback {
  readonly merchantId: string;
  readonly outTradeNo: string;
  readonly transactionId: string | null;
  readonly refundId?: string;
  readonly businessEventType: "payment.captured" | "payment.refunded" | "payment.cancelled" | "payment.revoked";
  readonly occurredAt: string;
  readonly orderAmountMinor?: number;
  readonly eventAmountMinor?: number;
  readonly currency?: string;
}

function normalizeWechatBusinessCallback(
  providerEventType: string,
  payload: Record<string, unknown>,
  callback: Record<string, unknown>,
  callbackTimestampSeconds: number,
): NormalizedWechatBusinessCallback {
  const merchantId = requiredString(payload.mchid, "WeChat payment event mchid", 64);
  const outTradeNo = requiredString(payload.out_trade_no, "WeChat payment event out_trade_no", 64);
  const transactionId = optionalWechatIdentifier(payload.transaction_id, "WeChat payment event transaction_id");
  const amount = payload.amount === undefined ? undefined : objectField(payload.amount, "WeChat payment event amount");
  const orderAmount = amount?.total;
  const refundAmount = amount?.refund;
  if (orderAmount !== undefined && (!Number.isSafeInteger(orderAmount) || (orderAmount as number) <= 0)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat payment event order amount is invalid");
  }
  if (refundAmount !== undefined && (!Number.isSafeInteger(refundAmount) || (refundAmount as number) <= 0)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat refund amount is invalid");
  }
  const currency = amount?.currency === undefined
    ? undefined
    : requiredString(amount.currency, "WeChat payment event currency", 3);
  if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat payment event currency is invalid");
  }
  const callbackCreatedAt = optionalWechatTimestamp(callback.create_time) ??
    new Date(callbackTimestampSeconds * 1_000).toISOString();
  if (providerEventType === "TRANSACTION.SUCCESS") {
    if (requiredString(payload.trade_state, "WeChat transaction trade_state", 32) !== "SUCCESS" ||
        transactionId === null || orderAmount === undefined || currency === undefined) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat capture event is incomplete or not successful");
    }
    return {
      merchantId,
      outTradeNo,
      transactionId,
      businessEventType: "payment.captured",
      occurredAt: requiredWechatTimestamp(payload.success_time, "WeChat success_time"),
      orderAmountMinor: orderAmount as number,
      eventAmountMinor: orderAmount as number,
      currency,
    };
  }
  if (providerEventType === "REFUND.SUCCESS") {
    if (requiredString(payload.refund_status, "WeChat refund_status", 32) !== "SUCCESS" || refundAmount === undefined) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat refund event is incomplete or not successful");
    }
    return {
      merchantId,
      outTradeNo,
      transactionId,
      refundId: requiredString(payload.refund_id, "WeChat refund_id", 64),
      businessEventType: "payment.refunded",
      occurredAt: requiredWechatTimestamp(payload.success_time, "WeChat refund success_time"),
      ...(orderAmount === undefined ? {} : { orderAmountMinor: orderAmount as number }),
      eventAmountMinor: refundAmount as number,
      ...(currency === undefined ? {} : { currency }),
    };
  }
  if (providerEventType === "TRANSACTION.CLOSED" || providerEventType === "TRANSACTION.REVOKED") {
    const expectedState = providerEventType === "TRANSACTION.CLOSED" ? "CLOSED" : "REVOKED";
    if (payload.trade_state !== undefined && payload.trade_state !== expectedState) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat terminal transaction state does not match event_type");
    }
    return {
      merchantId,
      outTradeNo,
      transactionId,
      businessEventType: providerEventType === "TRANSACTION.CLOSED" ? "payment.cancelled" : "payment.revoked",
      occurredAt: callbackCreatedAt,
      ...(orderAmount === undefined ? {} : { orderAmountMinor: orderAmount as number }),
      ...(currency === undefined ? {} : { currency }),
    };
  }
  throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat payment callback event_type is unsupported");
}

function optionalWechatIdentifier(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return identifier(requiredString(value, field, 128), field);
}

function requiredWechatTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field, 64);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `${field} is invalid`);
  return new Date(milliseconds).toISOString();
}

function optionalWechatTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredWechatTimestamp(value, "WeChat callback create_time");
}

function decryptWechatResource(resource: Record<string, unknown>, apiKey: Buffer): Buffer {
  const nonce = requiredString(resource.nonce, "WeChat resource nonce", 32);
  const associatedData = requiredString(resource.associated_data, "WeChat resource associated_data", 1_024);
  const ciphertext = decodeBase64(requiredString(resource.ciphertext, "WeChat resource ciphertext", 1_048_576));
  if (Buffer.byteLength(nonce, "utf8") !== 12 || ciphertext.byteLength <= 16) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat encrypted resource has invalid nonce or ciphertext");
  }
  const encrypted = ciphertext.subarray(0, ciphertext.byteLength - 16);
  const tag = ciphertext.subarray(ciphertext.byteLength - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", apiKey, Buffer.from(nonce, "utf8"));
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "WeChat encrypted resource authentication failed");
  }
}

function decodeBase64Signature(value: string): Buffer {
  const signature = decodeBase64(boundedHeader(value, "Wechatpay-Signature", 1_024));
  if (signature.byteLength < 128 || signature.byteLength > 1_024) {
    throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "WeChat signature length is invalid");
  }
  return signature;
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "provider base64 field is invalid");
  }
  const bytes = Buffer.from(value, "base64");
  const canonicalInput = value.replace(/=+$/, "");
  const canonicalOutput = bytes.toString("base64").replace(/=+$/, "");
  if (bytes.byteLength === 0 || canonicalInput.length !== canonicalOutput.length ||
      !timingSafeEqual(Buffer.from(canonicalInput), Buffer.from(canonicalOutput))) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "provider base64 field is non-canonical");
  }
  return bytes;
}

function parseCallbackTimestamp(value: string): number {
  if (!/^\d{10}$/.test(value)) {
    throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "Wechatpay-Timestamp is invalid");
  }
  return Number(value);
}

function boundedHeader(value: string, name: string, maximum: number): string {
  if (value.length === 0 || value.length > maximum || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `${name} is invalid`);
  }
  return value;
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function verifyWechatSignedResponse(
  headers: Headers,
  rawBody: Uint8Array,
  platformKeys: WechatPlatformKeyResolver,
  now: Date,
  maximumClockSkewSeconds: number,
): Promise<void> {
  const timestamp = boundedHeader(headers.get("wechatpay-timestamp") ?? "", "Wechatpay-Timestamp", 16);
  const timestampSeconds = parseCallbackTimestamp(timestamp);
  if (Math.abs(Math.floor(now.getTime() / 1_000) - timestampSeconds) > maximumClockSkewSeconds) {
    throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "WeChat API response timestamp is outside the accepted window");
  }
  const nonce = boundedHeader(headers.get("wechatpay-nonce") ?? "", "Wechatpay-Nonce", 256);
  const serial = boundedHeader(headers.get("wechatpay-serial") ?? "", "Wechatpay-Serial", 128);
  const signature = decodeBase64Signature(headers.get("wechatpay-signature") ?? "");
  const material = await platformKeys.resolve(serial);
  let publicKey;
  try {
    const text = typeof material === "string" ? material : material.toString("utf8");
    publicKey = text.includes("BEGIN CERTIFICATE")
      ? new X509Certificate(text).publicKey
      : createPublicKey(material);
  } catch {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", "WeChat response platform key is invalid");
  }
  const message = Buffer.concat([
    Buffer.from(timestamp), Buffer.from("\n"), Buffer.from(nonce), Buffer.from("\n"),
    Buffer.from(rawBody), Buffer.from("\n"),
  ]);
  if (!cryptoVerify("RSA-SHA256", message, publicKey, signature)) {
    throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "WeChat API response signature is invalid");
  }
}
