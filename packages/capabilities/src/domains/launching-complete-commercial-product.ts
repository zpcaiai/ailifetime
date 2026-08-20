import { DomainError } from "@ltm/core";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
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

const SKILL = "launching-complete-commercial-product";

function commercialReadiness(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  if (invocation.actor.stepUp !== true) throw new DomainError("AUTH_FORBIDDEN", "commercial readiness approval requires step-up authentication");
  const readinessId = requiredString(input, "readinessId");
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
  const vendorContractsApproved = requireTrue(requiredBoolean(input, "vendorContractsApproved"), "vendorContractsApproved");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 4, unique: true });
  if (p0Blockers + p1Blockers + unresolvedLegalBlocks + unresolvedFinancialBlocks !== 0) {
    throw new DomainError("AUTH_FORBIDDEN", "critical commercial blockers fail the readiness gate");
  }
  for (const drill of ["support_escalation", "month_end_close", "incident_response", "refund", "vendor_failure"]) {
    if (!operationalDrills.includes(drill)) throw new DomainError("VALIDATION_FAILED", `operationalDrills must include ${drill}`);
  }
  return {
    readinessId,
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
    vendorContractsApproved,
    externalEvidenceIds,
    state: "ready_for_e2e",
  };
}

function commercialCertification(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  if (invocation.actor.stepUp !== true) throw new DomainError("AUTH_FORBIDDEN", "commercial certification requires step-up authentication");
  const certificationId = requiredString(input, "certificationId");
  const environment = assertKnownState(requiredString(input, "environment"), ["staging", "production_canary"] as const, "environment");
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
  const crossSurfaceEntitlementsConsistent = requireTrue(
    requiredBoolean(input, "crossSurfaceEntitlementsConsistent"),
    "crossSurfaceEntitlementsConsistent",
  );
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
  return {
    certificationId,
    environment,
    entrypoints,
    scenarios,
    financialControlTotalMinor,
    ledgerControlTotalMinor,
    deletionProofTargets,
    criticalFailures,
    crossSurfaceEntitlementsConsistent,
    externalEvidenceIds,
    state: "certified_for_staged_launch",
  };
}

function stagedLaunch(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  if (invocation.actor.stepUp !== true) throw new DomainError("AUTH_FORBIDDEN", "production rollout requires step-up authentication");
  const launchId = requiredString(input, "launchId");
  const releaseManifestDigest = requiredString(input, "releaseManifestDigest");
  const repositoryCommit = requiredString(input, "repositoryCommit");
  const artifactCommit = requiredString(input, "artifactCommit");
  const sbomDigest = requiredString(input, "sbomDigest");
  const wave = assertKnownState(requiredString(input, "wave"), ["internal", "pilot", "consumer_canary", "partner", "regional", "global"] as const, "wave");
  const rolloutPercent = requiredNumber(input, "rolloutPercent", 0);
  const waveStartedAt = assertISODate(requiredString(input, "waveStartedAt"), "waveStartedAt");
  const releaseGates = stringList(input, "releaseGates", { min: 12, unique: true });
  const monitoringDomains = stringList(input, "monitoringDomains", { min: 8, unique: true });
  const approvalIds = stringList(input, "approvalIds", { min: 2, unique: true });
  const rollbackTested = requireTrue(requiredBoolean(input, "rollbackTested"), "rollbackTested");
  const automaticPauseEnabled = requireTrue(requiredBoolean(input, "automaticPauseEnabled"), "automaticPauseEnabled");
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
  return {
    launchId,
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
    rollbackTested,
    automaticPauseEnabled,
    activeGuardrailBreaches,
    externalEvidenceIds,
    state: "wave_approved",
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B125", SKILL, "approveCommercialReadiness", commercialReadiness, {
    permission: "launch.readiness.approve",
    requiresExternalEvidence: true,
  }),
  defineCapability("B126", SKILL, "certifyCommercialE2e", commercialCertification, {
    permission: "launch.e2e.certify",
    requiresExternalEvidence: true,
  }),
  defineCapability("B127", SKILL, "approveStagedProductionLaunch", stagedLaunch, {
    permission: "launch.production.approve",
    requiresExternalEvidence: true,
  }),
];

export function registerLaunchingCompleteCommercialProductCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const launchingCompleteCommercialProductCoverage = definitions.length;
