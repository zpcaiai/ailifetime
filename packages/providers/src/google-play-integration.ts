import { GoogleAuth } from "google-auth-library";
import type { VerifiedBusinessEvent } from "@ltm/core";
import type { EvidenceEnvironment, StoreTransactionEvidenceBinding, SignedCapabilityEvidence } from "./evidence.js";
import type { SecretReference } from "./external-evidence-adapters.js";
import {
  FetchHttpTransport,
  ProductionIntegrationError,
  attestVerifiedBusinessEvent,
  identifier,
  parseJsonObject,
  requiredString,
  sha256,
  storeVerifiedArtifact,
  type EvidenceArtifactStore,
  type EvidenceAttestor,
  type BusinessEventDraft,
  type HttpTransport,
  type SecretResolver,
} from "./production-common.js";

const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

export interface OAuthAccessTokenProvider {
  getAccessToken(): Promise<string>;
}

/** Uses Application Default Credentials, including workload identity, without loading a long-lived JSON key. */
export class GoogleApplicationDefaultAccessTokenProvider implements OAuthAccessTokenProvider {
  constructor(private readonly auth: GoogleAuth = new GoogleAuth({ scopes: [ANDROID_PUBLISHER_SCOPE] })) {}

  async getAccessToken(): Promise<string> {
    let token: string | null | undefined;
    try {
      token = await this.auth.getAccessToken();
    } catch {
      throw new ProductionIntegrationError("CREDENTIAL_UNAVAILABLE", "Google ADC access token could not be obtained", true);
    }
    if (typeof token !== "string" || token.length < 20 || token.length > 8_192) {
      throw new ProductionIntegrationError("CREDENTIAL_UNAVAILABLE", "Google ADC returned an invalid access token", true);
    }
    return token;
  }
}

/** Uses only a validated Google service-account record obtained from a managed secret. */
export class GoogleServiceAccountAccessTokenProvider implements OAuthAccessTokenProvider {
  constructor(
    private readonly credentialReference: SecretReference,
    private readonly secrets: SecretResolver,
  ) {}

  async getAccessToken(): Promise<string> {
    const secret = Buffer.from(await this.secrets.resolve(this.credentialReference));
    let credentials: Record<string, unknown>;
    try {
      credentials = parseJsonObject(secret, "Google service-account credential");
    } finally {
      secret.fill(0);
    }
    if (credentials.type !== "service_account") {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Google credential must be a service_account");
    }
    const clientEmail = requiredString(credentials.client_email, "Google client_email", 320);
    const privateKey = requiredString(credentials.private_key, "Google private_key", 8_192);
    const tokenUri = requiredString(credentials.token_uri, "Google token_uri", 256);
    if (!clientEmail.endsWith(".gserviceaccount.com") || !privateKey.includes("BEGIN PRIVATE KEY") || tokenUri !== "https://oauth2.googleapis.com/token") {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Google service-account credential fields are not permitted");
    }
    const auth = new GoogleAuth({
      credentials: {
        type: "service_account",
        client_email: clientEmail,
        private_key: privateKey,
        token_url: tokenUri,
        ...(typeof credentials.project_id === "string" ? { project_id: credentials.project_id } : {}),
      },
      scopes: [ANDROID_PUBLISHER_SCOPE],
    });
    let token: string | null | undefined;
    try {
      token = await auth.getAccessToken();
    } catch {
      throw new ProductionIntegrationError("CREDENTIAL_UNAVAILABLE", "Google OAuth access token could not be obtained", true);
    }
    if (typeof token !== "string" || token.length < 20 || token.length > 8_192) {
      throw new ProductionIntegrationError("CREDENTIAL_UNAVAILABLE", "Google OAuth returned an invalid access token", true);
    }
    return token;
  }
}

export interface GooglePlayIntegrationOptions {
  readonly packageName: string;
}

export interface VerifyGooglePlayTransactionInput {
  readonly tenantId: string;
  readonly environment: EvidenceEnvironment;
  readonly purchaseType: "product" | "subscription";
  readonly purchaseToken: string;
  readonly productId: string;
  readonly expectedObfuscatedAccountId?: string;
  readonly requireActiveEntitlement?: boolean;
  /** Present only for a provider-authenticated callback projected atomically into core. */
  readonly businessEvent?: BusinessEventDraft;
}

export interface GooglePlayTransactionReceipt {
  readonly tokenFingerprint: string;
  readonly purchaseType: "product" | "subscription";
  readonly productId: string;
  readonly orderId: string | null;
  readonly state: string;
  readonly acknowledged: boolean;
  readonly environment: EvidenceEnvironment;
}

export interface VerifiedGooglePlayTransaction {
  readonly evidence: SignedCapabilityEvidence<StoreTransactionEvidenceBinding>;
  readonly receipt: GooglePlayTransactionReceipt;
  readonly businessEvent?: VerifiedBusinessEvent;
}

/** Server-to-server Android Publisher verification. Purchase tokens never enter logs or evidence IDs. */
export class GooglePlayEvidenceIntegration {
  constructor(
    private readonly options: GooglePlayIntegrationOptions,
    private readonly tokens: OAuthAccessTokenProvider,
    private readonly artifacts: EvidenceArtifactStore,
    private readonly attestor: EvidenceAttestor,
    private readonly transport: HttpTransport = new FetchHttpTransport(),
  ) {
    if (!/^[A-Za-z][A-Za-z0-9_.]{2,254}$/.test(options.packageName)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Google Play packageName is invalid");
    }
  }

  async verifyAndAttest(input: VerifyGooglePlayTransactionInput): Promise<VerifiedGooglePlayTransaction> {
    identifier(input.tenantId, "tenantId");
    if (input.purchaseToken.length < 20 || input.purchaseToken.length > 4_096 || /[\u0000-\u0020\u007f]/.test(input.purchaseToken)) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play purchase token is invalid");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(input.productId)) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play productId is invalid");
    }
    const accessToken = await this.tokens.getAccessToken();
    const tokenPath = encodeURIComponent(input.purchaseToken);
    const packagePath = encodeURIComponent(this.options.packageName);
    const url = input.purchaseType === "product"
      ? new URL(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packagePath}/purchases/products/${encodeURIComponent(input.productId)}/tokens/${tokenPath}`)
      : new URL(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packagePath}/purchases/subscriptionsv2/tokens/${tokenPath}`);
    const response = await this.transport.request({
      url,
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      timeoutMs: 10_000,
      maximumResponseBytes: 1_048_576,
      acceptedStatuses: [200],
    });
    const payload = parseJsonObject(response.body, "Google Play purchase response");
    const validation = input.purchaseType === "product"
      ? validateProductPurchase(payload, input)
      : validateSubscriptionPurchase(payload, input);
    const tokenFingerprint = sha256(Buffer.from(input.purchaseToken, "utf8"));
    const binding: StoreTransactionEvidenceBinding = {
      tenantId: input.tenantId,
      batchId: "B66",
      operation: "verifyStoreTransaction",
      kind: "store-transaction",
      provider: "google-play",
      artifactSha256: sha256(response.body),
      environment: input.environment,
      subjectId: `gplay:${tokenFingerprint}`,
    };
    await storeVerifiedArtifact(this.artifacts, binding, response.body, "financial");
    const attested = input.businessEvent === undefined
      ? undefined
      : await attestVerifiedBusinessEvent(this.attestor, binding, response.body, input.businessEvent);
    const evidence = attested?.evidence ?? await this.attestor.attest(binding, response.body);
    return {
      evidence,
      receipt: {
        tokenFingerprint,
        purchaseType: input.purchaseType,
        productId: input.productId,
        orderId: validation.orderId,
        state: validation.state,
        acknowledged: validation.acknowledged,
        environment: input.environment,
      },
      ...(attested === undefined ? {} : { businessEvent: attested.event }),
    };
  }
}

interface PurchaseValidation {
  readonly orderId: string | null;
  readonly state: string;
  readonly acknowledged: boolean;
}

function validateProductPurchase(
  payload: Record<string, unknown>,
  input: VerifyGooglePlayTransactionInput,
): PurchaseValidation {
  if (payload.kind !== undefined && payload.kind !== "androidpublisher#productPurchase") {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play product response kind is invalid");
  }
  if (![0, 1, 2].includes(payload.purchaseState as number)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play product purchase state is unknown");
  }
  if (input.requireActiveEntitlement === true && payload.purchaseState !== 0) {
    throw new ProductionIntegrationError("PROVIDER_REJECTED", "Google Play product is not in PURCHASED state");
  }
  if (payload.productId !== undefined && payload.productId !== input.productId) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play product does not match the requested product");
  }
  if (payload.purchaseToken !== undefined && payload.purchaseToken !== input.purchaseToken) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play response token does not match the requested token");
  }
  assertExpectedGoogleAccount(payload.obfuscatedExternalAccountId, input.expectedObfuscatedAccountId);
  if (input.environment === "production" && payload.purchaseType === 0) {
    throw new ProductionIntegrationError("PROVIDER_REJECTED", "Google Play test purchase cannot unlock production evidence");
  }
  return {
    orderId: optionalString(payload.orderId),
    state: payload.purchaseState === 0 ? "PURCHASED" : payload.purchaseState === 1 ? "CANCELLED" : "PENDING",
    acknowledged: payload.acknowledgementState === 1,
  };
}

function validateSubscriptionPurchase(
  payload: Record<string, unknown>,
  input: VerifyGooglePlayTransactionInput,
): PurchaseValidation {
  if (payload.kind !== "androidpublisher#subscriptionPurchaseV2") {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play subscription response kind is invalid");
  }
  const state = requiredString(payload.subscriptionState, "Google subscriptionState", 80);
  const active = state === "SUBSCRIPTION_STATE_ACTIVE" || state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD";
  if (input.requireActiveEntitlement === true && !active) {
    throw new ProductionIntegrationError("PROVIDER_REJECTED", "Google Play subscription is not entitled");
  }
  if (input.environment === "production" && payload.testPurchase !== undefined) {
    throw new ProductionIntegrationError("PROVIDER_REJECTED", "Google Play test subscription cannot unlock production evidence");
  }
  const lineItems = payload.lineItems;
  if (!Array.isArray(lineItems) || !lineItems.some((item) =>
    item !== null && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).productId === input.productId)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play subscription does not contain the requested product");
  }
  const identifiers = payload.externalAccountIdentifiers;
  const accountId = identifiers !== null && typeof identifiers === "object" && !Array.isArray(identifiers)
    ? (identifiers as Record<string, unknown>).obfuscatedExternalAccountId
    : undefined;
  assertExpectedGoogleAccount(accountId, input.expectedObfuscatedAccountId);
  return {
    orderId: optionalString(payload.latestOrderId),
    state,
    acknowledged: payload.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
  };
}

function assertExpectedGoogleAccount(actual: unknown, expected: string | undefined): void {
  if (expected !== undefined && actual !== expected) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google Play purchase does not match the expected account");
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}
