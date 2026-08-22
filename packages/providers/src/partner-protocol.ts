import {
  createHmac,
  createPublicKey,
  randomUUID,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import type {
  CapabilityEvidenceBinding,
  SignedCapabilityEvidence,
} from "./evidence.js";
import type { SecretReference } from "./external-evidence-adapters.js";
import {
  FetchHttpTransport,
  ProductionIntegrationError,
  attestVerifiedBusinessEvent,
  assertProductionEndpoint,
  parseJsonObject,
  requiredString,
  sha256,
  storeVerifiedArtifact,
  type EvidenceArtifactStore,
  type EvidenceAttestor,
  type AttestedBusinessEvent,
  type BusinessEventDraft,
  type HttpTransport,
  type ReplayStore,
  type SecretResolver,
} from "./production-common.js";

type WithoutArtifact<T> = T extends CapabilityEvidenceBinding ? Omit<T, "artifactSha256"> : never;
export type CapabilityEvidenceBindingTemplate = WithoutArtifact<CapabilityEvidenceBinding>;

export type PartnerWebhookSignatureScheme = "hmac-sha256" | "ed25519" | "es256";

export interface PartnerWebhookPolicy<Binding extends CapabilityEvidenceBindingTemplate> {
  readonly provider: Binding["provider"];
  readonly signatureScheme: PartnerWebhookSignatureScheme;
  readonly verificationKeyReference: SecretReference;
  readonly maximumClockSkewSeconds?: number;
  readonly retentionClass: "financial" | "release" | "operational";
  /** Must validate native event type, subject, state, totals and any provider-specific invariants. */
  validate(payload: Readonly<Record<string, unknown>>, binding: Binding): void | Promise<void>;
}

export interface VerifyPartnerWebhookInput<Binding extends CapabilityEvidenceBindingTemplate> {
  readonly binding: Binding;
  readonly rawBody: Uint8Array;
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
}

/**
 * LTM Provider Webhook v1. This is an executable contract for custom tax,
 * notification, print/logistics, CRM/cloud, assurance and control-plane adapters.
 */
export class SignedPartnerWebhookIntegration<Binding extends CapabilityEvidenceBindingTemplate> {
  readonly #clock: () => Date;
  readonly #clockSkew: number;

  constructor(
    private readonly policy: PartnerWebhookPolicy<Binding>,
    private readonly secrets: SecretResolver,
    private readonly replays: ReplayStore,
    private readonly artifacts: EvidenceArtifactStore,
    private readonly attestor: EvidenceAttestor,
    clock: () => Date = () => new Date(),
  ) {
    this.#clock = clock;
    this.#clockSkew = policy.maximumClockSkewSeconds ?? 300;
    if (!Number.isSafeInteger(this.#clockSkew) || this.#clockSkew < 30 || this.#clockSkew > 900) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner webhook clock skew must be between 30 and 900 seconds");
    }
  }

  async verifyAndAttest(input: VerifyPartnerWebhookInput<Binding>): Promise<SignedCapabilityEvidence> {
    const verified = await this.#verify(input);
    const evidence = await this.attestor.attest(verified.binding, input.rawBody);
    await this.#claim(verified);
    return evidence;
  }

  async verifyAndAttestBusinessEvent(
    input: VerifyPartnerWebhookInput<Binding>,
    event: BusinessEventDraft,
  ): Promise<AttestedBusinessEvent> {
    const verified = await this.#verify(input);
    const attested = await attestVerifiedBusinessEvent(this.attestor, verified.binding, input.rawBody, event);
    await this.#claim(verified);
    return attested;
  }

  async #verify(input: VerifyPartnerWebhookInput<Binding>): Promise<{
    readonly binding: CapabilityEvidenceBinding;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly replayValue: string;
    readonly replayExpiresAt: Date;
  }> {
    if (input.binding.provider !== this.policy.provider) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner webhook provider does not match its configured policy");
    }
    if (input.rawBody.byteLength === 0 || input.rawBody.byteLength > 10_485_760) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "partner webhook body size is invalid");
    }
    const timestamp = parseUnixTimestamp(input.timestamp);
    const now = Math.floor(this.#clock().getTime() / 1_000);
    if (Math.abs(now - timestamp) > this.#clockSkew) {
      throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "partner webhook timestamp is outside the accepted window");
    }
    const nonce = safeHeader(input.nonce, "nonce", 128);
    const artifactSha256 = sha256(input.rawBody);
    const signedPayload = Buffer.from(
      `ltm-provider-webhook-v1\n${input.timestamp}\n${nonce}\n${artifactSha256}\n`,
      "utf8",
    );
    const key = Buffer.from(await this.secrets.resolve(this.policy.verificationKeyReference));
    try {
      if (!verifyPartnerSignature(this.policy.signatureScheme, signedPayload, input.signature, key)) {
        throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "partner webhook signature is invalid");
      }
    } finally {
      key.fill(0);
    }
    const payload = parseJsonObject(input.rawBody, "partner webhook body");
    await this.policy.validate(payload, input.binding);
    const binding = { ...input.binding, artifactSha256 } as CapabilityEvidenceBinding;
    await storeVerifiedArtifact(this.artifacts, binding, input.rawBody, this.policy.retentionClass);
    return {
      binding,
      payload,
      replayValue: `${input.timestamp}:${nonce}:${artifactSha256}`,
      replayExpiresAt: new Date((timestamp + this.#clockSkew * 2) * 1_000),
    };
  }

  async #claim(verified: {
    readonly binding: CapabilityEvidenceBinding;
    readonly replayValue: string;
    readonly replayExpiresAt: Date;
  }): Promise<void> {
    const claimed = await this.replays.claimOnce(
      `partner-webhook:${String(verified.binding.provider)}`,
      verified.replayValue,
      verified.replayExpiresAt,
    );
    if (!claimed) throw new ProductionIntegrationError("PROVIDER_REPLAY_DETECTED", "partner webhook has already been processed");
  }
}

export interface PartnerCommandAdapterOptions {
  readonly endpoint: URL;
  readonly signingSecretReference: SecretReference;
  /** Managed key used to verify the partner's exact response bytes. Required at runtime. */
  readonly responseVerificationKeyReference?: SecretReference;
  /** The partner receipt must use one of the authenticated webhook signature schemes. */
  readonly responseSignatureScheme?: PartnerWebhookSignatureScheme;
  readonly responseMaximumClockSkewSeconds?: number;
  readonly timeoutMs?: number;
}

export interface PartnerCommandInput {
  readonly tenantId: string;
  readonly batchId: `B${string}`;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PartnerCommandReceipt {
  readonly providerRequestId: string;
  readonly state: "accepted";
  readonly artifact: Uint8Array;
  readonly artifactSha256: string;
}

/** Outbound half of LTM Provider Webhook v1 with exact-body HMAC and idempotency. */
export class SignedPartnerCommandAdapter {
  readonly #clock: () => Date;
  readonly #responseClockSkew: number;

  constructor(
    private readonly options: PartnerCommandAdapterOptions,
    private readonly secrets: SecretResolver,
    private readonly transport: HttpTransport = new FetchHttpTransport(),
    clock: () => Date = () => new Date(),
  ) {
    assertProductionEndpoint(options.endpoint);
    if (options.responseVerificationKeyReference === undefined || options.responseSignatureScheme === undefined) {
      throw new ProductionIntegrationError(
        "CONFIGURATION_INVALID",
        "partner commands require a managed response verification key and signature scheme",
      );
    }
    this.#responseClockSkew = options.responseMaximumClockSkewSeconds ?? 300;
    if (!Number.isSafeInteger(this.#responseClockSkew) || this.#responseClockSkew < 30 || this.#responseClockSkew > 900) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner receipt clock skew must be between 30 and 900 seconds");
    }
    this.#clock = clock;
  }

  async send(input: PartnerCommandInput): Promise<PartnerCommandReceipt> {
    safeHeader(input.tenantId, "tenantId", 128);
    safeHeader(input.batchId, "batchId", 16);
    safeHeader(input.operation, "operation", 160);
    safeHeader(input.idempotencyKey, "idempotencyKey", 200);
    const timestamp = String(Math.floor(this.#clock().getTime() / 1_000));
    const nonce = randomUUID();
    const artifact = Buffer.from(JSON.stringify({
      version: "ltm-provider-command.v1",
      tenantId: input.tenantId,
      batchId: input.batchId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
    }), "utf8");
    if (artifact.byteLength > 1_048_576) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "partner command body exceeds one MiB");
    }
    const digest = sha256(artifact);
    const signingPayload = Buffer.from(`ltm-provider-command-v1\n${timestamp}\n${nonce}\n${digest}\n`, "utf8");
    const secret = Buffer.from(await this.secrets.resolve(this.options.signingSecretReference));
    let signature: string;
    try {
      if (secret.byteLength < 32) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner HMAC key must be at least 32 bytes");
      }
      signature = createHmac("sha256", secret).update(signingPayload).digest("base64");
    } finally {
      secret.fill(0);
    }
    const response = await this.transport.request({
      url: this.options.endpoint,
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "idempotency-key": input.idempotencyKey,
        "x-ltm-timestamp": timestamp,
        "x-ltm-nonce": nonce,
        "x-ltm-content-sha256": digest,
        "x-ltm-signature": signature,
      },
      body: artifact,
      timeoutMs: this.options.timeoutMs ?? 10_000,
      maximumResponseBytes: 1_048_576,
      acceptedStatuses: [200, 201, 202],
    });
    await this.#verifyReceipt(input.idempotencyKey, response.headers, response.body);
    const receipt = parseJsonObject(response.body, "partner command response");
    const providerRequestId = validatePartnerCommandReceipt(receipt);
    return {
      providerRequestId,
      state: "accepted",
      artifact: response.body,
      artifactSha256: sha256(response.body),
    };
  }

  async #verifyReceipt(idempotencyKey: string, headers: Headers, body: Uint8Array): Promise<void> {
    const timestampValue = headers.get("x-ltm-timestamp") ?? "";
    const timestamp = parseUnixTimestamp(timestampValue);
    const now = Math.floor(this.#clock().getTime() / 1_000);
    if (Math.abs(now - timestamp) > this.#responseClockSkew) {
      throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "partner receipt timestamp is outside the accepted window");
    }
    const nonce = safeHeader(headers.get("x-ltm-nonce") ?? "", "receipt nonce", 128);
    const responseIdempotencyKey = safeHeader(
      headers.get("x-ltm-idempotency-key") ?? "",
      "receipt idempotency key",
      200,
    );
    if (responseIdempotencyKey !== idempotencyKey) {
      throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "partner receipt idempotency binding is invalid");
    }
    const digest = sha256(body);
    const declaredDigest = headers.get("x-ltm-content-sha256") ?? "";
    if (!/^[a-f0-9]{64}$/.test(declaredDigest) || declaredDigest !== digest) {
      throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "partner receipt body digest is invalid");
    }
    const signedPayload = Buffer.from(
      `ltm-provider-receipt-v1\n${timestampValue}\n${nonce}\n${idempotencyKey}\n${digest}\n`,
      "utf8",
    );
    const signature = headers.get("x-ltm-signature") ?? "";
    const keyReference = this.options.responseVerificationKeyReference;
    const signatureScheme = this.options.responseSignatureScheme;
    if (keyReference === undefined || signatureScheme === undefined) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "partner receipt verifier is not configured");
    }
    const key = Buffer.from(await this.secrets.resolve(keyReference));
    try {
      if (!verifyPartnerSignature(signatureScheme, signedPayload, signature, key)) {
        throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "partner receipt signature is invalid");
      }
    } finally {
      key.fill(0);
    }
  }
}

function validatePartnerCommandReceipt(receipt: Record<string, unknown>): string {
  if (receipt.accepted !== true) {
    throw new ProductionIntegrationError("PROVIDER_REJECTED", "partner did not accept the command");
  }
  return requiredString(receipt.providerRequestId, "providerRequestId", 256);
}

function verifyPartnerSignature(
  scheme: PartnerWebhookSignatureScheme,
  payload: Buffer,
  encodedSignature: string,
  key: Buffer,
): boolean {
  const signature = decodeSignature(encodedSignature);
  if (scheme === "hmac-sha256") {
    if (key.byteLength < 32 || signature.byteLength !== 32) return false;
    return timingSafeEqual(signature, createHmac("sha256", key).update(payload).digest());
  }
  try {
    const publicKey = createPublicKey(key);
    if (scheme === "ed25519") {
      return publicKey.asymmetricKeyType === "ed25519" && cryptoVerify(null, payload, publicKey, signature);
    }
    return publicKey.asymmetricKeyType === "ec" && cryptoVerify("sha256", payload, publicKey, signature);
  } catch {
    return false;
  }
}

function decodeSignature(value: string): Buffer {
  if (value.startsWith("sha256=")) {
    const hex = value.slice(7);
    if (!/^[a-f0-9]{64}$/.test(hex)) return Buffer.alloc(0);
    return Buffer.from(hex, "hex");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return Buffer.alloc(0);
  return Buffer.from(value, "base64");
}

function parseUnixTimestamp(value: string): number {
  if (!/^\d{10}$/.test(value)) throw new ProductionIntegrationError("PROVIDER_SIGNATURE_INVALID", "partner timestamp is invalid");
  return Number(value);
}

function safeHeader(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\u0000-\u0020\u007f]/.test(normalized)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `${field} is invalid`);
  }
  return normalized;
}
