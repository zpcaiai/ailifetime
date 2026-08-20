import { DomainError } from "@ltm/core";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { objectValue, requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertActorTenant,
  assertKnownState,
  defineCapability,
  registerDefinitions,
  requireInteger,
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "designing-life-time-machine-experience";

function projectProfile(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const profileId = requiredString(input, "profileId");
  const stackProfile = requiredString(input, "stackProfile");
  const businessModel = requiredString(input, "businessModel");
  const regions = stringList(input, "regions", { min: 1, unique: true });
  const locales = stringList(input, "locales", { min: 1, unique: true });
  const channels = stringList(input, "channels", { min: 1, unique: true });
  const selectedBatches = stringList(input, "selectedBatches", { min: 1, unique: true });
  const northStarMetric = requiredString(input, "northStarMetric");
  const guardrails = stringList(input, "guardrails", { min: 4, unique: true });
  const dependencyClosureVerified = requireTrue(requiredBoolean(input, "dependencyClosureVerified"), "dependencyClosureVerified");
  const vanityMetrics = ["downloads", "page_views", "impressions"];
  if (vanityMetrics.includes(northStarMetric.toLowerCase())) {
    throw new DomainError("VALIDATION_FAILED", "northStarMetric must measure durable customer value");
  }
  for (const requiredGuardrail of ["safety", "quality", "cost", "revenue"]) {
    if (!guardrails.includes(requiredGuardrail)) {
      throw new DomainError("VALIDATION_FAILED", `guardrails must include ${requiredGuardrail}`);
    }
  }
  if (selectedBatches.some((batch) => !/^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(batch))) {
    throw new DomainError("VALIDATION_FAILED", "selectedBatches contains an invalid batch id");
  }
  return {
    profileId,
    stackProfile,
    businessModel,
    regions,
    locales,
    channels,
    selectedBatches,
    northStarMetric,
    guardrails,
    dependencyClosureVerified,
  };
}

function researchBlueprint(input: JsonObject): JsonObject {
  const researchId = requiredString(input, "researchId");
  const personaTypes = stringList(input, "personaTypes", { min: 2, unique: true });
  const journeys = stringList(input, "journeys", { min: 3, unique: true });
  const failureJourneys = stringList(input, "failureJourneys", { min: 2, unique: true });
  const sampleSize = requireInteger(requiredNumber(input, "sampleSize", 1), "sampleSize", 1);
  const anonymized = requireTrue(requiredBoolean(input, "anonymized"), "anonymized");
  const includesMinorResearch = requiredBoolean(input, "includesMinorResearch");
  const guardianEvidenceHash = typeof input.guardianEvidenceHash === "string" ? input.guardianEvidenceHash : undefined;
  if (includesMinorResearch && !guardianEvidenceHash) {
    throw new DomainError("GUARDIAN_VERIFICATION_REQUIRED", "minor research requires guardian evidence");
  }
  if (!failureJourneys.includes("refund") || !failureJourneys.includes("deletion")) {
    throw new DomainError("VALIDATION_FAILED", "research must cover refund and deletion failure journeys");
  }
  return {
    researchId,
    personaTypes,
    journeys,
    failureJourneys,
    sampleSize,
    anonymized,
    includesMinorResearch,
    ...(guardianEvidenceHash ? { guardianEvidenceHash } : {}),
  };
}

function informationArchitecture(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const manifestId = requiredString(input, "manifestId");
  const version = requiredString(input, "version");
  const routes = stringList(input, "routes", { min: 2, unique: true });
  const objectTypes = stringList(input, "objectTypes", { min: 3, unique: true });
  const serverSideAuthorization = requireTrue(
    requiredBoolean(input, "serverSideAuthorization"),
    "serverSideAuthorization",
    "navigation and search must be filtered on the server",
  );
  const consentAware = requireTrue(requiredBoolean(input, "consentAware"), "consentAware");
  const failClosedUnknownRoutes = requireTrue(requiredBoolean(input, "failClosedUnknownRoutes"), "failClosedUnknownRoutes");
  return { manifestId, version, routes, objectTypes, serverSideAuthorization, consentAware, failClosedUnknownRoutes };
}

function designSystem(input: JsonObject): JsonObject {
  const version = requiredString(input, "version");
  const tokens = objectValue(input, "tokens");
  const components = stringList(input, "components", { min: 3, unique: true });
  const accessibilityStates = stringList(input, "accessibilityStates", { min: 3, unique: true });
  const visualRegressionEnabled = requireTrue(requiredBoolean(input, "visualRegressionEnabled"), "visualRegressionEnabled");
  const whiteLabelOverridesRestricted = requireTrue(
    requiredBoolean(input, "whiteLabelOverridesRestricted"),
    "whiteLabelOverridesRestricted",
  );
  for (const state of ["keyboard", "screen_reader", "high_contrast"]) {
    if (!accessibilityStates.includes(state)) {
      throw new DomainError("VALIDATION_FAILED", `accessibilityStates must include ${state}`);
    }
  }
  return { version, tokens, components, accessibilityStates, visualRegressionEnabled, whiteLabelOverridesRestricted };
}

function localizationPolicy(input: JsonObject): JsonObject {
  const policyId = requiredString(input, "policyId");
  const locales = stringList(input, "locales", { min: 3, unique: true });
  const timezoneStorage = assertKnownState(requiredString(input, "timezoneStorage"), ["UTC"] as const, "timezoneStorage");
  const wcagTarget = assertKnownState(requiredString(input, "wcagTarget"), ["AA", "AAA"] as const, "wcagTarget");
  const channels = stringList(input, "channels", { min: 3, unique: true });
  const testSuites = stringList(input, "testSuites", { min: 3, unique: true });
  for (const locale of ["zh-CN", "zh-TW", "en"]) {
    if (!locales.includes(locale)) throw new DomainError("VALIDATION_FAILED", `locales must include ${locale}`);
  }
  for (const suite of ["pseudo_localization", "long_text", "accessibility"]) {
    if (!testSuites.includes(suite)) throw new DomainError("VALIDATION_FAILED", `testSuites must include ${suite}`);
  }
  return { policyId, locales, timezoneStorage, wcagTarget, channels, testSuites };
}

function experienceGate(input: JsonObject): JsonObject {
  const releaseCandidate = requiredString(input, "releaseCandidate");
  const baselineId = requiredString(input, "baselineId");
  const taskSuccessRate = requiredNumber(input, "taskSuccessRate", 0);
  const unresolvedCriticalIssues = requireInteger(
    requiredNumber(input, "unresolvedCriticalIssues", 0),
    "unresolvedCriticalIssues",
    0,
  );
  const controlledCopyApproved = requireTrue(requiredBoolean(input, "controlledCopyApproved"), "controlledCopyApproved");
  const aiDisclosurePresent = requireTrue(requiredBoolean(input, "aiDisclosurePresent"), "aiDisclosurePresent");
  const humanVisualApproval = requireTrue(requiredBoolean(input, "humanVisualApproval"), "humanVisualApproval");
  if (taskSuccessRate > 1 || unresolvedCriticalIssues !== 0) {
    throw new DomainError("VALIDATION_FAILED", "experience release gate requires a 0..1 success rate and no critical issues");
  }
  return {
    releaseCandidate,
    baselineId,
    taskSuccessRate,
    unresolvedCriticalIssues,
    controlledCopyApproved,
    aiDisclosurePresent,
    humanVisualApproval,
    gateState: "approved",
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B51", SKILL, "configureProjectProfile", projectProfile, { permission: "product.profile.manage" }),
  defineCapability("B52", SKILL, "recordResearchBlueprint", researchBlueprint, { permission: "research.manage" }),
  defineCapability("B53", SKILL, "publishInformationArchitecture", informationArchitecture, { permission: "experience.architecture.publish" }),
  defineCapability("B54", SKILL, "publishDesignSystem", designSystem, { permission: "design-system.publish" }),
  defineCapability("B55", SKILL, "publishLocalizationPolicy", localizationPolicy, { permission: "localization.policy.publish" }),
  defineCapability("B56", SKILL, "approveExperienceGate", experienceGate, { permission: "release.experience.approve" }),
];

export function registerDesigningLifeTimeMachineExperienceCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const designingLifeTimeMachineExperienceCoverage = definitions.length;
