import { DomainError } from "@ltm/core";
import { createHash } from "node:crypto";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertActorTenant,
  assertISODate,
  assertKnownState,
  defineCapability,
  jsonStringList,
  participantConsent,
  registerDefinitions,
  requireAcceptedMediaIntake,
  requireInteger,
  requireNonEmptyObject,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-consumer-time-machine";

function createGuestJourney(input: JsonObject): JsonObject {
  const sessionId = requiredString(input, "sessionId");
  const campaign = requiredString(input, "campaign");
  const disclosureAccepted = requiredBoolean(input, "disclosureAccepted");
  const retentionHours = requireInteger(requiredNumber(input, "retentionHours", 1), "retentionHours", 1, 24);
  const accessibilityMode = assertKnownState(
    requiredString(input, "accessibilityMode"),
    ["standard", "reduced_motion", "screen_reader"] as const,
    "accessibilityMode",
  );
  if (!disclosureAccepted) {
    throw new DomainError("CONSENT_REQUIRED", "AI, authorization, deletion, price, and refund disclosures must be acknowledged");
  }
  return { sessionId, campaign, disclosureAccepted, retentionHours, accessibilityMode, state: "guest" };
}

function acceptPhoto(input: JsonObject): JsonObject {
  const assetId = requiredString(input, "assetId");
  const mimeType = assertKnownState(requiredString(input, "mimeType"), ["image/jpeg"] as const, "mimeType");
  const byteLength = requireInteger(requiredNumber(input, "byteLength", 1), "byteLength", 1, 25_000_000);
  const faceCount = requireInteger(requiredNumber(input, "faceCount", 1), "faceCount", 1, 20);
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const magicVerified = requiredBoolean(input, "magicVerified");
  const metadataStripped = requiredBoolean(input, "metadataStripped");
  const malwareState = assertKnownState(requiredString(input, "malwareState"), ["clean", "blocked", "unknown"] as const, "malwareState");
  const sourceSha256 = requiredString(input, "sourceSha256");
  const canonicalSha256 = requiredString(input, "canonicalSha256");
  const lineageSha256 = requiredString(input, "lineageSha256");
  const scanEvidenceId = requiredString(input, "scanEvidenceId");
  const scannerProvider = requiredString(input, "scannerProvider");
  const scanAssessedAt = assertISODate(requiredString(input, "scanAssessedAt"), "scanAssessedAt");
  const participantMappingEvidenceId = requiredString(input, "participantMappingEvidenceId");
  const participantMappingProvider = requiredString(input, "participantMappingProvider");
  const participantMappingAssessedAt = assertISODate(
    requiredString(input, "participantMappingAssessedAt"),
    "participantMappingAssessedAt",
  );
  const participantMapComplete = requiredBoolean(input, "participantMapComplete");
  const qualityDimensions = requireNonEmptyObject(input, "qualityDimensions");
  const expectedLineageSha256 = createHash("sha256")
    .update(`ltm-media-lineage-v1\n${sourceSha256}\n${canonicalSha256}\n`)
    .digest("hex");
  if (!magicVerified || !metadataStripped || malwareState !== "clean" || !participantMapComplete ||
      !/^[a-f0-9]{64}$/.test(sourceSha256) || !/^[a-f0-9]{64}$/.test(canonicalSha256) ||
      !/^[a-f0-9]{64}$/.test(lineageSha256) || lineageSha256 !== expectedLineageSha256) {
    throw new DomainError("VALIDATION_FAILED", "unverified or unsafe media is rejected");
  }
  if (faceCount !== participantIds.length) {
    throw new DomainError("CONSENT_REQUIRED", "every detected person must be mapped to a consented participant");
  }
  return {
    assetId,
    mimeType,
    byteLength,
    faceCount,
    participantIds,
    magicVerified,
    metadataStripped,
    malwareState,
    sourceSha256,
    canonicalSha256,
    lineageSha256,
    scanEvidenceId,
    scannerProvider,
    scanAssessedAt,
    participantMappingEvidenceId,
    participantMappingProvider,
    participantMappingAssessedAt,
    participantMapComplete,
    qualityDimensions,
    purpose: "age_transformation",
  };
}

function saveComposition(input: JsonObject): JsonObject {
  const draftId = requiredString(input, "draftId");
  const sourceAssetId = requiredString(input, "sourceAssetId");
  const templateId = requiredString(input, "templateId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const targetAgesRaw = input.targetAges;
  if (!Array.isArray(targetAgesRaw) || targetAgesRaw.length === 0 || targetAgesRaw.some((age) => typeof age !== "number")) {
    throw new DomainError("VALIDATION_FAILED", "targetAges must be a non-empty numeric array");
  }
  const targetAges = targetAgesRaw.map((age) => requireInteger(age as number, "targetAges", 0, 100));
  if (new Set(targetAges).size !== targetAges.length) {
    throw new DomainError("VALIDATION_FAILED", "targetAges must be unique");
  }
  const composition = requireNonEmptyObject(input, "composition");
  const illustrativeLabel = requiredBoolean(input, "illustrativeLabel");
  if (!illustrativeLabel) {
    throw new DomainError("VALIDATION_FAILED", "composition must state that age outputs are illustrative AI transformations");
  }
  return { draftId, sourceAssetId, templateId, participantIds, targetAges, composition, illustrativeLabel, purpose: "age_transformation" };
}

const JOB_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  queued: ["preflight", "cancelled", "expired"],
  preflight: ["running", "failed", "cancelled"],
  running: ["quality-review", "partial", "failed", "cancelled"],
  "quality-review": ["ready", "partial", "failed", "cancelled"],
  partial: ["running", "ready", "failed", "cancelled", "expired"],
  ready: ["expired"],
  failed: ["queued", "expired"],
  cancelled: [],
  expired: [],
};

function transitionGenerationJob(input: JsonObject): JsonObject {
  const jobId = requiredString(input, "jobId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const fromState = assertKnownState(requiredString(input, "fromState"), Object.keys(JOB_TRANSITIONS), "fromState");
  const toState = assertKnownState(requiredString(input, "toState"), Object.keys(JOB_TRANSITIONS), "toState");
  const fingerprint = requiredString(input, "requestFingerprint");
  const milestones = jsonStringList(input.milestones, "milestones");
  if (!JOB_TRANSITIONS[fromState]?.includes(toState)) {
    throw new DomainError("VERSION_CONFLICT", `illegal generation transition ${fromState} -> ${toState}`);
  }
  if (toState === "ready" && !milestones.includes("quality_gate_passed")) {
    throw new DomainError("VALIDATION_FAILED", "ready jobs require a real quality-gate milestone");
  }
  return { jobId, participantIds, fromState, toState, requestFingerprint: fingerprint, milestones, purpose: "age_transformation" };
}

function publishExport(input: JsonObject): JsonObject {
  const workId = requiredString(input, "workId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const format = assertKnownState(
    requiredString(input, "format"),
    ["single_image", "grid", "short_video", "captioned_video", "print"] as const,
    "format",
  );
  const visibility = assertKnownState(requiredString(input, "visibility"), ["private", "link", "public"] as const, "visibility");
  const expiresAt = assertISODate(requiredString(input, "expiresAt"), "expiresAt");
  const aiLabel = requiredBoolean(input, "aiLabel");
  const provenanceId = requiredString(input, "provenanceId");
  const revocable = requiredBoolean(input, "revocable");
  const containsMinor = requiredBoolean(input, "containsMinor");
  if (!aiLabel || !revocable) throw new DomainError("VALIDATION_FAILED", "exports require AI labeling and revocation");
  if (containsMinor && visibility !== "private") {
    throw new DomainError("GUARDIAN_VERIFICATION_REQUIRED", "minor works are private by default and cannot be made public by this operation");
  }
  const expiryTime = Date.parse(expiresAt);
  if (expiryTime <= Date.now()) throw new DomainError("VALIDATION_FAILED", "share expiry must be in the future");
  if (expiryTime > Date.now() + 30 * 24 * 60 * 60_000) {
    throw new DomainError("VALIDATION_FAILED", "share expiry cannot exceed the 30-day product maximum");
  }
  return { workId, participantIds, format, visibility, expiresAt, aiLabel, provenanceId, revocable, containsMinor, purpose: "sharing" };
}

function mutateFamilyLibrary(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const libraryId = requiredString(input, "libraryId");
  const resourceId = requiredString(input, "resourceId");
  const ownerActorId = requiredString(input, "ownerActorId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const action = assertKnownState(requiredString(input, "action"), ["archive", "restore", "invite", "remove", "close"] as const, "action");
  const role = assertKnownState(requiredString(input, "role"), ["owner", "editor", "viewer"] as const, "role");
  const quotaState = assertKnownState(requiredString(input, "quotaState"), ["available", "full"] as const, "quotaState");
  if (quotaState === "full" && action === "restore") {
    throw new DomainError("VALIDATION_FAILED", "quota exhaustion cannot silently overwrite or delete library content");
  }
  if (invocation.actor.actorId !== ownerActorId && role === "owner") {
    throw new DomainError("AUTH_FORBIDDEN", "ownership cannot be asserted by a non-owner actor");
  }
  return { libraryId, resourceId, ownerActorId, participantIds, action, role, quotaState, purpose: "family_library" };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B06", SKILL, "createGuestJourney", createGuestJourney, {
    mode: "resource", collection: "consumer.guest-sessions", recordIdField: "sessionId",
  }),
  defineCapability("B07", SKILL, "acceptPhoto", acceptPhoto, {
    consent: participantConsent({ resourcePrefix: "media.asset", resourceIdField: "assetId", action: "ingest" }),
    mode: "resource", collection: "media.intake-results", recordIdField: "assetId",
  }),
  defineCapability("B08", SKILL, "saveComposition", saveComposition, {
    consent: participantConsent({ resourcePrefix: "media.asset", resourceIdField: "sourceAssetId", action: "transform" }),
    prerequisite: (runtime, invocation, data) => requireAcceptedMediaIntake(runtime, invocation, data),
    mode: "resource", collection: "consumer.composition-drafts", recordIdField: "draftId",
  }),
  defineCapability("B09", SKILL, "transitionGenerationJob", transitionGenerationJob, {
    consent: participantConsent(),
    mode: "state-transition",
    collection: "generation.jobs",
    recordIdField: "jobId",
    transition: { fromField: "fromState", toField: "toState", stateField: "state", initialFromStates: ["queued"] },
  }),
  defineCapability("B10", SKILL, "publishExport", publishExport, {
    consent: participantConsent({
      resourcePrefix: "work",
      resourceIdField: "workId",
      action: "share",
      atField: "expiresAt",
    }),
    processingPurpose: "sharing",
    mode: "external-command",
    collection: "sharing.export-commands",
  }),
  defineCapability("B11", SKILL, "mutateFamilyLibrary", mutateFamilyLibrary, {
    consent: participantConsent(), mode: "resource", collection: "family.library-operations",
  }),
];

export function registerBuildingConsumerTimeMachineCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingConsumerTimeMachineCoverage = definitions.length;
