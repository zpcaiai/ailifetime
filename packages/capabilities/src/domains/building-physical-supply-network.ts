import { DomainError } from "@ltm/core";
import { capabilityEvidenceScope } from "@ltm/providers";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { objectValue, requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertISODate,
  assertKnownState,
  defineCapability,
  rejectClientAssertions,
  registerDefinitions,
  requireInteger,
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-physical-supply-network";

function evidence(input: JsonObject, minimum = 1): string[] {
  return stringList(input, "externalEvidenceIds", { min: minimum, unique: true });
}

function sha256(input: JsonObject, field: string): string {
  const value = requiredString(input, field);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DomainError("VALIDATION_FAILED", `${field} must be a lowercase SHA-256 digest`);
  return value;
}

function providerEnvironment(input: JsonObject): "sandbox" | "production" {
  return assertKnownState(requiredString(input, "providerEnvironment"), ["sandbox", "production"] as const, "providerEnvironment");
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

function vendorProfile(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["terminatedAccessRevoked"]);
  const vendorId = requiredString(input, "vendorId");
  const vendorProfileArtifactSha256 = sha256(input, "vendorProfileArtifactSha256");
  const environment = providerEnvironment(input);
  const status = assertKnownState(requiredString(input, "status"), ["onboarding", "approved", "suspended", "terminated"] as const, "status");
  const contractVersion = requiredString(input, "contractVersion");
  const capabilities = stringList(input, "capabilities", { min: 1, unique: true });
  const regions = stringList(input, "regions", { min: 1, unique: true });
  const priceBookVersion = requiredString(input, "priceBookVersion");
  const capacityObservedAt = assertISODate(requiredString(input, "capacityObservedAt"), "capacityObservedAt");
  const dataAccessExpiresAt = assertISODate(requiredString(input, "dataAccessExpiresAt"), "dataAccessExpiresAt");
  const accessRevocationReceiptId = typeof input.accessRevocationReceiptId === "string"
    ? requiredString(input, "accessRevocationReceiptId")
    : undefined;
  const externalEvidenceIds = evidence(input, 2);
  if (Date.now() - Date.parse(capacityObservedAt) > 24 * 60 * 60 * 1000 && status === "approved") {
    throw new DomainError("VALIDATION_FAILED", "approved vendor capacity evidence is stale");
  }
  if (status === "terminated" && !accessRevocationReceiptId) throw new DomainError("AUTH_FORBIDDEN", "terminated vendor access requires a revocation receipt");
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B96",
    operation: "recordVendorProfile",
    kind: "vendor-profile",
    provider: `vendor:${vendorId}`,
    artifactSha256: vendorProfileArtifactSha256,
    environment,
    subjectId: vendorId,
  });
  return {
    vendorId,
    vendorProfileArtifactSha256,
    providerEnvironment: environment,
    status,
    contractVersion,
    capabilities,
    regions,
    priceBookVersion,
    capacityObservedAt,
    dataAccessExpiresAt,
    ...(accessRevocationReceiptId ? { accessRevocationReceiptId } : {}),
    externalEvidenceIds,
    evidenceScope,
  };
}

function proofApproval(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["productionLocked", "tokenVersionBound"]);
  const approvalId = requiredString(input, "approvalId");
  const orderId = requiredString(input, "orderId");
  const vendorId = requiredString(input, "vendorId");
  const proofArtifactSha256 = sha256(input, "proofArtifactSha256");
  const environment = providerEnvironment(input);
  const proofVersion = requiredString(input, "proofVersion");
  const proofHash = requiredString(input, "proofHash");
  const currentAssetHash = requiredString(input, "currentAssetHash");
  const approverId = requiredString(input, "approverId");
  const decision = assertKnownState(requiredString(input, "decision"), ["approved", "changes_requested", "rejected"] as const, "decision");
  const productionLockId = requiredString(input, "productionLockId");
  const tokenVersionId = requiredString(input, "tokenVersionId");
  const externalEvidenceIds = evidence(input);
  if (decision === "approved" && proofHash !== currentAssetHash) {
    throw new DomainError("VALIDATION_FAILED", "approved proof must match the production asset hash");
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B97",
    operation: "recordProofApproval",
    kind: "production-proof-lock",
    provider: `vendor:${vendorId}`,
    artifactSha256: proofArtifactSha256,
    environment,
    subjectId: approvalId,
  });
  return {
    approvalId,
    orderId,
    vendorId,
    proofArtifactSha256,
    providerEnvironment: environment,
    proofVersion,
    proofHash,
    currentAssetHash,
    approverId,
    decision,
    productionLockId,
    tokenVersionId,
    externalEvidenceIds,
    evidenceScope,
  };
}

function vendorJob(input: JsonObject): JsonObject {
  rejectClientAssertions(input, [
    "orderCancelled",
    "priorVendorJobsClosed",
    "capacityFresh",
    "vendorRequestArtifactSha256",
    "externalEvidenceIds",
    "providerRequestId",
  ]);
  const jobId = requiredString(input, "jobId");
  const orderId = requiredString(input, "orderId");
  const vendorId = requiredString(input, "vendorId");
  const purchaseOrderId = requiredString(input, "purchaseOrderId");
  const approvedProofHash = requiredString(input, "approvedProofHash");
  const environment = providerEnvironment(input);
  const routeVersion = requiredString(input, "routeVersion");
  const orderState = assertKnownState(requiredString(input, "orderState"), ["approved_for_production"] as const, "orderState");
  const priorJobDisposition = assertKnownState(
    requiredString(input, "priorJobDisposition"),
    ["none", "closed", "compensated"] as const,
    "priorJobDisposition",
  );
  const capacitySnapshotId = requiredString(input, "capacitySnapshotId");
  return {
    jobId,
    orderId,
    vendorId,
    purchaseOrderId,
    approvedProofHash,
    providerEnvironment: environment,
    routeVersion,
    orderState,
    priorJobDisposition,
    capacitySnapshotId,
    commandState: "requested",
  };
}

function shipment(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["publicTrackingRedacted"]);
  const shipmentId = requiredString(input, "shipmentId");
  const orderId = requiredString(input, "orderId");
  const addressToken = requiredString(input, "addressToken");
  const addressVersion = requiredString(input, "addressVersion");
  const carrierId = requiredString(input, "carrierId");
  const carrierEventId = requiredString(input, "carrierEventId");
  const carrierEventArtifactSha256 = sha256(input, "carrierEventArtifactSha256");
  const environment = providerEnvironment(input);
  const trackingToken = requiredString(input, "trackingToken");
  const state = assertKnownState(requiredString(input, "state"), ["label_created", "in_transit", "delivered", "exception", "returned"] as const, "state");
  const trackingViewPolicyVersion = requiredString(input, "trackingViewPolicyVersion");
  const externalEvidenceIds = evidence(input);
  if (/\s|@|\+?\d{7,}/.test(addressToken)) throw new DomainError("VALIDATION_FAILED", "addressToken must be an opaque vault reference");
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B99",
    operation: "recordShipment",
    kind: "carrier-event",
    provider: `carrier:${carrierId}`,
    artifactSha256: carrierEventArtifactSha256,
    environment,
    subjectId: shipmentId,
  });
  return {
    shipmentId,
    orderId,
    addressToken,
    addressVersion,
    carrierId,
    carrierEventId,
    carrierEventArtifactSha256,
    providerEnvironment: environment,
    trackingToken,
    state,
    trackingViewPolicyVersion,
    externalEvidenceIds,
    evidenceScope,
  };
}

function inventory(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["reservationProtected", "duplicateReturnChecked"]);
  const adjustmentId = requiredString(input, "adjustmentId");
  const sku = requiredString(input, "sku");
  const locationId = requiredString(input, "locationId");
  const vendorId = requiredString(input, "vendorId");
  const inventorySnapshotArtifactSha256 = sha256(input, "inventorySnapshotArtifactSha256");
  const environment = providerEnvironment(input);
  const sourceVersion = requiredString(input, "sourceVersion");
  const reason = assertKnownState(requiredString(input, "reason"), ["receipt", "reservation", "release", "return", "damage", "cycle_count"] as const, "reason");
  const quantityDelta = requireInteger(requiredNumber(input, "quantityDelta"), "quantityDelta");
  const availableAfter = requireInteger(requiredNumber(input, "availableAfter", 0), "availableAfter", 0);
  const reservationLedgerVersion = requiredString(input, "reservationLedgerVersion");
  const sourceEventId = requiredString(input, "sourceEventId");
  const externalEvidenceIds = evidence(input);
  if (quantityDelta === 0) throw new DomainError("VALIDATION_FAILED", "inventory adjustment cannot be zero");
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B100",
    operation: "recordInventoryAdjustment",
    kind: "inventory-snapshot",
    provider: `vendor:${vendorId}`,
    artifactSha256: inventorySnapshotArtifactSha256,
    environment,
    subjectId: adjustmentId,
  });
  return {
    adjustmentId,
    sku,
    locationId,
    vendorId,
    inventorySnapshotArtifactSha256,
    providerEnvironment: environment,
    sourceVersion,
    reason,
    quantityDelta,
    availableAfter,
    reservationLedgerVersion,
    sourceEventId,
    externalEvidenceIds,
    evidenceScope,
  };
}

function returnClaim(input: JsonObject): JsonObject {
  rejectClientAssertions(input, [
    "duplicateRemedyChecked",
    "eligibilityVerified",
    "claimArtifactSha256",
    "externalEvidenceIds",
    "providerRequestId",
  ]);
  const claimId = requiredString(input, "claimId");
  const orderId = requiredString(input, "orderId");
  const action = assertKnownState(requiredString(input, "action"), ["return", "replace", "refund", "carrier_claim", "vendor_claim"] as const, "action");
  const providerType = assertKnownState(requiredString(input, "providerType"), ["vendor", "carrier"] as const, "providerType");
  const providerId = requiredString(input, "providerId");
  const vendorId = requiredString(input, "vendorId");
  const environment = providerEnvironment(input);
  const evidenceReferences = stringList(input, "evidenceReferences", { min: 1, unique: true });
  const eligibilityDecisionId = requiredString(input, "eligibilityDecisionId");
  const remedyLedgerReference = requiredString(input, "remedyLedgerReference");
  const returnAddressToken = requiredString(input, "returnAddressToken");
  if (evidenceReferences.some((reference) => reference.startsWith("raw-media:"))) {
    throw new DomainError("VALIDATION_FAILED", "vendor/carrier claim evidence cannot contain raw customer media");
  }
  return {
    claimId,
    orderId,
    action,
    providerType,
    providerId,
    vendorId,
    providerEnvironment: environment,
    evidenceReferences,
    eligibilityDecisionId,
    remedyLedgerReference,
    returnAddressToken,
    commandState: "requested",
  };
}

function vendorScorecard(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["disabledVendorBlocked"]);
  const scorecardId = requiredString(input, "scorecardId");
  const vendorId = requiredString(input, "vendorId");
  const scorecardArtifactSha256 = sha256(input, "scorecardArtifactSha256");
  const environment = providerEnvironment(input);
  const period = requiredString(input, "period");
  const metrics = objectValue(input, "metrics");
  const eligibleOrderCount = requireInteger(requiredNumber(input, "eligibleOrderCount", 1), "eligibleOrderCount", 1);
  const measuredOrderCount = requireInteger(requiredNumber(input, "measuredOrderCount", 0), "measuredOrderCount", 0);
  const complaintIds = stringList(input, "complaintIds", { unique: true });
  const settlementId = requiredString(input, "settlementId");
  const vendorState = assertKnownState(requiredString(input, "vendorState"), ["active", "suspended", "terminated"] as const, "vendorState");
  const settlementControlTotalId = requiredString(input, "settlementControlTotalId");
  const externalEvidenceIds = evidence(input);
  if (measuredOrderCount > eligibleOrderCount) throw new DomainError("VALIDATION_FAILED", "scorecard denominator is inconsistent");
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B102",
    operation: "publishVendorScorecard",
    kind: "vendor-scorecard",
    provider: `vendor:${vendorId}`,
    artifactSha256: scorecardArtifactSha256,
    environment,
    subjectId: scorecardId,
  });
  return {
    scorecardId,
    vendorId,
    scorecardArtifactSha256,
    providerEnvironment: environment,
    period,
    metrics,
    eligibleOrderCount,
    measuredOrderCount,
    complaintIds,
    settlementId,
    vendorState,
    settlementControlTotalId,
    externalEvidenceIds,
    evidenceScope,
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B95", SKILL, "recordPrintPreflight", printPreflight, { permission: "print.preflight.record", mode: "resource" }),
  defineCapability("B96", SKILL, "recordVendorProfile", vendorProfile, {
    permission: "vendor.profile.manage",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    mode: "attestation",
  }),
  defineCapability("B97", SKILL, "recordProofApproval", proofApproval, {
    permission: "production.proof.approve",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    mode: "attestation",
  }),
  defineCapability("B98", SKILL, "createVendorProductionJob", vendorJob, {
    permission: "vendor.job.create",
    mode: "external-command",
    collection: "supply.vendor-production-commands",
    recordIdField: "jobId",
  }),
  defineCapability("B99", SKILL, "recordShipment", shipment, {
    permission: "shipping.manage",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    mode: "attestation",
    trustedExternalEventOnly: true,
  }),
  defineCapability("B100", SKILL, "recordInventoryAdjustment", inventory, {
    permission: "inventory.adjust",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    mode: "attestation",
    trustedExternalEventOnly: true,
  }),
  defineCapability("B101", SKILL, "createReturnOrClaim", returnClaim, {
    permission: "returns.claim.manage",
    mode: "external-command",
    collection: "supply.return-claim-commands",
    recordIdField: "claimId",
  }),
  defineCapability("B102", SKILL, "publishVendorScorecard", vendorScorecard, {
    permission: "vendor.scorecard.publish",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    mode: "attestation",
    trustedExternalEventOnly: true,
  }),
];

export function registerBuildingPhysicalSupplyNetworkCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingPhysicalSupplyNetworkCoverage = definitions.length;
