import { DomainError } from "@ltm/core";
import { capabilityEvidenceScope } from "@ltm/providers";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { requiredBoolean, requiredString, stringList } from "../validation.js";
import {
  assertISODate,
  assertKnownState,
  defineCapability,
  jsonStringList,
  participantConsent,
  registerDefinitions,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-channel-solutions";

function operateStudioSession(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  const studioSessionId = requiredString(input, "studioSessionId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const action = assertKnownState(requiredString(input, "action"), ["upload", "review", "approve", "reject", "order"] as const, "action");
  const actorCapacity = assertKnownState(requiredString(input, "actorCapacity"), ["customer", "photographer", "kiosk"] as const, "actorCapacity");
  const deviceState = assertKnownState(requiredString(input, "deviceState"), ["registered", "revoked", "unknown"] as const, "deviceState");
  const aiLabelLocked = requiredBoolean(input, "aiLabelLocked");
  const containsMinor = requiredBoolean(input, "containsMinor");
  if (deviceState !== "registered" || !aiLabelLocked) throw new DomainError("AUTH_FORBIDDEN", "studio operations require a registered device and locked trust controls");
  if (action === "approve" && actorCapacity !== "customer") throw new DomainError("AUTH_FORBIDDEN", "a photographer or kiosk cannot approve on behalf of an adult customer");
  if (containsMinor && !invocation.actor.guardianVerified) throw new DomainError("GUARDIAN_VERIFICATION_REQUIRED", "minor studio sessions require verified guardian context");
  return { studioSessionId, participantIds, action, actorCapacity, deviceState, aiLabelLocked, containsMinor, purpose: "studio_session" };
}

function processGiftOrMemorial(input: JsonObject): JsonObject {
  const channelOrderId = requiredString(input, "channelOrderId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const subjectStatus = assertKnownState(requiredString(input, "subjectStatus"), ["living", "deceased"] as const, "subjectStatus");
  const recipientClaimed = requiredBoolean(input, "recipientClaimed");
  const authorizationEvidenceId = requiredString(input, "authorizationEvidenceId");
  const interactionMode = assertKnownState(requiredString(input, "interactionMode"), ["none", "static_memorial", "interactive"] as const, "interactionMode");
  const paymentState = assertKnownState(requiredString(input, "paymentState"), ["captured", "settled", "pending", "unknown"] as const, "paymentState");
  if (subjectStatus === "living" && !recipientClaimed) throw new DomainError("CONSENT_REQUIRED", "living gift recipients must claim before their media is processed");
  if (subjectStatus === "deceased" && interactionMode === "interactive") throw new DomainError("VALIDATION_FAILED", "memorial experiences cannot impersonate a deceased person interactively");
  if (!["captured", "settled"].includes(paymentState)) throw new DomainError("DEPENDENCY_UNAVAILABLE", "gift fulfillment requires captured payment");
  return { channelOrderId, participantIds, subjectStatus, recipientClaimed, authorizationEvidenceId, interactionMode, paymentState, purpose: "gift_or_memorial" };
}

function configureEducationExperience(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  const experienceId = requiredString(input, "experienceId");
  const scenario = assertKnownState(requiredString(input, "scenario"), ["retirement_vision", "future_letter", "savings_reflection", "family_dialogue"] as const, "scenario");
  const regulatedUse = assertKnownState(
    requiredString(input, "regulatedUse"),
    ["education_only", "underwriting", "pricing", "claims", "credit", "employment", "eligibility", "unknown"] as const,
    "regulatedUse",
  );
  const facialDataTransferred = requiredBoolean(input, "facialDataTransferred");
  const photoOptional = requiredBoolean(input, "photoOptional");
  const productRecommendationSeparated = requiredBoolean(input, "productRecommendationSeparated");
  const approvalEvidenceIds = stringList(input, "approvalEvidenceIds", { min: 1, unique: true });
  const assuranceProviderId = evidenceProviderId(requiredString(input, "assuranceProviderId"));
  const providerEnvironment = assertKnownState(
    requiredString(input, "providerEnvironment"),
    ["test", "sandbox", "staging", "production"] as const,
    "providerEnvironment",
  );
  const assuranceArtifactSha256 = digest(requiredString(input, "assuranceArtifactSha256"), "assuranceArtifactSha256");
  if (regulatedUse !== "education_only" || facialDataTransferred || !photoOptional || !productRecommendationSeparated) {
    throw new DomainError("AUTH_FORBIDDEN", "education channel is isolated from regulated decisioning and must work without a photo");
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B37",
    operation: "configureEducationExperience",
    kind: "education-assurance",
    provider: `education-assurance:${assuranceProviderId}`,
    artifactSha256: assuranceArtifactSha256,
    environment: providerEnvironment,
    subjectId: experienceId,
  });
  return {
    experienceId,
    scenario,
    regulatedUse,
    facialDataTransferred,
    photoOptional,
    productRecommendationSeparated,
    approvalEvidenceIds,
    externalEvidenceIds: approvalEvidenceIds,
    assuranceProviderId,
    providerEnvironment,
    assuranceArtifactSha256,
    evidenceScope,
  };
}

function digest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DomainError("VALIDATION_FAILED", `${field} must be a lowercase SHA-256 digest`);
  return value;
}

function evidenceProviderId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)) {
    throw new DomainError("VALIDATION_FAILED", "assuranceProviderId is invalid");
  }
  return value;
}

const CRM_FIELDS = new Set(["name", "contact", "selectedTopic", "sourceSessionId"]);

function handoffLead(input: JsonObject): JsonObject {
  const handoffId = requiredString(input, "handoffId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const recipient = requiredString(input, "recipient");
  const fields = stringList(input, "fields", { min: 1, unique: true });
  const channel = assertKnownState(requiredString(input, "channel"), ["email", "sms", "phone", "wechat"] as const, "channel");
  const expiresAt = assertISODate(requiredString(input, "expiresAt"), "expiresAt");
  const explicitOptIn = requiredBoolean(input, "explicitOptIn");
  const suppressionState = assertKnownState(requiredString(input, "suppressionState"), ["clear", "blocked", "unknown"] as const, "suppressionState");
  if (!explicitOptIn) throw new DomainError("CONSENT_REQUIRED", "CRM handoff requires a separate, explicit opt-in");
  if (fields.some((field) => !CRM_FIELDS.has(field))) throw new DomainError("VALIDATION_FAILED", "CRM handoff contains a prohibited or excessive field");
  if (suppressionState !== "clear") throw new DomainError("AUTH_FORBIDDEN", "suppressed or unknown contacts cannot be handed off");
  if (Date.parse(expiresAt) <= Date.now()) throw new DomainError("VALIDATION_FAILED", "lead authorization must be unexpired");
  return { handoffId, participantIds, recipient, fields, channel, expiresAt, explicitOptIn, suppressionState, purpose: "crm_handoff" };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B35", SKILL, "operateStudioSession", operateStudioSession, {
    consent: participantConsent(), mode: "resource", collection: "channels.studio-session-actions",
  }),
  defineCapability("B36", SKILL, "processGiftOrMemorial", processGiftOrMemorial, {
    mode: "external-command",
    collection: "channels.gift-memorial-commands",
    recordIdField: "channelOrderId",
    consent(data, invocation) {
      return data.subjectStatus === "deceased"
        ? []
        : { participantIds: jsonStringList(data.participantIds, "participantIds", 1), purpose: invocation.actor.purpose };
    },
  }),
  defineCapability("B37", SKILL, "configureEducationExperience", configureEducationExperience, {
    permission: "channel.education.approve",
    mode: "attestation",
    collection: "channels.education-attestations",
    recordIdField: "experienceId",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
  }),
  defineCapability("B38", SKILL, "handoffLead", handoffLead, {
    consent: participantConsent(), mode: "external-command", collection: "channels.crm-handoff-commands", recordIdField: "handoffId",
  }),
];

export function registerBuildingChannelSolutionsCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingChannelSolutionsCoverage = definitions.length;
