import { canonicalJson, DomainError } from "@ltm/core";
import { createHash } from "node:crypto";
import type { CapabilityRegistry, JsonObject, JsonValue } from "../registry.js";
import { requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import { buildAgeGenerationPlan } from "../age-generation-plan.js";
import { participantQuality } from "../participant-quality.js";
import { buildWardrobePlan, parseWardrobeBinding, parseWardrobeEdit, requireWardrobeSource } from "../wardrobe-plan.js";
import {
  assertKnownState,
  defineCapability,
  participantConsent,
  registerDefinitions,
  requireAcceptedMediaIntake,
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
  if (!Array.isArray(targetAgesValue) || targetAgesValue.length < 1 || targetAgesValue.length > 101 || targetAgesValue.some((age) => typeof age !== "number")) {
    throw new DomainError("VALIDATION_FAILED", "targetAges must contain one through 101 numeric age nodes");
  }
  const targetAges = targetAgesValue.map((age) => requireInteger(age as number, "targetAges", 0, 100));
  if (new Set(targetAges).size !== targetAges.length) throw new DomainError("VALIDATION_FAILED", "target age nodes must be unique");
  const seed = requiredString(input, "seed");
  const promptPolicyVersion = requiredString(input, "promptPolicyVersion");
  const illustrativeLabel = requiredBoolean(input, "illustrativeLabel");
  if (!illustrativeLabel) throw new DomainError("VALIDATION_FAILED", "timeline output must be labeled illustrative, not predictive");
  if (input.wardrobeEdit !== undefined || input.timelineProfile === "wardrobe-edit-v1") {
    if (input.timelineProfile !== "wardrobe-edit-v1") throw new DomainError("VALIDATION_FAILED", "wardrobe requires its explicit versioned profile");
    const wardrobeEdit = parseWardrobeEdit(input.wardrobeEdit);
    const generationPlan = buildWardrobePlan({ sourceAssetId, participantIds, targetAges, seed, promptPolicyVersion, wardrobeEdit });
    return { jobId, sourceAssetId, participantIds, targetAges, seed, promptPolicyVersion, illustrativeLabel, timelineProfile: "wardrobe-edit-v1",
      wardrobeEdit, currentAge: wardrobeEdit.targetAge!, generationPlan, purpose: "age_transformation" };
  }
  const currentAge = input.currentAge === undefined ? undefined : requiredNumber(input, "currentAge", 0);
  const timelineProfile = input.timelineProfile === undefined ? undefined : requiredString(input, "timelineProfile");
  const templateId = input.templateId === undefined ? undefined : requiredString(input, "templateId");
  const imageQuality = input.imageQuality === undefined ? undefined : requiredString(input,"imageQuality");
  const participantAges = input.participantAges;
  if (participantAges !== undefined && (!Array.isArray(participantAges) || participantAges.some(age => typeof age !== "number"))) throw new DomainError("VALIDATION_FAILED", "participantAges must be a numeric array");
  const generationPlan = buildAgeGenerationPlan({
    sourceAssetId, participantIds, targetAges, seed, promptPolicyVersion,
    ...(currentAge === undefined ? {} : { currentAge }),
    ...(timelineProfile === undefined ? {} : { timelineProfile }),
    ...(templateId === undefined ? {} : { templateId }),
    ...(imageQuality === undefined ? {} : { imageQuality }),
    ...(participantAges === undefined ? {} : { participantAges: participantAges as number[] }),
  });
  return { jobId, sourceAssetId, participantIds, targetAges, seed, promptPolicyVersion, illustrativeLabel,
    ...(currentAge === undefined ? {} : { currentAge }),
    ...(timelineProfile === undefined ? {} : { timelineProfile }),
    ...(templateId === undefined ? {} : { templateId }),
    ...(imageQuality === undefined ? {} : { imageQuality }),
    ...(participantAges === undefined ? {} : { participantAges }),
    generationPlan, purpose: "age_transformation" };
}

const QUALITY_DIMENSIONS = ["identity", "ageRange", "facialDrift", "pose", "artifacts", "clarity"] as const;
function artifactBinding(input: JsonObject): JsonObject | undefined {
  if (input.artifactBinding === undefined) return undefined;
  const binding = requireNonEmptyObject(input, "artifactBinding");
  const keys = ["sourceAssetId", "assetId", "outputSha256", "targetAge", ...(binding.wardrobeBinding === undefined ? [] : ["wardrobeBinding"])];
  if (Object.keys(binding).length !== keys.length || Object.keys(binding).some(key => !keys.includes(key))) throw new DomainError("VALIDATION_FAILED", "artifactBinding must use the closed source/output/age schema");
  const sourceAssetId = requiredString(binding, "sourceAssetId"), assetId = requiredString(binding, "assetId");
  const outputSha256 = requiredString(binding, "outputSha256");
  if (!/^[a-f0-9]{64}$/.test(outputSha256)) throw new DomainError("VALIDATION_FAILED", "outputSha256 is invalid");
  const targetAge = requireInteger(requiredNumber(binding, "targetAge", 0), "targetAge", 0, 100);
  const wardrobe = binding.wardrobeBinding === undefined ? undefined : parseWardrobeBinding(binding.wardrobeBinding);
  if (wardrobe && (wardrobe.targetAge !== targetAge || wardrobe.sourceImageId === assetId || wardrobe.sourceImageSha256 === outputSha256)) throw new DomainError("VALIDATION_FAILED", "wardrobe output must be a new image at the unchanged age");
  return { sourceAssetId, assetId, outputSha256, targetAge, ...(wardrobe === undefined ? {} : { wardrobeBinding: wardrobe }) };
}

function qualityGate(input: JsonObject): JsonObject {
  const workId = requiredString(input, "workId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const modelVersion = requiredString(input, "modelVersion");
  const scores = requireNonEmptyObject(input, "scores");
  const thresholds = requireNonEmptyObject(input, "thresholds");
  const normalizedScores: Record<string, JsonValue> = {};
  const normalizedThresholds: Record<string, JsonValue> = {};
  const failed: string[] = [];
  const binding = artifactBinding(input);
  const scorerEvidence = photoScoreEvidence(input, binding, participantIds);
  const wardrobe = binding?.wardrobeBinding !== undefined;
  const v2=scorerEvidence?.schemaVersion==="ltm.photo-score.evidence.v2";
  if(input.reviewEvidence!==undefined)throw new DomainError("VALIDATION_FAILED","review evidence is server-managed, not a scoring input");
  const dimensions: readonly string[] = binding === undefined ? QUALITY_DIMENSIONS : [...QUALITY_DIMENSIONS, "background", "handsTeethEyes", "photorealism",...(v2?["aestheticUsability"]:[]), ...(wardrobe ? ["garmentMatch", "regionPreservation"] : [])];
  for (const dimension of dimensions) {
    const score = scores[dimension];
    const threshold = thresholds[dimension];
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1 ||
        typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw new DomainError("VALIDATION_FAILED", `quality ${dimension} score and threshold must be between zero and one; threshold must be positive`);
    }
    normalizedScores[dimension] = score;
    normalizedThresholds[dimension] = threshold;
    if (score < threshold) failed.push(dimension);
  }
  if (binding !== undefined && [scores, thresholds].some(values => Object.keys(values).length !== dimensions.length || Object.keys(values).some(key => !dimensions.includes(key)))) {
    throw new DomainError("VALIDATION_FAILED", "bound quality scores and thresholds must contain exactly the required dimensions");
  }
  const decision = assertKnownState(requiredString(input, "decision"), ["pass", "retry", "review", "reject"] as const, "decision");
  const people = participantQuality(input.participantAssessments, participantIds, wardrobe || (binding !== undefined && participantIds.length > 1), wardrobe);
  failed.push(...people.failedDimensions);
  const overrideReason = input.overrideReason === undefined ? undefined : requiredString(input, "overrideReason");
  if (decision === "pass" && failed.some((dimension) => binding !== undefined || dimension.startsWith("participant:") || ["identity", "ageRange", "facialDrift", "artifacts", "handsTeethEyes", "photorealism", "garmentMatch", "regionPreservation"].includes(dimension))) {
    throw new DomainError("VALIDATION_FAILED", "critical identity, age or artifact failures cannot be overridden");
  }
  if ((decision === "pass") !== (failed.length === 0) && !overrideReason) {
    throw new DomainError("VALIDATION_FAILED", "quality decision conflicts with dimension thresholds and has no audited override reason");
  }
  return {
    workId,
    participantIds,
    modelVersion,
    ...(people.assessments === undefined ? {} : { participantAssessments: people.assessments }),
    ...(binding === undefined ? {} : { artifactBinding: binding }),
    ...(scorerEvidence === undefined ? {} : { photoScoreEvidence: scorerEvidence }),
    scores: normalizedScores,
    thresholds: normalizedThresholds,
    failedDimensions: failed,
    decision,
    ...(overrideReason ? { overrideReason } : {}),
    purpose: "quality_assurance",
  };
}

function photoScoreEvidence(input: JsonObject, binding: JsonObject | undefined, participants: string[]): JsonObject | undefined {
  if (input.photoScoreEvidence === undefined) return undefined;
  if (binding === undefined) throw new DomainError("VALIDATION_FAILED", "photo scoring evidence requires an artifact binding");
  const evidence = requireNonEmptyObject(input, "photoScoreEvidence");
  const v2=evidence.schemaVersion==="ltm.photo-score.evidence.v2";
  const keys = ["schemaVersion", "requestSha256", "responseSha256", "sourceSha256", "modelSha256", "calibrationId", "calibrationSha256", "calibration", "ages",...(v2?["commandId","controlKey"]:[])];
  if (Object.keys(evidence).length !== keys.length || Object.keys(evidence).some(key => !keys.includes(key)) || !["ltm.photo-score.evidence.v1","ltm.photo-score.evidence.v2"].includes(String(evidence.schemaVersion))) {
    throw new DomainError("VALIDATION_FAILED", "photo scoring evidence schema is invalid");
  }
  for (const key of ["requestSha256", "responseSha256", "sourceSha256", "modelSha256", "calibrationSha256"]) {
    if (!/^[a-f0-9]{64}$/.test(requiredString(evidence, key))) throw new DomainError("VALIDATION_FAILED", "photo scoring evidence digest is invalid");
  }
  const calibrationId = requiredString(evidence, "calibrationId");
  const calibration = requireNonEmptyObject(evidence, "calibration"), thresholds = requireNonEmptyObject(input, "thresholds");
  const policyKeys = ["id", "modelVersion", "modelSha256", "context", "minimumTargetAge", "maximumTargetAge", "minimumAgeSpan", "maximumAgeSpan", "ageToleranceYears", "minimumAgeConfidence", "thresholds",...(v2?["protocolVersion","regression"]:[])];
  if(v2){
    const rule=requireNonEmptyObject(calibration,"regression");
    const controlKey="quality-control-"+createHash("sha256").update(canonicalJson({context:calibration.context,modelVersion:calibration.modelVersion,modelSha256:calibration.modelSha256})).digest("hex");
    if(calibration.protocolVersion!==2 || requiredString(evidence,"controlKey")!==controlKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requiredString(evidence,"commandId")) || Object.keys(rule).length!==3 || !Number.isInteger(rule.windowSize)||Number(rule.windowSize)<2||Number(rule.windowSize)>100 || !Number.isInteger(rule.minimumSamples)||Number(rule.minimumSamples)<2||Number(rule.minimumSamples)>Number(rule.windowSize)||typeof rule.maximumFailureRate!=="number"||!Number.isFinite(rule.maximumFailureRate)||rule.maximumFailureRate<=0||rule.maximumFailureRate>1)throw new DomainError("VALIDATION_FAILED","v2 quality control calibration is invalid");
  }
  const context = requireNonEmptyObject(calibration, "context"), minimums = requireNonEmptyObject(calibration, "thresholds");
  if (Object.keys(calibration).length !== policyKeys.length || Object.keys(calibration).some(key => !policyKeys.includes(key)) ||
      Object.keys(context).length !== 5 || ["provider", "templateId", "channel", "subjectMode", "operation"].some(key => typeof context[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(context[key] as string)) ||
      context.subjectMode !== (participants.length === 2 ? "couple" : "single") || context.operation !== (binding.wardrobeBinding === undefined ? "age" : "wardrobe") ||
      calibration.id !== calibrationId || calibration.modelVersion !== input.modelVersion || calibration.modelSha256 !== evidence.modelSha256 ||
      Object.keys(minimums).length !== Object.keys(thresholds).length || Object.keys(thresholds).some(key => minimums[key] !== thresholds[key]) ||
      createHash("sha256").update(canonicalJson(calibration)).digest("hex") !== evidence.calibrationSha256) {
    throw new DomainError("VALIDATION_FAILED", "photo scoring calibration snapshot or binding is invalid");
  }
  for (const [min, max] of [[calibration.minimumTargetAge, calibration.maximumTargetAge], [calibration.minimumAgeSpan, calibration.maximumAgeSpan]]) {
    if (typeof min !== "number" || typeof max !== "number" || !Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 100 || min > max) throw new DomainError("VALIDATION_FAILED", "photo scoring calibration ages are invalid");
  }
  if (typeof calibration.ageToleranceYears !== "number" || !Number.isFinite(calibration.ageToleranceYears) || calibration.ageToleranceYears <= 0 || calibration.ageToleranceYears > 100 ||
      typeof calibration.minimumAgeConfidence !== "number" || !Number.isFinite(calibration.minimumAgeConfidence) || calibration.minimumAgeConfidence <= 0 || calibration.minimumAgeConfidence > 1 ||
      (binding.targetAge as number) < (calibration.minimumTargetAge as number) || (binding.targetAge as number) > (calibration.maximumTargetAge as number)) throw new DomainError("VALIDATION_FAILED", "photo scoring calibration confidence or tolerance is invalid");
  if (!Array.isArray(evidence.ages) || evidence.ages.length !== participants.length) throw new DomainError("VALIDATION_FAILED", "photo scoring ages require exact participant coverage");
  const ages = evidence.ages.map((value, index) => {
    const age = requireNonEmptyObject({ value }, "value");
    if (Object.keys(age).length !== 3 || Object.keys(age).some(key => !["participantId", "estimatedAgeYears", "confidence"].includes(key)) || typeof age.participantId !== "string" || age.participantId !== participants[index] ||
        typeof age.estimatedAgeYears !== "number" || !Number.isFinite(age.estimatedAgeYears) || age.estimatedAgeYears < 0 || age.estimatedAgeYears > 120 ||
        typeof age.confidence !== "number" || !Number.isFinite(age.confidence) || age.confidence < 0 || age.confidence > 1) {
      throw new DomainError("VALIDATION_FAILED", "photo scoring age or participant binding is invalid");
    }
    return { participantId: age.participantId, estimatedAgeYears: age.estimatedAgeYears, confidence: age.confidence };
  });
  return { schemaVersion: String(evidence.schemaVersion), requestSha256: evidence.requestSha256!, responseSha256: evidence.responseSha256!, sourceSha256: evidence.sourceSha256!, modelSha256: evidence.modelSha256!, calibrationId, calibrationSha256: evidence.calibrationSha256!, calibration: JSON.parse(JSON.stringify(calibration)) as JsonObject, ages,...(v2?{controlKey:evidence.controlKey!,commandId:evidence.commandId!}:{}) };
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
  const binding = artifactBinding(input);
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
    ...(binding === undefined ? {} : { artifactBinding: binding }),
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
    consent: participantConsent({ resourcePrefix: "media.asset", resourceIdField: "sourceAssetId", action: "transform" }),
    prerequisite: async (runtime, invocation, data) => {
      await requireAcceptedMediaIntake(runtime, invocation, data);
      if (data.wardrobeEdit !== undefined) await requireWardrobeSource(runtime, invocation.actor, data);
    },
    mode: "external-command", collection: "generation.timeline-commands", recordIdField: "jobId",
  }),
  defineCapability("B15", SKILL, "evaluateQuality", qualityGate, {
    permission: "media.quality.evaluate",
    consent: participantConsent(), mode: "resource", collection: "media.quality-decisions", recordIdField: "workId",
  }),
  defineCapability("B16", SKILL, "renderVideo", renderVideo, {
    consent: participantConsent(), mode: "external-command", collection: "media.video-render-commands", recordIdField: "renderId",
  }),
  defineCapability("B17", SKILL, "certifySafetyAndProvenance", certifySafety, {
    permission: "media.safety.certify",
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
