import { DomainError } from "@ltm/core";
import { capabilityEvidenceScope } from "@ltm/providers";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { objectValue, requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertActorTenant,
  assertISODate,
  assertKnownState,
  defineCapability,
  registerDefinitions,
  rejectClientAssertions,
  requireInteger,
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "hardening-enterprise-platform";

function sha256(input: JsonObject, field: string): string {
  const value = requiredString(input, field);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DomainError("VALIDATION_FAILED", `${field} must be a lowercase SHA-256 digest`);
  return value;
}

function operationalEvidenceEnvironment(input: JsonObject): "test" | "sandbox" | "staging" | "production" {
  return assertKnownState(
    requiredString(input, "providerEnvironment"),
    ["test", "sandbox", "staging", "production"] as const,
    "providerEnvironment",
  );
}

function configChange(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["driftCheckPassed", "changeApproved", "controlsVerified"]);
  assertActorTenant(input, invocation);
  const changeId = requiredString(input, "changeId");
  const environment = assertKnownState(requiredString(input, "environment"), ["local", "ci", "staging", "production"] as const, "environment");
  const schemaVersion = requiredString(input, "schemaVersion");
  const secretReference = requiredString(input, "secretReference");
  const changedFields = stringList(input, "changedFields", { min: 1, unique: true });
  const disabledControls = stringList(input, "disabledControls", { unique: true });
  const approvalIds = stringList(input, "approvalIds", { min: environment === "production" ? 2 : 1, unique: true });
  const rollbackVersion = requiredString(input, "rollbackVersion");
  const changeControlProviderId = requiredString(input, "changeControlProviderId");
  const evidenceEnvironment = operationalEvidenceEnvironment(input);
  const changeReportSha256 = sha256(input, "changeReportSha256");
  const reportSchemaVersion = requiredString(input, "reportSchemaVersion");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (disabledControls.some((control) => ["consent", "ai_label", "child_safety", "high_impact_ban", "tenant_isolation"].includes(control))) {
    throw new DomainError("AUTH_FORBIDDEN", "tenant configuration cannot disable non-waivable controls");
  }
  if (/BEGIN [A-Z ]+PRIVATE KEY|password\s*=|secret\s*=|token\s*=/i.test(secretReference)) {
    throw new DomainError("VALIDATION_FAILED", "secretReference contains secret material");
  }
  if (environment === "production" && invocation.actor.stepUp !== true) {
    throw new DomainError("AUTH_FORBIDDEN", "production configuration changes require step-up authentication");
  }
  if (environment === "production" && evidenceEnvironment !== "production") {
    throw new DomainError("AUTH_FORBIDDEN", "production configuration changes require production evidence");
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B119",
    operation: "approveConfigurationChange",
    kind: "configuration-change-report",
    provider: `change-control:${changeControlProviderId}`,
    artifactSha256: changeReportSha256,
    environment: evidenceEnvironment,
    subjectId: changeId,
  });
  return {
    changeId,
    environment,
    schemaVersion,
    secretReference,
    changedFields,
    disabledControls,
    approvalIds,
    rollbackVersion,
    changeControlProviderId,
    providerEnvironment: evidenceEnvironment,
    changeReportSha256,
    reportSchemaVersion,
    externalEvidenceIds,
    evidenceScope,
    decisionState: environment === "production" ? "approved" : "simulation_only",
  };
}

function regionPolicy(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["signedCdnUrls", "revocationProofEnabled", "crossRegionApproval"]);
  assertActorTenant(input, invocation);
  const policyId = requiredString(input, "policyId");
  const cloudProviderId = requiredString(input, "cloudProviderId");
  const providerEnvironment = assertKnownState(
    requiredString(input, "providerEnvironment"),
    ["sandbox", "staging", "production"] as const,
    "providerEnvironment",
  );
  const topologyArtifactSha256 = sha256(input, "topologyArtifactSha256");
  const dataClass = assertKnownState(requiredString(input, "dataClass"), ["media", "identity", "business", "financial", "analytics", "logs"] as const, "dataClass");
  const originRegion = requiredString(input, "originRegion");
  const processingRegion = requiredString(input, "processingRegion");
  const allowedRegions = stringList(input, "allowedRegions", { min: 1, unique: true });
  const replicationRegions = stringList(input, "replicationRegions", { unique: true });
  const policyVersion = requiredString(input, "policyVersion");
  const cdnPolicyVersion = requiredString(input, "cdnPolicyVersion");
  const revocationProofId = requiredString(input, "revocationProofId");
  const unknownPolicy = requiredBoolean(input, "unknownPolicy");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (unknownPolicy || !allowedRegions.includes(processingRegion) || replicationRegions.some((region) => !allowedRegions.includes(region))) {
    throw new DomainError("AUTH_FORBIDDEN", "unknown or disallowed residency routes fail closed");
  }
  const crossRegionApprovalId = typeof input.crossRegionApprovalId === "string" ? input.crossRegionApprovalId : undefined;
  if (dataClass === "media" && replicationRegions.length > 0 && !crossRegionApprovalId) {
    throw new DomainError("AUTH_FORBIDDEN", "media replication requires explicit regional approval");
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B120",
    operation: "publishResidencyPolicy",
    kind: "cloud-residency",
    provider: `cloud:${cloudProviderId}`,
    artifactSha256: topologyArtifactSha256,
    environment: providerEnvironment,
    subjectId: policyId,
  });
  return {
    policyId,
    cloudProviderId,
    providerEnvironment,
    topologyArtifactSha256,
    dataClass,
    originRegion,
    processingRegion,
    allowedRegions,
    replicationRegions,
    policyVersion,
    cdnPolicyVersion,
    revocationProofId,
    unknownPolicy,
    externalEvidenceIds,
    ...(crossRegionApprovalId ? { crossRegionApprovalId } : {}),
    evidenceScope,
    decisionState: providerEnvironment === "sandbox" ? "simulation_only" : "approved",
  };
}

function capacityGate(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, [
    "p95Ms",
    "errorRate",
    "syntheticDataOnly",
    "paidTasksProtected",
    "tenantFairnessVerified",
    "capacityPassed",
  ]);
  const testRunId = requiredString(input, "testRunId");
  const loadProfile = requiredString(input, "loadProfile");
  const scenarios = stringList(input, "scenarios", { min: 5, unique: true });
  const thresholds = objectValue(input, "thresholds");
  const maxP95Ms = requireInteger(requiredNumber(input, "maxP95Ms", 1), "maxP95Ms", 1);
  const maxErrorRate = requiredNumber(input, "maxErrorRate", 0);
  const loadTestProviderId = requiredString(input, "loadTestProviderId");
  const environment = operationalEvidenceEnvironment(input);
  const capacityReportSha256 = sha256(input, "capacityReportSha256");
  const reportSchemaVersion = requiredString(input, "reportSchemaVersion");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  for (const scenario of ["baseline", "peak", "burst", "soak", "dependency_degraded"]) {
    if (!scenarios.includes(scenario)) throw new DomainError("VALIDATION_FAILED", `capacity scenarios must include ${scenario}`);
  }
  if (maxErrorRate < 0 || maxErrorRate > 1) {
    throw new DomainError("VALIDATION_FAILED", "capacity error-rate threshold must be between zero and one");
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B121",
    operation: "approveCapacityGate",
    kind: "capacity-test-report",
    provider: `load-test:${loadTestProviderId}`,
    artifactSha256: capacityReportSha256,
    environment,
    subjectId: testRunId,
  });
  return {
    testRunId,
    loadProfile,
    scenarios,
    thresholds,
    maxP95Ms,
    maxErrorRate,
    loadTestProviderId,
    providerEnvironment: environment,
    capacityReportSha256,
    reportSchemaVersion,
    externalEvidenceIds,
    evidenceScope,
    decisionState: environment === "production" ? "approved" : "simulation_only",
  };
}

function resilienceExercise(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, [
    "observedRtoSeconds",
    "observedRpoSeconds",
    "cancellationPriorityVerified",
    "deletionResurrectionPrevented",
    "duplicateSideEffectsPrevented",
    "exercisePassed",
  ]);
  const exerciseId = requiredString(input, "exerciseId");
  const faultType = assertKnownState(
    requiredString(input, "faultType"),
    ["model", "storage", "database", "queue", "payment", "messaging", "vendor", "region"] as const,
    "faultType",
  );
  const targetRtoSeconds = requireInteger(requiredNumber(input, "targetRtoSeconds", 0), "targetRtoSeconds", 0);
  const targetRpoSeconds = requireInteger(requiredNumber(input, "targetRpoSeconds", 0), "targetRpoSeconds", 0);
  const failoverRegion = requiredString(input, "failoverRegion");
  const allowedFailoverRegions = stringList(input, "allowedFailoverRegions", { min: 1, unique: true });
  const resilienceProviderId = requiredString(input, "resilienceProviderId");
  const environment = operationalEvidenceEnvironment(input);
  const resilienceReportSha256 = sha256(input, "resilienceReportSha256");
  const reportSchemaVersion = requiredString(input, "reportSchemaVersion");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (!allowedFailoverRegions.includes(failoverRegion)) {
    throw new DomainError("VALIDATION_FAILED", "resilience exercise failover region violates residency policy");
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B122",
    operation: "recordResilienceExercise",
    kind: "resilience-exercise-report",
    provider: `resilience-auditor:${resilienceProviderId}`,
    artifactSha256: resilienceReportSha256,
    environment,
    subjectId: exerciseId,
  });
  return {
    exerciseId,
    faultType,
    targetRtoSeconds,
    targetRpoSeconds,
    failoverRegion,
    allowedFailoverRegions,
    resilienceProviderId,
    providerEnvironment: environment,
    resilienceReportSha256,
    reportSchemaVersion,
    externalEvidenceIds,
    evidenceScope,
    decisionState: environment === "production" ? "verified" : "simulation_only",
  };
}

function securityAssurance(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["independentPentest", "retestComplete"]);
  const assessmentId = requiredString(input, "assessmentId");
  const pentestProviderId = requiredString(input, "pentestProviderId");
  const providerEnvironment = assertKnownState(
    requiredString(input, "providerEnvironment"),
    ["sandbox", "staging", "production"] as const,
    "providerEnvironment",
  );
  const artifactDigest = sha256(input, "artifactDigest");
  const sbomDigest = sha256(input, "sbomDigest");
  const retestArtifactSha256 = sha256(input, "retestArtifactSha256");
  const provenanceSignature = requiredString(input, "provenanceSignature");
  const scans = stringList(input, "scans", { min: 6, unique: true });
  const criticalFindings = requireInteger(requiredNumber(input, "criticalFindings", 0), "criticalFindings", 0);
  const highFindings = requireInteger(requiredNumber(input, "highFindings", 0), "highFindings", 0);
  const engagementId = requiredString(input, "engagementId");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 2, unique: true });
  for (const scan of ["secrets", "sast", "sca", "iac", "dast", "api"]) {
    if (!scans.includes(scan)) throw new DomainError("VALIDATION_FAILED", `security scans must include ${scan}`);
  }
  if (criticalFindings !== 0 || highFindings !== 0) throw new DomainError("AUTH_FORBIDDEN", "unresolved critical/high findings block assurance");
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B123",
    operation: "approveSecurityAssurance",
    kind: "independent-pentest",
    provider: `pentest:${pentestProviderId}`,
    artifactSha256: artifactDigest,
    environment: providerEnvironment,
    subjectId: assessmentId,
  });
  return {
    assessmentId,
    pentestProviderId,
    providerEnvironment,
    artifactDigest,
    sbomDigest,
    retestArtifactSha256,
    provenanceSignature,
    scans,
    criticalFindings,
    highFindings,
    engagementId,
    externalEvidenceIds,
    evidenceScope,
    decisionState: providerEnvironment === "sandbox" ? "simulation_only" : "approved",
  };
}

function complianceEvidence(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["controlsCertified", "compliancePassed"]);
  assertActorTenant(input, invocation);
  const assessmentId = requiredString(input, "assessmentId");
  const complianceProviderId = requiredString(input, "complianceProviderId");
  const providerEnvironment = assertKnownState(
    requiredString(input, "providerEnvironment"),
    ["sandbox", "staging", "production"] as const,
    "providerEnvironment",
  );
  const assessmentArtifactSha256 = sha256(input, "assessmentArtifactSha256");
  const profileVersion = requiredString(input, "profileVersion");
  const region = requiredString(input, "region");
  const controls = stringList(input, "controls", { min: 5, unique: true });
  const artifactHashes = stringList(input, "artifactHashes", { min: 3, unique: true });
  const evidenceExpiresAt = assertISODate(requiredString(input, "evidenceExpiresAt"), "evidenceExpiresAt");
  const exportTenantId = requiredString(input, "exportTenantId");
  const approvalIds = stringList(input, "approvalIds", { min: 2, unique: true });
  const unresolvedControlFailures = requireInteger(
    requiredNumber(input, "unresolvedControlFailures", 0),
    "unresolvedControlFailures",
    0,
  );
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 2, unique: true });
  if (exportTenantId !== invocation.actor.tenantId) throw new DomainError("TENANT_SCOPE_MISMATCH", "audit export tenant mismatch");
  if (Date.parse(evidenceExpiresAt) <= Date.now() || unresolvedControlFailures !== 0) {
    throw new DomainError("AUTH_FORBIDDEN", "expired or failed compliance controls block evidence approval");
  }
  for (const control of ["privacy", "ai_label", "minor", "finance", "security"]) {
    if (!controls.includes(control)) throw new DomainError("VALIDATION_FAILED", `controls must include ${control}`);
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B124",
    operation: "approveComplianceEvidence",
    kind: "compliance-attestation",
    provider: `compliance:${complianceProviderId}`,
    artifactSha256: assessmentArtifactSha256,
    environment: providerEnvironment,
    subjectId: assessmentId,
  });
  return {
    assessmentId,
    complianceProviderId,
    providerEnvironment,
    assessmentArtifactSha256,
    profileVersion,
    region,
    controls,
    artifactHashes,
    evidenceExpiresAt,
    exportTenantId,
    approvalIds,
    unresolvedControlFailures,
    externalEvidenceIds,
    evidenceScope,
    decisionState: providerEnvironment === "sandbox" ? "simulation_only" : "approved",
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B119", SKILL, "approveConfigurationChange", configChange, {
    permission: "platform.config.approve",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "changeReportSha256",
    mode: "attestation",
  }),
  defineCapability("B120", SKILL, "publishResidencyPolicy", regionPolicy, {
    permission: "platform.residency.publish",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "topologyArtifactSha256",
    mode: "attestation",
  }),
  defineCapability("B121", SKILL, "approveCapacityGate", capacityGate, {
    permission: "platform.capacity.approve",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "capacityReportSha256",
    mode: "attestation",
  }),
  defineCapability("B122", SKILL, "recordResilienceExercise", resilienceExercise, {
    permission: "platform.resilience.record",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "resilienceReportSha256",
    mode: "attestation",
  }),
  defineCapability("B123", SKILL, "approveSecurityAssurance", securityAssurance, {
    permission: "security.assurance.approve",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "artifactDigest",
    mode: "attestation",
  }),
  defineCapability("B124", SKILL, "approveComplianceEvidence", complianceEvidence, {
    permission: "compliance.evidence.approve",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "assessmentArtifactSha256",
    mode: "attestation",
  }),
];

export function registerHardeningEnterprisePlatformCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const hardeningEnterprisePlatformCoverage = definitions.length;
