import { DomainError } from "@ltm/core";
import type { CapabilityRegistry, JsonObject } from "../registry.js";
import { optionalString, requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertISODate,
  assertKnownState,
  defineCapability,
  participantConsent,
  registerDefinitions,
  requireInteger,
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-marketing-content-platform";

function safeHttpsUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError("VALIDATION_FAILED", `${field} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new DomainError("VALIDATION_FAILED", `${field} must use HTTPS without embedded credentials`);
  }
  return url.toString();
}

function landingPage(input: JsonObject): JsonObject {
  const pageId = requiredString(input, "pageId");
  const version = requiredString(input, "version");
  const status = assertKnownState(requiredString(input, "status"), ["draft", "preview", "published", "rolled_back"] as const, "status");
  const canonicalUrl = safeHttpsUrl(requiredString(input, "canonicalUrl"), "canonicalUrl");
  const components = stringList(input, "components", { min: 1, unique: true });
  const customScripts = stringList(input, "customScripts", { unique: true });
  const consentBeforeTracking = requireTrue(requiredBoolean(input, "consentBeforeTracking"), "consentBeforeTracking");
  const sanitized = requireTrue(requiredBoolean(input, "sanitized"), "sanitized");
  const experimentId = optionalString(input, "experimentId");
  if (customScripts.length > 0) throw new DomainError("VALIDATION_FAILED", "landing pages cannot inject custom scripts");
  if (experimentId && !requiredBoolean(input, "experimentGuardrailsApproved")) {
    throw new DomainError("VALIDATION_FAILED", "experiment pages require approved guardrails");
  }
  return {
    pageId,
    version,
    status,
    canonicalUrl,
    components,
    customScripts,
    consentBeforeTracking,
    sanitized,
    ...(experimentId ? { experimentId, experimentGuardrailsApproved: true } : {}),
  };
}

function editorialWorkflow(input: JsonObject): JsonObject {
  const contentId = requiredString(input, "contentId");
  const contentType = assertKnownState(
    requiredString(input, "contentType"),
    ["article", "faq", "case_study", "policy", "announcement", "media", "help"] as const,
    "contentType",
  );
  const fromState = assertKnownState(
    requiredString(input, "fromState"),
    ["draft", "review", "approved", "scheduled", "published", "archived"] as const,
    "fromState",
  );
  const toState = assertKnownState(
    requiredString(input, "toState"),
    ["review", "approved", "scheduled", "published", "archived", "withdrawn"] as const,
    "toState",
  );
  const version = requiredString(input, "version");
  const requiredLocales = stringList(input, "requiredLocales", { min: 1, unique: true });
  const completedLocales = stringList(input, "completedLocales", { min: 1, unique: true });
  const approvals = stringList(input, "approvals", { min: 1, unique: true });
  const mediaReferencesValid = requireTrue(requiredBoolean(input, "mediaReferencesValid"), "mediaReferencesValid");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  const transitions: Readonly<Record<string, readonly string[]>> = {
    draft: ["review"],
    review: ["approved", "withdrawn"],
    approved: ["scheduled", "published", "withdrawn"],
    scheduled: ["published", "withdrawn"],
    published: ["archived", "withdrawn"],
    archived: ["review"],
  };
  if (!transitions[fromState]?.includes(toState)) throw new DomainError("VALIDATION_FAILED", "illegal editorial state transition");
  if ((toState === "published" || contentType === "policy") && requiredLocales.some((locale) => !completedLocales.includes(locale))) {
    throw new DomainError("VALIDATION_FAILED", "mandatory translations must be complete before publication");
  }
  if (contentType === "policy" && !approvals.includes("legal")) {
    throw new DomainError("VALIDATION_FAILED", "policy content requires legal approval evidence");
  }
  return {
    contentId,
    contentType,
    fromState,
    toState,
    version,
    requiredLocales,
    completedLocales,
    approvals,
    mediaReferencesValid,
    externalEvidenceIds,
  };
}

function consentPolicy(input: JsonObject): JsonObject {
  const policyId = requiredString(input, "policyId");
  const region = requiredString(input, "region");
  const version = requiredString(input, "version");
  const purposes = stringList(input, "purposes", { min: 1, unique: true });
  const enabledTags = stringList(input, "enabledTags", { unique: true });
  const grantedPurposes = stringList(input, "grantedPurposes", { unique: true });
  const withdrawalPropagation = requireTrue(requiredBoolean(input, "withdrawalPropagation"), "withdrawalPropagation");
  const excludedFields = stringList(input, "excludedFields", { min: 4, unique: true });
  const requiredExclusions = ["raw_media", "face_features", "minor_identity", "private_dialogue"];
  if (enabledTags.some((tag) => (tag.startsWith("analytics:") && !grantedPurposes.includes("analytics")) || (tag.startsWith("ads:") && !grantedPurposes.includes("advertising")))) {
    throw new DomainError("CONSENT_REQUIRED", "a third-party tag cannot load before matching consent");
  }
  if (requiredExclusions.some((field) => !excludedFields.includes(field))) {
    throw new DomainError("VALIDATION_FAILED", "attribution policy does not exclude all sensitive fields");
  }
  return { policyId, region, version, purposes, enabledTags, grantedPurposes, withdrawalPropagation, excludedFields };
}

function campaign(input: JsonObject): JsonObject {
  const campaignId = requiredString(input, "campaignId");
  const state = assertKnownState(requiredString(input, "state"), ["draft", "active", "paused", "terminated"] as const, "state");
  const destinationUrl = safeHttpsUrl(requiredString(input, "destinationUrl"), "destinationUrl");
  const channels = stringList(input, "channels", { min: 1, unique: true });
  const attributionWindowDays = requireInteger(requiredNumber(input, "attributionWindowDays", 1), "attributionWindowDays", 1, 180);
  const tokenEntropyBits = requireInteger(requiredNumber(input, "tokenEntropyBits", 128), "tokenEntropyBits", 128, 512);
  const consentEnforced = requireTrue(requiredBoolean(input, "consentEnforced"), "consentEnforced");
  const experimentId = optionalString(input, "experimentId");
  const parsed = new URL(destinationUrl);
  for (const forbidden of ["face", "health", "minor", "child", "payment", "photo"]) {
    if ([...parsed.searchParams.keys()].some((key) => key.toLowerCase().includes(forbidden))) {
      throw new DomainError("VALIDATION_FAILED", "campaign URL contains a forbidden sensitive parameter");
    }
  }
  if (experimentId && !requiredBoolean(input, "experimentGuardrailsApproved")) {
    throw new DomainError("VALIDATION_FAILED", "campaign experiment guardrails are required");
  }
  return {
    campaignId,
    state,
    destinationUrl,
    channels,
    attributionWindowDays,
    tokenEntropyBits,
    consentEnforced,
    ...(experimentId ? { experimentId, experimentGuardrailsApproved: true } : {}),
  };
}

function shareAsset(input: JsonObject): JsonObject {
  const shareId = requiredString(input, "shareId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const purpose = requiredString(input, "purpose");
  const assetKind = assertKnownState(requiredString(input, "assetKind"), ["card", "video_cover", "og_image", "qr"] as const, "assetKind");
  const containsMinor = requiredBoolean(input, "containsMinor");
  const guardianVerified = requiredBoolean(input, "guardianVerified");
  const aiLabelPresent = requireTrue(requiredBoolean(input, "aiLabelPresent"), "aiLabelPresent");
  const tokenTtlSeconds = requireInteger(requiredNumber(input, "tokenTtlSeconds", 1), "tokenTtlSeconds", 1, 86_400);
  const sourceMediaResolution = assertKnownState(requiredString(input, "sourceMediaResolution"), ["derived", "preview"] as const, "sourceMediaResolution");
  if (containsMinor && !guardianVerified) {
    throw new DomainError("GUARDIAN_VERIFICATION_REQUIRED", "minor sharing requires verified guardian authorization");
  }
  return {
    shareId,
    participantIds,
    purpose,
    assetKind,
    containsMinor,
    guardianVerified,
    aiLabelPresent,
    tokenTtlSeconds,
    sourceMediaResolution,
  };
}

function trustDocument(input: JsonObject): JsonObject {
  const documentId = requiredString(input, "documentId");
  const documentType = assertKnownState(
    requiredString(input, "documentType"),
    ["brand_asset", "trust_center", "status_page", "dpa", "security_package", "rfp", "sales_material"] as const,
    "documentType",
  );
  const implementationVersion = requiredString(input, "implementationVersion");
  const expiresAt = assertISODate(requiredString(input, "expiresAt"), "expiresAt");
  const approvals = stringList(input, "approvals", { min: 1, unique: true });
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  const factualClaimsVerified = requireTrue(requiredBoolean(input, "factualClaimsVerified"), "factualClaimsVerified");
  if (Date.parse(expiresAt) <= Date.now()) throw new DomainError("VALIDATION_FAILED", "trust document evidence is expired");
  if (["dpa", "security_package", "rfp"].includes(documentType) && (!approvals.includes("legal") || !approvals.includes("security"))) {
    throw new DomainError("VALIDATION_FAILED", "regulated trust documents require legal and security approval");
  }
  return { documentId, documentType, implementationVersion, expiresAt, approvals, externalEvidenceIds, factualClaimsVerified };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B57", SKILL, "publishLandingPage", landingPage, { permission: "marketing.page.publish" }),
  defineCapability("B58", SKILL, "transitionEditorialContent", editorialWorkflow, {
    permission: "content.workflow.manage",
    requiresExternalEvidence: true,
  }),
  defineCapability("B59", SKILL, "publishConsentPolicy", consentPolicy, { permission: "privacy.consent-policy.manage" }),
  defineCapability("B60", SKILL, "configureCampaign", campaign, { permission: "marketing.campaign.manage" }),
  defineCapability("B61", SKILL, "createGovernedShareAsset", shareAsset, {
    permission: "share.asset.create",
    consent: participantConsent(),
  }),
  defineCapability("B62", SKILL, "publishTrustDocument", trustDocument, {
    permission: "trust.document.publish",
    requiresExternalEvidence: true,
  }),
];

export function registerBuildingMarketingContentPlatformCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingMarketingContentPlatformCoverage = definitions.length;
