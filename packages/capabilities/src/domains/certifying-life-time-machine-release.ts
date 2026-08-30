import { DomainError } from "@ltm/core";
import { capabilityEvidenceScope } from "@ltm/providers";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { requiredBoolean, requiredString, stringList } from "../validation.js";
import {
  assertKnownState,
  defineCapability,
  rejectClientAssertions,
  registerDefinitions,
  requireNonEmptyObject,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "certifying-life-time-machine-release";

const BUSINESS_LOOPS = ["consumer", "familyGift", "studio", "educationCrm", "failureAbuse"] as const;

function submitBusinessLoopEvidence(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  const certificationRunId = requiredString(input, "certificationRunId");
  const environment = assertKnownState(requiredString(input, "environment"), ["isolated_staging", "production_shadow"] as const, "environment");
  const loopEvidence = requireNonEmptyObject(input, "loopEvidence");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: BUSINESS_LOOPS.length, unique: true });
  const abuseFixturesSynthetic = requiredBoolean(input, "abuseFixturesSynthetic");
  const auditorProviderId = evidenceProviderId(requiredString(input, "auditorProviderId"), "auditorProviderId");
  const providerEnvironment = evidenceEnvironment(input);
  const certificationArtifactSha256 = digest(
    requiredString(input, "certificationArtifactSha256"),
    "certificationArtifactSha256",
  );
  for (const loop of BUSINESS_LOOPS) {
    const state = loopEvidence[loop];
    if (state !== "passed") {
      throw new DomainError("DEPENDENCY_UNAVAILABLE", `business loop ${loop} is missing or not passed`, { details: { loop } });
    }
  }
  if (!abuseFixturesSynthetic) throw new DomainError("VALIDATION_FAILED", "certification abuse fixtures must be synthetic and non-customer data");
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId, batchId: "B48", operation: "submitBusinessLoopEvidence",
    kind: "business-loop-certification", provider: `e2e-auditor:${auditorProviderId}`,
    artifactSha256: certificationArtifactSha256, environment: providerEnvironment, subjectId: certificationRunId,
  });
  return {
    certificationRunId,
    environment,
    loopEvidence,
    externalEvidenceIds,
    abuseFixturesSynthetic,
    certificationState: "evidence_submitted",
    auditorProviderId,
    providerEnvironment,
    certificationArtifactSha256,
    evidenceScope,
  };
}

function submitReleaseEvidence(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["certificateSignature"]);
  const releaseId = requiredString(input, "releaseId");
  const cleanRoomState = assertKnownState(requiredString(input, "cleanRoomState"), ["passed", "failed", "unknown"] as const, "cleanRoomState");
  const reportBatchIds = stringList(input, "reportBatchIds", { min: 51, unique: true });
  const reportHashes = requireNonEmptyObject(input, "reportHashes");
  const unresolvedBlockers = stringList(input, "unresolvedBlockers", { min: 0, unique: true });
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  const attestationState = assertKnownState(requiredString(input, "attestationState"), ["externally_verified", "pending", "rejected", "unknown"] as const, "attestationState");
  const releaseAuditorProviderId = evidenceProviderId(requiredString(input, "releaseAuditorProviderId"), "releaseAuditorProviderId");
  const providerEnvironment = evidenceEnvironment(input);
  const releaseArtifactSha256 = digest(requiredString(input, "releaseArtifactSha256"), "releaseArtifactSha256");
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
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId, batchId: "B49", operation: "submitReleaseEvidence",
    kind: "release-evidence", provider: `release-auditor:${releaseAuditorProviderId}`,
    artifactSha256: releaseArtifactSha256, environment: providerEnvironment, subjectId: releaseId,
  });
  return {
    releaseId,
    cleanRoomState,
    reportBatchIds,
    reportHashes,
    unresolvedBlockers,
    externalEvidenceIds,
    attestationState,
    certificationState: "externally_attested",
    releaseAuditorProviderId,
    providerEnvironment,
    releaseArtifactSha256,
    evidenceScope,
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
  defineCapability("B48", SKILL, "submitBusinessLoopEvidence", submitBusinessLoopEvidence, {
    permission: "certification.business_loop.submit",
    sensitive: true,
    requiresExternalEvidence: true,
    mode: "attestation",
    collection: "certification.business-loop-runs",
    recordIdField: "certificationRunId",
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "certificationArtifactSha256",
  }),
  defineCapability("B49", SKILL, "submitReleaseEvidence", submitReleaseEvidence, {
    permission: "certification.release.submit",
    sensitive: true,
    requiresExternalEvidence: true,
    mode: "attestation",
    collection: "certification.release-evidence",
    recordIdField: "releaseId",
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "releaseArtifactSha256",
  }),
];

export function registerCertifyingLifeTimeMachineReleaseCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const certifyingLifeTimeMachineReleaseCoverage = definitions.length;
