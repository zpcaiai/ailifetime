import { DomainError } from "@ltm/core";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { objectValue, requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertActorTenant,
  assertISODate,
  assertKnownState,
  defineCapability,
  registerDefinitions,
  requireInteger,
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-developer-integration-platform";

function httpsUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DomainError("VALIDATION_FAILED", `${field} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new DomainError("VALIDATION_FAILED", `${field} must be a credential-free HTTPS URL`);
  }
  return parsed.toString();
}

function developerPortal(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const portalVersion = requiredString(input, "portalVersion");
  const apiVersion = requiredString(input, "apiVersion");
  const openApiDigest = requiredString(input, "openApiDigest");
  const sandboxTenantId = requiredString(input, "sandboxTenantId");
  const callbackUrls = stringList(input, "callbackUrls", { min: 1, unique: true }).map((url) => httpsUrl(url, "callbackUrls"));
  const sampleDataSynthetic = requireTrue(requiredBoolean(input, "sampleDataSynthetic"), "sampleDataSynthetic");
  const idempotencyDocumented = requireTrue(requiredBoolean(input, "idempotencyDocumented"), "idempotencyDocumented");
  if (sandboxTenantId === invocation.actor.tenantId || callbackUrls.some((url) => /prod(?:uction)?[.-]/i.test(new URL(url).hostname))) {
    throw new DomainError("TENANT_SCOPE_MISMATCH", "sandbox must be isolated from production tenants and callbacks");
  }
  return { portalVersion, apiVersion, openApiDigest, sandboxTenantId, callbackUrls, sampleDataSynthetic, idempotencyDocumented };
}

function credentialPolicy(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const credentialId = requiredString(input, "credentialId");
  const credentialType = assertKnownState(requiredString(input, "credentialType"), ["api_key", "oauth_client", "service_account"] as const, "credentialType");
  const scopeTenantId = requiredString(input, "scopeTenantId");
  const scopes = stringList(input, "scopes", { min: 1, unique: true });
  const secretReference = requiredString(input, "secretReference");
  const expiresAt = assertISODate(requiredString(input, "expiresAt"), "expiresAt");
  const rotationOverlapMinutes = requireInteger(
    requiredNumber(input, "rotationOverlapMinutes", 0),
    "rotationOverlapMinutes",
    0,
    1_440,
  );
  const revocationCachePurged = requireTrue(requiredBoolean(input, "revocationCachePurged"), "revocationCachePurged");
  if (scopeTenantId !== invocation.actor.tenantId) throw new DomainError("TENANT_SCOPE_MISMATCH", "credential tenant scope mismatch");
  if (scopes.some((scope) => scope === "*" || scope.endsWith(":*"))) throw new DomainError("AUTH_FORBIDDEN", "wildcard credential scopes are prohibited");
  if (/BEGIN [A-Z ]+PRIVATE KEY|sk[_-][a-z0-9]{12,}|secret\s*=/i.test(secretReference)) {
    throw new DomainError("VALIDATION_FAILED", "secretReference contains secret material instead of a vault reference");
  }
  if (Date.parse(expiresAt) <= Date.now()) throw new DomainError("VALIDATION_FAILED", "credential expiry must be in the future");
  return {
    credentialId,
    credentialType,
    scopeTenantId,
    scopes,
    secretReference,
    expiresAt,
    rotationOverlapMinutes,
    revocationCachePurged,
  };
}

function sdkRelease(input: JsonObject): JsonObject {
  const sdkId = requiredString(input, "sdkId");
  const language = assertKnownState(requiredString(input, "language"), ["typescript", "java", "python", "swift", "kotlin"] as const, "language");
  const version = requiredString(input, "version");
  const contractVersion = requiredString(input, "contractVersion");
  const artifactDigest = requiredString(input, "artifactDigest");
  const compatibilityTests = stringList(input, "compatibilityTests", { min: 2, unique: true });
  const retryIdempotencyMiddleware = requireTrue(requiredBoolean(input, "retryIdempotencyMiddleware"), "retryIdempotencyMiddleware");
  const examplesRedactSecrets = requireTrue(requiredBoolean(input, "examplesRedactSecrets"), "examplesRedactSecrets");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new DomainError("VALIDATION_FAILED", "SDK version must be semantic");
  return {
    sdkId,
    language,
    version,
    contractVersion,
    artifactDigest,
    compatibilityTests,
    retryIdempotencyMiddleware,
    examplesRedactSecrets,
  };
}

function webhook(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const endpointId = requiredString(input, "endpointId");
  const endpointUrl = httpsUrl(requiredString(input, "endpointUrl"), "endpointUrl");
  const eventTypes = stringList(input, "eventTypes", { min: 1, unique: true });
  const signatureAlgorithm = assertKnownState(requiredString(input, "signatureAlgorithm"), ["hmac-sha256", "ed25519"] as const, "signatureAlgorithm");
  const signatureToleranceSeconds = requireInteger(
    requiredNumber(input, "signatureToleranceSeconds", 1),
    "signatureToleranceSeconds",
    1,
    300,
  );
  const replayEventId = requiredString(input, "replayEventId");
  const replayReason = requiredString(input, "replayReason");
  const consumerIdempotencyVerified = requireTrue(requiredBoolean(input, "consumerIdempotencyVerified"), "consumerIdempotencyVerified");
  const tenantActive = requireTrue(requiredBoolean(input, "tenantActive"), "tenantActive");
  return {
    endpointId,
    endpointUrl,
    eventTypes,
    signatureAlgorithm,
    signatureToleranceSeconds,
    replayEventId,
    replayReason,
    consumerIdempotencyVerified,
    tenantActive,
  };
}

function connector(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const connectorId = requiredString(input, "connectorId");
  const publisherId = requiredString(input, "publisherId");
  const version = requiredString(input, "version");
  const requestedScopes = stringList(input, "requestedScopes", { min: 1, unique: true });
  const previousScopes = stringList(input, "previousScopes", { unique: true });
  const dataClasses = stringList(input, "dataClasses", { min: 1, unique: true });
  const status = assertKnownState(requiredString(input, "status"), ["review", "approved", "published", "disabled"] as const, "status");
  const supplyChainScanPassed = requireTrue(requiredBoolean(input, "supplyChainScanPassed"), "supplyChainScanPassed");
  const credentialsTenantIsolated = requireTrue(requiredBoolean(input, "credentialsTenantIsolated"), "credentialsTenantIsolated");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  const expanded = requestedScopes.some((scope) => !previousScopes.includes(scope));
  if (expanded && typeof input.scopeExpansionApprovalId !== "string") {
    throw new DomainError("AUTH_FORBIDDEN", "connector scope expansion requires explicit approval");
  }
  if (dataClasses.some((value) => ["raw_media", "face_features", "minor_identity", "private_dialogue"].includes(value))) {
    throw new DomainError("AUTH_FORBIDDEN", "connector requests a prohibited default data class");
  }
  return {
    connectorId,
    publisherId,
    version,
    requestedScopes,
    previousScopes,
    dataClasses,
    status,
    supplyChainScanPassed,
    credentialsTenantIsolated,
    externalEvidenceIds,
    ...(typeof input.scopeExpansionApprovalId === "string" ? { scopeExpansionApprovalId: input.scopeExpansionApprovalId } : {}),
  };
}

function businessAdapter(input: JsonObject): JsonObject {
  const adapterId = requiredString(input, "adapterId");
  const systemType = assertKnownState(requiredString(input, "systemType"), ["crm", "cdp", "marketing", "support", "accounting"] as const, "systemType");
  const fieldMap = objectValue(input, "fieldMap");
  const sourceOfTruth = objectValue(input, "sourceOfTruth");
  const exportedDataClasses = stringList(input, "exportedDataClasses", { min: 1, unique: true });
  const contactConsentVerified = requiredBoolean(input, "contactConsentVerified");
  const deletionPropagated = requireTrue(requiredBoolean(input, "deletionPropagated"), "deletionPropagated");
  const controlTotal = requireInteger(requiredNumber(input, "controlTotal", 0), "controlTotal", 0);
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (exportedDataClasses.some((value) => ["raw_media", "face_features", "minor_identity", "private_dialogue"].includes(value))) {
    throw new DomainError("AUTH_FORBIDDEN", "business adapters cannot export sensitive media/identity data by default");
  }
  if (["crm", "cdp", "marketing"].includes(systemType) && !contactConsentVerified) {
    throw new DomainError("CONSENT_REQUIRED", "contact export requires explicit contact consent");
  }
  return {
    adapterId,
    systemType,
    fieldMap,
    sourceOfTruth,
    exportedDataClasses,
    contactConsentVerified,
    deletionPropagated,
    controlTotal,
    externalEvidenceIds,
  };
}

function partnerCertification(input: JsonObject): JsonObject {
  const certificationId = requiredString(input, "certificationId");
  const applicationId = requiredString(input, "applicationId");
  const environment = assertKnownState(requiredString(input, "environment"), ["sandbox"] as const, "environment");
  const apiVersion = requiredString(input, "apiVersion");
  const scenarios = stringList(input, "scenarios", { min: 5, unique: true });
  const callbackUrl = httpsUrl(requiredString(input, "callbackUrl"), "callbackUrl");
  const criticalFailures = requireInteger(requiredNumber(input, "criticalFailures", 0), "criticalFailures", 0);
  const syntheticDataOnly = requireTrue(requiredBoolean(input, "syntheticDataOnly"), "syntheticDataOnly");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 2, unique: true });
  for (const scenario of ["duplicate", "out_of_order", "timeout", "revocation", "tenant_isolation"]) {
    if (!scenarios.includes(scenario)) throw new DomainError("VALIDATION_FAILED", `certification scenarios must include ${scenario}`);
  }
  if (criticalFailures !== 0 || /prod(?:uction)?[.-]/i.test(new URL(callbackUrl).hostname)) {
    throw new DomainError("VALIDATION_FAILED", "critical failures or production callback block certification");
  }
  return {
    certificationId,
    applicationId,
    environment,
    apiVersion,
    scenarios,
    callbackUrl,
    criticalFailures,
    syntheticDataOnly,
    externalEvidenceIds,
  };
}

function apiLifecycle(input: JsonObject): JsonObject {
  const changeId = requiredString(input, "changeId");
  const surface = assertKnownState(requiredString(input, "surface"), ["api", "event", "sdk", "connector"] as const, "surface");
  const currentVersion = requiredString(input, "currentVersion");
  const targetVersion = requiredString(input, "targetVersion");
  const compatibility = assertKnownState(requiredString(input, "compatibility"), ["additive", "breaking", "security_exception"] as const, "compatibility");
  const deprecationAt = assertISODate(requiredString(input, "deprecationAt"), "deprecationAt");
  const sunsetAt = assertISODate(requiredString(input, "sunsetAt"), "sunsetAt");
  const affectedPartners = stringList(input, "affectedPartners", { unique: true });
  const migrationArtifacts = stringList(input, "migrationArtifacts", { min: 2, unique: true });
  const contractTestPassed = requireTrue(requiredBoolean(input, "contractTestPassed"), "contractTestPassed");
  if (Date.parse(deprecationAt) >= Date.parse(sunsetAt)) throw new DomainError("VALIDATION_FAILED", "deprecation must precede sunset");
  if (compatibility === "breaking" && affectedPartners.length > 0 && !requiredBoolean(input, "partnerAcknowledgementsRecorded")) {
    throw new DomainError("VALIDATION_FAILED", "breaking changes require partner acknowledgement or migration plans");
  }
  return {
    changeId,
    surface,
    currentVersion,
    targetVersion,
    compatibility,
    deprecationAt,
    sunsetAt,
    affectedPartners,
    migrationArtifacts,
    contractTestPassed,
    partnerAcknowledgementsRecorded: input.partnerAcknowledgementsRecorded === true,
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B103", SKILL, "publishDeveloperPortal", developerPortal, { permission: "developer.portal.publish" }),
  defineCapability("B104", SKILL, "registerMachineCredential", credentialPolicy, { permission: "credential.machine.manage" }),
  defineCapability("B105", SKILL, "publishSdkRelease", sdkRelease, { permission: "sdk.release.publish" }),
  defineCapability("B106", SKILL, "registerWebhookEndpoint", webhook, { permission: "webhook.endpoint.manage" }),
  defineCapability("B107", SKILL, "publishConnector", connector, {
    permission: "connector.marketplace.publish",
    requiresExternalEvidence: true,
  }),
  defineCapability("B108", SKILL, "registerBusinessAdapter", businessAdapter, {
    permission: "connector.adapter.manage",
    requiresExternalEvidence: true,
  }),
  defineCapability("B109", SKILL, "certifyPartnerIntegration", partnerCertification, {
    permission: "partner.integration.certify",
    requiresExternalEvidence: true,
  }),
  defineCapability("B110", SKILL, "recordApiLifecycleChange", apiLifecycle, { permission: "api.lifecycle.manage" }),
];

export function registerBuildingDeveloperIntegrationPlatformCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingDeveloperIntegrationPlatformCoverage = definitions.length;
