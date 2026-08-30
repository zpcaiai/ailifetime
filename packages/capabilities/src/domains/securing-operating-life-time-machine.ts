import { DomainError } from "@ltm/core";
import { capabilityEvidenceScope } from "@ltm/providers";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertKnownState,
  defineCapability,
  rejectClientAssertions,
  registerDefinitions,
  requireNonEmptyObject,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "securing-operating-life-time-machine";

const REQUIRED_SCANS = ["sast", "dast", "sca", "secrets", "iac", "container", "sbom"];

function approveSecurityBaseline(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["legalConfirmation"]);
  const baselineId = requiredString(input, "baselineId");
  const policyVersion = requiredString(input, "policyVersion");
  const controlState = assertKnownState(requiredString(input, "controlState"), ["passed", "failed", "exception", "unknown"] as const, "controlState");
  const scans = stringList(input, "scans", { min: REQUIRED_SCANS.length, unique: true });
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  const unresolvedCritical = requiredNumber(input, "unresolvedCritical", 0);
  const securityProviderId = evidenceProviderId(requiredString(input, "securityProviderId"), "securityProviderId");
  const providerEnvironment = evidenceEnvironment(input);
  const baselineArtifactSha256 = digest(requiredString(input, "baselineArtifactSha256"), "baselineArtifactSha256");
  const dataMap = requireNonEmptyObject(input, "dataMap");
  if (controlState !== "passed" || unresolvedCritical !== 0) {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "security baseline cannot pass with unknown controls or critical findings");
  }
  if (REQUIRED_SCANS.some((scan) => !scans.includes(scan))) throw new DomainError("VALIDATION_FAILED", "security baseline is missing a required scan class");
  if (!invocation.actor.stepUp) throw new DomainError("AUTH_FORBIDDEN", "security baseline approval requires step-up authentication");
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId, batchId: "B44", operation: "approveSecurityBaseline",
    kind: "security-baseline", provider: `security-auditor:${securityProviderId}`,
    artifactSha256: baselineArtifactSha256, environment: providerEnvironment, subjectId: baselineId,
  });
  return {
    baselineId, policyVersion, controlState, scans, externalEvidenceIds, unresolvedCritical, dataMap,
    securityProviderId, providerEnvironment, baselineArtifactSha256, evidenceScope,
  };
}

function defineServiceObjective(input: JsonObject): JsonObject {
  const objectiveId = requiredString(input, "objectiveId");
  const service = assertKnownState(requiredString(input, "service"), ["upload", "generation", "payment", "download", "partner_api", "deletion", "printing", "dialogue"] as const, "service");
  const indicator = requiredString(input, "indicator");
  const target = requiredNumber(input, "target", 0);
  const errorBudget = requiredNumber(input, "errorBudget", 0);
  const runbookId = requiredString(input, "runbookId");
  const capacityPlan = requireNonEmptyObject(input, "capacityPlan");
  const containsSensitivePayload = requiredBoolean(input, "containsSensitivePayload");
  if (target <= 0 || target > 1 || errorBudget > 1 || containsSensitivePayload) {
    throw new DomainError("VALIDATION_FAILED", "SLO ratios must be bounded and telemetry must exclude sensitive payloads");
  }
  return { objectiveId, service, indicator, target, errorBudget, runbookId, capacityPlan, containsSensitivePayload };
}

function attestRecoveryDrill(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  const drillId = requiredString(input, "drillId");
  const recoveryState = assertKnownState(requiredString(input, "recoveryState"), ["passed", "failed", "partial", "unknown"] as const, "recoveryState");
  const deletionReplayState = assertKnownState(requiredString(input, "deletionReplayState"), ["verified", "failed", "unknown"] as const, "deletionReplayState");
  const integrityChecks = stringList(input, "integrityChecks", { min: 5, unique: true });
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  const secondApproverId = requiredString(input, "secondApproverId");
  const recoveryProviderId = evidenceProviderId(requiredString(input, "recoveryProviderId"), "recoveryProviderId");
  const providerEnvironment = evidenceEnvironment(input);
  const recoveryArtifactSha256 = digest(requiredString(input, "recoveryArtifactSha256"), "recoveryArtifactSha256");
  if (recoveryState !== "passed" || deletionReplayState !== "verified") {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "recovery and deletion replay must be independently verified");
  }
  if (!invocation.actor.stepUp || secondApproverId === invocation.actor.actorId) {
    throw new DomainError("AUTH_FORBIDDEN", "recovery attestation requires step-up and an independent second approver");
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId, batchId: "B46", operation: "attestRecoveryDrill",
    kind: "recovery-drill", provider: `recovery-auditor:${recoveryProviderId}`,
    artifactSha256: recoveryArtifactSha256, environment: providerEnvironment, subjectId: drillId,
  });
  return {
    drillId, recoveryState, deletionReplayState, integrityChecks, externalEvidenceIds, secondApproverId,
    recoveryProviderId, providerEnvironment, recoveryArtifactSha256, evidenceScope,
  };
}

const RELEASE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  preview: ["staging"],
  staging: ["canary"],
  canary: ["production", "rolled_back"],
  production: ["rolled_back"],
  rolled_back: [],
};

function promoteRelease(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["signed"]);
  const releaseId = requiredString(input, "releaseId");
  const artifactDigest = requiredString(input, "artifactDigest");
  const provenanceId = requiredString(input, "provenanceId");
  const fromEnvironment = assertKnownState(requiredString(input, "fromEnvironment"), Object.keys(RELEASE_TRANSITIONS), "fromEnvironment");
  const toEnvironment = assertKnownState(requiredString(input, "toEnvironment"), Object.keys(RELEASE_TRANSITIONS), "toEnvironment");
  const gateState = assertKnownState(requiredString(input, "gateState"), ["passed", "failed", "unknown"] as const, "gateState");
  const requiredChecks = stringList(input, "requiredChecks", { min: 8, unique: true });
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  const releaseControlProviderId = evidenceProviderId(requiredString(input, "releaseControlProviderId"), "releaseControlProviderId");
  const providerEnvironment = evidenceEnvironment(input);
  if (!RELEASE_TRANSITIONS[fromEnvironment]?.includes(toEnvironment)) {
    throw new DomainError("VERSION_CONFLICT", `illegal release transition ${fromEnvironment} -> ${toEnvironment}`);
  }
  if (gateState !== "passed" || !/^[a-f0-9]{64}$/.test(artifactDigest)) {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "release promotion requires passing gates and a valid artifact digest");
  }
  if (toEnvironment === "production" && !invocation.actor.stepUp) throw new DomainError("AUTH_FORBIDDEN", "production promotion requires step-up authentication");
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId, batchId: "B47", operation: "promoteRelease",
    kind: "release-promotion", provider: `release-control:${releaseControlProviderId}`,
    artifactSha256: artifactDigest, environment: providerEnvironment, subjectId: releaseId,
  });
  return {
    releaseId, artifactDigest, provenanceId, fromEnvironment, toEnvironment, gateState, requiredChecks,
    externalEvidenceIds, releaseControlProviderId, providerEnvironment, evidenceScope,
  };
}

function evidenceEnvironment(input: JsonObject): "test" | "sandbox" | "staging" | "production" {
  return assertKnownState(
    requiredString(input, "providerEnvironment"),
    ["test", "sandbox", "staging", "production"] as const,
    "providerEnvironment",
  );
}

function evidenceProviderId(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)) throw new DomainError("VALIDATION_FAILED", `${field} is invalid`);
  return value;
}

function digest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DomainError("VALIDATION_FAILED", `${field} must be a lowercase SHA-256 digest`);
  return value;
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B44", SKILL, "approveSecurityBaseline", approveSecurityBaseline, {
    permission: "security.baseline.approve",
    requiresExternalEvidence: true,
    mode: "attestation",
    collection: "security.baselines",
    recordIdField: "baselineId",
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "baselineArtifactSha256",
  }),
  defineCapability("B45", SKILL, "defineServiceObjective", defineServiceObjective, {
    permission: "operations.slo.manage", mode: "resource", collection: "operations.service-objectives", recordIdField: "objectiveId",
  }),
  defineCapability("B46", SKILL, "attestRecoveryDrill", attestRecoveryDrill, {
    permission: "operations.recovery.attest",
    requiresExternalEvidence: true,
    mode: "attestation",
    collection: "operations.recovery-drills",
    recordIdField: "drillId",
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "recoveryArtifactSha256",
  }),
  defineCapability("B47", SKILL, "promoteRelease", promoteRelease, {
    permission: "release.promote",
    requiresExternalEvidence: true,
    mode: "state-transition",
    collection: "release.promotions",
    recordIdField: "releaseId",
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "artifactDigest",
    transition: { fromField: "fromEnvironment", toField: "toEnvironment", stateField: "environment", initialFromStates: ["preview"] },
  }),
];

export function registerSecuringOperatingLifeTimeMachineCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const securingOperatingLifeTimeMachineCoverage = definitions.length;
