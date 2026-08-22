import { DomainError } from "@ltm/core";
import type { JsonObject } from "../registry.js";
import { requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertActorTenant,
  assertISODate,
  assertKnownState,
  defineCapability,
  registerDefinitions,
  requireNonEmptyObject,
  type DomainCapabilityDefinition,
} from "./_shared.js";
import type { CapabilityInvocation, CapabilityRegistry } from "../registry.js";

const SKILL = "bootstrapping-life-time-machine-platform";

function architecture(input: JsonObject): JsonObject {
  const repositoryId = requiredString(input, "repositoryId");
  const stackProfile = requiredString(input, "stackProfile");
  const boundedContexts = stringList(input, "boundedContexts", { min: 2, unique: true });
  const healthChecks = stringList(input, "healthChecks", { min: 2, unique: true });
  const ownershipRules = stringList(input, "ownershipRules", { min: 1, unique: true });
  if (!healthChecks.includes("liveness") || !healthChecks.includes("readiness")) {
    throw new DomainError("VALIDATION_FAILED", "both liveness and readiness checks are required");
  }
  return { repositoryId, stackProfile, boundedContexts, healthChecks, ownershipRules };
}

function contracts(input: JsonObject): JsonObject {
  const contractVersion = requiredString(input, "contractVersion");
  const schemaVersion = requiredString(input, "schemaVersion");
  const aggregateTypes = stringList(input, "aggregateTypes", { min: 1, unique: true });
  const compatibility = assertKnownState(requiredString(input, "compatibility"), ["backward", "additive"] as const, "compatibility");
  const sensitiveFieldsClassified = requiredBoolean(input, "sensitiveFieldsClassified");
  if (!sensitiveFieldsClassified) {
    throw new DomainError("VALIDATION_FAILED", "sensitive fields must be classified before contract publication");
  }
  return { contractVersion, schemaVersion, aggregateTypes, compatibility, sensitiveFieldsClassified };
}

function identityPolicy(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const policyVersion = requiredString(input, "policyVersion");
  const actorTypes = stringList(input, "actorTypes", { min: 1, unique: true });
  const decisionModel = assertKnownState(requiredString(input, "decisionModel"), ["rbac_abac"] as const, "decisionModel");
  const databaseIsolation = requiredBoolean(input, "databaseIsolation");
  if (!databaseIsolation) {
    throw new DomainError("TENANT_SCOPE_MISMATCH", "database tenant isolation must be enabled");
  }
  return { policyVersion, actorTypes, decisionModel, databaseIsolation };
}

function consentRecord(input: JsonObject): JsonObject {
  const participantId = typeof input.participantId === "string"
    ? requiredString(input, "participantId")
    : requiredString(input, "subjectId");
  const purpose = requiredString(input, "purpose");
  const policyVersion = requiredString(input, "policyVersion");
  const evidenceHash = requiredString(input, "evidenceHash");
  const expiresAt = assertISODate(requiredString(input, "expiresAt"), "expiresAt");
  const status = assertKnownState(requiredString(input, "status"), ["active"] as const, "status");
  const isMinor = requiredBoolean(input, "isMinor");
  const guardianConsentId = typeof input.guardianConsentId === "string" ? input.guardianConsentId : undefined;
  if (isMinor && (!guardianConsentId || status !== "active")) {
    throw new DomainError("GUARDIAN_VERIFICATION_REQUIRED", "active, independent guardian consent is required");
  }
  if (new Date(expiresAt).getTime() <= Date.now() && status === "active") {
    throw new DomainError("CONSENT_REQUIRED", "expired consent cannot be recorded as active");
  }
  return {
    participantId,
    purpose,
    policyVersion,
    evidenceHash,
    expiresAt,
    status,
    isMinor,
    ...(guardianConsentId ? { guardianConsentId } : {}),
  };
}

function mediaLifecycle(input: JsonObject): JsonObject {
  const assetId = requiredString(input, "assetId");
  const classification = assertKnownState(
    requiredString(input, "classification"),
    ["raw", "intermediate", "derived", "share", "print", "backup"] as const,
    "classification",
  );
  const retentionDays = requiredNumber(input, "retentionDays", 0);
  const encrypted = requiredBoolean(input, "encrypted");
  const deletionTargets = stringList(input, "deletionTargets", { min: 1, unique: true });
  if (!Number.isInteger(retentionDays) || !encrypted || deletionTargets.includes("unknown")) {
    throw new DomainError("VALIDATION_FAILED", "media lifecycle requires encryption and a known integer retention policy");
  }
  return { assetId, classification, retentionDays, encrypted, deletionTargets, lifecycleState: "scheduled" };
}

function providerRoute(input: JsonObject): JsonObject {
  const providerId = requiredString(input, "providerId");
  const modelVersion = requiredString(input, "modelVersion");
  const region = requiredString(input, "region");
  const purpose = requiredString(input, "purpose");
  const health = assertKnownState(requiredString(input, "health"), ["healthy", "degraded", "disabled"] as const, "health");
  const retentionPolicy = assertKnownState(
    requiredString(input, "retentionPolicy"),
    ["zero_retention", "contracted_retention"] as const,
    "retentionPolicy",
  );
  const allowedForMinors = requiredBoolean(input, "allowedForMinors");
  const isMinor = requiredBoolean(input, "isMinor");
  if (health !== "healthy" || (isMinor && !allowedForMinors)) {
    throw new DomainError("VALIDATION_FAILED", "provider is not eligible for this route");
  }
  return { providerId, modelVersion, region, purpose, health, retentionPolicy, allowedForMinors, isMinor };
}

function durableWorkflow(input: JsonObject): JsonObject {
  const workflowId = requiredString(input, "workflowId");
  const workflowType = requiredString(input, "workflowType");
  const state = assertKnownState(requiredString(input, "state"), ["planned", "running", "compensating", "completed", "failed"] as const, "state");
  const activities = stringList(input, "activities", { min: 1, unique: true });
  const compensationPlan = requireNonEmptyObject(input, "compensationPlan");
  const retryLimit = requiredNumber(input, "retryLimit", 0);
  if (!Number.isSafeInteger(retryLimit) || retryLimit > 10 || state === "completed") {
    throw new DomainError("VALIDATION_FAILED", "new workflow intent requires a bounded retry policy and cannot start completed");
  }
  return { workflowId, workflowType, state, activities, compensationPlan, retryLimit };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B01", SKILL, "configureArchitecture", architecture, {
    mode: "resource", collection: "platform.architectures", recordIdField: "repositoryId",
  }),
  defineCapability("B02", SKILL, "publishContracts", contracts, {
    mode: "resource", collection: "platform.contract-releases", recordIdField: "contractVersion",
  }),
  defineCapability("B03", SKILL, "publishIdentityPolicy", identityPolicy, {
    mode: "resource", collection: "identity.policies", recordIdField: "policyVersion",
  }),
  defineCapability("B04", SKILL, "recordConsent", consentRecord, { mode: "consent-write" }),
  defineCapability("B05", SKILL, "scheduleMediaLifecycle", mediaLifecycle, {
    permission: "media.lifecycle.manage", mode: "external-command", collection: "media.lifecycle-commands", recordIdField: "assetId",
  }),
  defineCapability("B12", SKILL, "registerProviderRoute", providerRoute, {
    permission: "provider.route.manage", mode: "resource", collection: "providers.routes", recordIdField: "providerId",
  }),
  defineCapability("B13", SKILL, "startDurableWorkflow", durableWorkflow, {
    permission: "workflow.start", mode: "external-command", collection: "workflows.start-commands", recordIdField: "workflowId",
  }),
];

export function registerBootstrappingLifeTimeMachinePlatformCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const bootstrappingLifeTimeMachinePlatformCoverage = definitions.length;
