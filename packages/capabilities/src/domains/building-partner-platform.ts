import { DomainError } from "@ltm/core";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertActorTenant,
  assertKnownState,
  defineCapability,
  participantConsent,
  registerDefinitions,
  requireInteger,
  requireNonEmptyObject,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-partner-platform";

function configurePartnerTenant(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const partnerId = requiredString(input, "partnerId");
  const partnerTenantId = requiredString(input, "partnerTenantId");
  const region = requiredString(input, "region");
  const isolationMode = assertKnownState(requiredString(input, "isolationMode"), ["row_and_application", "dedicated"] as const, "isolationMode");
  const permittedPurposes = stringList(input, "permittedPurposes", { min: 1, unique: true });
  const status = assertKnownState(requiredString(input, "status"), ["sandbox", "pilot", "active", "suspended"] as const, "status");
  if (partnerTenantId !== invocation.actor.tenantId) throw new DomainError("TENANT_SCOPE_MISMATCH", "partner tenant must match authenticated scope");
  if (!invocation.actor.roles.some((role) => role === "partner_admin" || role === "platform_admin" || role === "service_account")) {
    throw new DomainError("AUTH_FORBIDDEN", "partner tenant configuration requires an administrative actor");
  }
  return { partnerId, partnerTenantId, region, isolationMode, permittedPurposes, status };
}

function onboardPartner(input: JsonObject): JsonObject {
  const partnerId = requiredString(input, "partnerId");
  const legalEntityId = requiredString(input, "legalEntityId");
  const contractVersion = requiredString(input, "contractVersion");
  const environment = assertKnownState(requiredString(input, "environment"), ["sandbox", "pilot", "production"] as const, "environment");
  const approvals = stringList(input, "approvals", { min: 1, unique: true });
  const dataPurposes = stringList(input, "dataPurposes", { min: 1, unique: true });
  const brandPolicy = requireNonEmptyObject(input, "brandPolicy");
  const aiLabelLocked = requiredBoolean(input, "aiLabelLocked");
  const productionApprovals = ["security", "privacy", "finance", "business"];
  if (!aiLabelLocked) throw new DomainError("VALIDATION_FAILED", "partner branding cannot override platform trust or AI labels");
  if (environment === "production" && productionApprovals.some((approval) => !approvals.includes(approval))) {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "production onboarding requires security, privacy, finance, and business approvals");
  }
  return { partnerId, legalEntityId, contractVersion, environment, approvals, dataPurposes, brandPolicy, aiLabelLocked };
}

function acceptPartnerApiRequest(input: JsonObject): JsonObject {
  const requestId = requiredString(input, "partnerRequestId");
  const clientId = requiredString(input, "clientId");
  const apiVersion = requiredString(input, "apiVersion");
  const authState = assertKnownState(requiredString(input, "authState"), ["verified", "rejected", "unknown"] as const, "authState");
  const signatureState = assertKnownState(requiredString(input, "signatureState"), ["verified", "rejected", "expired", "unknown"] as const, "signatureState");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const purpose = requiredString(input, "purpose");
  const sandbox = requiredBoolean(input, "sandbox");
  if (authState !== "verified" || signatureState !== "verified") {
    throw new DomainError("AUTH_FORBIDDEN", "partner authentication and request signature must be verified");
  }
  if (!/^v\d+$/.test(apiVersion)) throw new DomainError("VALIDATION_FAILED", "partner API version is unsupported");
  return { requestId, clientId, apiVersion, authState, signatureState, participantIds, purpose, sandbox };
}

function closePartnerSettlement(input: JsonObject): JsonObject {
  const settlementId = requiredString(input, "settlementId");
  const partnerId = requiredString(input, "partnerId");
  const contractVersion = requiredString(input, "contractVersion");
  const period = requiredString(input, "period");
  const meterState = assertKnownState(requiredString(input, "meterState"), ["reconciled", "disputed", "unknown"] as const, "meterState");
  const paymentState = assertKnownState(requiredString(input, "paymentState"), ["settled", "pending", "failed", "unknown"] as const, "paymentState");
  const grossMinor = requireInteger(requiredNumber(input, "grossMinor", 0), "grossMinor", 0);
  const platformMinor = requireInteger(requiredNumber(input, "platformMinor", 0), "platformMinor", 0);
  const partnerMinor = requireInteger(requiredNumber(input, "partnerMinor", 0), "partnerMinor", 0);
  const refundMinor = requireInteger(requiredNumber(input, "refundMinor", 0), "refundMinor", 0);
  const currency = requiredString(input, "currency").toUpperCase();
  if (meterState !== "reconciled" || paymentState !== "settled") throw new DomainError("DEPENDENCY_UNAVAILABLE", "unknown or unsettled partner state cannot be closed");
  if (platformMinor + partnerMinor + refundMinor !== grossMinor) throw new DomainError("VALIDATION_FAILED", "settlement allocation must equal gross metered value");
  return { settlementId, partnerId, contractVersion, period, meterState, paymentState, grossMinor, platformMinor, partnerMinor, refundMinor, currency };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B31", SKILL, "configurePartnerTenant", configurePartnerTenant, { permission: "partner.tenant.manage" }),
  defineCapability("B32", SKILL, "onboardPartner", onboardPartner, { permission: "partner.onboarding.approve" }),
  defineCapability("B33", SKILL, "acceptPartnerApiRequest", acceptPartnerApiRequest, { consent: participantConsent() }),
  defineCapability("B34", SKILL, "closePartnerSettlement", closePartnerSettlement, { permission: "partner.settlement.close" }),
];

export function registerBuildingPartnerPlatformCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingPartnerPlatformCoverage = definitions.length;
