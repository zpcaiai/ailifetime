import { DomainError } from "@ltm/core";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { requiredBoolean, requiredString, stringList } from "../validation.js";
import {
  assertISODate,
  assertKnownState,
  defineCapability,
  participantConsent,
  registerDefinitions,
  requireNonEmptyObject,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-family-future-self";

function updateFamilyGraph(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  const familyId = requiredString(input, "familyId");
  const participantIds = stringList(input, "participantIds", { min: 2, unique: true });
  const relationship = assertKnownState(requiredString(input, "relationship"), ["parent", "child", "spouse", "sibling", "guardian", "other"] as const, "relationship");
  const action = assertKnownState(requiredString(input, "action"), ["invite", "accept", "remove", "change_role"] as const, "action");
  const containsMinor = requiredBoolean(input, "containsMinor");
  if (containsMinor && !invocation.actor.guardianVerified) {
    throw new DomainError("GUARDIAN_VERIFICATION_REQUIRED", "verified guardian context is required for a family graph containing minors");
  }
  return { familyId, participantIds, relationship, action, containsMinor, purpose: "family_graph" };
}

function composeFamilyScene(input: JsonObject): JsonObject {
  const sceneId = requiredString(input, "sceneId");
  const participantIds = stringList(input, "participantIds", { min: 2, unique: true });
  const templateId = requiredString(input, "templateId");
  const qualityDecision = assertKnownState(requiredString(input, "qualityDecision"), ["passed", "review", "failed", "unknown"] as const, "qualityDecision");
  const illustrativeLabel = requiredBoolean(input, "illustrativeLabel");
  if (qualityDecision !== "passed") throw new DomainError("VALIDATION_FAILED", "only a passed, known multi-person quality decision can enter composition");
  if (!illustrativeLabel) throw new DomainError("VALIDATION_FAILED", "family aging scenes must be labeled as illustrative AI output");
  return { sceneId, participantIds, templateId, qualityDecision, illustrativeLabel, purpose: "family_scene" };
}

function applyChildSafeguard(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  const safeguardId = requiredString(input, "safeguardId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const containsMinor = requiredBoolean(input, "containsMinor");
  const requestedFeature = assertKnownState(
    requiredString(input, "requestedFeature"),
    ["private_generation", "family_library", "public_share", "marketing", "future_self_dialogue"] as const,
    "requestedFeature",
  );
  const ageBand = assertKnownState(requiredString(input, "ageBand"), ["child", "teen"] as const, "ageBand");
  const guardianControlsVersion = requiredString(input, "guardianControlsVersion");
  if (!containsMinor) throw new DomainError("VALIDATION_FAILED", "child safeguard records must identify a minor participant");
  if (!invocation.actor.guardianVerified) throw new DomainError("GUARDIAN_VERIFICATION_REQUIRED", "verified guardian context is required");
  if (["public_share", "marketing", "future_self_dialogue"].includes(requestedFeature)) {
    throw new DomainError("AUTH_FORBIDDEN", `${requestedFeature} is disabled for minors`);
  }
  return { safeguardId, participantIds, containsMinor, requestedFeature, ageBand, guardianControlsVersion, purpose: "child_safeguarding" };
}

const PROHIBITED_PREDICTIONS = new Set(["health", "lifespan", "wealth", "career", "medical", "insurance"]);

function createFutureNarrative(input: JsonObject): JsonObject {
  const narrativeId = requiredString(input, "narrativeId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const format = assertKnownState(requiredString(input, "format"), ["story", "letter", "goal_visualization"] as const, "format");
  const themes = stringList(input, "themes", { min: 1, unique: true });
  const illustrativeDisclosure = requiredBoolean(input, "illustrativeDisclosure");
  const userAuthoredGoals = requiredBoolean(input, "userAuthoredGoals");
  if (!illustrativeDisclosure || !userAuthoredGoals || themes.some((theme) => PROHIBITED_PREDICTIONS.has(theme))) {
    throw new DomainError("VALIDATION_FAILED", "future-self narratives must be user-directed fiction without consequential predictions");
  }
  return { narrativeId, participantIds, format, themes, illustrativeDisclosure, userAuthoredGoals, purpose: "future_self_narrative" };
}

function converseWithFutureSelf(input: JsonObject): JsonObject {
  const conversationId = requiredString(input, "conversationId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const safetyPolicyVersion = requiredString(input, "safetyPolicyVersion");
  const riskState = assertKnownState(requiredString(input, "riskState"), ["clear", "crisis", "blocked", "unknown"] as const, "riskState");
  const anthropomorphicDisclosure = requiredBoolean(input, "anthropomorphicDisclosure");
  const memoryConsent = requiredBoolean(input, "memoryConsent");
  const persona = requireNonEmptyObject(input, "persona");
  if (!anthropomorphicDisclosure) throw new DomainError("VALIDATION_FAILED", "future-self dialogue must disclose that it is an AI persona");
  if (riskState === "unknown" || riskState === "blocked") throw new DomainError("VALIDATION_FAILED", "unknown or blocked safety state cannot produce dialogue");
  return {
    conversationId,
    participantIds,
    safetyPolicyVersion,
    riskState,
    anthropomorphicDisclosure,
    memoryConsent,
    persona,
    responseMode: riskState === "crisis" ? "human_crisis_handoff" : "bounded_reflection",
    purpose: memoryConsent ? "future_self_memory" : "future_self_dialogue",
  };
}

function scheduleAnnualRitual(input: JsonObject): JsonObject {
  const ritualId = requiredString(input, "ritualId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const scheduledAt = assertISODate(requiredString(input, "scheduledAt"), "scheduledAt");
  const scheduleSource = assertKnownState(requiredString(input, "scheduleSource"), ["user_selected"] as const, "scheduleSource");
  const archivePolicyVersion = requiredString(input, "archivePolicyVersion");
  const longTermMemoryConsent = requiredBoolean(input, "longTermMemoryConsent");
  const reminderConsent = requiredBoolean(input, "reminderConsent");
  if (!longTermMemoryConsent || !reminderConsent) {
    throw new DomainError("CONSENT_REQUIRED", "annual archives and reminders require independent active choices");
  }
  if (Date.parse(scheduledAt) <= Date.now()) throw new DomainError("VALIDATION_FAILED", "annual ritual must be scheduled in the future");
  return { ritualId, participantIds, scheduledAt, scheduleSource, archivePolicyVersion, longTermMemoryConsent, reminderConsent, purpose: "annual_archive" };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B19", SKILL, "updateFamilyGraph", updateFamilyGraph, { consent: participantConsent() }),
  defineCapability("B20", SKILL, "composeFamilyScene", composeFamilyScene, { consent: participantConsent() }),
  defineCapability("B21", SKILL, "applyChildSafeguard", applyChildSafeguard, { consent: participantConsent() }),
  defineCapability("B22", SKILL, "createFutureNarrative", createFutureNarrative, { consent: participantConsent() }),
  defineCapability("B23", SKILL, "converseWithFutureSelf", converseWithFutureSelf, { consent: participantConsent() }),
  defineCapability("B24", SKILL, "scheduleAnnualRitual", scheduleAnnualRitual, { consent: participantConsent() }),
];

export function registerBuildingFamilyFutureSelfCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingFamilyFutureSelfCoverage = definitions.length;
