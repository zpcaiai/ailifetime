import { DomainError } from "@ltm/core";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { objectValue, requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertActorTenant,
  assertISODate,
  assertKnownState,
  defineCapability,
  registerDefinitions,
  requireInteger,
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "hardening-enterprise-platform";

function configChange(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const changeId = requiredString(input, "changeId");
  const environment = assertKnownState(requiredString(input, "environment"), ["local", "ci", "staging", "production"] as const, "environment");
  const schemaVersion = requiredString(input, "schemaVersion");
  const secretReference = requiredString(input, "secretReference");
  const changedFields = stringList(input, "changedFields", { min: 1, unique: true });
  const disabledControls = stringList(input, "disabledControls", { unique: true });
  const approvalIds = stringList(input, "approvalIds", { min: environment === "production" ? 2 : 1, unique: true });
  const rollbackVersion = requiredString(input, "rollbackVersion");
  const driftCheckPassed = requireTrue(requiredBoolean(input, "driftCheckPassed"), "driftCheckPassed");
  if (disabledControls.some((control) => ["consent", "ai_label", "child_safety", "high_impact_ban", "tenant_isolation"].includes(control))) {
    throw new DomainError("AUTH_FORBIDDEN", "tenant configuration cannot disable non-waivable controls");
  }
  if (/BEGIN [A-Z ]+PRIVATE KEY|password\s*=|secret\s*=|token\s*=/i.test(secretReference)) {
    throw new DomainError("VALIDATION_FAILED", "secretReference contains secret material");
  }
  if (environment === "production" && invocation.actor.stepUp !== true) {
    throw new DomainError("AUTH_FORBIDDEN", "production configuration changes require step-up authentication");
  }
  return {
    changeId,
    environment,
    schemaVersion,
    secretReference,
    changedFields,
    disabledControls,
    approvalIds,
    rollbackVersion,
    driftCheckPassed,
  };
}

function regionPolicy(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const policyId = requiredString(input, "policyId");
  const dataClass = assertKnownState(requiredString(input, "dataClass"), ["media", "identity", "business", "financial", "analytics", "logs"] as const, "dataClass");
  const originRegion = requiredString(input, "originRegion");
  const processingRegion = requiredString(input, "processingRegion");
  const allowedRegions = stringList(input, "allowedRegions", { min: 1, unique: true });
  const replicationRegions = stringList(input, "replicationRegions", { unique: true });
  const policyVersion = requiredString(input, "policyVersion");
  const signedCdnUrls = requireTrue(requiredBoolean(input, "signedCdnUrls"), "signedCdnUrls");
  const revocationProofEnabled = requireTrue(requiredBoolean(input, "revocationProofEnabled"), "revocationProofEnabled");
  const unknownPolicy = requiredBoolean(input, "unknownPolicy");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (unknownPolicy || !allowedRegions.includes(processingRegion) || replicationRegions.some((region) => !allowedRegions.includes(region))) {
    throw new DomainError("AUTH_FORBIDDEN", "unknown or disallowed residency routes fail closed");
  }
  if (dataClass === "media" && replicationRegions.length > 0 && !requiredBoolean(input, "crossRegionApproval")) {
    throw new DomainError("AUTH_FORBIDDEN", "media replication requires explicit regional approval");
  }
  return {
    policyId,
    dataClass,
    originRegion,
    processingRegion,
    allowedRegions,
    replicationRegions,
    policyVersion,
    signedCdnUrls,
    revocationProofEnabled,
    unknownPolicy,
    externalEvidenceIds,
    crossRegionApproval: input.crossRegionApproval === true,
  };
}

function capacityGate(input: JsonObject): JsonObject {
  const testRunId = requiredString(input, "testRunId");
  const loadProfile = requiredString(input, "loadProfile");
  const scenarios = stringList(input, "scenarios", { min: 5, unique: true });
  const thresholds = objectValue(input, "thresholds");
  const p95Ms = requireInteger(requiredNumber(input, "p95Ms", 0), "p95Ms", 0);
  const maxP95Ms = requireInteger(requiredNumber(input, "maxP95Ms", 1), "maxP95Ms", 1);
  const errorRate = requiredNumber(input, "errorRate", 0);
  const maxErrorRate = requiredNumber(input, "maxErrorRate", 0);
  const syntheticDataOnly = requireTrue(requiredBoolean(input, "syntheticDataOnly"), "syntheticDataOnly");
  const paidTasksProtected = requireTrue(requiredBoolean(input, "paidTasksProtected"), "paidTasksProtected");
  const tenantFairnessVerified = requireTrue(requiredBoolean(input, "tenantFairnessVerified"), "tenantFairnessVerified");
  for (const scenario of ["baseline", "peak", "burst", "soak", "dependency_degraded"]) {
    if (!scenarios.includes(scenario)) throw new DomainError("VALIDATION_FAILED", `capacity scenarios must include ${scenario}`);
  }
  if (p95Ms > maxP95Ms || errorRate > maxErrorRate || errorRate < 0 || maxErrorRate < 0 || maxErrorRate > 1) {
    throw new DomainError("VALIDATION_FAILED", "observed capacity exceeds a hard release threshold");
  }
  return {
    testRunId,
    loadProfile,
    scenarios,
    thresholds,
    p95Ms,
    maxP95Ms,
    errorRate,
    maxErrorRate,
    syntheticDataOnly,
    paidTasksProtected,
    tenantFairnessVerified,
  };
}

function resilienceExercise(input: JsonObject): JsonObject {
  const exerciseId = requiredString(input, "exerciseId");
  const faultType = assertKnownState(
    requiredString(input, "faultType"),
    ["model", "storage", "database", "queue", "payment", "messaging", "vendor", "region"] as const,
    "faultType",
  );
  const targetRtoSeconds = requireInteger(requiredNumber(input, "targetRtoSeconds", 0), "targetRtoSeconds", 0);
  const observedRtoSeconds = requireInteger(requiredNumber(input, "observedRtoSeconds", 0), "observedRtoSeconds", 0);
  const targetRpoSeconds = requireInteger(requiredNumber(input, "targetRpoSeconds", 0), "targetRpoSeconds", 0);
  const observedRpoSeconds = requireInteger(requiredNumber(input, "observedRpoSeconds", 0), "observedRpoSeconds", 0);
  const failoverRegion = requiredString(input, "failoverRegion");
  const allowedFailoverRegions = stringList(input, "allowedFailoverRegions", { min: 1, unique: true });
  const cancellationPriorityVerified = requireTrue(requiredBoolean(input, "cancellationPriorityVerified"), "cancellationPriorityVerified");
  const deletionResurrectionPrevented = requireTrue(requiredBoolean(input, "deletionResurrectionPrevented"), "deletionResurrectionPrevented");
  const duplicateSideEffectsPrevented = requireTrue(requiredBoolean(input, "duplicateSideEffectsPrevented"), "duplicateSideEffectsPrevented");
  if (observedRtoSeconds > targetRtoSeconds || observedRpoSeconds > targetRpoSeconds || !allowedFailoverRegions.includes(failoverRegion)) {
    throw new DomainError("VALIDATION_FAILED", "resilience exercise failed RTO/RPO or residency policy");
  }
  return {
    exerciseId,
    faultType,
    targetRtoSeconds,
    observedRtoSeconds,
    targetRpoSeconds,
    observedRpoSeconds,
    failoverRegion,
    allowedFailoverRegions,
    cancellationPriorityVerified,
    deletionResurrectionPrevented,
    duplicateSideEffectsPrevented,
  };
}

function securityAssurance(input: JsonObject): JsonObject {
  const assessmentId = requiredString(input, "assessmentId");
  const artifactDigest = requiredString(input, "artifactDigest");
  const sbomDigest = requiredString(input, "sbomDigest");
  const provenanceSignature = requiredString(input, "provenanceSignature");
  const scans = stringList(input, "scans", { min: 6, unique: true });
  const criticalFindings = requireInteger(requiredNumber(input, "criticalFindings", 0), "criticalFindings", 0);
  const highFindings = requireInteger(requiredNumber(input, "highFindings", 0), "highFindings", 0);
  const independentPentest = requireTrue(requiredBoolean(input, "independentPentest"), "independentPentest");
  const retestComplete = requireTrue(requiredBoolean(input, "retestComplete"), "retestComplete");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 2, unique: true });
  for (const scan of ["secrets", "sast", "sca", "iac", "dast", "api"]) {
    if (!scans.includes(scan)) throw new DomainError("VALIDATION_FAILED", `security scans must include ${scan}`);
  }
  if (criticalFindings !== 0 || highFindings !== 0) throw new DomainError("AUTH_FORBIDDEN", "unresolved critical/high findings block assurance");
  return {
    assessmentId,
    artifactDigest,
    sbomDigest,
    provenanceSignature,
    scans,
    criticalFindings,
    highFindings,
    independentPentest,
    retestComplete,
    externalEvidenceIds,
  };
}

function complianceEvidence(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const assessmentId = requiredString(input, "assessmentId");
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
  return {
    assessmentId,
    profileVersion,
    region,
    controls,
    artifactHashes,
    evidenceExpiresAt,
    exportTenantId,
    approvalIds,
    unresolvedControlFailures,
    externalEvidenceIds,
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B119", SKILL, "approveConfigurationChange", configChange, { permission: "platform.config.approve" }),
  defineCapability("B120", SKILL, "publishResidencyPolicy", regionPolicy, {
    permission: "platform.residency.publish",
    requiresExternalEvidence: true,
  }),
  defineCapability("B121", SKILL, "approveCapacityGate", capacityGate, { permission: "platform.capacity.approve" }),
  defineCapability("B122", SKILL, "recordResilienceExercise", resilienceExercise, { permission: "platform.resilience.record" }),
  defineCapability("B123", SKILL, "approveSecurityAssurance", securityAssurance, {
    permission: "security.assurance.approve",
    requiresExternalEvidence: true,
  }),
  defineCapability("B124", SKILL, "approveComplianceEvidence", complianceEvidence, {
    permission: "compliance.evidence.approve",
    requiresExternalEvidence: true,
  }),
];

export function registerHardeningEnterprisePlatformCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const hardeningEnterprisePlatformCoverage = definitions.length;
