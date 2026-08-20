import { DomainError } from "@ltm/core";
import type { CapabilityRegistry, JsonObject } from "../registry.js";
import { objectValue, requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertISODate,
  assertKnownState,
  defineCapability,
  registerDefinitions,
  requireInteger,
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-physical-supply-network";

function evidence(input: JsonObject, minimum = 1): string[] {
  return stringList(input, "externalEvidenceIds", { min: minimum, unique: true });
}

function printPreflight(input: JsonObject): JsonObject {
  const preflightId = requiredString(input, "preflightId");
  const productType = assertKnownState(requiredString(input, "productType"), ["photo_book", "frame", "card", "calendar", "gift_box"] as const, "productType");
  const templateVersion = requiredString(input, "templateVersion");
  const assetHash = requiredString(input, "assetHash");
  const dpi = requireInteger(requiredNumber(input, "dpi", 72), "dpi", 72, 2400);
  const bleedMm = requiredNumber(input, "bleedMm", 0);
  const fontsEmbedded = requireTrue(requiredBoolean(input, "fontsEmbedded"), "fontsEmbedded");
  const faceCropSafe = requireTrue(requiredBoolean(input, "faceCropSafe"), "faceCropSafe");
  const colorProfile = requiredString(input, "colorProfile");
  const specificationFrozen = requireTrue(requiredBoolean(input, "specificationFrozen"), "specificationFrozen");
  if (dpi < 240 || bleedMm < 2) throw new DomainError("VALIDATION_FAILED", "print asset does not meet minimum DPI or bleed");
  return { preflightId, productType, templateVersion, assetHash, dpi, bleedMm, fontsEmbedded, faceCropSafe, colorProfile, specificationFrozen };
}

function vendorProfile(input: JsonObject): JsonObject {
  const vendorId = requiredString(input, "vendorId");
  const status = assertKnownState(requiredString(input, "status"), ["onboarding", "approved", "suspended", "terminated"] as const, "status");
  const contractVersion = requiredString(input, "contractVersion");
  const capabilities = stringList(input, "capabilities", { min: 1, unique: true });
  const regions = stringList(input, "regions", { min: 1, unique: true });
  const priceBookVersion = requiredString(input, "priceBookVersion");
  const capacityObservedAt = assertISODate(requiredString(input, "capacityObservedAt"), "capacityObservedAt");
  const dataAccessExpiresAt = assertISODate(requiredString(input, "dataAccessExpiresAt"), "dataAccessExpiresAt");
  const terminatedAccessRevoked = requiredBoolean(input, "terminatedAccessRevoked");
  const externalEvidenceIds = evidence(input, 2);
  if (Date.now() - Date.parse(capacityObservedAt) > 24 * 60 * 60 * 1000 && status === "approved") {
    throw new DomainError("VALIDATION_FAILED", "approved vendor capacity evidence is stale");
  }
  if (status === "terminated" && !terminatedAccessRevoked) throw new DomainError("AUTH_FORBIDDEN", "terminated vendor access must be revoked");
  return {
    vendorId,
    status,
    contractVersion,
    capabilities,
    regions,
    priceBookVersion,
    capacityObservedAt,
    dataAccessExpiresAt,
    terminatedAccessRevoked,
    externalEvidenceIds,
  };
}

function proofApproval(input: JsonObject): JsonObject {
  const approvalId = requiredString(input, "approvalId");
  const orderId = requiredString(input, "orderId");
  const proofVersion = requiredString(input, "proofVersion");
  const proofHash = requiredString(input, "proofHash");
  const currentAssetHash = requiredString(input, "currentAssetHash");
  const approverId = requiredString(input, "approverId");
  const decision = assertKnownState(requiredString(input, "decision"), ["approved", "changes_requested", "rejected"] as const, "decision");
  const productionLocked = requiredBoolean(input, "productionLocked");
  const tokenVersionBound = requireTrue(requiredBoolean(input, "tokenVersionBound"), "tokenVersionBound");
  const externalEvidenceIds = evidence(input);
  if (decision === "approved" && (proofHash !== currentAssetHash || !productionLocked)) {
    throw new DomainError("VALIDATION_FAILED", "approved proof must match and lock the production asset hash");
  }
  return {
    approvalId,
    orderId,
    proofVersion,
    proofHash,
    currentAssetHash,
    approverId,
    decision,
    productionLocked,
    tokenVersionBound,
    externalEvidenceIds,
  };
}

function vendorJob(input: JsonObject): JsonObject {
  const jobId = requiredString(input, "jobId");
  const orderId = requiredString(input, "orderId");
  const vendorId = requiredString(input, "vendorId");
  const purchaseOrderId = requiredString(input, "purchaseOrderId");
  const approvedProofHash = requiredString(input, "approvedProofHash");
  const routeVersion = requiredString(input, "routeVersion");
  const vendorStatus = assertKnownState(requiredString(input, "vendorStatus"), ["approved"] as const, "vendorStatus");
  const orderCancelled = requiredBoolean(input, "orderCancelled");
  const priorVendorJobsClosed = requireTrue(requiredBoolean(input, "priorVendorJobsClosed"), "priorVendorJobsClosed");
  const capacityFresh = requireTrue(requiredBoolean(input, "capacityFresh"), "capacityFresh");
  const externalEvidenceIds = evidence(input);
  if (orderCancelled) throw new DomainError("VALIDATION_FAILED", "cancelled orders cannot create vendor jobs");
  return {
    jobId,
    orderId,
    vendorId,
    purchaseOrderId,
    approvedProofHash,
    routeVersion,
    vendorStatus,
    orderCancelled,
    priorVendorJobsClosed,
    capacityFresh,
    externalEvidenceIds,
  };
}

function shipment(input: JsonObject): JsonObject {
  const shipmentId = requiredString(input, "shipmentId");
  const orderId = requiredString(input, "orderId");
  const addressToken = requiredString(input, "addressToken");
  const addressVersion = requiredString(input, "addressVersion");
  const carrierId = requiredString(input, "carrierId");
  const carrierEventId = requiredString(input, "carrierEventId");
  const trackingToken = requiredString(input, "trackingToken");
  const state = assertKnownState(requiredString(input, "state"), ["label_created", "in_transit", "delivered", "exception", "returned"] as const, "state");
  const publicTrackingRedacted = requireTrue(requiredBoolean(input, "publicTrackingRedacted"), "publicTrackingRedacted");
  const externalEvidenceIds = evidence(input);
  if (/\s|@|\+?\d{7,}/.test(addressToken)) throw new DomainError("VALIDATION_FAILED", "addressToken must be an opaque vault reference");
  return {
    shipmentId,
    orderId,
    addressToken,
    addressVersion,
    carrierId,
    carrierEventId,
    trackingToken,
    state,
    publicTrackingRedacted,
    externalEvidenceIds,
  };
}

function inventory(input: JsonObject): JsonObject {
  const adjustmentId = requiredString(input, "adjustmentId");
  const sku = requiredString(input, "sku");
  const locationId = requiredString(input, "locationId");
  const sourceVersion = requiredString(input, "sourceVersion");
  const reason = assertKnownState(requiredString(input, "reason"), ["receipt", "reservation", "release", "return", "damage", "cycle_count"] as const, "reason");
  const quantityDelta = requireInteger(requiredNumber(input, "quantityDelta"), "quantityDelta");
  const availableAfter = requireInteger(requiredNumber(input, "availableAfter", 0), "availableAfter", 0);
  const reservationProtected = requireTrue(requiredBoolean(input, "reservationProtected"), "reservationProtected");
  const duplicateReturnChecked = requireTrue(requiredBoolean(input, "duplicateReturnChecked"), "duplicateReturnChecked");
  const externalEvidenceIds = evidence(input);
  if (quantityDelta === 0) throw new DomainError("VALIDATION_FAILED", "inventory adjustment cannot be zero");
  return {
    adjustmentId,
    sku,
    locationId,
    sourceVersion,
    reason,
    quantityDelta,
    availableAfter,
    reservationProtected,
    duplicateReturnChecked,
    externalEvidenceIds,
  };
}

function returnClaim(input: JsonObject): JsonObject {
  const claimId = requiredString(input, "claimId");
  const orderId = requiredString(input, "orderId");
  const action = assertKnownState(requiredString(input, "action"), ["return", "replace", "refund", "carrier_claim", "vendor_claim"] as const, "action");
  const evidenceReferences = stringList(input, "evidenceReferences", { min: 1, unique: true });
  const duplicateRemedyChecked = requireTrue(requiredBoolean(input, "duplicateRemedyChecked"), "duplicateRemedyChecked");
  const eligibilityVerified = requireTrue(requiredBoolean(input, "eligibilityVerified"), "eligibilityVerified");
  const returnAddressToken = requiredString(input, "returnAddressToken");
  const externalEvidenceIds = evidence(input);
  if (evidenceReferences.some((reference) => reference.startsWith("raw-media:"))) {
    throw new DomainError("VALIDATION_FAILED", "vendor/carrier claim evidence cannot contain raw customer media");
  }
  return {
    claimId,
    orderId,
    action,
    evidenceReferences,
    duplicateRemedyChecked,
    eligibilityVerified,
    returnAddressToken,
    externalEvidenceIds,
  };
}

function vendorScorecard(input: JsonObject): JsonObject {
  const scorecardId = requiredString(input, "scorecardId");
  const vendorId = requiredString(input, "vendorId");
  const period = requiredString(input, "period");
  const metrics = objectValue(input, "metrics");
  const eligibleOrderCount = requireInteger(requiredNumber(input, "eligibleOrderCount", 1), "eligibleOrderCount", 1);
  const measuredOrderCount = requireInteger(requiredNumber(input, "measuredOrderCount", 0), "measuredOrderCount", 0);
  const complaintIds = stringList(input, "complaintIds", { unique: true });
  const settlementId = requiredString(input, "settlementId");
  const disabledVendorBlocked = requireTrue(requiredBoolean(input, "disabledVendorBlocked"), "disabledVendorBlocked");
  const externalEvidenceIds = evidence(input);
  if (measuredOrderCount > eligibleOrderCount) throw new DomainError("VALIDATION_FAILED", "scorecard denominator is inconsistent");
  return {
    scorecardId,
    vendorId,
    period,
    metrics,
    eligibleOrderCount,
    measuredOrderCount,
    complaintIds,
    settlementId,
    disabledVendorBlocked,
    externalEvidenceIds,
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B95", SKILL, "recordPrintPreflight", printPreflight, { permission: "print.preflight.record" }),
  defineCapability("B96", SKILL, "recordVendorProfile", vendorProfile, { permission: "vendor.profile.manage", requiresExternalEvidence: true }),
  defineCapability("B97", SKILL, "recordProofApproval", proofApproval, { permission: "production.proof.approve", requiresExternalEvidence: true }),
  defineCapability("B98", SKILL, "createVendorProductionJob", vendorJob, { permission: "vendor.job.create", requiresExternalEvidence: true }),
  defineCapability("B99", SKILL, "recordShipment", shipment, { permission: "shipping.manage", requiresExternalEvidence: true }),
  defineCapability("B100", SKILL, "recordInventoryAdjustment", inventory, { permission: "inventory.adjust", requiresExternalEvidence: true }),
  defineCapability("B101", SKILL, "createReturnOrClaim", returnClaim, { permission: "returns.claim.manage", requiresExternalEvidence: true }),
  defineCapability("B102", SKILL, "publishVendorScorecard", vendorScorecard, { permission: "vendor.scorecard.publish", requiresExternalEvidence: true }),
];

export function registerBuildingPhysicalSupplyNetworkCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingPhysicalSupplyNetworkCoverage = definitions.length;
