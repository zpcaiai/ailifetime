import type {
  AssuranceEvidenceBinding,
  BusinessSystemEvidenceBinding,
  FoundationAssuranceEvidenceBinding,
  ExternalCommandCallbackEvidenceBinding,
  PaymentOperationsEvidenceBinding,
  NotificationEvidenceBinding,
  PublicationEvidenceBinding,
  SignedCapabilityEvidence,
  StoreReleaseEvidenceBinding,
  StoreTransactionEvidenceBinding,
  SupplyEvidenceBinding,
  TaxEvidenceBinding,
  WechatPaymentEvidenceBinding,
} from "./evidence.js";

export type SecretReference = `vault:${string}` | `kms:${string}` | `secret-manager:${string}`;
export type ProviderSignatureScheme =
  | "apple-jws"
  | "google-play-api"
  | "wechatpay-rsa-sha256"
  | "webhook-hmac-sha256"
  | "detached-ed25519"
  | "detached-es256"
  | "provider-api-response";

export interface ProviderSignatureMaterial {
  readonly scheme: ProviderSignatureScheme;
  readonly bytes: Uint8Array;
  readonly keyId?: string;
  readonly certificateSerial?: string;
}

export interface EvidenceVerificationRequest<Binding> {
  readonly binding: Binding;
  /** Exact provider response/request bytes whose SHA-256 is in the binding. */
  readonly artifact: Uint8Array;
  /** Opaque provider signature or signed-envelope bytes; never a client asserted boolean. */
  readonly providerSignature: ProviderSignatureMaterial;
  /** Reference only. Implementations must resolve it server-side and never log secret material. */
  readonly credentialReference: SecretReference;
  readonly receivedAt: string;
}

export interface ExternalEvidenceAdapterPorts {
  verifyExternalCommandCallback(
    request: EvidenceVerificationRequest<ExternalCommandCallbackEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<ExternalCommandCallbackEvidenceBinding>>;
  verifyPublicationEvidence(
    request: EvidenceVerificationRequest<PublicationEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<PublicationEvidenceBinding>>;
  verifyNotificationEvidence(
    request: EvidenceVerificationRequest<NotificationEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<NotificationEvidenceBinding>>;
  verifyStoreTransaction(
    request: EvidenceVerificationRequest<StoreTransactionEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<StoreTransactionEvidenceBinding>>;
  verifyWechatPaymentCallback(
    request: EvidenceVerificationRequest<WechatPaymentEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<WechatPaymentEvidenceBinding>>;
  verifyStoreRelease(
    request: EvidenceVerificationRequest<StoreReleaseEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<StoreReleaseEvidenceBinding>>;
  verifyTaxDocument(
    request: EvidenceVerificationRequest<TaxEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<TaxEvidenceBinding>>;
  verifyPaymentEvidence(
    request: EvidenceVerificationRequest<PaymentOperationsEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<PaymentOperationsEvidenceBinding>>;
  verifySupplyEvidence(
    request: EvidenceVerificationRequest<SupplyEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<SupplyEvidenceBinding>>;
  verifyBusinessSystemEvidence(
    request: EvidenceVerificationRequest<BusinessSystemEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<BusinessSystemEvidenceBinding>>;
  verifyAssuranceEvidence(
    request: EvidenceVerificationRequest<AssuranceEvidenceBinding | FoundationAssuranceEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<AssuranceEvidenceBinding | FoundationAssuranceEvidenceBinding>>;
}

export class ExternalEvidenceAdapterUnavailableError extends Error {
  readonly code = "EXTERNAL_EVIDENCE_ADAPTER_UNAVAILABLE";

  constructor(readonly adapterKind: string) {
    super(`${adapterKind} evidence adapter is not configured`);
    this.name = "ExternalEvidenceAdapterUnavailableError";
  }
}

/** Production-safe default. It never fabricates or accepts third-party receipts. */
export class FailClosedExternalEvidenceAdapterPorts implements ExternalEvidenceAdapterPorts {
  async verifyExternalCommandCallback(
    _request: EvidenceVerificationRequest<ExternalCommandCallbackEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<ExternalCommandCallbackEvidenceBinding>> {
    throw new ExternalEvidenceAdapterUnavailableError("external-command-callback");
  }

  async verifyPublicationEvidence(
    _request: EvidenceVerificationRequest<PublicationEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<PublicationEvidenceBinding>> {
    throw new ExternalEvidenceAdapterUnavailableError("publication-assurance");
  }

  async verifyNotificationEvidence(
    _request: EvidenceVerificationRequest<NotificationEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<NotificationEvidenceBinding>> {
    throw new ExternalEvidenceAdapterUnavailableError("notification-provider");
  }

  async verifyStoreTransaction(
    _request: EvidenceVerificationRequest<StoreTransactionEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<StoreTransactionEvidenceBinding>> {
    throw new ExternalEvidenceAdapterUnavailableError("store-transaction");
  }

  async verifyWechatPaymentCallback(
    _request: EvidenceVerificationRequest<WechatPaymentEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<WechatPaymentEvidenceBinding>> {
    throw new ExternalEvidenceAdapterUnavailableError("wechat-payment");
  }

  async verifyStoreRelease(
    _request: EvidenceVerificationRequest<StoreReleaseEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<StoreReleaseEvidenceBinding>> {
    throw new ExternalEvidenceAdapterUnavailableError("store-release");
  }

  async verifyTaxDocument(
    _request: EvidenceVerificationRequest<TaxEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<TaxEvidenceBinding>> {
    throw new ExternalEvidenceAdapterUnavailableError("tax-document");
  }

  async verifyPaymentEvidence(
    _request: EvidenceVerificationRequest<PaymentOperationsEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<PaymentOperationsEvidenceBinding>> {
    throw new ExternalEvidenceAdapterUnavailableError("payment-operations");
  }

  async verifySupplyEvidence(
    _request: EvidenceVerificationRequest<SupplyEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<SupplyEvidenceBinding>> {
    throw new ExternalEvidenceAdapterUnavailableError("supply-network");
  }

  async verifyBusinessSystemEvidence(
    _request: EvidenceVerificationRequest<BusinessSystemEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<BusinessSystemEvidenceBinding>> {
    throw new ExternalEvidenceAdapterUnavailableError("business-system");
  }

  async verifyAssuranceEvidence(
    _request: EvidenceVerificationRequest<AssuranceEvidenceBinding | FoundationAssuranceEvidenceBinding>,
  ): Promise<SignedCapabilityEvidence<AssuranceEvidenceBinding | FoundationAssuranceEvidenceBinding>> {
    throw new ExternalEvidenceAdapterUnavailableError("assurance-release");
  }
}

export interface ProductionCredentialGate {
  readonly adapter: string;
  readonly credentials: readonly string[];
  readonly productionEvidenceRequired: boolean;
}

export const PRODUCTION_CREDENTIAL_GATES: readonly ProductionCredentialGate[] = Object.freeze([
  { adapter: "publication-assurance", credentials: ["legal/security reviewer issuer key", "content repository binding"], productionEvidenceRequired: true },
  { adapter: "notification-provider", credentials: ["provider API identity", "webhook signing key", "sending identity/domain binding"], productionEvidenceRequired: true },
  { adapter: "payment-processor", credentials: ["merchant/workload identity", "webhook verification key", "account and legal-entity binding"], productionEvidenceRequired: true },
  { adapter: "apple-app-store", credentials: ["App Store Connect issuer/key ID", "private key reference", "bundle ID"], productionEvidenceRequired: true },
  { adapter: "google-play", credentials: ["service-account workload identity", "package name"], productionEvidenceRequired: true },
  { adapter: "wechat-pay", credentials: ["merchant ID", "API v3 key reference", "platform certificate serial"], productionEvidenceRequired: true },
  { adapter: "wechat-mini-program", credentials: ["app ID", "code-upload key reference", "review account"], productionEvidenceRequired: true },
  { adapter: "tax-authority", credentials: ["legal-entity tax profile", "invoice provider credential", "numbering scope"], productionEvidenceRequired: true },
  { adapter: "erp-finance", credentials: ["ERP workload identity", "legal-entity and ledger binding", "export signing key"], productionEvidenceRequired: true },
  { adapter: "vendor/carrier", credentials: ["vendor API credential", "contract/version", "webhook verification key"], productionEvidenceRequired: true },
  { adapter: "crm/cloud", credentials: ["OAuth/workload identity", "tenant/account binding", "regional endpoint policy"], productionEvidenceRequired: true },
  { adapter: "pentest/compliance", credentials: ["independent issuer public key", "engagement/report ID"], productionEvidenceRequired: true },
  { adapter: "release-control", credentials: ["control-plane workload identity", "artifact signing public key", "deployment target binding"], productionEvidenceRequired: true },
]);
