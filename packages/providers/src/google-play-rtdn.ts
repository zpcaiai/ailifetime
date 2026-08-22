import { OAuth2Client } from "google-auth-library";
import type { VerifiedBusinessEvent } from "@ltm/core";
import type { EvidenceEnvironment, SignedCapabilityEvidence, StoreTransactionEvidenceBinding } from "./evidence.js";
import {
  ProductionIntegrationError,
  identifier,
  parseJsonObject,
  requiredString,
  sha256,
  type EvidenceArtifactStore,
  type ReplayStore,
} from "./production-common.js";
import {
  GooglePlayEvidenceIntegration,
  type GooglePlayTransactionReceipt,
} from "./google-play-integration.js";
import type { TrustedCommerceBindingResolver } from "./commerce-bindings.js";

export interface GooglePubSubOidcVerifierOptions {
  readonly audience: string;
  readonly serviceAccountEmail: string;
}

export interface GooglePushIdentityVerifier {
  verifyAuthorization(authorization: string): Promise<void>;
}

/** Verifies the Google-signed Pub/Sub push identity token and its configured service account. */
export class GooglePubSubOidcVerifier implements GooglePushIdentityVerifier {
  constructor(
    private readonly options: GooglePubSubOidcVerifierOptions,
    private readonly client: OAuth2Client = new OAuth2Client(),
  ) {
    if (!isHttpsAudience(options.audience)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Google Pub/Sub audience must be a credential-free HTTPS URL");
    }
    if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com$/.test(options.serviceAccountEmail)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Google Pub/Sub service account email is invalid");
    }
  }

  async verifyAuthorization(authorization: string): Promise<void> {
    const match = /^Bearer ([A-Za-z0-9._~-]{100,8192})$/.exec(authorization);
    if (match === null) {
      throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "Google Pub/Sub bearer token is missing or invalid");
    }
    try {
      const ticket = await this.client.verifyIdToken({ idToken: match[1] as string, audience: this.options.audience });
      const payload = ticket.getPayload();
      if (payload === undefined || payload.email !== this.options.serviceAccountEmail || payload.email_verified !== true) {
        throw new Error("identity mismatch");
      }
    } catch {
      throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "Google Pub/Sub identity token verification failed");
    }
  }
}

export interface GooglePlayRtdnOptions {
  readonly packageName: string;
  readonly subscription: string;
  readonly clock?: () => Date;
}

export interface VerifyGooglePlayRtdnInput {
  readonly tenantId: string;
  readonly environment: EvidenceEnvironment;
  readonly authorization: string;
  /** Exact UTF-8 Pub/Sub push request body. */
  readonly rawBody: Uint8Array;
}

export type GooglePlayRtdnResult =
  | {
      readonly disposition: "attested";
      readonly messageId: string;
      readonly eventKind: "product" | "subscription";
      readonly evidence: SignedCapabilityEvidence<StoreTransactionEvidenceBinding>;
      readonly businessEvent: VerifiedBusinessEvent;
      readonly receipt: GooglePlayTransactionReceipt & { readonly accountId: string };
    }
  | {
      readonly disposition: "ignored";
      readonly messageId: string;
      readonly eventKind: "test";
    };

/**
 * Real-time Developer Notifications receiver. The Pub/Sub envelope is authenticated,
 * replay-claimed and stored exactly; positive events are then revalidated with the
 * Android Publisher API before evidence is issued.
 */
export class GooglePlayRtdnIntegration {
  readonly #clock: () => Date;

  constructor(
    private readonly options: GooglePlayRtdnOptions,
    private readonly identity: GooglePushIdentityVerifier,
    private readonly purchases: GooglePlayEvidenceIntegration,
    private readonly replays: ReplayStore,
    private readonly artifacts: EvidenceArtifactStore,
    private readonly commerceBindings: TrustedCommerceBindingResolver,
  ) {
    if (!/^[A-Za-z][A-Za-z0-9_.]{2,254}$/.test(options.packageName)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Google Play packageName is invalid");
    }
    if (!/^projects\/[A-Za-z0-9._:-]{1,256}\/subscriptions\/[A-Za-z0-9._~-]{1,255}$/.test(options.subscription)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Google Pub/Sub subscription is invalid");
    }
    this.#clock = options.clock ?? (() => new Date());
  }

  async verifyAndAttest(input: VerifyGooglePlayRtdnInput): Promise<GooglePlayRtdnResult> {
    identifier(input.tenantId, "tenantId");
    if (input.rawBody.byteLength === 0 || input.rawBody.byteLength > 1_048_576) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Pub/Sub body size is invalid");
    }
    await this.identity.verifyAuthorization(input.authorization);
    const envelope = parseJsonObject(input.rawBody, "Google Pub/Sub push body");
    if (requiredString(envelope.subscription, "Google Pub/Sub subscription", 768) !== this.options.subscription) {
      throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "Google Pub/Sub subscription binding is invalid");
    }
    const message = objectField(envelope.message, "Google Pub/Sub message");
    const messageId = identifier(requiredString(message.messageId, "Google Pub/Sub messageId", 128), "messageId");
    validatePublishTime(requiredString(message.publishTime, "Google Pub/Sub publishTime", 64), this.#clock());
    const notificationBytes = decodeCanonicalBase64(requiredString(message.data, "Google Pub/Sub message data", 1_048_576));
    const notification = parseJsonObject(notificationBytes, "Google Play developer notification");
    if (requiredString(notification.packageName, "Google Play packageName", 255) !== this.options.packageName) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play notification package does not match the configured app");
    }
    const eventTimeMillis = validateEventTime(requiredString(notification.eventTimeMillis, "Google Play eventTimeMillis", 32), this.#clock());
    const event = notificationEvent(notification);
    await storeRawPush(this.artifacts, input.tenantId, messageId, input.rawBody);
    if (event.kind === "test") {
      await this.#claim(messageId);
      return { disposition: "ignored", messageId, eventKind: event.kind };
    }
    const tokenFingerprint = sha256(Buffer.from(event.purchaseToken, "utf8"));
    let purchaseType: "product" | "subscription";
    let productId: string;
    let commerceBinding;
    if (event.kind === "voided-purchase") {
      const voidedBinding = await this.commerceBindings.resolveGoogleVoided({
          purchaseTokenSha256: tokenFingerprint,
          orderId: event.orderId,
          providerProductType: event.productType,
        });
      purchaseType = voidedBinding.purchaseType;
      productId = voidedBinding.productId;
      commerceBinding = voidedBinding;
    } else {
      purchaseType = event.kind;
      productId = event.productId;
      commerceBinding = await this.commerceBindings.resolveGoogle({
          purchaseTokenSha256: tokenFingerprint,
          productId: event.productId,
          purchaseType: event.kind,
        });
    }
    if (commerceBinding.tenantId !== input.tenantId) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play purchase belongs to a different tenant");
    }
    const businessEventType = googleBusinessEventType(event);
    const verified = await this.purchases.verifyAndAttest({
      tenantId: input.tenantId,
      environment: input.environment,
      purchaseType,
      purchaseToken: event.purchaseToken,
      productId,
      ...(commerceBinding.expectedObfuscatedAccountId === undefined
        ? {}
        : { expectedObfuscatedAccountId: commerceBinding.expectedObfuscatedAccountId }),
      requireActiveEntitlement: false,
      businessEvent: {
        eventId: messageId,
        subjectType: "account",
        subjectId: commerceBinding.accountId,
        eventType: businessEventType,
        providerOccurredAt: new Date(eventTimeMillis).toISOString(),
        sequence: eventTimeMillis,
        correlationId: event.kind === "voided-purchase" ? event.orderId : `gplay:${tokenFingerprint}`,
        canonicalClaims: {
          accountId: commerceBinding.accountId,
          productId,
          transactionId: `gplay:${tokenFingerprint}`,
          purchaseType,
          notificationType: event.notificationType,
          ...(event.kind === "voided-purchase"
            ? { orderId: event.orderId, refundType: event.refundType }
            : {}),
        },
      },
    });
    if (verified.businessEvent === undefined) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Google callback attestor did not return a bound business event");
    }
    await this.#claim(messageId);
    return {
      disposition: "attested",
      messageId,
      eventKind: purchaseType,
      evidence: verified.evidence,
      businessEvent: verified.businessEvent,
      receipt: { ...verified.receipt, accountId: commerceBinding.accountId },
    };
  }

  async #claim(messageId: string): Promise<void> {
    const claimed = await this.replays.claimOnce(
      `google-play-rtdn:${this.options.subscription}`,
      messageId,
      new Date(this.#clock().getTime() + 7 * 24 * 60 * 60_000),
    );
    if (!claimed) {
      throw new ProductionIntegrationError("PROVIDER_REPLAY_DETECTED", "Google Play notification has already been processed");
    }
  }
}

type NotificationEvent =
  | { readonly kind: "product"; readonly purchaseToken: string; readonly productId: string; readonly notificationType: number }
  | { readonly kind: "subscription"; readonly purchaseToken: string; readonly productId: string; readonly notificationType: number }
  | { readonly kind: "test" }
  | {
      readonly kind: "voided-purchase";
      readonly purchaseToken: string;
      readonly orderId: string;
      readonly productType: number;
      readonly refundType: number;
      readonly notificationType: number;
    };

function notificationEvent(notification: Record<string, unknown>): NotificationEvent {
  const candidates = [
    notification.oneTimeProductNotification,
    notification.subscriptionNotification,
    notification.testNotification,
    notification.voidedPurchaseNotification,
  ].filter((value) => value !== undefined);
  if (candidates.length !== 1) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play notification must contain exactly one event payload");
  }
  if (notification.oneTimeProductNotification !== undefined) {
    const event = objectField(notification.oneTimeProductNotification, "Google Play one-time product notification");
    const notificationType = positiveNotificationType(event.notificationType, "one-time product");
    return {
      kind: "product",
      purchaseToken: purchaseToken(event.purchaseToken),
      productId: productId(event.sku),
      notificationType,
    };
  }
  if (notification.subscriptionNotification !== undefined) {
    const event = objectField(notification.subscriptionNotification, "Google Play subscription notification");
    const notificationType = positiveNotificationType(event.notificationType, "subscription");
    return {
      kind: "subscription",
      purchaseToken: purchaseToken(event.purchaseToken),
      productId: productId(event.subscriptionId),
      notificationType,
    };
  }
  if (notification.testNotification !== undefined) {
    objectField(notification.testNotification, "Google Play test notification");
    return { kind: "test" };
  }
  const event = objectField(notification.voidedPurchaseNotification, "Google Play voided purchase notification");
  const productType = boundedNotificationNumber(event.productType, "voided productType", 1, 2);
  const refundType = boundedNotificationNumber(event.refundType, "voided refundType", 1, 2);
  return {
    kind: "voided-purchase",
    purchaseToken: purchaseToken(event.purchaseToken),
    orderId: identifier(requiredString(event.orderId, "Google Play voided orderId", 255), "voided orderId"),
    productType,
    refundType,
    notificationType: refundType,
  };
}

function positiveNotificationType(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 64) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `Google Play ${label} notificationType is invalid`);
  }
  return value as number;
}

function boundedNotificationNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `Google Play ${label} is invalid`);
  }
  return value as number;
}

function googleBusinessEventType(event: Exclude<NotificationEvent, { readonly kind: "test" }>): string {
  if (event.kind === "voided-purchase") {
    return event.productType === 1 ? "entitlement.revoked" : "entitlement.refunded";
  }
  if (event.kind === "product") {
    const mapping: Readonly<Record<number, string>> = {
      1: "entitlement.granted",
      2: "entitlement.refunded",
    };
    const result = mapping[event.notificationType];
    if (result === undefined) throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google product notification type is unsupported");
    return result;
  }
  const mapping: Readonly<Record<number, string>> = {
    1: "entitlement.restored",
    2: "entitlement.renewed",
    3: "entitlement.cancelled",
    4: "entitlement.granted",
    5: "entitlement.on_hold",
    6: "entitlement.grace",
    7: "entitlement.restored",
    8: "entitlement.renewed",
    9: "entitlement.renewed",
    10: "entitlement.on_hold",
    11: "entitlement.on_hold",
    12: "entitlement.revoked",
    13: "entitlement.expired",
    19: "entitlement.renewed",
  };
  const result = mapping[event.notificationType];
  if (result === undefined) throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google subscription notification type is unsupported");
  return result;
}

function purchaseToken(value: unknown): string {
  const token = requiredString(value, "Google Play purchaseToken", 4_096);
  if (token.length < 20 || /[\u0000-\u0020\u007f]/.test(token)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play purchaseToken is invalid");
  }
  return token;
}

function productId(value: unknown): string {
  const id = requiredString(value, "Google Play product ID", 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(id)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play product ID is invalid");
  }
  return id;
}

function validatePublishTime(value: string, now: Date): void {
  const milliseconds = Date.parse(value);
  const age = now.getTime() - milliseconds;
  if (!Number.isFinite(milliseconds) || age < -5 * 60_000 || age > 7 * 24 * 60 * 60_000) {
    throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "Google Pub/Sub publishTime is outside the accepted window");
  }
}

function validateEventTime(value: string, now: Date): number {
  if (!/^\d{10,16}$/.test(value)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play eventTimeMillis is invalid");
  }
  const milliseconds = Number(value);
  const age = now.getTime() - milliseconds;
  if (!Number.isSafeInteger(milliseconds) || age < -5 * 60_000 || age > 7 * 24 * 60 * 60_000) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play eventTimeMillis is outside the accepted window");
  }
  return milliseconds;
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Pub/Sub message data is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== value) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Pub/Sub message data is not canonical base64");
  }
  return bytes;
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function storeRawPush(
  artifacts: EvidenceArtifactStore,
  tenantId: string,
  messageId: string,
  rawBody: Uint8Array,
): Promise<void> {
  const digest = sha256(rawBody);
  const stored = await artifacts.put({
    tenantId,
    provider: "google-play-pubsub",
    subjectId: messageId,
    artifact: rawBody,
    sha256: digest,
    retentionClass: "financial",
  });
  if (stored.sha256 !== digest || stored.uri.trim() === "") {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Pub/Sub artifact storage was not confirmed");
  }
}

function isHttpsAudience(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "";
  } catch {
    return false;
  }
}
