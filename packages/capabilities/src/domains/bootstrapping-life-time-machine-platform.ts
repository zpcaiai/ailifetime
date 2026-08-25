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

function requirePlatformControlActor(invocation: CapabilityInvocation, batchId: "B01" | "B02"): void {
  if (!invocation.actor.roles.some((role) => role === "platform_admin" || role === "service_account")) {
    throw new DomainError("AUTH_FORBIDDEN", `${batchId} is restricted to a platform administrator or service identity`);
  }
}

function architecture(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  requirePlatformControlActor(invocation, "B01");
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

function contracts(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  requirePlatformControlActor(invocation, "B02");
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

function consentPolicyCatalogPublication(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  if (!invocation.actor.roles.some((role) => role === "platform_admin" || role === "service_account")) {
    throw new DomainError("AUTH_FORBIDDEN", "B03 is restricted to a platform administrator or service identity");
  }
  const unsupported = Object.keys(input).filter((field) => field !== "tenantId");
  if (unsupported.length > 0) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "B03 accepts no client-authored policy; it publishes runtime-verified catalog metadata",
      { details: { fields: unsupported.sort() } },
    );
  }
  return {};
}

function consentRecord(input: JsonObject): JsonObject {
  const participantId = typeof input.participantId === "string"
    ? requiredString(input, "participantId")
    : requiredString(input, "subjectId");
  const purpose = requiredString(input, "purpose");
  const policyVersion = requiredString(input, "policyVersion");
  const evidenceHash = input.evidenceHash === undefined ? undefined : requiredString(input, "evidenceHash");
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null
    ? undefined
    : assertISODate(requiredString(input, "expiresAt"), "expiresAt");
  const status = assertKnownState(requiredString(input, "status"), ["active"] as const, "status");
  const grantorCapacity = assertKnownState(
    requiredString(input, "grantorCapacity"),
    ["self", "guardian", "authorized_agent"] as const,
    "grantorCapacity",
  );
  const scopeInput = requireNonEmptyObject(input, "scope");
  const scope = {
    resource: requiredString(scopeInput, "resource"),
    actions: stringList(scopeInput, "actions", { min: 1, unique: true }),
  };
  if (Object.prototype.hasOwnProperty.call(input, "guardianConsentId") ||
      Object.prototype.hasOwnProperty.call(input, "isMinor")) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "guardian and minor authority are derived from the durable participant registry, not client assertions",
    );
  }
  if (expiresAt !== undefined && new Date(expiresAt).getTime() <= Date.now() && status === "active") {
    throw new DomainError("CONSENT_REQUIRED", "expired consent cannot be recorded as active");
  }
  return {
    participantId,
    purpose,
    policyVersion,
    ...(evidenceHash === undefined ? {} : { evidenceHash }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    status,
    grantorCapacity,
    scope,
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
    permission: "platform.architecture.manage",
    mode: "resource", collection: "platform.architectures", recordIdField: "repositoryId",
  }),
  defineCapability("B02", SKILL, "publishContracts", contracts, {
    permission: "platform.contract.publish",
    mode: "resource", collection: "platform.contract-releases", recordIdField: "contractVersion",
  }),
  defineCapability("B03", SKILL, "publishConsentPolicyCatalog", consentPolicyCatalogPublication, {
    permission: "consent-policy:publish",
    mode: "resource",
    collection: "identity.consent-policy-catalogs",
    recordIdField: "catalogSha256",
    serverConsentPolicyMetadata: true,
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
