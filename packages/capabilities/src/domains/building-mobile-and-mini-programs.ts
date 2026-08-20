import { DomainError } from "@ltm/core";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { objectValue, requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertActorTenant,
  assertKnownState,
  defineCapability,
  participantConsent,
  registerDefinitions,
  requireInteger,
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-mobile-and-mini-programs";

function digest(value: string, field: string): string {
  if (!/^[a-f0-9]{32,128}$/i.test(value)) throw new DomainError("VALIDATION_FAILED", `${field} must be a digest`);
  return value;
}

function money(input: JsonObject): { amountMinor: number; currency: string } {
  const amountMinor = requireInteger(requiredNumber(input, "amountMinor", 1), "amountMinor", 1);
  const currency = requiredString(input, "currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new DomainError("VALIDATION_FAILED", "currency must be an ISO-4217 code");
  return { amountMinor, currency };
}

function mobileManifest(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const appId = requiredString(input, "appId");
  const platform = assertKnownState(requiredString(input, "platform"), ["ios", "android"] as const, "platform");
  const manifestVersion = requiredString(input, "manifestVersion");
  const minimumClientVersion = requiredString(input, "minimumClientVersion");
  const allowedApiVersions = stringList(input, "allowedApiVersions", { min: 1, unique: true });
  const secureTokenStorage = requireTrue(requiredBoolean(input, "secureTokenStorage"), "secureTokenStorage");
  const failClosedUnknownVersion = requireTrue(requiredBoolean(input, "failClosedUnknownVersion"), "failClosedUnknownVersion");
  const offlineDataClasses = stringList(input, "offlineDataClasses", { unique: true });
  if (offlineDataClasses.some((entry) => ["raw_media", "private_dialogue", "payment_credential"].includes(entry))) {
    throw new DomainError("VALIDATION_FAILED", "offline cache includes a prohibited data class");
  }
  return {
    appId,
    platform,
    manifestVersion,
    minimumClientVersion,
    allowedApiVersions,
    secureTokenStorage,
    failClosedUnknownVersion,
    offlineDataClasses,
  };
}

function uploadSession(input: JsonObject): JsonObject {
  const uploadId = requiredString(input, "uploadId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const purpose = requiredString(input, "purpose");
  const mediaType = assertKnownState(requiredString(input, "mediaType"), ["image/heic", "image/jpeg", "image/png"] as const, "mediaType");
  const checksum = digest(requiredString(input, "checksum"), "checksum");
  const chunkCount = requireInteger(requiredNumber(input, "chunkCount", 1), "chunkCount", 1, 100_000);
  const exifRemoved = requireTrue(requiredBoolean(input, "exifRemoved"), "exifRemoved");
  const serverRevalidation = requireTrue(requiredBoolean(input, "serverRevalidation"), "serverRevalidation");
  const idempotentAssembly = requireTrue(requiredBoolean(input, "idempotentAssembly"), "idempotentAssembly");
  return { uploadId, participantIds, purpose, mediaType, checksum, chunkCount, exifRemoved, serverRevalidation, idempotentAssembly };
}

function mobileGeneration(input: JsonObject): JsonObject {
  const projectId = requiredString(input, "projectId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const purpose = requiredString(input, "purpose");
  const action = assertKnownState(requiredString(input, "action"), ["edit", "generate", "export", "share", "delete"] as const, "action");
  const authorizationState = assertKnownState(requiredString(input, "authorizationState"), ["active"] as const, "authorizationState");
  const progressSource = assertKnownState(requiredString(input, "progressSource"), ["server", "realtime", "polling"] as const, "progressSource");
  const conflictStrategy = assertKnownState(requiredString(input, "conflictStrategy"), ["version_merge", "user_review"] as const, "conflictStrategy");
  const aiLabelPresent = requiredBoolean(input, "aiLabelPresent");
  if ((action === "export" || action === "share") && !aiLabelPresent) {
    throw new DomainError("VALIDATION_FAILED", "exported or shared media must retain the AI label");
  }
  return { projectId, participantIds, purpose, action, authorizationState, progressSource, conflictStrategy, aiLabelPresent };
}

function storeTransaction(input: JsonObject): JsonObject {
  const transactionId = requiredString(input, "transactionId");
  const provider = assertKnownState(requiredString(input, "provider"), ["app_store", "google_play"] as const, "provider");
  const productId = requiredString(input, "productId");
  const accountId = requiredString(input, "accountId");
  const receiptHash = digest(requiredString(input, "receiptHash"), "receiptHash");
  const { amountMinor, currency } = money(input);
  const serverSignatureVerified = requireTrue(requiredBoolean(input, "serverSignatureVerified"), "serverSignatureVerified");
  const entitlementFromServer = requireTrue(requiredBoolean(input, "entitlementFromServer"), "entitlementFromServer");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  return {
    transactionId,
    provider,
    productId,
    accountId,
    receiptHash,
    amountMinor,
    currency,
    serverSignatureVerified,
    entitlementFromServer,
    externalEvidenceIds,
  };
}

function mobileNotification(input: JsonObject): JsonObject {
  const notificationId = requiredString(input, "notificationId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const purpose = requiredString(input, "purpose");
  const deviceId = requiredString(input, "deviceId");
  const deviceOwnerActorId = requiredString(input, "deviceOwnerActorId");
  const navigationRef = requiredString(input, "navigationRef");
  const payload = objectValue(input, "payload");
  const authorizationRechecked = requireTrue(requiredBoolean(input, "authorizationRechecked"), "authorizationRechecked");
  const widgetDataMinimal = requireTrue(requiredBoolean(input, "widgetDataMinimal"), "widgetDataMinimal");
  if (deviceOwnerActorId !== input.ownerActorId && typeof input.ownerActorId === "string") {
    throw new DomainError("TENANT_SCOPE_MISMATCH", "device owner does not match the notification owner");
  }
  const serialized = JSON.stringify(payload).toLowerCase();
  if (["face", "child_name", "raw_media", "private_dialogue", "full_order"].some((field) => serialized.includes(field))) {
    throw new DomainError("VALIDATION_FAILED", "notification payload contains sensitive lock-screen data");
  }
  return {
    notificationId,
    participantIds,
    purpose,
    deviceId,
    deviceOwnerActorId,
    navigationRef,
    payload,
    authorizationRechecked,
    widgetDataMinimal,
  };
}

function mobileAssurance(input: JsonObject): JsonObject {
  const buildId = requiredString(input, "buildId");
  const privacyManifestHash = digest(requiredString(input, "privacyManifestHash"), "privacyManifestHash");
  const testDevices = stringList(input, "testDevices", { min: 2, unique: true });
  const testSuites = stringList(input, "testSuites", { min: 4, unique: true });
  const prohibitedSdkFlows = stringList(input, "prohibitedSdkFlows", { unique: true });
  const networkCaptureReconciled = requireTrue(requiredBoolean(input, "networkCaptureReconciled"), "networkCaptureReconciled");
  const productionDebugDisabled = requireTrue(requiredBoolean(input, "productionDebugDisabled"), "productionDebugDisabled");
  for (const suite of ["security", "privacy", "performance", "accessibility"]) {
    if (!testSuites.includes(suite)) throw new DomainError("VALIDATION_FAILED", `testSuites must include ${suite}`);
  }
  if (prohibitedSdkFlows.length > 0) throw new DomainError("VALIDATION_FAILED", "unapproved SDK data flows block release");
  return {
    buildId,
    privacyManifestHash,
    testDevices,
    testSuites,
    prohibitedSdkFlows,
    networkCaptureReconciled,
    productionDebugDisabled,
  };
}

function mobileRelease(input: JsonObject): JsonObject {
  const releaseId = requiredString(input, "releaseId");
  const platform = assertKnownState(requiredString(input, "platform"), ["ios", "android"] as const, "platform");
  const artifactDigest = digest(requiredString(input, "artifactDigest"), "artifactDigest");
  const signingKeyReference = requiredString(input, "signingKeyReference");
  const rolloutPercent = requiredNumber(input, "rolloutPercent", 0);
  const criticalFindings = requireInteger(requiredNumber(input, "criticalFindings", 0), "criticalFindings", 0);
  const gates = stringList(input, "passedGates", { min: 6, unique: true });
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (rolloutPercent > 100 || criticalFindings !== 0) throw new DomainError("VALIDATION_FAILED", "mobile release gate is not satisfied");
  if (/private[-_ ]?key|BEGIN [A-Z ]+PRIVATE KEY/i.test(signingKeyReference)) {
    throw new DomainError("VALIDATION_FAILED", "signingKeyReference must not contain secret material");
  }
  for (const gate of ["unit", "device", "security", "privacy", "iap", "cold_start"]) {
    if (!gates.includes(gate)) throw new DomainError("VALIDATION_FAILED", `passedGates must include ${gate}`);
  }
  return { releaseId, platform, artifactDigest, signingKeyReference, rolloutPercent, criticalFindings, passedGates: gates, externalEvidenceIds };
}

function miniProgramJourney(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const sessionId = requiredString(input, "sessionId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const purpose = requiredString(input, "purpose");
  const identityBinding = assertKnownState(requiredString(input, "identityBinding"), ["provider_subject"] as const, "identityBinding");
  const cacheNamespace = requiredString(input, "cacheNamespace");
  const mediaUrlTtlSeconds = requireInteger(requiredNumber(input, "mediaUrlTtlSeconds", 1), "mediaUrlTtlSeconds", 1, 900);
  const cacheClearedOnHide = requireTrue(requiredBoolean(input, "cacheClearedOnHide"), "cacheClearedOnHide");
  const serverAuthorization = requireTrue(requiredBoolean(input, "serverAuthorization"), "serverAuthorization");
  return { sessionId, participantIds, purpose, identityBinding, cacheNamespace, mediaUrlTtlSeconds, cacheClearedOnHide, serverAuthorization };
}

function wechatCommercialAction(input: JsonObject): JsonObject {
  const paymentId = requiredString(input, "paymentId");
  const providerEventId = requiredString(input, "providerEventId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const purpose = requiredString(input, "purpose");
  const { amountMinor, currency } = money(input);
  const serverSignatureVerified = requireTrue(requiredBoolean(input, "serverSignatureVerified"), "serverSignatureVerified");
  const messageAuthorizationCount = requireInteger(
    requiredNumber(input, "messageAuthorizationCount", 0),
    "messageAuthorizationCount",
    0,
    100,
  );
  const shareReauthorization = requireTrue(requiredBoolean(input, "shareReauthorization"), "shareReauthorization");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (currency !== "CNY") throw new DomainError("VALIDATION_FAILED", "WeChat payment records must use CNY");
  return {
    paymentId,
    providerEventId,
    participantIds,
    purpose,
    amountMinor,
    currency,
    serverSignatureVerified,
    messageAuthorizationCount,
    shareReauthorization,
    externalEvidenceIds,
  };
}

function miniProgramRelease(input: JsonObject): JsonObject {
  const releaseId = requiredString(input, "releaseId");
  const subjectId = requiredString(input, "subjectId");
  const privacyDeclarationHash = digest(requiredString(input, "privacyDeclarationHash"), "privacyDeclarationHash");
  const reviewTenantId = requiredString(input, "reviewTenantId");
  const isolatedReviewTenant = requireTrue(requiredBoolean(input, "isolatedReviewTenant"), "isolatedReviewTenant");
  const rollbackCompatible = requireTrue(requiredBoolean(input, "rollbackCompatible"), "rollbackCompatible");
  const unresolvedReviewIssues = requireInteger(requiredNumber(input, "unresolvedReviewIssues", 0), "unresolvedReviewIssues", 0);
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 2, unique: true });
  if (unresolvedReviewIssues !== 0) throw new DomainError("VALIDATION_FAILED", "mini-program review issues must be closed");
  return {
    releaseId,
    subjectId,
    privacyDeclarationHash,
    reviewTenantId,
    isolatedReviewTenant,
    rollbackCompatible,
    unresolvedReviewIssues,
    externalEvidenceIds,
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B63", SKILL, "publishMobileManifest", mobileManifest, { permission: "mobile.manifest.publish" }),
  defineCapability("B64", SKILL, "createResumableUpload", uploadSession, {
    permission: "media.upload.create",
    consent: participantConsent(),
  }),
  defineCapability("B65", SKILL, "runMobileGenerationAction", mobileGeneration, {
    permission: "generation.mobile.execute",
    consent: participantConsent(),
  }),
  defineCapability("B66", SKILL, "verifyStoreTransaction", storeTransaction, {
    permission: "entitlement.store.verify",
    requiresExternalEvidence: true,
  }),
  defineCapability("B67", SKILL, "registerMobileNotification", mobileNotification, {
    permission: "notification.mobile.schedule",
    consent: participantConsent(),
  }),
  defineCapability("B68", SKILL, "approveMobileAssurance", mobileAssurance, { permission: "mobile.assurance.approve" }),
  defineCapability("B69", SKILL, "approveMobileStoreRelease", mobileRelease, {
    permission: "release.mobile.approve",
    requiresExternalEvidence: true,
  }),
  defineCapability("B70", SKILL, "startMiniProgramJourney", miniProgramJourney, {
    permission: "mini-program.journey.execute",
    consent: participantConsent(),
  }),
  defineCapability("B71", SKILL, "recordWechatCommercialAction", wechatCommercialAction, {
    permission: "payment.wechat.record",
    consent: participantConsent(),
    requiresExternalEvidence: true,
  }),
  defineCapability("B72", SKILL, "approveMiniProgramRelease", miniProgramRelease, {
    permission: "release.mini-program.approve",
    requiresExternalEvidence: true,
  }),
];

export function registerBuildingMobileAndMiniProgramsCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingMobileAndMiniProgramsCoverage = definitions.length;
