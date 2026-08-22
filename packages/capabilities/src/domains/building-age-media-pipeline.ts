import { DomainError } from "@ltm/core";
import type { CapabilityRegistry, JsonObject, JsonValue } from "../registry.js";
import { requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertKnownState,
  defineCapability,
  participantConsent,
  registerDefinitions,
  requireInteger,
  requireNonEmptyObject,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-age-media-pipeline";

function createTimeline(input: JsonObject): JsonObject {
  const jobId = requiredString(input, "jobId");
  const sourceAssetId = requiredString(input, "sourceAssetId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const targetAgesValue = input.targetAges;
  if (!Array.isArray(targetAgesValue) || targetAgesValue.length < 2 || targetAgesValue.some((age) => typeof age !== "number")) {
    throw new DomainError("VALIDATION_FAILED", "targetAges must contain at least two numeric age nodes");
  }
  const targetAges = targetAgesValue.map((age) => requireInteger(age as number, "targetAges", 0, 100));
  if (new Set(targetAges).size !== targetAges.length) throw new DomainError("VALIDATION_FAILED", "target age nodes must be unique");
  const seed = requiredString(input, "seed");
  const promptPolicyVersion = requiredString(input, "promptPolicyVersion");
  const illustrativeLabel = requiredBoolean(input, "illustrativeLabel");
  if (!illustrativeLabel) throw new DomainError("VALIDATION_FAILED", "timeline output must be labeled illustrative, not predictive");
  return { jobId, sourceAssetId, participantIds, targetAges, seed, promptPolicyVersion, illustrativeLabel, purpose: "age_transformation" };
}

const QUALITY_DIMENSIONS = ["identity", "ageRange", "facialDrift", "pose", "artifacts", "clarity"] as const;

function qualityGate(input: JsonObject): JsonObject {
  const workId = requiredString(input, "workId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const modelVersion = requiredString(input, "modelVersion");
  const scores = requireNonEmptyObject(input, "scores");
  const thresholds = requireNonEmptyObject(input, "thresholds");
  const normalizedScores: Record<string, JsonValue> = {};
  const normalizedThresholds: Record<string, JsonValue> = {};
  const failed: string[] = [];
  for (const dimension of QUALITY_DIMENSIONS) {
    const score = scores[dimension];
    const threshold = thresholds[dimension];
    if (typeof score !== "number" || score < 0 || score > 1 || typeof threshold !== "number" || threshold < 0 || threshold > 1) {
      throw new DomainError("VALIDATION_FAILED", `quality ${dimension} score and threshold must be between zero and one`);
    }
    normalizedScores[dimension] = score;
    normalizedThresholds[dimension] = threshold;
    if (score < threshold) failed.push(dimension);
  }
  const decision = assertKnownState(requiredString(input, "decision"), ["pass", "retry", "review", "reject"] as const, "decision");
  const overrideReason = typeof input.overrideReason === "string" ? input.overrideReason : undefined;
  if ((decision === "pass") !== (failed.length === 0) && !overrideReason) {
    throw new DomainError("VALIDATION_FAILED", "quality decision conflicts with dimension thresholds and has no audited override reason");
  }
  return {
    workId,
    participantIds,
    modelVersion,
    scores: normalizedScores,
    thresholds: normalizedThresholds,
    failedDimensions: failed,
    decision,
    ...(overrideReason ? { overrideReason } : {}),
    purpose: "quality_assurance",
  };
}

function renderVideo(input: JsonObject): JsonObject {
  const renderId = requiredString(input, "renderId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const frameAssetIds = stringList(input, "frameAssetIds", { min: 2, unique: true });
  const transition = assertKnownState(requiredString(input, "transition"), ["safe_fade", "interpolated"] as const, "transition");
  const continuityState = assertKnownState(requiredString(input, "continuityState"), ["passed", "failed", "unknown"] as const, "continuityState");
  const aiLabel = requiredBoolean(input, "aiLabel");
  const voiceCloning = requiredBoolean(input, "voiceCloning");
  const voiceConsentId = typeof input.voiceConsentId === "string" ? input.voiceConsentId : undefined;
  const licenseIds = stringList(input, "licenseIds", { min: 1, unique: true });
  if (!aiLabel) throw new DomainError("VALIDATION_FAILED", "video render requires visible AI labeling");
  if (continuityState === "unknown" || (continuityState === "failed" && transition !== "safe_fade")) {
    throw new DomainError("VALIDATION_FAILED", "unsafe or unknown continuity must fail closed to a safe fade");
  }
  if (voiceCloning && !voiceConsentId) throw new DomainError("CONSENT_REQUIRED", "voice cloning requires separate active consent");
  return {
    renderId,
    participantIds,
    frameAssetIds,
    transition,
    continuityState,
    aiLabel,
    voiceCloning,
    ...(voiceConsentId ? { voiceConsentId } : {}),
    licenseIds,
    purpose: voiceCloning ? "voice_cloning" : "age_transformation",
  };
}

function certifySafety(input: JsonObject): JsonObject {
  const workId = requiredString(input, "workId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const inputSafety = assertKnownState(requiredString(input, "inputSafety"), ["allowed", "blocked", "review", "unknown"] as const, "inputSafety");
  const outputSafety = assertKnownState(requiredString(input, "outputSafety"), ["allowed", "blocked", "review", "unknown"] as const, "outputSafety");
  const subjectClass = assertKnownState(requiredString(input, "subjectClass"), ["private_person", "public_figure", "unknown"] as const, "subjectClass");
  const enhancedAuthorization = requiredBoolean(input, "enhancedAuthorization");
  const provenanceId = requiredString(input, "provenanceId");
  const manifestSignature = requiredString(input, "manifestSignature");
  const aiLabel = requiredBoolean(input, "aiLabel");
  if (inputSafety !== "allowed" || outputSafety !== "allowed" || subjectClass === "unknown") {
    throw new DomainError("VALIDATION_FAILED", "unknown, blocked, or unreviewed safety state cannot be certified");
  }
  if (subjectClass === "public_figure" && !enhancedAuthorization) {
    throw new DomainError("CONSENT_REQUIRED", "public-figure output requires enhanced authorization review");
  }
  if (!aiLabel || manifestSignature.length < 16) throw new DomainError("VALIDATION_FAILED", "signed provenance and AI labels are mandatory");
  return {
    workId,
    participantIds,
    inputSafety,
    outputSafety,
    subjectClass,
    enhancedAuthorization,
    provenanceId,
    manifestSignature,
    aiLabel,
    purpose: "age_transformation",
  };
}

function reserveGenerationBudget(input: JsonObject): JsonObject {
  const reservationId = requiredString(input, "reservationId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const estimatedMinor = requireInteger(requiredNumber(input, "estimatedMinor", 1), "estimatedMinor", 1);
  const budgetRemainingMinor = requireInteger(requiredNumber(input, "budgetRemainingMinor", 0), "budgetRemainingMinor", 0);
  const retryBudget = requireInteger(requiredNumber(input, "retryBudget", 0), "retryBudget", 0, 3);
  const cacheScopeParticipantId = requiredString(input, "cacheScopeParticipantId");
  const routeState = assertKnownState(requiredString(input, "routeState"), ["eligible", "degraded", "blocked", "unknown"] as const, "routeState");
  if (estimatedMinor > budgetRemainingMinor) throw new DomainError("VALIDATION_FAILED", "generation estimate exceeds available budget");
  if (participantIds.length !== 1 || cacheScopeParticipantId !== participantIds[0]) {
    throw new DomainError("TENANT_SCOPE_MISMATCH", "face-result cache scope must match exactly one authorized participant");
  }
  if (routeState !== "eligible") throw new DomainError("DEPENDENCY_UNAVAILABLE", "only an eligible, policy-compliant route may reserve generation budget");
  return { reservationId, participantIds, estimatedMinor, budgetRemainingMinor, retryBudget, cacheScopeParticipantId, routeState, purpose: "age_transformation" };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B14", SKILL, "createTimeline", createTimeline, {
    consent: participantConsent(), mode: "external-command", collection: "generation.timeline-commands", recordIdField: "jobId",
  }),
  defineCapability("B15", SKILL, "evaluateQuality", qualityGate, {
    consent: participantConsent(), mode: "resource", collection: "media.quality-decisions", recordIdField: "workId",
  }),
  defineCapability("B16", SKILL, "renderVideo", renderVideo, {
    consent: participantConsent(), mode: "external-command", collection: "media.video-render-commands", recordIdField: "renderId",
  }),
  defineCapability("B17", SKILL, "certifySafetyAndProvenance", certifySafety, {
    consent: participantConsent(), mode: "resource", collection: "media.safety-certificates", recordIdField: "workId",
  }),
  defineCapability("B18", SKILL, "reserveGenerationBudget", reserveGenerationBudget, {
    consent: participantConsent(), mode: "resource", collection: "generation.budget-reservations", recordIdField: "reservationId",
  }),
];

export function registerBuildingAgeMediaPipelineCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingAgeMediaPipelineCoverage = definitions.length;
