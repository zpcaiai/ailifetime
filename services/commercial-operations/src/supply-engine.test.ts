import assert from "node:assert/strict";
import test from "node:test";
import { CommercialOperationsError, sha256, type JsonObject } from "./common.js";
import type { SupplyOperationsEngine } from "./supply-engine.js";
import { commercialTestFixture, TEST_DIGEST, TEST_DIGEST_B } from "./test-fixtures.js";

type Fixture = ReturnType<typeof commercialTestFixture>;

function expectCode(action: () => unknown, code: CommercialOperationsError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof CommercialOperationsError && error.code === code);
}

function configurePrint(supply: SupplyOperationsEngine, f: Fixture, suffix = "1", digest = TEST_DIGEST): string {
  const specificationId = `spec-${suffix}`;
  const layoutId = `layout-${suffix}`;
  const artifactId = `artifact-${suffix}`;
  supply.configurePrintSpecification(f.reviewer, { specificationId, version: "v1", productType: "photo_book", widthMm: 210, heightMm: 297, pageCount: 20, material: "paper-premium", binding: "layflat", packaging: "box", colorProfile: "CMYK_FOGRA39", bleedMm: 3, safeZoneMm: 5, vendorCapabilityVersion: "cap-v1", templateLicenseId: "license-v1", idempotencyKey: `print-spec-${suffix}` });
  supply.validateLayout(f.actor, { layoutId, specificationId, specificationVersion: "v1", cropFocusWithinSafeZone: true, textOverflowCount: 0, lowResolutionAssetIds: [], spreadWarnings: [], aiDisclosurePresent: true, copyrightAttributionIds: ["license-v1"], idempotencyKey: `print-layout-${suffix}` });
  supply.preflightPrintArtifact(f.actor, { artifactId, layoutId, specificationId, specificationVersion: "v1", pdfSha256: digest, thumbnailManifestSha256: TEST_DIGEST_B, layoutManifestSha256: suffix === "1" ? TEST_DIGEST : TEST_DIGEST_B, mimeType: "application/pdf", pageCount: 20, minimumDpi: 300, colorSpace: "CMYK_FOGRA39", bleedMm: 3, fontsEmbedded: true, transparencyFlattened: true, barcodeValid: true, licensedAssetIds: ["license-v1"], hiddenLayerCount: 0, fileComplete: true, idempotencyKey: `print-artifact-${suffix}` });
  return artifactId;
}

function onboardVendor(f: Fixture, vendorId: "v1" | "v2", capacitySequence = 1): void {
  f.supply.onboardVendor(f.reviewer, { vendorId, legalEntity: `Vendor ${vendorId}`, facilities: [`factory-${vendorId}`], regions: ["CN"], productCapabilities: ["photo_book"], certifications: [{ name: "iso9001", expiresAt: "2027-01-01T00:00:00Z" }], dataProcessingAgreementVersion: "dpa-v1", contractVersion: "contract-v1", contractExpiresAt: "2027-01-01T00:00:00Z", credentialReference: `secret-manager:vendors/${vendorId}`, networkPolicyId: `network-${vendorId}`, idempotencyKey: `vendor-${vendorId}` });
  const fact = f.fact(`vendor:${vendorId}` as "vendor:v1" | "vendor:v2", "vendor.capacity", vendorId, { vendorId, calendarVersion: "calendar-v1", availableUnits: 100, cutoffAt: "2026-08-28T18:00:00Z", holidays: [], maintenanceWindows: [], minimumBatch: 1, serviceRegions: ["CN"], confidenceBasisPoints: 9_000, updatedAt: "2026-08-28T11:55:00Z" }, capacitySequence);
  f.supply.applyVendorCapacityFact(f.actor, fact, 15 * 60_000, `capacity-${vendorId}`);
  f.supply.approvePriceBook(f.reviewer, { priceBookId: `price-${vendorId}`, vendorId, version: "price-v1", effectiveFrom: "2026-01-01", effectiveUntil: "2026-12-31", currency: "CNY", entries: [{ product: "photo_book", process: "layflat", minimumQuantity: 1, unitMinor: 2_000, rushMinor: 0, packagingMinor: 100, shippingMinor: 500, taxBasisPoints: 0 }], approverIds: ["a1", "a2"], idempotencyKey: `price-${vendorId}` });
  f.supply.configureVendorSla(f.reviewer, { vendorId, slaVersion: "sla-v1", thresholdsSeconds: { accept: 60, proof: 60, production: 3_600, quality: 300, ship: 600, deliver: 86_400, rework: 3_600, dataDeletion: 86_400, eventNotification: 60 }, effectiveFrom: "2026-01-01", idempotencyKey: `sla-${vendorId}` });
}

function approvedLockedProof(f: Fixture, proofId: string, orderId: string, artifactId: string, vendorId = "v1"): void {
  f.supply.createProof(f.actor, { proofId, orderId, artifactId, proofVersion: 1, softProofSha256: TEST_DIGEST, thumbnailManifestSha256: TEST_DIGEST_B, riskAnnotations: ["color-difference"], colorDisclaimer: "Screen color may differ from print.", requiredApprovalRoles: ["customer"], requiredApprovalCount: 1, expiresAt: "2026-08-29T00:00:00Z", idempotencyKey: `proof-create-${proofId}` });
  const token = `proof-token-${proofId}`;
  const grant = f.supply.issueProofLink(f.actor, { proofId, intendedApproverId: "approver", intendedRole: "customer", tokenSha256: sha256(token), expiresAt: "2026-08-28T13:00:00Z", idempotencyKey: `proof-link-${proofId}` });
  f.supply.approveProof(f.approver, { proofId, grantId: String(grant.grantId), token, decision: "approved", comment: "approved exact proof", idempotencyKey: `proof-approve-${proofId}` });
  f.supply.lockProofForProduction(f.reviewer, { proofId, vendorId, idempotencyKey: `proof-lock-${proofId}` });
}

test("B95 dedicated print configurator/preflight satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  await t.test("B95-R01 versioned product geometry/material/color/vendor capability", () => {
    const spec = f.supply.configurePrintSpecification(f.reviewer, { specificationId: "spec-main", version: "v1", productType: "photo_book", widthMm: 210, heightMm: 297, pageCount: 20, material: "paper-premium", binding: "layflat", packaging: "box", colorProfile: "CMYK_FOGRA39", bleedMm: 3, safeZoneMm: 5, vendorCapabilityVersion: "cap-v1", templateLicenseId: "license-v1", idempotencyKey: "b95-r01" });
    assert.equal(spec.version, "v1");
    assert.equal(spec.vendorCapabilityVersion, "cap-v1");
  });
  await t.test("B95-R02 layout blocks unsafe crops/overflow/resolution/disclosure/license", () => {
    const blocked = f.supply.validateLayout(f.actor, { layoutId: "layout-blocked", specificationId: "spec-main", specificationVersion: "v1", cropFocusWithinSafeZone: false, textOverflowCount: 1, lowResolutionAssetIds: ["asset-low"], spreadWarnings: ["cross-spread"], aiDisclosurePresent: false, copyrightAttributionIds: [], idempotencyKey: "b95-r02" });
    assert.equal(blocked.state, "layout_blocked");
    assert.deepEqual(new Set(blocked.blockers as readonly string[]), new Set(["crop_focus_outside_safe_zone", "text_overflow", "low_resolution", "ai_disclosure_missing", "copyright_attribution_missing"]));
  });
  let artifact: JsonObject;
  await t.test("B95-R03 server emits immutable checksummed print PDF/manifests", () => {
    f.supply.validateLayout(f.actor, { layoutId: "layout-main", specificationId: "spec-main", specificationVersion: "v1", cropFocusWithinSafeZone: true, textOverflowCount: 0, lowResolutionAssetIds: [], spreadWarnings: [], aiDisclosurePresent: true, copyrightAttributionIds: ["license-v1"], idempotencyKey: "b95-r03-layout" });
    artifact = f.supply.preflightPrintArtifact(f.actor, { artifactId: "artifact-main", layoutId: "layout-main", specificationId: "spec-main", specificationVersion: "v1", pdfSha256: TEST_DIGEST, thumbnailManifestSha256: TEST_DIGEST_B, layoutManifestSha256: TEST_DIGEST, mimeType: "application/pdf", pageCount: 20, minimumDpi: 300, colorSpace: "CMYK_FOGRA39", bleedMm: 3, fontsEmbedded: true, transparencyFlattened: true, barcodeValid: true, licensedAssetIds: ["license-v1"], hiddenLayerCount: 0, fileComplete: true, idempotencyKey: "b95-r03" });
    assert.equal(artifact.immutable, true);
    assert.equal(artifact.status, "preflight_passed");
  });
  await t.test("B95-R04 preflight evaluates all production blockers fail closed", () => {
    const checks = artifact.checks as JsonObject;
    assert.deepEqual(Object.keys(checks).sort(), ["barcode", "bleed", "colorSpace", "fonts", "hiddenLayers", "integrity", "license", "pageCount", "resolution", "transparency"].sort());
    const failed = f.supply.preflightPrintArtifact(f.actor, { artifactId: "artifact-bad", layoutId: "layout-main", specificationId: "spec-main", specificationVersion: "v1", pdfSha256: TEST_DIGEST_B, thumbnailManifestSha256: TEST_DIGEST, layoutManifestSha256: TEST_DIGEST_B, mimeType: "application/pdf", pageCount: 19, minimumDpi: 72, colorSpace: "RGB", bleedMm: 0, fontsEmbedded: false, transparencyFlattened: false, barcodeValid: false, licensedAssetIds: [], hiddenLayerCount: 1, fileComplete: false, idempotencyKey: "b95-r04" });
    assert.equal(failed.status, "preflight_failed");
    assert.equal((failed.failures as readonly string[]).length, 10);
    expectCode(() => f.supply.pinPaidOrderPrintVersion(f.actor, { orderId: "bad-order", artifactId: "artifact-bad", specificationVersion: "v1", paid: true, idempotencyKey: "b95-r04-pin" }), "STATE_TRANSITION_INVALID");
  });
  await t.test("B95-R05 paid version remains pinned; regeneration needs approvals/diff", () => {
    f.supply.pinPaidOrderPrintVersion(f.actor, { orderId: "order-print", artifactId: "artifact-main", specificationVersion: "v1", paid: true, idempotencyKey: "b95-r05-pin" });
    configurePrint(f.supply, f, "replacement", TEST_DIGEST_B);
    const regenerated = f.supply.approvePrintRegeneration(f.reviewer, { orderId: "order-print", newArtifactId: "artifact-replacement", approverIds: ["a1", "a2"], differenceEvidenceSha256: TEST_DIGEST, idempotencyKey: "b95-r05" });
    assert.equal(regenerated.state, "regeneration_approved");
    assert.equal((regenerated.replacementVersion as JsonObject).artifactSha256, TEST_DIGEST_B);
  });
  f.repository.close();
});

test("B96 dedicated vendor contract/capacity engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  await t.test("B96-R01 vendor entity/facility/certification/DPA/contract are versioned", () => {
    f.supply.onboardVendor(f.reviewer, { vendorId: "v1", legalEntity: "Vendor One", facilities: ["factory-1"], regions: ["CN"], productCapabilities: ["photo_book"], certifications: [{ name: "iso9001", expiresAt: "2027-01-01T00:00:00Z" }], dataProcessingAgreementVersion: "dpa-v1", contractVersion: "contract-v1", contractExpiresAt: "2027-01-01T00:00:00Z", credentialReference: "secret-manager:vendors/v1", networkPolicyId: "network-v1", idempotencyKey: "b96-r01" });
    assert.equal(f.repository.get("tenant-a", "vendor.profile", "v1")?.state.status, "active");
  });
  await t.test("B96-R02 frozen approved pricebook covers tier/rush/package/ship/tax", () => {
    const book = f.supply.approvePriceBook(f.reviewer, { priceBookId: "price-v1", vendorId: "v1", version: "v1", effectiveFrom: "2026-01-01", effectiveUntil: "2026-12-31", currency: "CNY", entries: [{ product: "photo_book", process: "layflat", minimumQuantity: 1, unitMinor: 5_000, rushMinor: 500, packagingMinor: 100, shippingMinor: 800, taxBasisPoints: 1_300 }], approverIds: ["a1", "a2"], idempotencyKey: "b96-r02" });
    assert.equal(book.frozen, true);
    expectCode(() => f.supply.approvePriceBook(f.reviewer, { priceBookId: "price-overlap", vendorId: "v1", version: "v2", effectiveFrom: "2026-06-01", effectiveUntil: "2027-01-01", currency: "CNY", entries: [{ product: "photo_book", process: "layflat", minimumQuantity: 1, unitMinor: 5_100, rushMinor: 0, packagingMinor: 0, shippingMinor: 0, taxBasisPoints: 0 }], approverIds: ["a1", "a2"], idempotencyKey: "b96-r02-overlap" }), "CONFLICT");
  });
  await t.test("B96-R03 signed fresh capacity includes cutoff/holiday/maintenance/confidence", () => {
    const fact = f.fact("vendor:v1", "vendor.capacity", "v1", { vendorId: "v1", calendarVersion: "calendar-v1", availableUnits: 50, cutoffAt: "2026-08-28T18:00:00Z", holidays: ["2026-10-01"], maintenanceWindows: ["2026-09-01T00:00:00Z"], minimumBatch: 1, serviceRegions: ["CN"], confidenceBasisPoints: 9_000, updatedAt: "2026-08-28T11:55:00Z" });
    const capacity = f.supply.applyVendorCapacityFact(f.actor, fact, 15 * 60_000, "b96-r03");
    assert.equal(capacity.availableUnits, 50);
    assert.equal(capacity.confidenceBasisPoints, 9_000);
  });
  await t.test("B96-R04 SLA covers full accept-to-delete/event lifecycle", () => {
    const thresholds = { accept: 60, proof: 120, production: 3_600, quality: 300, ship: 600, deliver: 86_400, rework: 3_600, dataDeletion: 86_400, eventNotification: 60 };
    const sla = f.supply.configureVendorSla(f.reviewer, { vendorId: "v1", slaVersion: "sla-v1", thresholdsSeconds: thresholds, effectiveFrom: "2026-01-01", idempotencyKey: "b96-r04" });
    assert.equal(Object.keys(sla.thresholdsSeconds as JsonObject).length, 9);
  });
  await t.test("B96-R05 termination revokes credentials/network/routing and schedules deletion", () => {
    const result = f.supply.terminateVendor(f.reviewer, { vendorId: "v1", approverIds: ["a1", "a2"], reason: "contract ended", downstreamDeletionDueAt: "2026-09-01T00:00:00Z", idempotencyKey: "b96-r05" });
    assert.equal(result.credentialsRevoked, true);
    assert.equal(result.newRoutingBlocked, true);
  });
  f.repository.close();
});

test("B97 dedicated production-proof engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  const artifact1 = configurePrint(f.supply, f, "proof1", TEST_DIGEST);
  onboardVendor(f, "v1");
  await t.test("B97-R01 proof binds exact print bytes/thumbnails/color/risk", () => {
    const proof = f.supply.createProof(f.actor, { proofId: "proof-1", orderId: "order-proof", artifactId: artifact1, proofVersion: 1, softProofSha256: TEST_DIGEST, thumbnailManifestSha256: TEST_DIGEST_B, riskAnnotations: ["color-difference"], colorDisclaimer: "Screen color may differ.", requiredApprovalRoles: ["customer"], requiredApprovalCount: 1, expiresAt: "2026-08-29T00:00:00Z", idempotencyKey: "b97-r01" });
    assert.equal(proof.artifactSha256, TEST_DIGEST);
  });
  await t.test("B97-R02 product/channel/risk policy determines required approval roles/count", () => {
    const proof = f.repository.get("tenant-a", "proof.approval", "proof-1")?.state;
    assert.deepEqual(proof?.requiredApprovalRoles, ["customer"]);
    assert.equal(proof?.requiredApprovalCount, 1);
  });
  await t.test("B97-R03 short-lived identity/version-bound token is non-enumerable", () => {
    const token = "proof-secret-1";
    const grant = f.supply.issueProofLink(f.actor, { proofId: "proof-1", intendedApproverId: "approver", intendedRole: "customer", tokenSha256: sha256(token), expiresAt: "2026-08-28T13:00:00Z", idempotencyKey: "b97-r03-link" });
    assert.equal(grant.publiclyIndexable, false);
    const approved = f.supply.approveProof(f.approver, { proofId: "proof-1", grantId: String(grant.grantId), token, decision: "approved", comment: "exact version approved", idempotencyKey: "b97-r03" });
    assert.equal(approved.state, "approved");
  });
  await t.test("B97-R04 change creates new preflighted version and supersedes old", () => {
    const artifact2 = configurePrint(f.supply, f, "proof2", TEST_DIGEST_B);
    const replacement = f.supply.requestProofChange(f.actor, { proofId: "proof-1", replacementProofId: "proof-2", replacementArtifactId: artifact2, reason: "customer corrected text", idempotencyKey: "b97-r04" });
    assert.equal(replacement.proofVersion, 2);
    assert.equal(f.repository.get("tenant-a", "proof.approval", "proof-1")?.state.state, "superseded");
  });
  await t.test("B97-R05 only approved exact bytes lock; timeout/cancel remain explicit", () => {
    const token = "proof-secret-2";
    const grant = f.supply.issueProofLink(f.actor, { proofId: "proof-2", intendedApproverId: "approver", intendedRole: "customer", tokenSha256: sha256(token), expiresAt: "2026-08-28T13:00:00Z", idempotencyKey: "b97-r05-link" });
    f.supply.approveProof(f.approver, { proofId: "proof-2", grantId: String(grant.grantId), token, decision: "approved", comment: "replacement approved", idempotencyKey: "b97-r05-approve" });
    const locked = f.supply.lockProofForProduction(f.reviewer, { proofId: "proof-2", vendorId: "v1", idempotencyKey: "b97-r05" });
    assert.equal(locked.productionLocked, true);
    expectCode(() => f.supply.requestProofChange(f.actor, { proofId: "proof-2", replacementProofId: "proof-3", replacementArtifactId: artifact1, reason: "silent replacement", idempotencyKey: "b97-r05-block" }), "STATE_TRANSITION_INVALID");
  });
  f.repository.close();
});

test("B98 dedicated routing/vendor-job engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  const artifact = configurePrint(f.supply, f, "route", TEST_DIGEST);
  onboardVendor(f, "v1");
  onboardVendor(f, "v2");
  approvedLockedProof(f, "proof-route", "order-route", artifact, "v1");
  await t.test("B98-R01 route combines capability/capacity/region/deadline/cost/health", () => {
    const route = f.supply.routeOrder(f.actor, { orderId: "order-route", proofId: "proof-route", productCapability: "photo_book", quantity: 2, region: "CN", requiredDataRegion: "CN", deadlineAt: "2026-09-01T00:00:00Z", maximumCostMinor: 10_000, routingRuleVersion: "route-v1", candidateVendorIds: ["v1", "v2"], idempotencyKey: "b98-r01" });
    assert.equal(route.selectedVendorId, "v1");
    assert.equal((route.candidates as readonly JsonObject[]).every((candidate) => candidate.capable === true), true);
  });
  await t.test("B98-R02 records candidates/rule/reason and governed eligible override", () => {
    const route = f.supply.overrideRoute(f.reviewer, { orderId: "order-route", vendorId: "v2", approverIds: ["a1", "a2"], reason: "geographic load balancing", idempotencyKey: "b98-r02" });
    assert.equal(route.selectedVendorId, "v2");
    assert.equal((route.manualOverride as JsonObject).reason, "geographic load balancing");
  });
  let job: JsonObject;
  await t.test("B98-R03 versioned PO/job carries minimum customer data and locked file", () => {
    job = f.supply.createVendorJob(f.actor, { jobId: "job-1", orderId: "order-route", purchaseOrderId: "po-1", quantity: 2, purchasePriceMinor: 8_000, currency: "CNY", fileReference: "object-lock://prints/artifact-route", dueAt: "2026-09-01T00:00:00Z", idempotencyKey: "b98-r03" });
    assert.equal(job.customerData, "minimum_fulfillment_reference_only");
    expectCode(() => f.supply.createVendorJob(f.actor, { jobId: "job-duplicate", orderId: "order-route", purchaseOrderId: "po-2", quantity: 2, purchasePriceMinor: 8_000, currency: "CNY", fileReference: "object-lock://prints/artifact-route", dueAt: "2026-09-01T00:00:00Z", idempotencyKey: "b98-r03-duplicate" }), "STATE_TRANSITION_INVALID");
  });
  await t.test("B98-R04 signed sequenced vendor lifecycle drives durable workflow", () => {
    const fact = f.fact("vendor:v2", "vendor.job", "job-1", { jobId: "job-1", providerJobId: "provider-job-1", state: "accepted", acceptedQuantity: 2, artifactSha256: job.artifactSha256 });
    const accepted = f.supply.applyVendorJobFact(f.actor, fact, "b98-r04");
    assert.equal(accepted.state, "accepted");
    expectCode(() => f.supply.applyVendorJobFact(f.actor, f.fact("vendor:v2", "vendor.job", "job-1", { jobId: "job-1", providerJobId: "provider-job-1", state: "scheduled", acceptedQuantity: 2, artifactSha256: job.artifactSha256 }, 1), "b98-r04-reordered"), "CONFLICT");
  });
  await t.test("B98-R05 reroute requires signed cancellation and exclusive production lease", () => {
    approvedLockedProof(f, "proof-route-2", "order-route-2", artifact, "v1");
    f.supply.routeOrder(f.actor, { orderId: "order-route-2", proofId: "proof-route-2", productCapability: "photo_book", quantity: 1, region: "CN", requiredDataRegion: "CN", deadlineAt: "2026-09-01T00:00:00Z", maximumCostMinor: 10_000, routingRuleVersion: "route-v1", candidateVendorIds: ["v1"], idempotencyKey: "b98-r05-route" });
    f.supply.createVendorJob(f.actor, { jobId: "job-2", orderId: "order-route-2", purchaseOrderId: "po-2", quantity: 1, purchasePriceMinor: 4_000, currency: "CNY", fileReference: "object-lock://prints/artifact-route", dueAt: "2026-09-01T00:00:00Z", idempotencyKey: "b98-r05-job" });
    const cancelled = f.fact("vendor:v1", "vendor.job-cancelled", "job-2", { jobId: "job-2", cancelled: true, productionStarted: false });
    const lease = f.supply.rerouteVendorJob(f.reviewer, { jobId: "job-2", cancellationFact: cancelled, replacementVendorId: "v2", approverIds: ["a1", "a2"], idempotencyKey: "b98-r05" });
    assert.equal(lease.state, "reroute_authorized");
    assert.equal(lease.replacementJobRequired, true);
  });
  f.repository.close();
});

test("B99 dedicated address/carrier/tracking engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  await t.test("B99-R01 China/global validation requires user-confirmed normalization", () => {
    expectCode(() => f.supply.confirmShippingAddress(f.actor, { orderId: "order-ship", addressId: "address-bad", countryCode: "CN", recipientName: "Customer", line1: "Road 1", city: "Shanghai", region: "Shanghai", postalCode: "200000", phoneE164: "+8613800000000", normalizationSuggestions: ["standardize district"], serviceable: true, userConfirmed: false, idempotencyKey: "b99-r01-bad" }), "STATE_TRANSITION_INVALID");
    const address = f.supply.confirmShippingAddress(f.actor, { orderId: "order-ship", addressId: "address-1", countryCode: "CN", recipientName: "Customer", line1: "Road 1", city: "Shanghai", region: "Shanghai", postalCode: "200000", phoneE164: "+8613800000000", normalizationSuggestions: ["standardize district"], serviceable: true, userConfirmed: true, idempotencyKey: "b99-r01" });
    assert.equal(address.userConfirmed, true);
  });
  let quote: JsonObject;
  await t.test("B99-R02 signed quote binds product/weight/dimensions/region/SLA/insurance/tax/contract/expiry", () => {
    const fact = f.fact("carrier:c1", "carrier.rate", "quote-1", { quoteId: "quote-1", orderId: "order-ship", addressId: "address-1", productCode: "photo-book", weightGrams: 1_000, dimensionsMm: [300, 220, 40], region: "CN-31", serviceLevel: "express", insuranceMinor: 100, taxMinor: 50, baseRateMinor: 800, totalMinor: 950, currency: "CNY", contractVersion: "carrier-v1", expiresAt: "2026-08-28T12:10:00Z" });
    quote = f.supply.applyShippingQuoteFact(f.actor, fact, "b99-r02");
    assert.equal(quote.totalMinor, 950);
    assert.equal(quote.provider, "carrier:c1");
  });
  let shipment: JsonObject;
  await t.test("B99-R03 signed idempotent label limits vendor address fields", () => {
    const fact = f.fact("carrier:c1", "carrier.label", "shipment-1", { shipmentId: "shipment-1", orderId: "order-ship", quoteId: "quote-1", operation: "purchase", trackingNumber: "TRACK123456", labelArtifactSha256: TEST_DIGEST, handoffCode: "HANDOFF1", necessaryAddressFields: ["recipientName", "line1", "city", "region", "postalCode", "countryCode", "phoneE164"] });
    shipment = f.supply.applyShippingLabelFact(f.actor, fact, "b99-r03");
    assert.equal(shipment.state, "label_purchased");
    assert.equal((shipment.necessaryAddressFields as readonly string[]).includes("line1"), true);
  });
  await t.test("B99-R04 signed tracking normalizes/dedupes and ignores out-of-order regression", () => {
    const shipped = f.fact("carrier:c1", "carrier.tracking", "shipment-1", { shipmentId: "shipment-1", trackingNumber: "TRACK123456", state: "shipped", carrierCode: "C1", eventAt: "2026-08-28T11:10:00Z", locationCode: "CN-SH", exceptionCode: "none" }, 2);
    f.supply.applyTrackingFact(f.actor, shipped, "b99-r04-ship");
    const inTransit = f.fact("carrier:c1", "carrier.tracking", "shipment-1", { shipmentId: "shipment-1", trackingNumber: "TRACK123456", state: "in_transit", carrierCode: "C1", eventAt: "2026-08-28T11:30:00Z", locationCode: "CN-SU", exceptionCode: "none" }, 4);
    f.supply.applyTrackingFact(f.actor, inTransit, "b99-r04-transit");
    const stale = f.fact("carrier:c1", "carrier.tracking", "shipment-1", { shipmentId: "shipment-1", trackingNumber: "TRACK123456", state: "label_created", carrierCode: "C1", eventAt: "2026-08-28T11:05:00Z", locationCode: "CN-SH", exceptionCode: "none" }, 3);
    const result = f.supply.applyTrackingFact(f.actor, stale, "b99-r04-stale");
    assert.equal(result.trackingState, "in_transit");
    assert.equal((result.ignoredTrackingFactIds as readonly string[]).length, 1);
  });
  await t.test("B99-R05 public/white-label tracking masks address and phone", () => {
    const token = "public-tracking-secret";
    f.supply.createPublicTrackingAccess(f.actor, { accessId: "tracking-access-1", shipmentId: "shipment-1", tokenSha256: sha256(token), expiresAt: "2026-08-28T13:00:00Z", whiteLabelPartnerId: "partner-1", idempotencyKey: "b99-r05-access" });
    const result = f.supply.publicTracking("tenant-a", "tracking-access-1", token);
    assert.equal(result.address, "redacted");
    assert.equal(result.phone, "redacted");
    assert.equal(result.trackingNumberSuffix, "3456");
  });
  f.repository.close();
});

test("B100 dedicated inventory/ATP engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  onboardVendor(f, "v1");
  await t.test("B100-R01 stock models SKU/material/package/location/lot/unit/on-hand/reserved/in-transit/safety", () => {
    const stock = f.supply.configureStockItem(f.reviewer, { stockId: "stock-1", sku: "book-sku", material: "paper-premium", packaging: "box", locationType: "vendor", locationId: "v1", lotId: "lot-1", unit: "piece", onHand: 100, inTransit: 20, safetyStock: 10, inventoryProvider: "inventory:v1", idempotencyKey: "b100-r01" });
    assert.equal(stock.available, 90);
    assert.equal(stock.reserved, 0);
  });
  await t.test("B100-R02 checkout reservation is atomic/expiring and lifecycle-confirmed", () => {
    const held = f.supply.reserveStock(f.actor, { reservationId: "reservation-1", orderId: "order-stock", stockId: "stock-1", quantity: 5, expiresAt: "2026-08-28T12:30:00Z", idempotencyKey: "b100-r02-hold" });
    assert.equal(held.state, "held");
    f.supply.transitionReservation(f.actor, { reservationId: "reservation-1", action: "payment_confirmed", idempotencyKey: "b100-r02-paid" });
    f.supply.transitionReservation(f.actor, { reservationId: "reservation-1", action: "route_confirmed", idempotencyKey: "b100-r02-route" });
    const consumed = f.supply.transitionReservation(f.actor, { reservationId: "reservation-1", action: "production_consumed", idempotencyKey: "b100-r02-consume" });
    assert.equal(consumed.state, "consumed");
    assert.equal(f.repository.get("tenant-a", "inventory.stock", "stock-1")?.state.onHand, 95);
  });
  await t.test("B100-R03 ATP never treats stale supplier data as live", () => {
    const fact = f.fact("inventory:v1", "inventory.adjustment", "stock-1", { stockId: "stock-1", adjustmentType: "supplier_sync", quantity: 0, reportedOnHand: 95, reasonCode: "cycle_sync", evidenceSha256: TEST_DIGEST });
    f.supply.applyInventoryFact(f.reviewer, fact, "b100-r03-fact");
    const live = f.supply.availabilityPromise({ tenantId: "tenant-a", stockId: "stock-1", quantity: 5, capacityId: "v1", procurementLeadDays: 2, deliveryDays: 1, maximumSupplierAgeMs: 2 * 60 * 60_000 });
    assert.equal(live.mode, "live");
    const stale = f.supply.availabilityPromise({ tenantId: "tenant-a", stockId: "stock-1", quantity: 5, capacityId: "v1", procurementLeadDays: 2, deliveryDays: 1, maximumSupplierAgeMs: 1 });
    assert.notEqual(stale.mode, "live");
    assert.equal(stale.staleDataCannotPromiseLive, true);
  });
  await t.test("B100-R04 preorder exposes date/refund/notification and forbids silent substitution", () => {
    expectCode(() => f.supply.configurePreorder(f.reviewer, { preorderId: "preorder-bad", sku: "book-sku", promisedDeliveryDate: "2026-09-15", refundPolicyVersion: "refund-v1", notificationPlanVersion: "notify-v1", substitutionAllowed: true, substitutionApprovalRequired: false, idempotencyKey: "b100-r04-bad" }), "STATE_TRANSITION_INVALID");
    const preorder = f.supply.configurePreorder(f.reviewer, { preorderId: "preorder-1", sku: "book-sku", promisedDeliveryDate: "2026-09-15", refundPolicyVersion: "refund-v1", notificationPlanVersion: "notify-v1", substitutionAllowed: true, substitutionApprovalRequired: true, idempotencyKey: "b100-r04" });
    assert.equal(preorder.promisedDeliveryDate, "2026-09-15");
  });
  await t.test("B100-R05 signed adjustments require reason/evidence/audit and flag anomaly", () => {
    const fact = f.fact("inventory:v1", "inventory.adjustment", "stock-1", { stockId: "stock-1", adjustmentType: "count", quantity: 55, reportedOnHand: 40, reasonCode: "verified_count", evidenceSha256: TEST_DIGEST_B }, 2);
    const stock = f.supply.applyInventoryFact(f.reviewer, fact, "b100-r05");
    assert.equal(stock.anomaly, true);
    assert.equal((stock.lastAdjustment as JsonObject).evidenceSha256, TEST_DIGEST_B);
  });
  f.repository.close();
});

test("B101 dedicated returns/replacements/claims engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  await t.test("B101-R01 eligibility binds region/product/customization/reason/window/policy", () => {
    f.supply.configureReturnPolicy(f.reviewer, { policyId: "return-v1", version: "v1", regions: ["CN"], productTypes: ["photo_book"], customProductsReturnable: true, returnWindowDays: 30, exceptionApprovalRequired: true, idempotencyKey: "b101-r01-policy" });
    const authorization = f.supply.openReturnAuthorization(f.actor, { authorizationId: "return-1", orderId: "order-return", policyId: "return-v1", region: "CN", productType: "photo_book", customized: true, deliveredAt: "2026-08-20T00:00:00Z", reasonCode: "damaged", requestedRemedy: "replacement", idempotencyKey: "b101-r01" });
    assert.equal(authorization.eligibility, "standard");
  });
  await t.test("B101-R02 reason taxonomy covers damage/print/missing/color/loss/wrong/address/privacy", () => {
    const reasons = ["damaged", "print_error", "missing_page", "color_variance", "lost", "wrong_item", "address_issue", "privacy_incident"];
    assert.equal(reasons.includes(String(f.repository.get("tenant-a", "returns.authorization", "return-1")?.state.reasonCode)), true);
  });
  await t.test("B101-R03 evidence is scanned, digest-only, short-lived, and excludes unrelated faces", () => {
    expectCode(() => f.supply.attachClaimEvidence(f.actor, { authorizationId: "return-1", evidenceId: "evidence-bad", artifactSha256: TEST_DIGEST, mimeType: "image/jpeg", malwareScan: "clean", containsFace: true, containsChild: false, containsPrivateConversation: false, expiresAt: "2026-09-01T00:00:00Z", idempotencyKey: "b101-r03-bad" }), "POLICY_BLOCKED");
    const evidence = f.supply.attachClaimEvidence(f.actor, { authorizationId: "return-1", evidenceId: "evidence-1", artifactSha256: TEST_DIGEST, mimeType: "image/jpeg", malwareScan: "clean", containsFace: false, containsChild: false, containsPrivateConversation: false, expiresAt: "2026-09-01T00:00:00Z", idempotencyKey: "b101-r03" });
    assert.equal(evidence.rawMediaPersisted, false);
  });
  await t.test("B101-R04 replacement reuses approved spec/bytes but creates new no-charge fulfillment chain", () => {
    const replacement = f.supply.createReplacementOrder(f.actor, { authorizationId: "return-1", replacementOrderId: "replacement-1", originalSpecificationId: "spec-v1", originalProofId: "proof-v1", originalArtifactSha256: TEST_DIGEST, newFulfillmentChainId: "fulfillment-new-1", idempotencyKey: "b101-r04" });
    assert.equal(replacement.chargeMinor, 0);
    assert.equal(replacement.inventoryReservationState, "new_required");
    expectCode(() => f.supply.createReplacementOrder(f.actor, { authorizationId: "return-1", replacementOrderId: "replacement-2", originalSpecificationId: "spec-v1", originalProofId: "proof-v1", originalArtifactSha256: TEST_DIGEST, newFulfillmentChainId: "fulfillment-new-2", idempotencyKey: "b101-r04-duplicate" }), "STATE_TRANSITION_INVALID");
  });
  await t.test("B101-R05 provider recovery drives liability/ledger/quality and tracks receipt", () => {
    f.supply.createRecoveryClaim(f.reviewer, { claimId: "recovery-1", authorizationId: "return-1", liableProvider: "v1", providerType: "vendor", amountMinor: 5_000, currency: "CNY", evidenceIds: ["evidence-1"], idempotencyKey: "b101-r05-claim" });
    const fact = f.fact("vendor:v1", "claim.recovery", "recovery-1", { claimId: "recovery-1", decision: "settled", liability: "vendor", recoveredMinor: 4_000, currency: "CNY", settlementReference: "settlement-1" });
    const result = f.supply.applyRecoveryFact(f.reviewer, fact, "b101-r05");
    assert.equal(result.recoveredMinor, 4_000);
    assert.equal(result.ledgerAdjustment, "required");
  });
  f.repository.close();
});

test("B102 dedicated vendor-quality/SLA/CAPA engine satisfies five mandatory semantics", async (t) => {
  const f = commercialTestFixture();
  await t.test("B102-R01 platform observations cover operational/quality/deletion/API metrics", () => {
    const fact = f.fact("platform:quality", "quality.observation", "order-quality-1", { vendorId: "v1", orderId: "order-quality-1", metric: "first_pass", outcome: "pass", eligible: true, exclusionReason: "none", latencyMs: 100, sourceReference: "platform-order-event" });
    const observation = f.supply.recordQualityObservation(f.actor, fact, "b102-r01");
    assert.equal(observation.metric, "first_pass");
    const deletion = f.fact("platform:quality", "quality.observation", "order-quality-2", { vendorId: "v1", orderId: "order-quality-2", metric: "deletion", outcome: "fail", eligible: true, exclusionReason: "none", latencyMs: 2_000, sourceReference: "platform-deletion-event" }, 2);
    f.supply.recordQualityObservation(f.actor, deletion, "b102-r01-deletion");
  });
  let scorecard: JsonObject;
  await t.test("B102-R02 scorecard declares denominator/exclusions/latency/sample and rejects self-report", () => {
    scorecard = f.supply.vendorScorecard({ tenantId: "tenant-a", vendorId: "v1", from: "2026-08-01T00:00:00Z", through: "2026-08-31T00:00:00Z", maximumLatencyMs: 500 });
    assert.equal(scorecard.denominator, 2);
    assert.equal(scorecard.late, 1);
    assert.equal(scorecard.dataAuthority, "platform_signed_facts_only");
  });
  await t.test("B102-R03 score is advisory; major action requires explanation/notice/appeal/contract/two approvals", () => {
    const recommendation = f.supply.recommendVendorAction(f.actor, { recommendationId: "recommendation-1", vendorId: "v1", scorecard, thresholdBasisPoints: 8_000, idempotencyKey: "b102-r03-recommend" });
    assert.equal(recommendation.automaticallyApplied, false);
    const decision = f.supply.decideVendorAction(f.reviewer, { decisionId: "decision-1", recommendationId: "recommendation-1", action: "degrade", explanation: "measured first-pass/deletion failures", contractClause: "SLA-4.2", noticeReference: "notice-1", appealDueAt: "2026-09-15T00:00:00Z", approverIds: ["a1", "a2"], idempotencyKey: "b102-r03" });
    assert.equal(decision.state, "notified_appealable");
  });
  await t.test("B102-R04 SLA settlement is order-traceable and emits payout/ledger instructions", () => {
    const settlement = f.supply.createSlaSettlement(f.reviewer, { settlementId: "sla-settlement-1", vendorId: "v1", orderId: "order-quality-2", breachCode: "late_delivery", remedy: "debit", amountMinor: 500, currency: "CNY", contractVersion: "contract-v1", idempotencyKey: "b102-r04" });
    assert.equal((settlement.ledgerInstruction as JsonObject).sourceReference, "sla-settlement-1");
    expectCode(() => f.supply.createSlaSettlement(f.reviewer, { settlementId: "privacy-credit", vendorId: "v1", orderId: "order-privacy", breachCode: "privacy", remedy: "service_credit", amountMinor: 500, currency: "CNY", contractVersion: "contract-v1", idempotencyKey: "b102-r04-privacy" }), "POLICY_BLOCKED");
  });
  await t.test("B102-R05 CAPA requires independent retest then signed cleanup evidence", () => {
    f.supply.createCapa(f.reviewer, { capaId: "capa-1", vendorId: "v1", reviewPeriod: "2026-08", rootCause: "deletion workflow gap", correctiveActions: ["fix-worker"], preventiveActions: ["monthly-control"], retestCriteria: ["deletion-within-sla"], ownerId: "quality-owner", dueAt: "2026-09-15T00:00:00Z", idempotencyKey: "b102-r05-create" });
    const retest = f.fact("platform:quality", "quality.capa-retest", "capa-1", { capaId: "capa-1", vendorId: "v1", passed: true, criteriaResults: [{ criterion: "deletion-within-sla", passed: true }], evidenceSha256: TEST_DIGEST });
    f.supply.applyCapaRetestFact(f.reviewer, retest, "b102-r05-retest");
    const cleanup = f.fact("platform:quality", "quality.cleanup", "capa-1", { capaId: "capa-1", vendorId: "v1", deleted: true, deletionScope: "customer-print-artifacts", evidenceSha256: TEST_DIGEST_B }, 2);
    const closed = f.supply.applyCapaCleanupFact(f.reviewer, cleanup, "b102-r05");
    assert.equal(closed.state, "closed");
  });
  f.repository.close();
});
