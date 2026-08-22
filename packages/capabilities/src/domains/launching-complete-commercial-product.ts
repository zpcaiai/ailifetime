import { DomainError } from "@ltm/core";
import { capabilityEvidenceScope } from "@ltm/providers";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
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

const SKILL = "launching-complete-commercial-product";

function sha256(input: JsonObject, field: string): string {
  const value = requiredString(input, field);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DomainError("VALIDATION_FAILED", `${field} must be a lowercase SHA-256 digest`);
  return value;
}

function commercialReadiness(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["vendorContractsApproved"]);
  assertActorTenant(input, invocation);
  if (invocation.actor.stepUp !== true) throw new DomainError("AUTH_FORBIDDEN", "commercial readiness approval requires step-up authentication");
  const readinessId = requiredString(input, "readinessId");
  const auditorProviderId = requiredString(input, "auditorProviderId");
  const providerEnvironment = assertKnownState(
    requiredString(input, "providerEnvironment"),
    ["sandbox", "staging", "production"] as const,
    "providerEnvironment",
  );
  const readinessArtifactSha256 = sha256(input, "readinessArtifactSha256");
  const profileVersion = requiredString(input, "profileVersion");
  const policyVersions = stringList(input, "policyVersions", { min: 6, unique: true });
  const operationalDrills = stringList(input, "operationalDrills", { min: 5, unique: true });
  const providerChecks = stringList(input, "providerChecks", { min: 6, unique: true });
  const raciRoles = stringList(input, "raciRoles", { min: 4, unique: true });
  const stopConditions = stringList(input, "stopConditions", { min: 3, unique: true });
  const p0Blockers = requireInteger(requiredNumber(input, "p0Blockers", 0), "p0Blockers", 0);
  const p1Blockers = requireInteger(requiredNumber(input, "p1Blockers", 0), "p1Blockers", 0);
  const unresolvedLegalBlocks = requireInteger(requiredNumber(input, "unresolvedLegalBlocks", 0), "unresolvedLegalBlocks", 0);
  const unresolvedFinancialBlocks = requireInteger(requiredNumber(input, "unresolvedFinancialBlocks", 0), "unresolvedFinancialBlocks", 0);
  const vendorContractRegisterId = requiredString(input, "vendorContractRegisterId");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 4, unique: true });
  if (p0Blockers + p1Blockers + unresolvedLegalBlocks + unresolvedFinancialBlocks !== 0) {
    throw new DomainError("AUTH_FORBIDDEN", "critical commercial blockers fail the readiness gate");
  }
  for (const drill of ["support_escalation", "month_end_close", "incident_response", "refund", "vendor_failure"]) {
    if (!operationalDrills.includes(drill)) throw new DomainError("VALIDATION_FAILED", `operationalDrills must include ${drill}`);
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B125",
    operation: "approveCommercialReadiness",
    kind: "commercial-readiness",
    provider: `readiness-auditor:${auditorProviderId}`,
    artifactSha256: readinessArtifactSha256,
    environment: providerEnvironment,
    subjectId: readinessId,
  });
  return {
    readinessId,
    auditorProviderId,
    providerEnvironment,
    readinessArtifactSha256,
    profileVersion,
    policyVersions,
    operationalDrills,
    providerChecks,
    raciRoles,
    stopConditions,
    p0Blockers,
    p1Blockers,
    unresolvedLegalBlocks,
    unresolvedFinancialBlocks,
    vendorContractRegisterId,
    externalEvidenceIds,
    evidenceScope,
    state: providerEnvironment === "sandbox" ? "simulation_only" : "ready_for_e2e",
  };
}

function commercialCertification(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["crossSurfaceEntitlementsConsistent"]);
  assertActorTenant(input, invocation);
  if (invocation.actor.stepUp !== true) throw new DomainError("AUTH_FORBIDDEN", "commercial certification requires step-up authentication");
  const certificationId = requiredString(input, "certificationId");
  const auditorProviderId = requiredString(input, "auditorProviderId");
  const scenarioArtifactSha256 = sha256(input, "scenarioArtifactSha256");
  const environment = assertKnownState(
    requiredString(input, "environment"),
    ["sandbox", "staging", "production_canary"] as const,
    "environment",
  );
  const entrypoints = stringList(input, "entrypoints", { min: 4, unique: true });
  const scenarios = stringList(input, "scenarios", { min: 8, unique: true });
  const financialControlTotalMinor = requireInteger(
    requiredNumber(input, "financialControlTotalMinor", 0),
    "financialControlTotalMinor",
    0,
  );
  const ledgerControlTotalMinor = requireInteger(requiredNumber(input, "ledgerControlTotalMinor", 0), "ledgerControlTotalMinor", 0);
  const deletionProofTargets = stringList(input, "deletionProofTargets", { min: 5, unique: true });
  const criticalFailures = requireInteger(requiredNumber(input, "criticalFailures", 0), "criticalFailures", 0);
  const entitlementReconciliationId = requiredString(input, "entitlementReconciliationId");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 5, unique: true });
  for (const scenario of ["consent", "generation", "payment", "refund", "physical_fulfillment", "support", "finance_close", "deletion"]) {
    if (!scenarios.includes(scenario)) throw new DomainError("VALIDATION_FAILED", `commercial E2E scenarios must include ${scenario}`);
  }
  for (const target of ["connector", "cdn", "vendor", "warehouse", "application"]) {
    if (!deletionProofTargets.includes(target)) throw new DomainError("VALIDATION_FAILED", `deletion proof must include ${target}`);
  }
  if (financialControlTotalMinor !== ledgerControlTotalMinor || criticalFailures !== 0) {
    throw new DomainError("LEDGER_UNBALANCED", "financial mismatch or critical E2E failure blocks certification");
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B126",
    operation: "certifyCommercialE2e",
    kind: "commercial-e2e",
    provider: `e2e-auditor:${auditorProviderId}`,
    artifactSha256: scenarioArtifactSha256,
    environment: environment === "production_canary" ? "production" : environment,
    subjectId: certificationId,
  });
  return {
    certificationId,
    auditorProviderId,
    scenarioArtifactSha256,
    environment,
    entrypoints,
    scenarios,
    financialControlTotalMinor,
    ledgerControlTotalMinor,
    deletionProofTargets,
    criticalFailures,
    entitlementReconciliationId,
    externalEvidenceIds,
    evidenceScope,
    state: environment === "sandbox" ? "simulation_only" : "certified_for_staged_launch",
  };
}

function stagedLaunch(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["rollbackTested", "automaticPauseEnabled"]);
  assertActorTenant(input, invocation);
  if (invocation.actor.stepUp !== true) throw new DomainError("AUTH_FORBIDDEN", "production rollout requires step-up authentication");
  const launchId = requiredString(input, "launchId");
  const releaseControlProviderId = requiredString(input, "releaseControlProviderId");
  const providerEnvironment = assertKnownState(
    requiredString(input, "providerEnvironment"),
    ["sandbox", "production"] as const,
    "providerEnvironment",
  );
  const releaseManifestDigest = sha256(input, "releaseManifestDigest");
  const repositoryCommit = requiredString(input, "repositoryCommit");
  const artifactCommit = requiredString(input, "artifactCommit");
  const sbomDigest = sha256(input, "sbomDigest");
  const wave = assertKnownState(requiredString(input, "wave"), ["internal", "pilot", "consumer_canary", "partner", "regional", "global"] as const, "wave");
  const rolloutPercent = requiredNumber(input, "rolloutPercent", 0);
  const waveStartedAt = assertISODate(requiredString(input, "waveStartedAt"), "waveStartedAt");
  const releaseGates = stringList(input, "releaseGates", { min: 12, unique: true });
  const monitoringDomains = stringList(input, "monitoringDomains", { min: 8, unique: true });
  const approvalIds = stringList(input, "approvalIds", { min: 2, unique: true });
  const rollbackExerciseId = requiredString(input, "rollbackExerciseId");
  const automaticPausePolicyVersion = requiredString(input, "automaticPausePolicyVersion");
  const activeGuardrailBreaches = requireInteger(
    requiredNumber(input, "activeGuardrailBreaches", 0),
    "activeGuardrailBreaches",
    0,
  );
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 5, unique: true });
  if (repositoryCommit !== artifactCommit || rolloutPercent <= 0 || rolloutPercent > 100 || activeGuardrailBreaches !== 0) {
    throw new DomainError("AUTH_FORBIDDEN", "artifact mismatch, invalid wave size, or guardrail breach blocks rollout");
  }
  for (let gate = 0; gate <= 11; gate += 1) {
    if (!releaseGates.includes(`G${gate}`)) throw new DomainError("VALIDATION_FAILED", `releaseGates must include G${gate}`);
  }
  for (const domain of ["quality", "payment", "refund", "support", "ledger", "supply", "privacy", "security"]) {
    if (!monitoringDomains.includes(domain)) throw new DomainError("VALIDATION_FAILED", `monitoringDomains must include ${domain}`);
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B127",
    operation: "approveStagedProductionLaunch",
    kind: "release-control-plane",
    provider: `release-control:${releaseControlProviderId}`,
    artifactSha256: releaseManifestDigest,
    environment: providerEnvironment,
    subjectId: launchId,
  });
  return {
    launchId,
    releaseControlProviderId,
    providerEnvironment,
    releaseManifestDigest,
    repositoryCommit,
    artifactCommit,
    sbomDigest,
    wave,
    rolloutPercent,
    waveStartedAt,
    releaseGates,
    monitoringDomains,
    approvalIds,
    rollbackExerciseId,
    automaticPausePolicyVersion,
    activeGuardrailBreaches,
    externalEvidenceIds,
    evidenceScope,
    state: providerEnvironment === "sandbox" ? "simulation_only" : "wave_approved",
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B125", SKILL, "approveCommercialReadiness", commercialReadiness, {
    permission: "launch.readiness.approve",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    mode: "attestation",
  }),
  defineCapability("B126", SKILL, "certifyCommercialE2e", commercialCertification, {
    permission: "launch.e2e.certify",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    mode: "attestation",
  }),
  defineCapability("B127", SKILL, "approveStagedProductionLaunch", stagedLaunch, {
    permission: "launch.production.approve",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    mode: "attestation",
  }),
];

export function registerLaunchingCompleteCommercialProductCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const launchingCompleteCommercialProductCoverage = definitions.length;
