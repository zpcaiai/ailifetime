import { DomainError } from "@ltm/core";
import type { CapabilityRegistry, JsonObject } from "../registry.js";
import { requiredBoolean, requiredString, stringList } from "../validation.js";
import {
  assertKnownState,
  defineCapability,
  registerDefinitions,
  requireNonEmptyObject,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "certifying-life-time-machine-release";

const BUSINESS_LOOPS = ["consumer", "familyGift", "studio", "educationCrm", "failureAbuse"] as const;

function submitBusinessLoopEvidence(input: JsonObject): JsonObject {
  const certificationRunId = requiredString(input, "certificationRunId");
  const environment = assertKnownState(requiredString(input, "environment"), ["isolated_staging", "production_shadow"] as const, "environment");
  const loopEvidence = requireNonEmptyObject(input, "loopEvidence");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: BUSINESS_LOOPS.length, unique: true });
  const abuseFixturesSynthetic = requiredBoolean(input, "abuseFixturesSynthetic");
  for (const loop of BUSINESS_LOOPS) {
    const state = loopEvidence[loop];
    if (state !== "passed") {
      throw new DomainError("DEPENDENCY_UNAVAILABLE", `business loop ${loop} is missing or not passed`, { details: { loop } });
    }
  }
  if (!abuseFixturesSynthetic) throw new DomainError("VALIDATION_FAILED", "certification abuse fixtures must be synthetic and non-customer data");
  return {
    certificationRunId,
    environment,
    loopEvidence,
    externalEvidenceIds,
    abuseFixturesSynthetic,
    certificationState: "evidence_submitted",
  };
}

function submitReleaseEvidence(input: JsonObject): JsonObject {
  const releaseId = requiredString(input, "releaseId");
  const cleanRoomState = assertKnownState(requiredString(input, "cleanRoomState"), ["passed", "failed", "unknown"] as const, "cleanRoomState");
  const reportBatchIds = stringList(input, "reportBatchIds", { min: 51, unique: true });
  const reportHashes = requireNonEmptyObject(input, "reportHashes");
  const unresolvedBlockers = stringList(input, "unresolvedBlockers", { min: 0, unique: true });
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  const attestationState = assertKnownState(requiredString(input, "attestationState"), ["externally_verified", "pending", "rejected", "unknown"] as const, "attestationState");
  const certificateSignature = requiredString(input, "certificateSignature");
  const expectedBatchIds = Array.from({ length: 51 }, (_, index) => `B${index.toString().padStart(2, "0")}`);
  if (cleanRoomState !== "passed" || attestationState !== "externally_verified") {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "clean-room and external attestation must pass before release evidence is accepted");
  }
  if (reportBatchIds.length !== expectedBatchIds.length || expectedBatchIds.some((batchId) => !reportBatchIds.includes(batchId))) {
    throw new DomainError("VALIDATION_FAILED", "release evidence must cover every batch B00 through B50 exactly once");
  }
  if (expectedBatchIds.some((batchId) => typeof reportHashes[batchId] !== "string")) {
    throw new DomainError("VALIDATION_FAILED", "every batch report must have a recorded evidence hash");
  }
  if (unresolvedBlockers.length > 0) throw new DomainError("DEPENDENCY_UNAVAILABLE", "release cannot be certified with unresolved blockers");
  if (certificateSignature.length < 32) throw new DomainError("VALIDATION_FAILED", "release certificate signature is invalid");
  return {
    releaseId,
    cleanRoomState,
    reportBatchIds,
    reportHashes,
    unresolvedBlockers,
    externalEvidenceIds,
    attestationState,
    certificateSignature,
    certificationState: "externally_attested",
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B48", SKILL, "submitBusinessLoopEvidence", submitBusinessLoopEvidence, {
    permission: "certification.business_loop.submit",
    sensitive: true,
    requiresExternalEvidence: true,
  }),
  defineCapability("B49", SKILL, "submitReleaseEvidence", submitReleaseEvidence, {
    permission: "certification.release.submit",
    sensitive: true,
    requiresExternalEvidence: true,
  }),
];

export function registerCertifyingLifeTimeMachineReleaseCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const certifyingLifeTimeMachineReleaseCoverage = definitions.length;
