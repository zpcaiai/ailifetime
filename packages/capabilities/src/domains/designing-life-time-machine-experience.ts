import { DomainError } from "@ltm/core";
import { capabilityEvidenceScope } from "@ltm/providers";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { objectValue, requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertActorTenant,
  assertKnownState,
  defineCapability,
  rejectClientAssertions,
  registerDefinitions,
  requireInteger,
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "designing-life-time-machine-experience";

function sha256(input: JsonObject, field: string): string {
  const value = requiredString(input, field);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DomainError("VALIDATION_FAILED", `${field} must be a lowercase SHA-256 digest`);
  return value;
}

function providerEnvironment(input: JsonObject): "test" | "sandbox" | "staging" | "production" {
  return assertKnownState(
    requiredString(input, "providerEnvironment"),
    ["test", "sandbox", "staging", "production"] as const,
    "providerEnvironment",
  );
}

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

function experienceGate(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, [
    "taskSuccessRate",
    "unresolvedCriticalIssues",
    "controlledCopyApproved",
    "aiDisclosurePresent",
    "humanVisualApproval",
    "gateState",
  ]);
  const releaseCandidate = requiredString(input, "releaseCandidate");
  const baselineId = requiredString(input, "baselineId");
  const assessmentProviderId = requiredString(input, "assessmentProviderId");
  const environment = providerEnvironment(input);
  const evaluationReportSha256 = sha256(input, "evaluationReportSha256");
  const reportPolicyVersion = requiredString(input, "reportPolicyVersion");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (!invocation.actor.roles.includes("auditor") || invocation.actor.stepUp !== true) {
    throw new DomainError("AUTH_FORBIDDEN", "experience gate approval requires a step-up authenticated auditor");
  }
  if (assessmentProviderId === invocation.actor.actorId) {
    throw new DomainError("AUTH_FORBIDDEN", "experience report issuer and approving auditor must be independent");
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B56",
    operation: "approveExperienceGate",
    kind: "experience-gate-report",
    provider: `experience-assurance:${assessmentProviderId}`,
    artifactSha256: evaluationReportSha256,
    environment,
    subjectId: releaseCandidate,
  });
  return {
    releaseCandidate,
    baselineId,
    assessmentProviderId,
    providerEnvironment: environment,
    evaluationReportSha256,
    reportPolicyVersion,
    externalEvidenceIds,
    evidenceScope,
    decisionState: environment === "production" ? "approved" : "simulation_only",
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B51", SKILL, "configureProjectProfile", projectProfile, {
    permission: "product.profile.manage",
    mode: "resource",
  }),
  defineCapability("B52", SKILL, "recordResearchBlueprint", researchBlueprint, {
    permission: "research.manage",
    mode: "resource",
  }),
  defineCapability("B53", SKILL, "publishInformationArchitecture", informationArchitecture, {
    permission: "experience.architecture.publish",
    mode: "resource",
  }),
  defineCapability("B54", SKILL, "publishDesignSystem", designSystem, {
    permission: "design-system.publish",
    mode: "resource",
  }),
  defineCapability("B55", SKILL, "publishLocalizationPolicy", localizationPolicy, {
    permission: "localization.policy.publish",
    mode: "resource",
  }),
  defineCapability("B56", SKILL, "approveExperienceGate", experienceGate, {
    permission: "release.experience.approve",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "evaluationReportSha256",
    mode: "attestation",
  }),
];

export function registerDesigningLifeTimeMachineExperienceCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const designingLifeTimeMachineExperienceCoverage = definitions.length;
