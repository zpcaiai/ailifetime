import { createHash } from "node:crypto";
import {
  requestBoundEvidenceScope,
  externalCommandCallbackProviderAllowed,
  resolveExternalCommandCallbackRoute,
  type ExternalCommandCallbackRouteDefinition,
} from "@ltm/core";

export type EvidenceEnvironment = "test" | "sandbox" | "staging" | "production";

type EvidenceBinding<
  Batch extends string,
  Operation extends string,
  Kind extends string,
  Provider extends string,
> = {
  readonly tenantId: string;
  readonly batchId: Batch;
  readonly operation: Operation;
  readonly kind: Kind;
  readonly provider: Provider;
  readonly artifactSha256: string;
  readonly environment: EvidenceEnvironment;
  readonly subjectId: string;
  /** Present only for direct authority decisions bound to one canonical request. */
  readonly requestSha256?: string;
};

export type StoreTransactionEvidenceBinding = EvidenceBinding<
  "B66",
  "verifyStoreTransaction",
  "store-transaction",
  "apple-app-store" | "google-play"
>;

export type FoundationAssuranceEvidenceBinding =
  | EvidenceBinding<"B37", "configureEducationExperience", "education-assurance", `education-assurance:${string}`>
  | EvidenceBinding<"B44", "approveSecurityBaseline", "security-baseline", `security-auditor:${string}`>
  | EvidenceBinding<"B46", "attestRecoveryDrill", "recovery-drill", `recovery-auditor:${string}`>
  | EvidenceBinding<"B47", "promoteRelease", "release-promotion", `release-control:${string}`>
  | EvidenceBinding<"B48", "submitBusinessLoopEvidence", "business-loop-certification", `e2e-auditor:${string}`>
  | EvidenceBinding<"B49", "submitReleaseEvidence", "release-evidence", `release-auditor:${string}`>;

export type WechatPaymentEvidenceBinding = EvidenceBinding<
  "B71",
  "recordWechatCommercialAction",
  "wechat-payment-callback",
  "wechat-pay"
>;

export type StoreReleaseEvidenceBinding =
  | EvidenceBinding<"B69", "approveMobileStoreRelease", "store-release", "apple-app-store" | "google-play">
  | EvidenceBinding<"B72", "approveMiniProgramRelease", "mini-program-release", "wechat-mini-program">;

export type PublicationEvidenceBinding =
  | EvidenceBinding<"B58", "transitionEditorialContent", "editorial-approval", `publication-review:${string}`>
  | EvidenceBinding<"B62", "publishTrustDocument", "trust-document-attestation", `trust-assurance:${string}`>;

export type NotificationEvidenceBinding =
  | EvidenceBinding<"B74", "scheduleMultiChannelNotification", "notification-route", `notification:${string}`>
  | EvidenceBinding<"B77", "recordDeliverabilityControl", "deliverability-control", `notification:${string}`>;

export type TaxEvidenceBinding = EvidenceBinding<
  "B89",
  "requestTaxDocument",
  "tax-document-request",
  `tax-authority:${string}`
>;

export type PaymentOperationsEvidenceBinding =
  | EvidenceBinding<"B91", "recordDisputeDecision", "payment-dispute", `payment:${string}`>
  | EvidenceBinding<"B92", "approvePartnerPayout", "partner-payout", `payment:${string}`>;

export type SupplyEvidenceBinding =
  | EvidenceBinding<"B96", "recordVendorProfile", "vendor-profile", `vendor:${string}`>
  | EvidenceBinding<"B97", "recordProofApproval", "production-proof-lock", `vendor:${string}`>
  | EvidenceBinding<"B98", "createVendorProductionJob", "vendor-job-acceptance", `vendor:${string}`>
  | EvidenceBinding<"B99", "recordShipment", "carrier-event", `carrier:${string}`>
  | EvidenceBinding<"B100", "recordInventoryAdjustment", "inventory-snapshot", `vendor:${string}`>
  | EvidenceBinding<"B101", "createReturnOrClaim", "return-claim", `vendor:${string}` | `carrier:${string}`>
  | EvidenceBinding<"B102", "publishVendorScorecard", "vendor-scorecard", `vendor:${string}`>;

export type BusinessSystemEvidenceBinding =
  | EvidenceBinding<"B107", "publishConnector", "connector-package", `crm:${string}` | `cloud:${string}`>
  | EvidenceBinding<"B108", "registerBusinessAdapter", "business-adapter", `crm:${string}` | `cloud:${string}`>
  | EvidenceBinding<"B109", "certifyPartnerIntegration", "partner-integration", `crm:${string}` | `cloud:${string}`>
  | EvidenceBinding<"B94", "approveMonthEndClose", "financial-close-export", `erp:${string}`>
  | EvidenceBinding<"B120", "publishResidencyPolicy", "cloud-residency", `cloud:${string}`>;

export type AssuranceEvidenceBinding =
  | EvidenceBinding<"B68", "approveMobileAssurance", "mobile-assurance", `mobile-assurance:${string}`>
  | EvidenceBinding<"B123", "approveSecurityAssurance", "independent-pentest", `pentest:${string}`>
  | EvidenceBinding<"B124", "approveComplianceEvidence", "compliance-attestation", `compliance:${string}`>
  | EvidenceBinding<"B125", "approveCommercialReadiness", "commercial-readiness", `readiness-auditor:${string}`>
  | EvidenceBinding<"B126", "certifyCommercialE2e", "commercial-e2e", `e2e-auditor:${string}`>
  | EvidenceBinding<"B127", "approveStagedProductionLaunch", "release-control-plane", `release-control:${string}`>;

export type OperationalReportEvidenceBinding =
  | EvidenceBinding<"B56", "approveExperienceGate", "experience-gate-report", `experience-assurance:${string}`>
  | EvidenceBinding<"B118", "recordModelEvaluation", "model-evaluation-report", `model-evaluator:${string}`>
  | EvidenceBinding<"B119", "approveConfigurationChange", "configuration-change-report", `change-control:${string}`>
  | EvidenceBinding<"B121", "approveCapacityGate", "capacity-test-report", `load-test:${string}`>
  | EvidenceBinding<"B122", "recordResilienceExercise", "resilience-exercise-report", `resilience-auditor:${string}`>;

type CallbackProvider<Route extends ExternalCommandCallbackRouteDefinition> =
  Route["providerBinding"] extends { readonly kind: "exact"; readonly provider: infer Provider extends string }
    ? Provider
    : Route["providerBinding"] extends { readonly kind: "record-field"; readonly prefix: infer Prefix extends string }
      ? `${Prefix}${string}`
      : Route["providerBinding"] extends {
          readonly kind: "record-provider-pair";
          readonly allowedTypes: readonly (infer ProviderType extends string)[];
        }
        ? `${ProviderType}:${string}`
        : never;

type CallbackEvidenceBinding<Route extends ExternalCommandCallbackRouteDefinition> =
  Route extends ExternalCommandCallbackRouteDefinition
    ? EvidenceBinding<Route["batchId"], Route["operation"], Route["evidenceKind"], CallbackProvider<Route>>
    : never;

/** Every terminal external-command callback tuple accepted by the provider boundary. */
export type ExternalCommandCallbackEvidenceBinding = CallbackEvidenceBinding<ExternalCommandCallbackRouteDefinition>;

export type CapabilityEvidenceBinding =
  | FoundationAssuranceEvidenceBinding
  | StoreTransactionEvidenceBinding
  | WechatPaymentEvidenceBinding
  | StoreReleaseEvidenceBinding
  | PublicationEvidenceBinding
  | NotificationEvidenceBinding
  | TaxEvidenceBinding
  | PaymentOperationsEvidenceBinding
  | SupplyEvidenceBinding
  | BusinessSystemEvidenceBinding
  | AssuranceEvidenceBinding
  | OperationalReportEvidenceBinding
  | ExternalCommandCallbackEvidenceBinding;

/** Signature on the LTM attestation envelope, not the provider's native receipt. */
export type EvidenceAlgorithm = "Ed25519";

export interface SignedCapabilityEvidence<Binding extends CapabilityEvidenceBinding = CapabilityEvidenceBinding> {
  readonly version: "ltm.external-evidence.v1";
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly binding: Binding;
  readonly scope: string;
  readonly issuer: string;
  readonly provider: Binding["provider"];
  readonly artifactSha256: string;
  readonly canonicalClaimsSha256?: string;
  readonly businessEventSha256?: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly replayPolicy: "reusable" | "single_use";
  readonly algorithm: EvidenceAlgorithm;
  readonly keyId: string;
  readonly signature: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function sha256Artifact(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

export function assertArtifactDigest(payload: Uint8Array, expectedSha256: string): void {
  const normalized = exactSha256(expectedSha256);
  if (sha256Artifact(payload) !== normalized) throw new Error("artifact SHA-256 does not match the evidence binding");
}

export function capabilityEvidenceScope(binding: CapabilityEvidenceBinding): string {
  assertCapabilityEvidenceBinding(binding);
  const canonical = [
    "ltm-capability-evidence-v1",
    binding.tenantId,
    binding.batchId,
    binding.operation,
    binding.kind,
    binding.provider,
    binding.artifactSha256,
    binding.environment,
    binding.subjectId,
  ].map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  const baseScope = `ltm-evidence:v1:${createHash("sha256").update(canonical).digest("hex")}`;
  return binding.requestSha256 === undefined
    ? baseScope
    : requestBoundEvidenceScope(baseScope, binding.requestSha256);
}

export function assertCapabilityEvidenceBinding(binding: CapabilityEvidenceBinding): void {
  identifier(binding.tenantId, "tenantId");
  identifier(binding.subjectId, "subjectId");
  identifier(binding.provider, "provider");
  exactSha256(binding.artifactSha256);
  if (binding.requestSha256 !== undefined) exactSha256(binding.requestSha256);
  assertBindingTuple(binding);
}

export function assertSignedCapabilityEvidence(
  evidence: SignedCapabilityEvidence,
  now = new Date(),
): void {
  if (evidence.version !== "ltm.external-evidence.v1") throw new Error("unsupported evidence envelope version");
  if (evidence.algorithm !== "Ed25519") throw new Error("evidence attestation must use Ed25519");
  identifier(evidence.evidenceId, "evidenceId");
  identifier(evidence.issuer, "issuer");
  identifier(evidence.nonce, "nonce");
  identifier(evidence.keyId, "keyId");
  assertCapabilityEvidenceBinding(evidence.binding);
  if (evidence.tenantId !== evidence.binding.tenantId) throw new Error("evidence tenant does not match its binding");
  if (evidence.provider !== evidence.binding.provider) throw new Error("evidence provider does not match its binding");
  if (evidence.artifactSha256 !== evidence.binding.artifactSha256) throw new Error("evidence artifact does not match its binding");
  if ((evidence.canonicalClaimsSha256 === undefined) !== (evidence.businessEventSha256 === undefined)) {
    throw new Error("business evidence requires both canonical claims and complete event digests");
  }
  if (evidence.canonicalClaimsSha256 !== undefined && !SHA256.test(evidence.canonicalClaimsSha256)) {
    throw new Error("canonical claims digest is invalid");
  }
  if (evidence.businessEventSha256 !== undefined && !SHA256.test(evidence.businessEventSha256)) {
    throw new Error("business event digest is invalid");
  }
  if (evidence.scope !== capabilityEvidenceScope(evidence.binding)) throw new Error("evidence scope does not match its binding");
  const issuedAt = parseTimestamp(evidence.issuedAt, "issuedAt");
  const expiresAt = parseTimestamp(evidence.expiresAt, "expiresAt");
  if (issuedAt > now.getTime() || expiresAt <= now.getTime() || expiresAt <= issuedAt) {
    throw new Error("evidence is not currently valid");
  }
  if (evidence.binding.environment === "production") {
    if (isTestIssuer(evidence.issuer)) {
      throw new Error("production evidence cannot use a test issuer");
    }
  }
  if (evidence.replayPolicy !== "reusable" && evidence.replayPolicy !== "single_use") {
    throw new Error("evidence replay policy is invalid");
  }
  if (evidence.signature.trim() === "") throw new Error("evidence signature is required");
}

/** Convert only a fully-bound adapter attestation to the core runtime envelope. */
export function toRuntimeExternalEvidence(evidence: SignedCapabilityEvidence): {
  readonly version: "ltm.external-evidence.v1";
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly issuer: string;
  readonly provider: string;
  readonly scope: string;
  readonly artifactSha256: string;
  readonly canonicalClaimsSha256?: string;
  readonly businessEventSha256?: string;
  readonly environment: EvidenceEnvironment;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly replayPolicy: "reusable" | "single_use";
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly signature: string;
} {
  assertSignedCapabilityEvidence(evidence);
  return {
    version: evidence.version,
    evidenceId: evidence.evidenceId,
    tenantId: evidence.tenantId,
    issuer: evidence.issuer,
    provider: evidence.provider,
    scope: evidence.scope,
    artifactSha256: evidence.artifactSha256,
    ...(evidence.canonicalClaimsSha256 === undefined
      ? {}
      : { canonicalClaimsSha256: evidence.canonicalClaimsSha256 }),
    ...(evidence.businessEventSha256 === undefined
      ? {}
      : { businessEventSha256: evidence.businessEventSha256 }),
    environment: evidence.binding.environment,
    issuedAt: evidence.issuedAt,
    expiresAt: evidence.expiresAt,
    nonce: evidence.nonce,
    replayPolicy: evidence.replayPolicy,
    algorithm: evidence.algorithm,
    keyId: evidence.keyId,
    signature: evidence.signature,
  };
}

function assertBindingTuple(binding: CapabilityEvidenceBinding): void {
  const commandRoute = resolveExternalCommandCallbackRoute(binding.batchId, binding.operation);
  if (commandRoute !== undefined && binding.kind === commandRoute.evidenceKind &&
      externalCommandCallbackProviderAllowed(commandRoute, binding.provider)) {
    return;
  }
  switch (binding.batchId) {
    case "B37":
      if (binding.operation !== "configureEducationExperience" || binding.kind !== "education-assurance" || !binding.provider.startsWith("education-assurance:")) break;
      return;
    case "B44":
      if (binding.operation !== "approveSecurityBaseline" || binding.kind !== "security-baseline" || !binding.provider.startsWith("security-auditor:")) break;
      return;
    case "B46":
      if (binding.operation !== "attestRecoveryDrill" || binding.kind !== "recovery-drill" || !binding.provider.startsWith("recovery-auditor:")) break;
      return;
    case "B47":
      if (binding.operation !== "promoteRelease" || binding.kind !== "release-promotion" || !binding.provider.startsWith("release-control:")) break;
      return;
    case "B48":
      if (binding.operation !== "submitBusinessLoopEvidence" || binding.kind !== "business-loop-certification" || !binding.provider.startsWith("e2e-auditor:")) break;
      return;
    case "B49":
      if (binding.operation !== "submitReleaseEvidence" || binding.kind !== "release-evidence" || !binding.provider.startsWith("release-auditor:")) break;
      return;
    case "B56":
      if (binding.operation !== "approveExperienceGate" || binding.kind !== "experience-gate-report" || !binding.provider.startsWith("experience-assurance:")) break;
      return;
    case "B58":
      if (binding.operation !== "transitionEditorialContent" || binding.kind !== "editorial-approval" || !binding.provider.startsWith("publication-review:")) break;
      return;
    case "B62":
      if (binding.operation !== "publishTrustDocument" || binding.kind !== "trust-document-attestation" || !binding.provider.startsWith("trust-assurance:")) break;
      return;
    case "B66":
      if (binding.operation !== "verifyStoreTransaction" || binding.kind !== "store-transaction" || !["apple-app-store", "google-play"].includes(binding.provider)) break;
      return;
    case "B68":
      if (binding.operation !== "approveMobileAssurance" || binding.kind !== "mobile-assurance" || !binding.provider.startsWith("mobile-assurance:")) break;
      return;
    case "B69":
      if (binding.operation !== "approveMobileStoreRelease" || binding.kind !== "store-release" || !["apple-app-store", "google-play"].includes(binding.provider)) break;
      return;
    case "B71":
      if (binding.operation !== "recordWechatCommercialAction" || binding.kind !== "wechat-payment-callback" || binding.provider !== "wechat-pay") break;
      return;
    case "B72":
      if (binding.operation !== "approveMiniProgramRelease" || binding.kind !== "mini-program-release" || binding.provider !== "wechat-mini-program") break;
      return;
    case "B74":
      if (binding.operation !== "scheduleMultiChannelNotification" || binding.kind !== "notification-route" || !binding.provider.startsWith("notification:")) break;
      return;
    case "B77":
      if (binding.operation !== "recordDeliverabilityControl" || binding.kind !== "deliverability-control" || !binding.provider.startsWith("notification:")) break;
      return;
    case "B89":
      if (binding.operation !== "requestTaxDocument" || binding.kind !== "tax-document-request" || !binding.provider.startsWith("tax-authority:")) break;
      return;
    case "B91":
      if (binding.operation !== "recordDisputeDecision" || binding.kind !== "payment-dispute" || !binding.provider.startsWith("payment:")) break;
      return;
    case "B92":
      if (binding.operation !== "approvePartnerPayout" || binding.kind !== "partner-payout" || !binding.provider.startsWith("payment:")) break;
      return;
    case "B94":
      if (binding.operation !== "approveMonthEndClose" || binding.kind !== "financial-close-export" || !binding.provider.startsWith("erp:")) break;
      return;
    case "B96":
      if (binding.operation !== "recordVendorProfile" || binding.kind !== "vendor-profile" || !binding.provider.startsWith("vendor:")) break;
      return;
    case "B97":
      if (binding.operation !== "recordProofApproval" || binding.kind !== "production-proof-lock" || !binding.provider.startsWith("vendor:")) break;
      return;
    case "B98":
      if (binding.operation !== "createVendorProductionJob" || binding.kind !== "vendor-job-acceptance" || !binding.provider.startsWith("vendor:")) break;
      return;
    case "B99":
      if (binding.operation !== "recordShipment" || binding.kind !== "carrier-event" || !binding.provider.startsWith("carrier:")) break;
      return;
    case "B100":
      if (binding.operation !== "recordInventoryAdjustment" || binding.kind !== "inventory-snapshot" || !binding.provider.startsWith("vendor:")) break;
      return;
    case "B101":
      if (binding.operation !== "createReturnOrClaim" || binding.kind !== "return-claim" || (!binding.provider.startsWith("vendor:") && !binding.provider.startsWith("carrier:"))) break;
      return;
    case "B102":
      if (binding.operation !== "publishVendorScorecard" || binding.kind !== "vendor-scorecard" || !binding.provider.startsWith("vendor:")) break;
      return;
    case "B107":
      if (binding.operation !== "publishConnector" || binding.kind !== "connector-package" || !isBusinessProvider(binding.provider)) break;
      return;
    case "B108":
      if (binding.operation !== "registerBusinessAdapter" || binding.kind !== "business-adapter" || !isBusinessProvider(binding.provider)) break;
      return;
    case "B109":
      if (binding.operation !== "certifyPartnerIntegration" || binding.kind !== "partner-integration" || !isBusinessProvider(binding.provider)) break;
      return;
    case "B118":
      if (binding.operation !== "recordModelEvaluation" || binding.kind !== "model-evaluation-report" || !binding.provider.startsWith("model-evaluator:")) break;
      return;
    case "B119":
      if (binding.operation !== "approveConfigurationChange" || binding.kind !== "configuration-change-report" || !binding.provider.startsWith("change-control:")) break;
      return;
    case "B120":
      if (binding.operation !== "publishResidencyPolicy" || binding.kind !== "cloud-residency" || !binding.provider.startsWith("cloud:")) break;
      return;
    case "B121":
      if (binding.operation !== "approveCapacityGate" || binding.kind !== "capacity-test-report" || !binding.provider.startsWith("load-test:")) break;
      return;
    case "B122":
      if (binding.operation !== "recordResilienceExercise" || binding.kind !== "resilience-exercise-report" || !binding.provider.startsWith("resilience-auditor:")) break;
      return;
    case "B123":
      if (binding.operation !== "approveSecurityAssurance" || binding.kind !== "independent-pentest" || !binding.provider.startsWith("pentest:")) break;
      return;
    case "B124":
      if (binding.operation !== "approveComplianceEvidence" || binding.kind !== "compliance-attestation" || !binding.provider.startsWith("compliance:")) break;
      return;
    case "B125":
      if (binding.operation !== "approveCommercialReadiness" || binding.kind !== "commercial-readiness" || !binding.provider.startsWith("readiness-auditor:")) break;
      return;
    case "B126":
      if (binding.operation !== "certifyCommercialE2e" || binding.kind !== "commercial-e2e" || !binding.provider.startsWith("e2e-auditor:")) break;
      return;
    case "B127":
      if (binding.operation !== "approveStagedProductionLaunch" || binding.kind !== "release-control-plane" || !binding.provider.startsWith("release-control:")) break;
      return;
  }
  throw new Error("evidence batch, operation, kind, and provider are not a permitted tuple");
}

function isBusinessProvider(provider: string): boolean {
  return provider.startsWith("crm:") || provider.startsWith("cloud:");
}

function isTestIssuer(issuer: string): boolean {
  return issuer === "test" || issuer.startsWith("test:") || issuer.startsWith("fixture:") || issuer.startsWith("sandbox:");
}

function identifier(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized !== value || !IDENTIFIER.test(normalized)) throw new Error(`${field} has an invalid format`);
  return normalized;
}

function exactSha256(value: string): string {
  const normalized = value.trim();
  if (normalized !== value || !SHA256.test(normalized)) throw new Error("artifactSha256 must be a lowercase SHA-256 digest");
  return normalized;
}

function parseTimestamp(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error(`${field} must be an ISO UTC timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} is invalid`);
  return parsed;
}
