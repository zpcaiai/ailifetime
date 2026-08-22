import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export * from "./evidence.js";
export * from "./external-evidence-adapters.js";
export * from "./production-common.js";
export * from "./apple-store-integration.js";
export * from "./google-play-integration.js";
export * from "./google-play-rtdn.js";
export * from "./wechat-pay-integration.js";
export * from "./partner-protocol.js";
export * from "./commerce-bindings.js";
export * from "./managed-infrastructure.js";
export * from "./operational-reports.js";

export type ProviderEnvironment = "local" | "test" | "staging" | "production";

export interface ProviderRequest {
  requestId: string;
  tenantId: string;
  idempotencyKey: string;
  region: string;
  consentReceiptIds: readonly string[];
  synthetic: boolean;
}

export interface MediaGenerationRequest extends ProviderRequest {
  sourceAssetId: string;
  targetAges: readonly number[];
  promptPolicyVersion: string;
  seed: string;
}

export interface MediaGenerationResult {
  providerRequestId: string;
  status: "accepted";
  provenanceId: string;
  estimatedMinorUnits: number;
}

export interface PaymentAuthorizationRequest extends ProviderRequest {
  paymentToken: string;
  amountMinor: number;
  currency: string;
}

export interface PaymentAuthorizationResult {
  providerPaymentId: string;
  status: "authorized";
  amountMinor: number;
  currency: string;
}

export interface NotificationSendRequest extends ProviderRequest {
  channel: "email" | "sms" | "push" | "wechat" | "in_app";
  destinationToken: string;
  templateVersion: string;
  variables: Readonly<Record<string, string>>;
}

export interface NotificationSendResult {
  providerMessageId: string;
  status: "accepted";
}

export interface FulfillmentRequest extends ProviderRequest {
  purchaseOrderId: string;
  printAssetId: string;
  specificationVersion: string;
  quantity: number;
}

export interface FulfillmentResult {
  vendorJobId: string;
  status: "accepted";
}

export interface ProviderPorts {
  generateMedia(request: MediaGenerationRequest): Promise<MediaGenerationResult>;
  authorizePayment(request: PaymentAuthorizationRequest): Promise<PaymentAuthorizationResult>;
  sendNotification(request: NotificationSendRequest): Promise<NotificationSendResult>;
  submitFulfillment(request: FulfillmentRequest): Promise<FulfillmentResult>;
  verifyWebhook(payload: Uint8Array, signature: string, secret: string): boolean;
}

export class ProviderUnavailableError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE";
  constructor(readonly providerKind: string) {
    super(`${providerKind} provider is not configured`);
    this.name = "ProviderUnavailableError";
  }
}

export class FailClosedProviderPorts implements ProviderPorts {
  async generateMedia(_request: MediaGenerationRequest): Promise<MediaGenerationResult> {
    throw new ProviderUnavailableError("media");
  }
  async authorizePayment(_request: PaymentAuthorizationRequest): Promise<PaymentAuthorizationResult> {
    throw new ProviderUnavailableError("payment");
  }
  async sendNotification(_request: NotificationSendRequest): Promise<NotificationSendResult> {
    throw new ProviderUnavailableError("notification");
  }
  async submitFulfillment(_request: FulfillmentRequest): Promise<FulfillmentResult> {
    throw new ProviderUnavailableError("fulfillment");
  }
  verifyWebhook(_payload: Uint8Array, _signature: string, _secret: string): boolean {
    return false;
  }
}

export class SandboxProviderPorts implements ProviderPorts {
  constructor(private readonly environment: ProviderEnvironment) {
    if (environment === "production") {
      throw new Error("Sandbox providers cannot run in production");
    }
  }

  async generateMedia(request: MediaGenerationRequest): Promise<MediaGenerationResult> {
    this.assertSafeRequest(request);
    if (request.targetAges.length === 0 || request.targetAges.some((age) => !Number.isInteger(age) || age < 0 || age > 100)) {
      throw new Error("target ages must be integers from 0 through 100");
    }
    return {
      providerRequestId: stableId("media", request.idempotencyKey),
      status: "accepted",
      provenanceId: stableId("provenance", `${request.sourceAssetId}:${request.seed}:${request.promptPolicyVersion}`),
      estimatedMinorUnits: request.targetAges.length * 10,
    };
  }

  async authorizePayment(request: PaymentAuthorizationRequest): Promise<PaymentAuthorizationResult> {
    this.assertSafeRequest(request);
    if (!request.paymentToken.startsWith("tok_synthetic_")) throw new Error("sandbox accepts synthetic tokens only");
    if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) throw new Error("amountMinor must be positive");
    if (!/^[A-Z]{3}$/.test(request.currency)) throw new Error("currency must be ISO 4217 format");
    return {
      providerPaymentId: stableId("payment", request.idempotencyKey),
      status: "authorized",
      amountMinor: request.amountMinor,
      currency: request.currency,
    };
  }

  async sendNotification(request: NotificationSendRequest): Promise<NotificationSendResult> {
    this.assertSafeRequest(request);
    if (!request.destinationToken.startsWith("synthetic:")) throw new Error("sandbox destination must be synthetic");
    return { providerMessageId: stableId("message", request.idempotencyKey), status: "accepted" };
  }

  async submitFulfillment(request: FulfillmentRequest): Promise<FulfillmentResult> {
    this.assertSafeRequest(request);
    if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0) throw new Error("quantity must be positive");
    return { vendorJobId: stableId("vendor", request.idempotencyKey), status: "accepted" };
  }

  verifyWebhook(payload: Uint8Array, signature: string, secret: string): boolean {
    if (secret.length < 16 || !/^[a-f0-9]{64}$/.test(signature)) return false;
    const expected = createHmac("sha256", secret).update(payload).digest();
    const supplied = Buffer.from(signature, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private assertSafeRequest(request: ProviderRequest): void {
    if (!request.synthetic) throw new Error("sandbox providers reject non-synthetic data");
    if (!request.requestId || !request.tenantId || !request.idempotencyKey || !request.region) throw new Error("provider context is incomplete");
    if (request.consentReceiptIds.length === 0) throw new Error("consent receipts are required");
  }
}

function stableId(prefix: string, source: string): string {
  return `${prefix}_${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
}
