import {
  Environment as AppleEnvironment,
  SignedDataVerifier,
  VerificationException,
} from "@apple/app-store-server-library";
import type { VerifiedBusinessEvent } from "@ltm/core";
import type { EvidenceEnvironment, StoreTransactionEvidenceBinding, SignedCapabilityEvidence } from "./evidence.js";
import type { SecretReference } from "./external-evidence-adapters.js";
import type { TrustedCommerceBindingResolver } from "./commerce-bindings.js";
import {
  ProductionIntegrationError,
  attestVerifiedBusinessEvent,
  identifier,
  parseJsonObject,
  requiredString,
  sha256,
  storeVerifiedArtifact,
  type EvidenceArtifactStore,
  type EvidenceAttestor,
  type ReplayStore,
  type SecretResolver,
} from "./production-common.js";

export interface AppleStoreIntegrationOptions {
  readonly bundleId: string;
  readonly appAppleId?: number;
  readonly appleRootCertificateReferences: readonly SecretReference[];
  readonly enableOnlineCertificateChecks: boolean;
  readonly clock?: () => Date;
}

export interface VerifyAppleTransactionInput {
  readonly tenantId: string;
  readonly environment: EvidenceEnvironment;
  readonly signedTransaction: string;
  readonly expectedTransactionId: string;
  readonly expectedProductId?: string;
  readonly expectedAppAccountToken?: string;
  readonly requireActiveEntitlement?: boolean;
}

export interface AppleTransactionReceipt {
  readonly transactionId: string;
  readonly originalTransactionId: string;
  readonly productId: string;
  readonly purchaseDate: string;
  readonly expiresAt: string | null;
  readonly environment: EvidenceEnvironment;
  readonly accountId?: string;
}

export interface VerifiedAppleTransaction {
  readonly evidence: SignedCapabilityEvidence<StoreTransactionEvidenceBinding>;
  readonly receipt: AppleTransactionReceipt;
}

/** Native Apple x5c/JWS verification followed by a separately signed LTM attestation. */
export class AppleStoreEvidenceIntegration {
  readonly #clock: () => Date;

  constructor(
    private readonly options: AppleStoreIntegrationOptions,
    private readonly secrets: SecretResolver,
    private readonly artifacts: EvidenceArtifactStore,
    private readonly attestor: EvidenceAttestor,
    private readonly commerceBindings?: TrustedCommerceBindingResolver,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/.test(options.bundleId)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Apple bundleId is invalid");
    }
    if (options.appleRootCertificateReferences.length === 0 || options.appleRootCertificateReferences.length > 8) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "one to eight Apple root certificates are required");
    }
    if (options.appAppleId !== undefined && (!Number.isSafeInteger(options.appAppleId) || options.appAppleId <= 0)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Apple appAppleId must be a positive integer");
    }
    this.#clock = options.clock ?? (() => new Date());
  }

  async verifyAndAttest(input: VerifyAppleTransactionInput): Promise<VerifiedAppleTransaction> {
    identifier(input.tenantId, "tenantId");
    identifier(input.expectedTransactionId, "expectedTransactionId");
    if (input.environment === "production") {
      if (!this.options.enableOnlineCertificateChecks) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", "production Apple verification requires online certificate checks");
      }
      if (this.options.appAppleId === undefined) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", "production Apple verification requires appAppleId");
      }
    }
    if (input.signedTransaction.length < 100 || input.signedTransaction.length > 64 * 1_024 || input.signedTransaction.split(".").length !== 3) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple signedTransaction is not a bounded compact JWS");
    }
    const roots = await Promise.all(this.options.appleRootCertificateReferences.map(async (reference) =>
      Buffer.from(await this.secrets.resolve(reference))));
    const verifier = new SignedDataVerifier(
      roots,
      this.options.enableOnlineCertificateChecks,
      appleEnvironment(input.environment),
      this.options.bundleId,
      this.options.appAppleId,
    );
    let transaction;
    try {
      transaction = await verifier.verifyAndDecodeTransaction(input.signedTransaction);
    } catch (error) {
      throw new ProductionIntegrationError(
        "PROVIDER_SIGNATURE_INVALID",
        error instanceof VerificationException
          ? `Apple transaction JWS verification failed with status ${error.status}`
          : "Apple transaction JWS verification failed",
      );
    }
    const transactionId = requiredAppleField(transaction.transactionId, "transactionId");
    const originalTransactionId = requiredAppleField(transaction.originalTransactionId, "originalTransactionId");
    const productId = requiredAppleField(transaction.productId, "productId");
    if (transactionId !== input.expectedTransactionId) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple transaction does not match the expected transaction ID");
    }
    if (input.expectedProductId !== undefined && productId !== input.expectedProductId) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple transaction does not match the expected product");
    }
    if (input.expectedAppAccountToken !== undefined && transaction.appAccountToken !== input.expectedAppAccountToken) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple transaction does not match the expected account token");
    }
    const expectedNativeEnvironment = appleEnvironment(input.environment);
    if (transaction.environment !== expectedNativeEnvironment) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple transaction environment does not match the requested environment");
    }
    if (transaction.revocationDate !== undefined || transaction.revocationReason !== undefined) {
      throw new ProductionIntegrationError("PROVIDER_REJECTED", "Apple transaction has been revoked");
    }
    const now = this.#clock().getTime();
    if (input.requireActiveEntitlement === true && transaction.expiresDate !== undefined && transaction.expiresDate <= now) {
      throw new ProductionIntegrationError("PROVIDER_REJECTED", "Apple subscription entitlement has expired");
    }
    if (!Number.isSafeInteger(transaction.purchaseDate) || (transaction.purchaseDate ?? 0) <= 0) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple transaction purchaseDate is invalid");
    }
    const commerceBinding = this.commerceBindings === undefined ? undefined : await this.commerceBindings.resolveApple({
      transactionId,
      originalTransactionId,
      productId,
      appAccountToken: transaction.appAccountToken ?? null,
    });
    if (commerceBinding !== undefined && commerceBinding.tenantId !== input.tenantId) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple transaction belongs to a different tenant");
    }
    const artifact = Buffer.from(input.signedTransaction, "utf8");
    const binding: StoreTransactionEvidenceBinding = {
      tenantId: input.tenantId,
      batchId: "B66",
      operation: "verifyStoreTransaction",
      kind: "store-transaction",
      provider: "apple-app-store",
      artifactSha256: sha256(artifact),
      environment: input.environment,
      subjectId: transactionId,
    };
    await storeVerifiedArtifact(this.artifacts, binding, artifact, "financial");
    const evidence = await this.attestor.attest(binding, artifact);
    return {
      evidence,
      receipt: {
        transactionId,
        originalTransactionId,
        productId,
        purchaseDate: new Date(transaction.purchaseDate as number).toISOString(),
        expiresAt: transaction.expiresDate === undefined ? null : new Date(transaction.expiresDate).toISOString(),
        environment: input.environment,
        ...(commerceBinding === undefined ? {} : { accountId: commerceBinding.accountId }),
      },
    };
  }
}

function requiredAppleField(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === "" || value.length > 512) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `Apple transaction ${field} is missing or invalid`);
  }
  return value;
}

const ENTITLEMENT_NOTIFICATION_EVENTS: Readonly<Record<string, string>> = {
  SUBSCRIBED: "entitlement.granted",
  DID_RENEW: "entitlement.renewed",
  OFFER_REDEEMED: "entitlement.renewed",
  ONE_TIME_CHARGE: "entitlement.granted",
  DID_FAIL_TO_RENEW: "entitlement.billing_retry",
  GRACE_PERIOD_EXPIRED: "entitlement.expired",
  EXPIRED: "entitlement.expired",
  REFUND: "entitlement.refunded",
  REVOKE: "entitlement.revoked",
  REFUND_REVERSED: "entitlement.restored",
};

export interface VerifyAppleNotificationInput {
  readonly tenantId: string;
  readonly environment: EvidenceEnvironment;
  /** Exact UTF-8 JSON request body received from Apple. */
  readonly rawBody: Uint8Array;
}

export type AppleNotificationResult =
  | {
      readonly disposition: "attested";
      readonly notificationId: string;
      readonly notificationType: string;
      readonly evidence: SignedCapabilityEvidence<StoreTransactionEvidenceBinding>;
      readonly businessEvent: VerifiedBusinessEvent;
      readonly receipt: AppleTransactionReceipt;
    }
  | {
      readonly disposition: "ignored";
      readonly notificationId: string;
      readonly notificationType: string;
    };

/** Verifies App Store Server Notifications V2 and stores the exact callback bytes. */
export class AppleStoreNotificationIntegration {
  readonly #clock: () => Date;

  constructor(
    private readonly options: AppleStoreIntegrationOptions,
    private readonly secrets: SecretResolver,
    private readonly replays: ReplayStore,
    private readonly artifacts: EvidenceArtifactStore,
    private readonly attestor: EvidenceAttestor,
    private readonly commerceBindings?: TrustedCommerceBindingResolver,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/.test(options.bundleId)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Apple bundleId is invalid");
    }
    if (options.appleRootCertificateReferences.length === 0 || options.appleRootCertificateReferences.length > 8) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "one to eight Apple root certificates are required");
    }
    if (options.appAppleId !== undefined && (!Number.isSafeInteger(options.appAppleId) || options.appAppleId <= 0)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Apple appAppleId must be a positive integer");
    }
    this.#clock = options.clock ?? (() => new Date());
  }

  async verifyAndAttest(input: VerifyAppleNotificationInput): Promise<AppleNotificationResult> {
    identifier(input.tenantId, "tenantId");
    if (input.environment === "production" && (!this.options.enableOnlineCertificateChecks || this.options.appAppleId === undefined)) {
      throw new ProductionIntegrationError(
        "CONFIGURATION_INVALID",
        "production Apple notifications require online certificate checks and appAppleId",
      );
    }
    if (input.rawBody.byteLength === 0 || input.rawBody.byteLength > 1_048_576) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple notification body size is invalid");
    }
    const body = parseJsonObject(input.rawBody, "Apple notification body");
    const signedPayload = requiredString(body.signedPayload, "Apple signedPayload", 256 * 1_024);
    if (signedPayload.split(".").length !== 3) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple signedPayload is not a compact JWS");
    }
    const roots = await Promise.all(this.options.appleRootCertificateReferences.map(async (reference) =>
      Buffer.from(await this.secrets.resolve(reference))));
    const verifier = new SignedDataVerifier(
      roots,
      this.options.enableOnlineCertificateChecks,
      appleEnvironment(input.environment),
      this.options.bundleId,
      this.options.appAppleId,
    );
    let notification;
    try {
      notification = await verifier.verifyAndDecodeNotification(signedPayload);
    } catch (error) {
      throw new ProductionIntegrationError(
        "PROVIDER_SIGNATURE_INVALID",
        error instanceof VerificationException
          ? `Apple notification JWS verification failed with status ${error.status}`
          : "Apple notification JWS verification failed",
      );
    }
    const notificationId = requiredAppleField(notification.notificationUUID, "notificationUUID");
    const notificationType = requiredAppleField(notification.notificationType, "notificationType");
    const expectedEnvironment = appleEnvironment(input.environment);
    if (notification.data?.environment !== expectedEnvironment || notification.data.bundleId !== this.options.bundleId) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple notification app/environment binding is invalid");
    }
    const businessEventType = ENTITLEMENT_NOTIFICATION_EVENTS[notificationType];
    if (businessEventType === undefined) {
      const artifactSha256 = sha256(input.rawBody);
      const stored = await this.artifacts.put({
        tenantId: input.tenantId,
        provider: "apple-app-store",
        subjectId: notificationId,
        artifact: input.rawBody,
        sha256: artifactSha256,
        retentionClass: "financial",
      });
      if (stored.sha256 !== artifactSha256 || stored.uri.trim() === "") {
        throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple notification artifact storage was not confirmed");
      }
      await claimAppleNotification(this.replays, this.options.bundleId, notificationId, this.#clock());
      return { disposition: "ignored", notificationId, notificationType };
    }
    const signedTransaction = requiredAppleField(notification.data?.signedTransactionInfo, "signedTransactionInfo");
    let transaction;
    try {
      transaction = await verifier.verifyAndDecodeTransaction(signedTransaction);
    } catch (error) {
      throw new ProductionIntegrationError(
        "PROVIDER_SIGNATURE_INVALID",
        error instanceof VerificationException
          ? `Apple transaction JWS verification failed with status ${error.status}`
          : "Apple transaction JWS verification failed",
      );
    }
    const transactionId = requiredAppleField(transaction.transactionId, "transactionId");
    const originalTransactionId = requiredAppleField(transaction.originalTransactionId, "originalTransactionId");
    const productId = requiredAppleField(transaction.productId, "productId");
    if (transaction.environment !== expectedEnvironment || transaction.bundleId !== this.options.bundleId) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple transaction app/environment binding is invalid");
    }
    if (!Number.isSafeInteger(transaction.purchaseDate) || (transaction.purchaseDate ?? 0) <= 0) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple transaction purchaseDate is invalid");
    }
    if (this.commerceBindings === undefined) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Apple business callbacks require a trusted commerce binding resolver");
    }
    const commerceBinding = await this.commerceBindings.resolveApple({
      transactionId,
      originalTransactionId,
      productId,
      appAccountToken: transaction.appAccountToken ?? null,
    });
    if (commerceBinding.tenantId !== input.tenantId) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple notification transaction belongs to a different tenant");
    }
    const binding: StoreTransactionEvidenceBinding = {
      tenantId: input.tenantId,
      batchId: "B66",
      operation: "verifyStoreTransaction",
      kind: "store-transaction",
      provider: "apple-app-store",
      artifactSha256: sha256(input.rawBody),
      environment: input.environment,
      subjectId: transactionId,
    };
    await storeVerifiedArtifact(this.artifacts, binding, input.rawBody, "financial");
    const providerOccurredAtMs = notification.signedDate ?? transaction.signedDate ?? transaction.purchaseDate;
    if (!Number.isSafeInteger(providerOccurredAtMs) || (providerOccurredAtMs ?? 0) <= 0) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Apple notification signed date is invalid");
    }
    const attested = await attestVerifiedBusinessEvent(this.attestor, binding, input.rawBody, {
      eventId: notificationId,
      subjectType: "account",
      subjectId: commerceBinding.accountId,
      eventType: businessEventType,
      providerOccurredAt: new Date(providerOccurredAtMs as number).toISOString(),
      sequence: providerOccurredAtMs as number,
      correlationId: originalTransactionId,
      canonicalClaims: {
        accountId: commerceBinding.accountId,
        productId,
        transactionId,
        originalTransactionId,
        expiresAt: transaction.expiresDate === undefined ? null : new Date(transaction.expiresDate).toISOString(),
        purchaseDate: new Date(transaction.purchaseDate as number).toISOString(),
        notificationType,
        ...(transaction.revocationDate === undefined
          ? {}
          : { revocationDate: new Date(transaction.revocationDate).toISOString() }),
        ...(transaction.revocationReason === undefined ? {} : { revocationReason: transaction.revocationReason }),
      },
    });
    await claimAppleNotification(this.replays, this.options.bundleId, notificationId, this.#clock());
    return {
      disposition: "attested",
      notificationId,
      notificationType,
      evidence: attested.evidence,
      businessEvent: attested.event,
      receipt: {
        transactionId,
        originalTransactionId,
        productId,
        purchaseDate: new Date(transaction.purchaseDate as number).toISOString(),
        expiresAt: transaction.expiresDate === undefined ? null : new Date(transaction.expiresDate).toISOString(),
        environment: input.environment,
        accountId: commerceBinding.accountId,
      },
    };
  }
}

async function claimAppleNotification(
  replays: ReplayStore,
  bundleId: string,
  notificationId: string,
  now: Date,
): Promise<void> {
  const claimed = await replays.claimOnce(
    `apple-notification:${bundleId}`,
    notificationId,
    new Date(now.getTime() + 6 * 24 * 60 * 60_000),
  );
  if (!claimed) throw new ProductionIntegrationError("PROVIDER_REPLAY_DETECTED", "Apple notification has already been processed");
}

function appleEnvironment(environment: EvidenceEnvironment): AppleEnvironment {
  return environment === "production" ? AppleEnvironment.PRODUCTION : AppleEnvironment.SANDBOX;
}
