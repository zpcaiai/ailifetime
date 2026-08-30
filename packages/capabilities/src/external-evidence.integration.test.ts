import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  DomainError,
  LifeTimeMachineRuntime,
  signConsentPolicyCatalog,
  signExternalEvidence,
  type ActorContext,
  type EvidenceEnvironment,
} from "@ltm/core";
import {
  capabilityEvidenceScope,
  type CapabilityEvidenceBinding,
} from "@ltm/providers";
import { createCapabilityRegistry } from "./index.js";
import type { JsonObject, JsonValue } from "./registry.js";

const TENANT_ID = "tenant-evidence-test";
const ISSUER = "test:capability-adapter-fixture";
const KEY_ID = "test-ed25519-2026";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const FOUNDATION_BATCH_IDS = Array.from({ length: 51 }, (_, index) => `B${index.toString().padStart(2, "0")}`);
const FOUNDATION_REPORT_HASHES = Object.fromEntries(FOUNDATION_BATCH_IDS.map((batchId) => [batchId, DIGEST_C]));
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const EXTERNAL_EVENT_ONLY = new Set(["B66", "B71", "B99", "B100", "B102"]);

interface EvidenceCase {
  readonly batchId: `B${string}`;
  readonly binding: CapabilityEvidenceBinding;
  readonly artifactField: string;
  readonly legacyAssertionField?: string;
  readonly input: JsonObject;
}

function admin(batchId: string, operationSuffix = "execute"): ActorContext {
  return {
    actorId: "platform-admin-fixture",
    tenantId: TENANT_ID,
    roles: ["platform_admin", "auditor"],
    purpose: "sandbox_commercial_validation",
    requestId: `request-${batchId}-${operationSuffix}`,
    stepUp: true,
    operationId: `operation-${batchId}-${operationSuffix}`,
  };
}

function evidenceIds(batchId: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `test-evidence-${batchId}-${index + 1}`);
}

function runtimeFor(testContext: TestContext, provider: string, environment: EvidenceEnvironment = "sandbox"): LifeTimeMachineRuntime {
  const runtime = new LifeTimeMachineRuntime({
    databasePath: ":memory:",
    evidencePolicy: environment === "production" ? "production" : "development",
    evidenceEnvironment: environment,
    trustedEvidenceKeys: [{
      issuer: ISSUER,
      provider,
      keyId: KEY_ID,
      algorithm: "Ed25519",
      publicKeyPem: PUBLIC_KEY_PEM,
      allowedScopes: ["ltm-evidence:v1:*"],
      allowedEnvironments: environment === "production" ? ["sandbox", "production"] : [environment],
    }],
  });
  testContext.after(() => runtime.close());
  return runtime;
}

function registerSandboxEvidence(
  runtime: LifeTimeMachineRuntime,
  context: ActorContext,
  binding: CapabilityEvidenceBinding,
  ids: readonly string[],
): void {
  const scope = capabilityEvidenceScope(binding);
  ids.forEach((evidenceId, index) => {
    const unsigned = {
      version: "ltm.external-evidence.v1" as const,
      evidenceId,
      tenantId: context.tenantId,
      issuer: ISSUER,
      provider: binding.provider,
      environment: "sandbox" as const,
      scope,
      artifactSha256: binding.artifactSha256,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      nonce: `sandbox-nonce-${binding.batchId}-${index + 1}-2026`,
      replayPolicy: "single_use" as const,
      algorithm: "Ed25519" as const,
      keyId: KEY_ID,
    };
    runtime.registerExternalEvidence(context, {
      evidence: signExternalEvidence(unsigned, PRIVATE_KEY_PEM),
      idempotencyKey: `register-${evidenceId}`,
    });
  });
}

function requestBoundBinding(
  registry: ReturnType<typeof createCapabilityRegistry>,
  evidenceCase: EvidenceCase,
  context: ActorContext,
): CapabilityEvidenceBinding {
  const parsed = registry.get(evidenceCase.batchId)?.parseInput({
    actor: context,
    idempotencyKey: `request-binding-${evidenceCase.batchId}`,
    input: evidenceCase.input,
  });
  assert.ok(parsed);
  const requestSha256 = parsed.decisionRequestSha256;
  return typeof requestSha256 === "string"
    ? { ...evidenceCase.binding, requestSha256 }
    : evidenceCase.binding;
}

function objectResult(value: JsonValue): JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value;
}

async function rejectsDomainCode(promise: Promise<JsonValue>, code: DomainError["code"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    return true;
  });
}

const cases: readonly EvidenceCase[] = [
  {
    batchId: "B37",
    binding: {
      tenantId: TENANT_ID, batchId: "B37", operation: "configureEducationExperience", kind: "education-assurance",
      provider: "education-assurance:auditor-37", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "experience-37",
    },
    artifactField: "assuranceArtifactSha256",
    input: {
      experienceId: "experience-37", scenario: "retirement_vision", regulatedUse: "education_only",
      facialDataTransferred: false, photoOptional: true, productRecommendationSeparated: true,
      approvalEvidenceIds: evidenceIds("B37", 1), assuranceProviderId: "auditor-37",
      providerEnvironment: "sandbox", assuranceArtifactSha256: DIGEST_A,
    },
  },
  {
    batchId: "B44",
    binding: {
      tenantId: TENANT_ID, batchId: "B44", operation: "approveSecurityBaseline", kind: "security-baseline",
      provider: "security-auditor:auditor-44", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "baseline-44",
    },
    artifactField: "baselineArtifactSha256",
    legacyAssertionField: "legalConfirmation",
    input: {
      baselineId: "baseline-44", policyVersion: "security-v44", controlState: "passed",
      scans: ["sast", "dast", "sca", "secrets", "iac", "container", "sbom"],
      externalEvidenceIds: evidenceIds("B44", 1), unresolvedCritical: 0,
      dataMap: { classification: "mapped" }, securityProviderId: "auditor-44",
      providerEnvironment: "sandbox", baselineArtifactSha256: DIGEST_A,
    },
  },
  {
    batchId: "B46",
    binding: {
      tenantId: TENANT_ID, batchId: "B46", operation: "attestRecoveryDrill", kind: "recovery-drill",
      provider: "recovery-auditor:auditor-46", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "drill-46",
    },
    artifactField: "recoveryArtifactSha256",
    input: {
      drillId: "drill-46", recoveryState: "passed", deletionReplayState: "verified",
      integrityChecks: ["restore", "rpo", "rto", "deletion", "checksum"],
      externalEvidenceIds: evidenceIds("B46", 1), secondApproverId: "independent-approver-46",
      recoveryProviderId: "auditor-46", providerEnvironment: "sandbox", recoveryArtifactSha256: DIGEST_A,
    },
  },
  {
    batchId: "B47",
    binding: {
      tenantId: TENANT_ID, batchId: "B47", operation: "promoteRelease", kind: "release-promotion",
      provider: "release-control:control-47", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "release-47",
    },
    artifactField: "artifactDigest",
    legacyAssertionField: "signed",
    input: {
      releaseId: "release-47", artifactDigest: DIGEST_A, provenanceId: "provenance-47",
      fromEnvironment: "preview", toEnvironment: "staging", gateState: "passed",
      requiredChecks: ["unit", "integration", "e2e", "security", "privacy", "ledger", "rollback", "observability"],
      externalEvidenceIds: evidenceIds("B47", 1), releaseControlProviderId: "control-47", providerEnvironment: "sandbox",
    },
  },
  {
    batchId: "B48",
    binding: {
      tenantId: TENANT_ID, batchId: "B48", operation: "submitBusinessLoopEvidence", kind: "business-loop-certification",
      provider: "e2e-auditor:auditor-48", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "certification-48",
    },
    artifactField: "certificationArtifactSha256",
    input: {
      certificationRunId: "certification-48", environment: "isolated_staging",
      loopEvidence: { consumer: "passed", familyGift: "passed", studio: "passed", educationCrm: "passed", failureAbuse: "passed" },
      externalEvidenceIds: evidenceIds("B48", 5), abuseFixturesSynthetic: true,
      auditorProviderId: "auditor-48", providerEnvironment: "sandbox", certificationArtifactSha256: DIGEST_A,
    },
  },
  {
    batchId: "B49",
    binding: {
      tenantId: TENANT_ID, batchId: "B49", operation: "submitReleaseEvidence", kind: "release-evidence",
      provider: "release-auditor:auditor-49", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "release-49",
    },
    artifactField: "releaseArtifactSha256",
    legacyAssertionField: "certificateSignature",
    input: {
      releaseId: "release-49", cleanRoomState: "passed", reportBatchIds: FOUNDATION_BATCH_IDS,
      reportHashes: FOUNDATION_REPORT_HASHES, unresolvedBlockers: [], externalEvidenceIds: evidenceIds("B49", 1),
      attestationState: "externally_verified", releaseAuditorProviderId: "auditor-49",
      providerEnvironment: "sandbox", releaseArtifactSha256: DIGEST_A,
    },
  },
  {
    batchId: "B56",
    binding: {
      tenantId: TENANT_ID, batchId: "B56", operation: "approveExperienceGate", kind: "experience-gate-report",
      provider: "experience-assurance:assessor-56", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "release-56",
    },
    artifactField: "evaluationReportSha256",
    legacyAssertionField: "controlledCopyApproved",
    input: {
      releaseCandidate: "release-56", baselineId: "baseline-56", assessmentProviderId: "assessor-56",
      providerEnvironment: "sandbox", evaluationReportSha256: DIGEST_A, reportPolicyVersion: "experience-report-v1",
      externalEvidenceIds: evidenceIds("B56", 1),
    },
  },
  {
    batchId: "B66",
    binding: {
      tenantId: TENANT_ID, batchId: "B66", operation: "verifyStoreTransaction", kind: "store-transaction",
      provider: "apple-app-store", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "transaction-66",
    },
    artifactField: "receiptArtifactSha256",
    legacyAssertionField: "serverSignatureVerified",
    input: {
      transactionId: "transaction-66", provider: "app_store", providerEnvironment: "sandbox",
      productId: "product-66", accountId: "account-66", receiptArtifactSha256: DIGEST_A,
      amountMinor: 499, currency: "USD", externalEvidenceIds: evidenceIds("B66", 1),
    },
  },
  {
    batchId: "B71",
    binding: {
      tenantId: TENANT_ID, batchId: "B71", operation: "recordWechatCommercialAction", kind: "wechat-payment-callback",
      provider: "wechat-pay", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "payment-71",
    },
    artifactField: "callbackArtifactSha256",
    legacyAssertionField: "serverSignatureVerified",
    input: {
      paymentId: "payment-71", providerEventId: "wechat-event-71", providerEnvironment: "sandbox",
      callbackArtifactSha256: DIGEST_A, participantIds: ["platform-admin-fixture"],
      purpose: "sandbox_commercial_validation", amountMinor: 100, currency: "CNY",
      messageAuthorizationCount: 0, externalEvidenceIds: evidenceIds("B71", 1),
    },
  },
  {
    batchId: "B99",
    binding: {
      tenantId: TENANT_ID, batchId: "B99", operation: "recordShipment", kind: "carrier-event",
      provider: "carrier:carrier-99", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "shipment-99",
    },
    artifactField: "carrierEventArtifactSha256",
    legacyAssertionField: "publicTrackingRedacted",
    input: {
      shipmentId: "shipment-99", orderId: "order-99", addressToken: "vault-address-99", addressVersion: "v1",
      carrierId: "carrier-99", carrierEventId: "carrier-event-99", carrierEventArtifactSha256: DIGEST_A,
      providerEnvironment: "sandbox", trackingToken: "tracking-token-99", state: "in_transit",
      trackingViewPolicyVersion: "tracking-v1", externalEvidenceIds: evidenceIds("B99", 1),
    },
  },
  {
    batchId: "B100",
    binding: {
      tenantId: TENANT_ID, batchId: "B100", operation: "recordInventoryAdjustment", kind: "inventory-snapshot",
      provider: "vendor:vendor-100", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "adjustment-100",
    },
    artifactField: "inventorySnapshotArtifactSha256",
    legacyAssertionField: "reservationProtected",
    input: {
      adjustmentId: "adjustment-100", sku: "sku-100", locationId: "location-100", vendorId: "vendor-100",
      inventorySnapshotArtifactSha256: DIGEST_A, providerEnvironment: "sandbox", sourceVersion: "source-v1",
      reason: "receipt", quantityDelta: 2, availableAfter: 10, reservationLedgerVersion: "reservation-v1",
      sourceEventId: "source-event-100", externalEvidenceIds: evidenceIds("B100", 1),
    },
  },
  {
    batchId: "B102",
    binding: {
      tenantId: TENANT_ID, batchId: "B102", operation: "publishVendorScorecard", kind: "vendor-scorecard",
      provider: "vendor:vendor-102", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "scorecard-102",
    },
    artifactField: "scorecardArtifactSha256",
    legacyAssertionField: "disabledVendorBlocked",
    input: {
      scorecardId: "scorecard-102", vendorId: "vendor-102", scorecardArtifactSha256: DIGEST_A,
      providerEnvironment: "sandbox", period: "2026-08", metrics: { onTimeRate: 0.99 },
      eligibleOrderCount: 10, measuredOrderCount: 9, complaintIds: [], settlementId: "settlement-102",
      vendorState: "active", settlementControlTotalId: "control-total-102",
      externalEvidenceIds: evidenceIds("B102", 1),
    },
  },
  {
    batchId: "B118",
    binding: {
      tenantId: TENANT_ID, batchId: "B118", operation: "recordModelEvaluation", kind: "model-evaluation-report",
      provider: "model-evaluator:evaluator-118", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "evaluation-118",
    },
    artifactField: "evaluationReportSha256",
    legacyAssertionField: "rollbackReady",
    input: {
      evaluationId: "evaluation-118", modelVersion: "model-v118", promptVersion: "prompt-v118",
      datasetId: "dataset-118", datasetAuthorization: "synthetic",
      cohorts: ["adult", "minor", "locale-zh", "locale-en"],
      metrics: ["safety", "fairness", "quality", "latency", "cost", "stability"],
      evaluationProviderId: "evaluator-118", providerEnvironment: "sandbox",
      evaluationReportSha256: DIGEST_A, reportSchemaVersion: "ltm.model-evaluation-report.v1",
      externalEvidenceIds: evidenceIds("B118", 1),
    },
  },
  {
    batchId: "B119",
    binding: {
      tenantId: TENANT_ID, batchId: "B119", operation: "approveConfigurationChange", kind: "configuration-change-report",
      provider: "change-control:control-119", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "change-119",
    },
    artifactField: "changeReportSha256",
    legacyAssertionField: "driftCheckPassed",
    input: {
      tenantId: TENANT_ID, changeId: "change-119", environment: "staging", schemaVersion: "schema-v119",
      secretReference: "secret-manager:ltm/staging/config", changedFields: ["featureFlags"], disabledControls: [],
      approvalIds: ["approval-119"], rollbackVersion: "rollback-v119", changeControlProviderId: "control-119",
      providerEnvironment: "sandbox", changeReportSha256: DIGEST_A,
      reportSchemaVersion: "ltm.configuration-change-report.v1", externalEvidenceIds: evidenceIds("B119", 1),
    },
  },
  {
    batchId: "B121",
    binding: {
      tenantId: TENANT_ID, batchId: "B121", operation: "approveCapacityGate", kind: "capacity-test-report",
      provider: "load-test:runner-121", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "capacity-121",
    },
    artifactField: "capacityReportSha256",
    legacyAssertionField: "paidTasksProtected",
    input: {
      testRunId: "capacity-121", loadProfile: "commercial-peak-v1",
      scenarios: ["baseline", "peak", "burst", "soak", "dependency_degraded"], thresholds: { policy: "capacity-v1" },
      maxP95Ms: 1_000, maxErrorRate: 0.01, loadTestProviderId: "runner-121", providerEnvironment: "sandbox",
      capacityReportSha256: DIGEST_A, reportSchemaVersion: "ltm.capacity-test-report.v1",
      externalEvidenceIds: evidenceIds("B121", 1),
    },
  },
  {
    batchId: "B122",
    binding: {
      tenantId: TENANT_ID, batchId: "B122", operation: "recordResilienceExercise", kind: "resilience-exercise-report",
      provider: "resilience-auditor:auditor-122", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "exercise-122",
    },
    artifactField: "resilienceReportSha256",
    legacyAssertionField: "deletionResurrectionPrevented",
    input: {
      exerciseId: "exercise-122", faultType: "database", targetRtoSeconds: 300, targetRpoSeconds: 60,
      failoverRegion: "cn-north-1", allowedFailoverRegions: ["cn-north-1"], resilienceProviderId: "auditor-122",
      providerEnvironment: "sandbox", resilienceReportSha256: DIGEST_A,
      reportSchemaVersion: "ltm.resilience-exercise-report.v1", externalEvidenceIds: evidenceIds("B122", 1),
    },
  },
  {
    batchId: "B123",
    binding: {
      tenantId: TENANT_ID, batchId: "B123", operation: "approveSecurityAssurance", kind: "independent-pentest",
      provider: "pentest:auditor-123", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "assessment-123",
    },
    artifactField: "artifactDigest",
    legacyAssertionField: "independentPentest",
    input: {
      assessmentId: "assessment-123", pentestProviderId: "auditor-123", providerEnvironment: "sandbox",
      artifactDigest: DIGEST_A, sbomDigest: DIGEST_B, retestArtifactSha256: DIGEST_C,
      provenanceSignature: "sandbox-provenance-reference", scans: ["secrets", "sast", "sca", "iac", "dast", "api"],
      criticalFindings: 0, highFindings: 0, engagementId: "engagement-123",
      externalEvidenceIds: evidenceIds("B123", 2),
    },
  },
  {
    batchId: "B124",
    binding: {
      tenantId: TENANT_ID, batchId: "B124", operation: "approveComplianceEvidence", kind: "compliance-attestation",
      provider: "compliance:auditor-124", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "assessment-124",
    },
    artifactField: "assessmentArtifactSha256",
    legacyAssertionField: "controlsCertified",
    input: {
      assessmentId: "assessment-124", complianceProviderId: "auditor-124", providerEnvironment: "sandbox",
      assessmentArtifactSha256: DIGEST_A, profileVersion: "profile-v1", region: "CN",
      controls: ["privacy", "ai_label", "minor", "finance", "security"], artifactHashes: [DIGEST_A, DIGEST_B, DIGEST_C],
      evidenceExpiresAt: "2099-01-01T00:00:00.000Z", exportTenantId: TENANT_ID,
      approvalIds: ["approval-124-a", "approval-124-b"], unresolvedControlFailures: 0,
      externalEvidenceIds: evidenceIds("B124", 2),
    },
  },
  {
    batchId: "B125",
    binding: {
      tenantId: TENANT_ID, batchId: "B125", operation: "approveCommercialReadiness", kind: "commercial-readiness",
      provider: "readiness-auditor:auditor-125", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "readiness-125",
    },
    artifactField: "readinessArtifactSha256",
    legacyAssertionField: "vendorContractsApproved",
    input: {
      readinessId: "readiness-125", auditorProviderId: "auditor-125", providerEnvironment: "sandbox",
      readinessArtifactSha256: DIGEST_A, profileVersion: "profile-v1",
      policyVersions: ["privacy-v1", "security-v1", "finance-v1", "support-v1", "supply-v1", "release-v1"],
      operationalDrills: ["support_escalation", "month_end_close", "incident_response", "refund", "vendor_failure"],
      providerChecks: ["payment", "tax", "store", "wechat", "vendor", "cloud"],
      raciRoles: ["responsible", "accountable", "consulted", "informed"],
      stopConditions: ["security", "finance", "availability"], p0Blockers: 0, p1Blockers: 0,
      unresolvedLegalBlocks: 0, unresolvedFinancialBlocks: 0, vendorContractRegisterId: "contracts-125",
      externalEvidenceIds: evidenceIds("B125", 4),
    },
  },
  {
    batchId: "B126",
    binding: {
      tenantId: TENANT_ID, batchId: "B126", operation: "certifyCommercialE2e", kind: "commercial-e2e",
      provider: "e2e-auditor:auditor-126", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "certification-126",
    },
    artifactField: "scenarioArtifactSha256",
    legacyAssertionField: "crossSurfaceEntitlementsConsistent",
    input: {
      certificationId: "certification-126", auditorProviderId: "auditor-126", scenarioArtifactSha256: DIGEST_A,
      environment: "sandbox", entrypoints: ["web", "ios", "android", "mini_program"],
      scenarios: ["consent", "generation", "payment", "refund", "physical_fulfillment", "support", "finance_close", "deletion"],
      financialControlTotalMinor: 1000, ledgerControlTotalMinor: 1000,
      deletionProofTargets: ["connector", "cdn", "vendor", "warehouse", "application"], criticalFailures: 0,
      entitlementReconciliationId: "reconciliation-126", externalEvidenceIds: evidenceIds("B126", 5),
    },
  },
  {
    batchId: "B127",
    binding: {
      tenantId: TENANT_ID, batchId: "B127", operation: "approveStagedProductionLaunch", kind: "release-control-plane",
      provider: "release-control:control-plane-127", artifactSha256: DIGEST_A, environment: "sandbox", subjectId: "launch-127",
    },
    artifactField: "releaseManifestDigest",
    legacyAssertionField: "rollbackTested",
    input: {
      launchId: "launch-127", releaseControlProviderId: "control-plane-127", providerEnvironment: "sandbox",
      releaseManifestDigest: DIGEST_A, repositoryCommit: "commit-127", artifactCommit: "commit-127", sbomDigest: DIGEST_B,
      wave: "global", rolloutPercent: 100, waveStartedAt: "2026-08-20T00:00:00.000Z",
      releaseGates: Array.from({ length: 12 }, (_, index) => `G${index}`),
      monitoringDomains: ["quality", "payment", "refund", "message", "support", "ledger", "supply", "privacy", "security", "cost", "slo"],
      approvalIds: ["approval-127-a", "approval-127-b"], rollbackExerciseId: "rollback-127",
      automaticPausePolicyVersion: "pause-v1", activeGuardrailBreaches: 0,
      guardrailPolicySha256: DIGEST_A, waveObservationSetSha256: DIGEST_B,
      rollbackForwardDrillSha256: DIGEST_C,
      globalWaveObservationPath: "security/evidence/global-wave-observation.json",
      globalWaveObservationSha256: DIGEST_A,
      changeApproverEvidenceIds: ["change-risk-evidence", "change-operations-evidence"],
      externalEvidenceIds: evidenceIds("B127", 5),
    },
  },
];

for (const evidenceCase of cases) {
  const positiveTitle = EXTERNAL_EVENT_ONLY.has(evidenceCase.batchId)
    ? `${evidenceCase.batchId} closes the legacy direct-fact capability path`
    : `${evidenceCase.batchId} accepts exactly scoped signed sandbox evidence`;
  test(positiveTitle, async (testContext) => {
    const context = admin(evidenceCase.batchId);
    const runtime = runtimeFor(testContext, evidenceCase.binding.provider);
    const registry = createCapabilityRegistry();
    if (EXTERNAL_EVENT_ONLY.has(evidenceCase.batchId)) {
      await rejectsDomainCode(registry.execute(runtime, evidenceCase.batchId, {
        actor: context,
        idempotencyKey: `legacy-direct-${evidenceCase.batchId}`,
        input: evidenceCase.input,
      }), "AUTH_FORBIDDEN");
      return;
    }
    if (evidenceCase.batchId === "B71") {
      runtime.grantConsent(context, {
        participantId: context.actorId,
        grantorCapacity: "self",
        purpose: context.purpose,
        scope: { feature: "wechat_commercial_action" },
        policyVersion: "sandbox-policy-v1",
        evidenceHash: DIGEST_C,
        idempotencyKey: "grant-b71-sandbox-consent",
      });
    }
    const ids = (evidenceCase.input.externalEvidenceIds ?? evidenceCase.input.approvalEvidenceIds) as string[];
    registerSandboxEvidence(runtime, context, requestBoundBinding(registry, evidenceCase, context), ids);

    const result = objectResult(await registry.execute(runtime, evidenceCase.batchId, {
      actor: context,
      idempotencyKey: `execute-${evidenceCase.batchId}`,
      input: evidenceCase.input,
    }));

    const expectedState = evidenceCase.batchId === "B47"
      ? "staging"
      : "evidence_persisted";
    assert.equal(result.state, expectedState);
    for (const evidenceId of ids) assert.notEqual(runtime.getExternalEvidence(context, evidenceId).consumedAt, null);
  });

  const negativeTitle = EXTERNAL_EVENT_ONLY.has(evidenceCase.batchId)
    ? `${evidenceCase.batchId} remains closed even when legacy evidence fields are supplied`
    : `${evidenceCase.batchId} rejects cross-artifact scope replay and legacy client assertions`;
  test(negativeTitle, async (testContext) => {
    const context = admin(evidenceCase.batchId, "negative");
    const runtime = runtimeFor(testContext, evidenceCase.binding.provider);
    const registry = createCapabilityRegistry();
    if (EXTERNAL_EVENT_ONLY.has(evidenceCase.batchId)) {
      await rejectsDomainCode(registry.execute(runtime, evidenceCase.batchId, {
        actor: context,
        idempotencyKey: `legacy-direct-negative-${evidenceCase.batchId}`,
        input: evidenceCase.input,
      }), "AUTH_FORBIDDEN");
      return;
    }
    if (evidenceCase.batchId === "B71") {
      runtime.grantConsent(context, {
        participantId: context.actorId,
        grantorCapacity: "self",
        purpose: context.purpose,
        scope: { feature: "wechat_commercial_action" },
        policyVersion: "sandbox-policy-v1",
        evidenceHash: DIGEST_C,
        idempotencyKey: "grant-b71-negative-consent",
      });
    }
    const ids = (evidenceCase.input.externalEvidenceIds ?? evidenceCase.input.approvalEvidenceIds) as string[];
    registerSandboxEvidence(runtime, context, requestBoundBinding(registry, evidenceCase, context), ids);

    await rejectsDomainCode(
      registry.execute(runtime, evidenceCase.batchId, {
        actor: context,
        idempotencyKey: `cross-scope-${evidenceCase.batchId}`,
        input: { ...evidenceCase.input, [evidenceCase.artifactField]: DIGEST_B },
      }),
      "EVIDENCE_SCOPE_MISMATCH",
    );
    if (evidenceCase.legacyAssertionField !== undefined) {
      await rejectsDomainCode(
        registry.execute(runtime, evidenceCase.batchId, {
          actor: { ...context, requestId: `legacy-${evidenceCase.batchId}` },
          idempotencyKey: `legacy-assertion-${evidenceCase.batchId}`,
          input: { ...evidenceCase.input, [evidenceCase.legacyAssertionField]: true },
        }),
        "VALIDATION_FAILED",
      );
    }
  });
}

test("operational attestations fail closed when no server-side evidence verifier is configured", async (testContext) => {
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:" });
  testContext.after(() => runtime.close());
  const registry = createCapabilityRegistry();
  for (const batchId of ["B56", "B118", "B119", "B121", "B122"] as const) {
    const evidenceCase = cases.find((item) => item.batchId === batchId);
    assert.ok(evidenceCase);
    await rejectsDomainCode(registry.execute(runtime, batchId, {
      actor: admin(batchId, "missing-verifier"),
      idempotencyKey: `missing-verifier-${batchId}`,
      input: evidenceCase.input,
    }), "EXTERNAL_ADAPTER_UNAVAILABLE");
  }
});

test("B56 approval requires an independent step-up auditor rather than a client approval flag", async (testContext) => {
  const evidenceCase = cases.find((item) => item.batchId === "B56");
  assert.ok(evidenceCase);
  const runtime = runtimeFor(testContext, evidenceCase.binding.provider);
  const registry = createCapabilityRegistry();
  const ids = evidenceCase.input.externalEvidenceIds as string[];
  registerSandboxEvidence(
    runtime,
    admin("B56", "register-role-check"),
    requestBoundBinding(registry, evidenceCase, admin("B56", "request-role-check")),
    ids,
  );

  await rejectsDomainCode(registry.execute(runtime, "B56", {
    actor: { ...admin("B56", "non-auditor"), roles: ["platform_admin"] },
    idempotencyKey: "b56-non-auditor",
    input: evidenceCase.input,
  }), "AUTH_FORBIDDEN");
  await rejectsDomainCode(registry.execute(runtime, "B56", {
    actor: { ...admin("B56", "issuer-is-approver"), actorId: "assessor-56" },
    idempotencyKey: "b56-issuer-is-approver",
    input: evidenceCase.input,
  }), "AUTH_FORBIDDEN");
});

test("B47 rolls back single-use evidence when the capability transition fails", async (testContext) => {
  const evidenceCase = cases.find((item) => item.batchId === "B47");
  assert.ok(evidenceCase);
  const context = admin("B47", "atomic-rollback");
  const runtime = runtimeFor(testContext, evidenceCase.binding.provider);
  const registry = createCapabilityRegistry();
  const ids = evidenceCase.input.externalEvidenceIds as string[];
  registerSandboxEvidence(runtime, context, requestBoundBinding(registry, evidenceCase, context), ids);
  runtime.createRecord(context, {
    collection: "release.promotions",
    id: "release-47",
    data: { environment: "production" },
    idempotencyKey: "b47-stale-transition-fixture",
  });

  await rejectsDomainCode(createCapabilityRegistry().execute(runtime, "B47", {
    actor: context,
    idempotencyKey: "b47-atomic-rollback",
    input: evidenceCase.input,
  }), "VERSION_CONFLICT");

  for (const evidenceId of ids) {
    assert.equal(runtime.getExternalEvidence(context, evidenceId).consumedAt, null);
  }
  assert.equal(runtime.getRecord(context, "release.promotions", "release-47").data.environment, "production");
  assert.equal(
    runtime.listAudit(context, 200).filter((entry) => entry.action === "capability.B47.transition").length,
    0,
  );
});

test("production evidence runtime rejects a signed sandbox operational-report fixture", (testContext) => {
  const evidenceCase = cases.find((item) => item.batchId === "B119");
  assert.ok(evidenceCase);
  const context = admin("production-reject");
  const productionIssuer = "capability-adapter-fixture";
  const productionKeyId = "ed25519-2026";
  const policyIssuedAt = new Date(Date.now() - 60_000).toISOString();
  const policyExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const consentPolicyCatalog = signConsentPolicyCatalog({
    schemaVersion: "ltm.consent-policy-catalog.v1",
    catalogId: "capability-production-policy-1",
    issuer: "privacy-policy-authority",
    environment: "production",
    issuedAt: policyIssuedAt,
    expiresAt: policyExpiresAt,
    algorithm: "Ed25519",
    keyId: "capability-consent-key-1",
    policies: [{
      policyVersion: "capability-policy-v1",
      purpose: "sandbox_commercial_validation",
      locale: "zh-CN",
      jurisdictions: ["CN"],
      resourceKinds: ["record"],
      allowedActions: ["read"],
      grantorCapacities: ["self"],
      minorApplicability: "adult",
      disclosureSha256: DIGEST_C,
      effectiveFrom: policyIssuedAt,
      effectiveUntil: policyExpiresAt,
      maxConsentLifetimeSeconds: 3_600,
    }],
  }, PRIVATE_KEY_PEM);
  const runtime = new LifeTimeMachineRuntime({
    databasePath: ":memory:",
    evidencePolicy: "production",
    evidenceEnvironment: "production",
    trustedEvidenceKeys: [{
      issuer: productionIssuer,
      provider: evidenceCase.binding.provider,
      keyId: productionKeyId,
      algorithm: "Ed25519",
      publicKeyPem: PUBLIC_KEY_PEM,
      allowedScopes: ["ltm-evidence:v1:*"],
      allowedEnvironments: ["production"],
    }],
    consentPolicyCatalog,
    trustedConsentPolicyKeys: [{
      keyId: "capability-consent-key-1",
      issuer: "privacy-policy-authority",
      algorithm: "Ed25519",
      publicKeyPem: PUBLIC_KEY_PEM,
      allowedEnvironments: ["production"],
      notBefore: policyIssuedAt,
      notAfter: policyExpiresAt,
    }],
    consentPolicyJurisdiction: "CN",
    consentPolicyLocale: "zh-CN",
  });
  testContext.after(() => runtime.close());
  const scope = capabilityEvidenceScope(evidenceCase.binding);
  const unsigned = {
    version: "ltm.external-evidence.v1" as const,
    evidenceId: "test-evidence-production-reject",
    tenantId: context.tenantId,
    issuer: productionIssuer,
    provider: evidenceCase.binding.provider,
    environment: "sandbox" as const,
    scope,
    artifactSha256: evidenceCase.binding.artifactSha256,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    nonce: "sandbox-production-rejection-2026",
    replayPolicy: "single_use" as const,
    algorithm: "Ed25519" as const,
    keyId: productionKeyId,
  };
  assert.throws(
    () => runtime.registerExternalEvidence(context, {
      evidence: signExternalEvidence(unsigned, PRIVATE_KEY_PEM),
      idempotencyKey: "register-sandbox-in-production",
    }),
    (error: unknown) => error instanceof DomainError && error.code === "EVIDENCE_TRUST_KEY_NOT_FOUND",
  );
});
