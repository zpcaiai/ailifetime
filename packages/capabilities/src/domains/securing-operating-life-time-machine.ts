import { DomainError } from "@ltm/core";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertKnownState,
  defineCapability,
  registerDefinitions,
  requireNonEmptyObject,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "securing-operating-life-time-machine";

const REQUIRED_SCANS = ["sast", "dast", "sca", "secrets", "iac", "container", "sbom"];

function approveSecurityBaseline(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  const baselineId = requiredString(input, "baselineId");
  const policyVersion = requiredString(input, "policyVersion");
  const controlState = assertKnownState(requiredString(input, "controlState"), ["passed", "failed", "exception", "unknown"] as const, "controlState");
  const scans = stringList(input, "scans", { min: REQUIRED_SCANS.length, unique: true });
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  const unresolvedCritical = requiredNumber(input, "unresolvedCritical", 0);
  const legalConfirmation = requiredBoolean(input, "legalConfirmation");
  const dataMap = requireNonEmptyObject(input, "dataMap");
  if (controlState !== "passed" || unresolvedCritical !== 0 || !legalConfirmation) {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "security baseline cannot pass with unknown controls, critical findings, or missing legal confirmation");
  }
  if (REQUIRED_SCANS.some((scan) => !scans.includes(scan))) throw new DomainError("VALIDATION_FAILED", "security baseline is missing a required scan class");
  if (!invocation.actor.stepUp) throw new DomainError("AUTH_FORBIDDEN", "security baseline approval requires step-up authentication");
  return { baselineId, policyVersion, controlState, scans, externalEvidenceIds, unresolvedCritical, legalConfirmation, dataMap };
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
  if (recoveryState !== "passed" || deletionReplayState !== "verified") {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "recovery and deletion replay must be independently verified");
  }
  if (!invocation.actor.stepUp || secondApproverId === invocation.actor.actorId) {
    throw new DomainError("AUTH_FORBIDDEN", "recovery attestation requires step-up and an independent second approver");
  }
  return { drillId, recoveryState, deletionReplayState, integrityChecks, externalEvidenceIds, secondApproverId };
}

const RELEASE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  preview: ["staging"],
  staging: ["canary"],
  canary: ["production", "rolled_back"],
  production: ["rolled_back"],
  rolled_back: [],
};

function promoteRelease(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  const releaseId = requiredString(input, "releaseId");
  const artifactDigest = requiredString(input, "artifactDigest");
  const provenanceId = requiredString(input, "provenanceId");
  const fromEnvironment = assertKnownState(requiredString(input, "fromEnvironment"), Object.keys(RELEASE_TRANSITIONS), "fromEnvironment");
  const toEnvironment = assertKnownState(requiredString(input, "toEnvironment"), Object.keys(RELEASE_TRANSITIONS), "toEnvironment");
  const gateState = assertKnownState(requiredString(input, "gateState"), ["passed", "failed", "unknown"] as const, "gateState");
  const requiredChecks = stringList(input, "requiredChecks", { min: 8, unique: true });
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  const signed = requiredBoolean(input, "signed");
  if (!RELEASE_TRANSITIONS[fromEnvironment]?.includes(toEnvironment)) {
    throw new DomainError("VERSION_CONFLICT", `illegal release transition ${fromEnvironment} -> ${toEnvironment}`);
  }
  if (gateState !== "passed" || !signed || !/^[a-f0-9]{32,128}$/i.test(artifactDigest)) {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "release promotion requires passing gates, signed provenance, and a valid artifact digest");
  }
  if (toEnvironment === "production" && !invocation.actor.stepUp) throw new DomainError("AUTH_FORBIDDEN", "production promotion requires step-up authentication");
  return { releaseId, artifactDigest, provenanceId, fromEnvironment, toEnvironment, gateState, requiredChecks, externalEvidenceIds, signed };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B44", SKILL, "approveSecurityBaseline", approveSecurityBaseline, {
    permission: "security.baseline.approve",
    requiresExternalEvidence: true,
  }),
  defineCapability("B45", SKILL, "defineServiceObjective", defineServiceObjective, { permission: "operations.slo.manage" }),
  defineCapability("B46", SKILL, "attestRecoveryDrill", attestRecoveryDrill, {
    permission: "operations.recovery.attest",
    requiresExternalEvidence: true,
  }),
  defineCapability("B47", SKILL, "promoteRelease", promoteRelease, {
    permission: "release.promote",
    requiresExternalEvidence: true,
  }),
];

export function registerSecuringOperatingLifeTimeMachineCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const securingOperatingLifeTimeMachineCoverage = definitions.length;
