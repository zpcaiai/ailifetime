import {
  CommercialOperationsError,
  assertActor,
  assertExactKeys,
  basisPoints,
  conflict,
  currency,
  dateOnly,
  exactUtc,
  freeze,
  identifier,
  minor,
  nonEmpty,
  requireState,
  sha256,
  sortedUnique,
  type CommercialActor,
  type JsonObject,
  type JsonValue,
} from "./common.js";
import { CommercialFactVerifier, type SignedCommercialFact, type VerifiedCommercialFact } from "./signed-facts.js";
import type { AggregateSnapshot, CommercialOperationsRepository } from "./store.js";

const SUPPLY_ROLES = ["supply_operator", "vendor_manager", "platform_admin"] as const;
const APPROVER_ROLES = ["supply_manager", "vendor_manager", "quality_manager", "platform_admin"] as const;
const TRACKING_STATES = ["label_created", "shipped", "in_transit", "out_for_delivery", "exception", "delivered", "returned"] as const;
const CLAIM_REASONS = ["damaged", "print_error", "missing_page", "color_variance", "lost", "wrong_item", "address_issue", "privacy_incident"] as const;

export interface SupplyEngineOptions {
  readonly repository: CommercialOperationsRepository;
  readonly factVerifier: CommercialFactVerifier;
  readonly clock?: () => Date;
}

/** Dedicated B95-B102 print and physical-supply domain engine. */
export class SupplyOperationsEngine {
  readonly #repository: CommercialOperationsRepository;
  readonly #facts: CommercialFactVerifier;
  readonly #clock: () => Date;

  constructor(options: SupplyEngineOptions) {
    this.#repository = options.repository;
    this.#facts = options.factVerifier;
    this.#clock = options.clock ?? (() => new Date());
  }

  // B95 — immutable product specifications and server-side print preflight.
  configurePrintSpecification(actor: CommercialActor, input: {
    readonly specificationId: string;
    readonly version: string;
    readonly productType: "photo_book" | "frame" | "card" | "calendar" | "gift_box";
    readonly widthMm: number;
    readonly heightMm: number;
    readonly pageCount: number;
    readonly material: string;
    readonly binding: string;
    readonly packaging: string;
    readonly colorProfile: "CMYK_FOGRA39" | "CMYK_GRACOL";
    readonly bleedMm: number;
    readonly safeZoneMm: number;
    readonly vendorCapabilityVersion: string;
    readonly templateLicenseId: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    for (const [field, value] of [["widthMm", input.widthMm], ["heightMm", input.heightMm], ["bleedMm", input.bleedMm], ["safeZoneMm", input.safeZoneMm]] as const) {
      if (!Number.isFinite(value) || value <= 0 || value > 2_000) throw new CommercialOperationsError("VALIDATION_FAILED", `${field} is outside production bounds`);
    }
    if (!Number.isSafeInteger(input.pageCount) || input.pageCount < 1 || input.pageCount > 1_000) throw new CommercialOperationsError("VALIDATION_FAILED", "pageCount is invalid");
    const state: JsonObject = {
      specificationId: identifier(input.specificationId, "specificationId"), version: identifier(input.version, "version"),
      productType: input.productType, widthMm: input.widthMm, heightMm: input.heightMm, pageCount: input.pageCount,
      material: identifier(input.material, "material"), binding: identifier(input.binding, "binding"), packaging: identifier(input.packaging, "packaging"),
      colorProfile: input.colorProfile, bleedMm: input.bleedMm, safeZoneMm: input.safeZoneMm,
      vendorCapabilityVersion: identifier(input.vendorCapabilityVersion, "vendorCapabilityVersion"),
      templateLicenseId: identifier(input.templateLicenseId, "templateLicenseId"), status: "approved",
    };
    const aggregateId = `${input.specificationId}:${input.version}`;
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B95.configurePrintSpecification", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "print.specification", aggregateId, expectedVersion: null,
        state, eventType: "print.specificationApproved", event: { specificationId: input.specificationId, version: input.version, vendorCapabilityVersion: input.vendorCapabilityVersion },
      }).state,
    }).value as JsonObject;
  }

  validateLayout(actor: CommercialActor, input: {
    readonly layoutId: string;
    readonly specificationId: string;
    readonly specificationVersion: string;
    readonly cropFocusWithinSafeZone: boolean;
    readonly textOverflowCount: number;
    readonly lowResolutionAssetIds: readonly string[];
    readonly spreadWarnings: readonly string[];
    readonly aiDisclosurePresent: boolean;
    readonly copyrightAttributionIds: readonly string[];
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    this.#required(actor.tenantId, "print.specification", `${input.specificationId}:${input.specificationVersion}`);
    if (!Number.isSafeInteger(input.textOverflowCount) || input.textOverflowCount < 0) throw new CommercialOperationsError("VALIDATION_FAILED", "text overflow count is invalid");
    const blockers = [
      ...(input.cropFocusWithinSafeZone ? [] : ["crop_focus_outside_safe_zone"]),
      ...(input.textOverflowCount === 0 ? [] : ["text_overflow"]),
      ...(input.lowResolutionAssetIds.length === 0 ? [] : ["low_resolution"]),
      ...(input.aiDisclosurePresent ? [] : ["ai_disclosure_missing"]),
      ...(input.copyrightAttributionIds.length > 0 ? [] : ["copyright_attribution_missing"]),
    ];
    const state: JsonObject = {
      layoutId: identifier(input.layoutId, "layoutId"), specificationId: input.specificationId,
      specificationVersion: input.specificationVersion, cropFocusWithinSafeZone: input.cropFocusWithinSafeZone,
      textOverflowCount: input.textOverflowCount, lowResolutionAssetIds: sortedUnique(input.lowResolutionAssetIds, "lowResolutionAssetIds", 0),
      spreadWarnings: sortedUnique(input.spreadWarnings, "spreadWarnings", 0), aiDisclosurePresent: input.aiDisclosurePresent,
      copyrightAttributionIds: sortedUnique(input.copyrightAttributionIds, "copyrightAttributionIds", 0), blockers,
      state: blockers.length === 0 ? "layout_ready" : "layout_blocked",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B95.validateLayout", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "print.layout", aggregateId: input.layoutId,
        expectedVersion: this.#repository.get(actor.tenantId, "print.layout", input.layoutId)?.version ?? null,
        state, eventType: blockers.length === 0 ? "print.layoutReady" : "print.layoutBlocked", event: { blockers, spreadWarnings: state.spreadWarnings },
      }).state,
    }).value as JsonObject;
  }

  preflightPrintArtifact(actor: CommercialActor, input: {
    readonly artifactId: string;
    readonly layoutId: string;
    readonly specificationId: string;
    readonly specificationVersion: string;
    readonly pdfSha256: string;
    readonly thumbnailManifestSha256: string;
    readonly layoutManifestSha256: string;
    readonly mimeType: "application/pdf";
    readonly pageCount: number;
    readonly minimumDpi: number;
    readonly colorSpace: string;
    readonly bleedMm: number;
    readonly fontsEmbedded: boolean;
    readonly transparencyFlattened: boolean;
    readonly barcodeValid: boolean;
    readonly licensedAssetIds: readonly string[];
    readonly hiddenLayerCount: number;
    readonly fileComplete: boolean;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const layout = this.#required<JsonObject>(actor.tenantId, "print.layout", input.layoutId);
    requireState(layout.state.state === "layout_ready", "blocked layout cannot become a print artifact");
    const spec = this.#required<JsonObject>(actor.tenantId, "print.specification", `${input.specificationId}:${input.specificationVersion}`).state;
    for (const digest of [input.pdfSha256, input.thumbnailManifestSha256, input.layoutManifestSha256]) {
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new CommercialOperationsError("VALIDATION_FAILED", "print artifact digest is invalid");
    }
    const checks: JsonObject = {
      resolution: input.minimumDpi >= 300,
      colorSpace: input.colorSpace === spec.colorProfile,
      bleed: input.bleedMm >= Number(spec.bleedMm),
      fonts: input.fontsEmbedded,
      transparency: input.transparencyFlattened,
      pageCount: input.pageCount === spec.pageCount,
      barcode: input.barcodeValid,
      license: input.licensedAssetIds.length > 0,
      hiddenLayers: input.hiddenLayerCount === 0,
      integrity: input.fileComplete,
    };
    const failures = Object.entries(checks).filter(([, passed]) => passed !== true).map(([name]) => name);
    const state: JsonObject = {
      artifactId: identifier(input.artifactId, "artifactId"), layoutId: input.layoutId,
      specificationId: input.specificationId, specificationVersion: input.specificationVersion,
      pdfSha256: input.pdfSha256, thumbnailManifestSha256: input.thumbnailManifestSha256,
      layoutManifestSha256: input.layoutManifestSha256, mimeType: input.mimeType,
      immutable: true, checks, failures, status: failures.length === 0 ? "preflight_passed" : "preflight_failed",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B95.preflightPrintArtifact", request: { ...state, licensedAssetIds: input.licensedAssetIds },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "print.artifact", aggregateId: input.artifactId, expectedVersion: null,
        state, eventType: failures.length === 0 ? "print.preflightPassed" : "print.preflightFailed", event: { checks, failures, pdfSha256: input.pdfSha256 },
      }).state,
    }).value as JsonObject;
  }

  pinPaidOrderPrintVersion(actor: CommercialActor, input: {
    readonly orderId: string;
    readonly artifactId: string;
    readonly specificationVersion: string;
    readonly paid: boolean;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    if (!input.paid) throw new CommercialOperationsError("POLICY_BLOCKED", "only paid physical orders can pin production inputs");
    const artifact = this.#required<JsonObject>(actor.tenantId, "print.artifact", input.artifactId);
    requireState(artifact.state.status === "preflight_passed", "preflight failure cannot be pinned for production");
    if (artifact.state.specificationVersion !== input.specificationVersion) conflict("order specification and print artifact version differ");
    const state: JsonObject = {
      orderId: identifier(input.orderId, "orderId"), artifactId: input.artifactId,
      artifactSha256: artifact.state.pdfSha256, specificationVersion: input.specificationVersion,
      paid: true, state: "version_pinned", replacementVersion: null,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B95.pinPaidOrder", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "print.orderVersion", aggregateId: input.orderId, expectedVersion: null,
        state, eventType: "print.orderVersionPinned", event: { artifactId: input.artifactId, artifactSha256: state.artifactSha256, specificationVersion: input.specificationVersion },
      }).state,
    }).value as JsonObject;
  }

  approvePrintRegeneration(actor: CommercialActor, input: {
    readonly orderId: string;
    readonly newArtifactId: string;
    readonly approverIds: readonly string[];
    readonly differenceEvidenceSha256: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES, input.approverIds);
    if (!/^[a-f0-9]{64}$/.test(input.differenceEvidenceSha256)) throw new CommercialOperationsError("VALIDATION_FAILED", "print regeneration requires difference evidence");
    const order = this.#required<JsonObject>(actor.tenantId, "print.orderVersion", input.orderId);
    const artifact = this.#required<JsonObject>(actor.tenantId, "print.artifact", input.newArtifactId);
    requireState(artifact.state.status === "preflight_passed", "replacement artifact must pass fresh preflight");
    if (artifact.state.pdfSha256 === order.state.artifactSha256) conflict("regeneration does not change the immutable print bytes");
    const approvals = sortedUnique(input.approverIds, "approverIds", 2);
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B95.approveRegeneration",
      request: { orderId: input.orderId, newArtifactId: input.newArtifactId, approverIds: approvals, differenceEvidenceSha256: input.differenceEvidenceSha256 },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "print.orderVersion", aggregateId: order.aggregateId, expectedVersion: order.version,
        state: { ...order.state, replacementVersion: { artifactId: input.newArtifactId, artifactSha256: artifact.state.pdfSha256, specificationVersion: artifact.state.specificationVersion, approvals, differenceEvidenceSha256: input.differenceEvidenceSha256 }, state: "regeneration_approved" },
        eventType: "print.regenerationApproved", event: { newArtifactId: input.newArtifactId, approvals, differenceEvidenceSha256: input.differenceEvidenceSha256 },
      }).state,
    }).value as JsonObject;
  }

  // B96 — contractual vendor catalog, frozen price books, signed capacity and revocation.
  onboardVendor(actor: CommercialActor, input: {
    readonly vendorId: string;
    readonly legalEntity: string;
    readonly facilities: readonly string[];
    readonly regions: readonly string[];
    readonly productCapabilities: readonly string[];
    readonly certifications: readonly { readonly name: string; readonly expiresAt: string }[];
    readonly dataProcessingAgreementVersion: string;
    readonly contractVersion: string;
    readonly contractExpiresAt: string;
    readonly credentialReference: string;
    readonly networkPolicyId: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    if (!input.credentialReference.startsWith("secret-manager:") || /BEGIN|password|token=/i.test(input.credentialReference)) {
      throw new CommercialOperationsError("CONFIGURATION_INVALID", "vendor credential must be a managed reference, never secret material");
    }
    const certifications = input.certifications.map((item) => ({ name: identifier(item.name, "certification"), expiresAt: exactUtc(item.expiresAt, "certification expiresAt") }));
    const state: JsonObject = {
      vendorId: identifier(input.vendorId, "vendorId"), legalEntity: nonEmpty(input.legalEntity, "legalEntity"),
      facilities: sortedUnique(input.facilities, "facilities"), regions: sortedUnique(input.regions, "regions"),
      productCapabilities: sortedUnique(input.productCapabilities, "productCapabilities"), certifications,
      dataProcessingAgreementVersion: identifier(input.dataProcessingAgreementVersion, "dataProcessingAgreementVersion"),
      contractVersion: identifier(input.contractVersion, "contractVersion"), contractExpiresAt: exactUtc(input.contractExpiresAt, "contractExpiresAt"),
      credentialReference: input.credentialReference, networkPolicyId: identifier(input.networkPolicyId, "networkPolicyId"),
      status: "active", accessScope: "fulfillment_minimum_only", rawMediaAccess: "time_limited_when_required", terminatedAt: null,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B96.onboardVendor", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "vendor.profile", aggregateId: input.vendorId, expectedVersion: null,
        state, eventType: "vendor.onboarded", event: { contractVersion: input.contractVersion, regions: state.regions, capabilities: state.productCapabilities },
      }).state,
    }).value as JsonObject;
  }

  approvePriceBook(actor: CommercialActor, input: {
    readonly priceBookId: string;
    readonly vendorId: string;
    readonly version: string;
    readonly effectiveFrom: string;
    readonly effectiveUntil: string;
    readonly currency: string;
    readonly entries: readonly { readonly product: string; readonly process: string; readonly minimumQuantity: number; readonly unitMinor: number; readonly rushMinor: number; readonly packagingMinor: number; readonly shippingMinor: number; readonly taxBasisPoints: number }[];
    readonly approverIds: readonly string[];
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES, input.approverIds);
    const vendor = this.#required<JsonObject>(actor.tenantId, "vendor.profile", input.vendorId);
    requireState(vendor.state.status === "active", "inactive vendor cannot receive a new price book");
    const effectiveFrom = dateOnly(input.effectiveFrom, "effectiveFrom");
    const effectiveUntil = dateOnly(input.effectiveUntil, "effectiveUntil");
    if (effectiveUntil < effectiveFrom) throw new CommercialOperationsError("VALIDATION_FAILED", "price book effective range is invalid");
    const overlap = this.#repository.listEvents(actor.tenantId, "vendor.priceBook").some((event) => {
      const book = event.payload;
      return book.vendorId === input.vendorId && book.status === "approved" && String(book.effectiveFrom) <= effectiveUntil && String(book.effectiveUntil) >= effectiveFrom;
    });
    if (overlap) conflict("vendor price book effective period overlaps an approved frozen version");
    const entries = input.entries.map((entry) => ({
      product: identifier(entry.product, "product"), process: identifier(entry.process, "process"),
      minimumQuantity: integer(entry.minimumQuantity, "minimumQuantity", 1), unitMinor: minor(entry.unitMinor),
      rushMinor: minor(entry.rushMinor, "rushMinor", true), packagingMinor: minor(entry.packagingMinor, "packagingMinor", true),
      shippingMinor: minor(entry.shippingMinor, "shippingMinor", true), taxBasisPoints: basisPoints(entry.taxBasisPoints),
    }));
    const state: JsonObject = {
      priceBookId: identifier(input.priceBookId, "priceBookId"), vendorId: input.vendorId, version: identifier(input.version, "version"),
      effectiveFrom, effectiveUntil, currency: currency(input.currency), entries, approvals: sortedUnique(input.approverIds, "approverIds", 2),
      status: "approved", frozen: true,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B96.approvePriceBook", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "vendor.priceBook", aggregateId: input.priceBookId, expectedVersion: null,
        state, eventType: "vendor.priceBookApproved", event: state,
      }).state,
    }).value as JsonObject;
  }

  applyVendorCapacityFact(actor: CommercialActor, fact: SignedCommercialFact, maximumAgeMs: number, idempotencyKey: string): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "vendor.capacity");
    const vendor = this.#required<JsonObject>(actor.tenantId, "vendor.profile", verified.subjectId);
    requireState(vendor.state.status === "active", "inactive vendor capacity cannot be routed");
    assertExactKeys(verified.payload, ["vendorId", "calendarVersion", "availableUnits", "cutoffAt", "holidays", "maintenanceWindows", "minimumBatch", "serviceRegions", "confidenceBasisPoints", "updatedAt"], "vendor capacity fact");
    if (verified.provider !== `vendor:${verified.subjectId}` || verified.payload.vendorId !== verified.subjectId || Date.parse(String(verified.payload.updatedAt)) < this.#clock().getTime() - maximumAgeMs) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "vendor capacity fact is stale or misbound");
    }
    const state: JsonObject = {
      ...verified.payload, vendorId: verified.subjectId, availableUnits: integer(Number(verified.payload.availableUnits), "availableUnits", 0),
      minimumBatch: integer(Number(verified.payload.minimumBatch), "minimumBatch", 1),
      confidenceBasisPoints: basisPoints(Number(verified.payload.confidenceBasisPoints), "confidenceBasisPoints"),
      cutoffAt: exactUtc(String(verified.payload.cutoffAt), "cutoffAt"), updatedAt: exactUtc(String(verified.payload.updatedAt), "updatedAt"),
      providerFactId: verified.factId, factSha256: verified.factSha256,
    };
    return this.#atomicFact(actor, verified, idempotencyKey, "B96.applyCapacity", { vendorId: verified.subjectId, maximumAgeMs }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "vendor.capacity", aggregateId: verified.subjectId,
        expectedVersion: this.#repository.get(actor.tenantId, "vendor.capacity", verified.subjectId)?.version ?? null,
        state, eventType: "vendor.capacityUpdated", event: { availableUnits: state.availableUnits, confidenceBasisPoints: state.confidenceBasisPoints, updatedAt: state.updatedAt },
      }).state);
  }

  configureVendorSla(actor: CommercialActor, input: {
    readonly vendorId: string;
    readonly slaVersion: string;
    readonly thresholdsSeconds: Readonly<Record<"accept" | "proof" | "production" | "quality" | "ship" | "deliver" | "rework" | "dataDeletion" | "eventNotification", number>>;
    readonly effectiveFrom: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    this.#required(actor.tenantId, "vendor.profile", input.vendorId);
    const keys = ["accept", "proof", "production", "quality", "ship", "deliver", "rework", "dataDeletion", "eventNotification"] as const;
    assertExactKeys(input.thresholdsSeconds, keys, "vendor SLA thresholds");
    const thresholds = Object.fromEntries(keys.map((key) => [key, integer(input.thresholdsSeconds[key], `${key} SLA`, 1)])) as JsonObject;
    const state: JsonObject = {
      vendorId: input.vendorId, slaVersion: identifier(input.slaVersion, "slaVersion"), thresholdsSeconds: thresholds,
      effectiveFrom: dateOnly(input.effectiveFrom, "effectiveFrom"), status: "approved",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B96.configureSla", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "vendor.sla", aggregateId: `${input.vendorId}:${input.slaVersion}`, expectedVersion: null,
        state, eventType: "vendor.slaApproved", event: { slaVersion: input.slaVersion, thresholdsSeconds: thresholds },
      }).state,
    }).value as JsonObject;
  }

  terminateVendor(actor: CommercialActor, input: {
    readonly vendorId: string;
    readonly approverIds: readonly string[];
    readonly reason: string;
    readonly downstreamDeletionDueAt: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES, input.approverIds);
    const vendor = this.#required<JsonObject>(actor.tenantId, "vendor.profile", input.vendorId);
    requireState(vendor.state.status === "active", "vendor is already inactive");
    const state = {
      ...vendor.state, status: "terminated", terminatedAt: this.#clock().toISOString(),
      terminationReason: nonEmpty(input.reason, "reason"), accessRevoked: true, credentialsRevoked: true,
      networkAccessRevoked: true, downstreamDeletionDueAt: exactUtc(input.downstreamDeletionDueAt, "downstreamDeletionDueAt"),
      newRoutingBlocked: true, approvals: sortedUnique(input.approverIds, "approverIds", 2),
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B96.terminateVendor", request: { vendorId: input.vendorId, approverIds: input.approverIds, reason: input.reason, downstreamDeletionDueAt: input.downstreamDeletionDueAt },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "vendor.profile", aggregateId: vendor.aggregateId, expectedVersion: vendor.version,
        state, eventType: "vendor.terminated", event: { reason: input.reason, downstreamDeletionDueAt: input.downstreamDeletionDueAt, accessRevoked: true },
      }).state,
    }).value as JsonObject;
  }

  // B97 — version-bound proof links, approvals, changes and production lock.
  createProof(actor: CommercialActor, input: {
    readonly proofId: string;
    readonly orderId: string;
    readonly artifactId: string;
    readonly proofVersion: number;
    readonly softProofSha256: string;
    readonly thumbnailManifestSha256: string;
    readonly riskAnnotations: readonly string[];
    readonly colorDisclaimer: string;
    readonly requiredApprovalRoles: readonly string[];
    readonly requiredApprovalCount: number;
    readonly expiresAt: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const artifact = this.#required<JsonObject>(actor.tenantId, "print.artifact", input.artifactId);
    requireState(artifact.state.status === "preflight_passed", "proof requires exact preflight-passed print bytes");
    for (const digest of [input.softProofSha256, input.thumbnailManifestSha256]) if (!/^[a-f0-9]{64}$/.test(digest)) throw new CommercialOperationsError("VALIDATION_FAILED", "proof digest is invalid");
    const state: JsonObject = {
      proofId: identifier(input.proofId, "proofId"), orderId: identifier(input.orderId, "orderId"), artifactId: input.artifactId,
      artifactSha256: artifact.state.pdfSha256, proofVersion: integer(input.proofVersion, "proofVersion", 1),
      softProofSha256: input.softProofSha256, thumbnailManifestSha256: input.thumbnailManifestSha256,
      riskAnnotations: sortedUnique(input.riskAnnotations, "riskAnnotations", 0), colorDisclaimer: nonEmpty(input.colorDisclaimer, "colorDisclaimer"),
      requiredApprovalRoles: sortedUnique(input.requiredApprovalRoles, "requiredApprovalRoles"),
      requiredApprovalCount: integer(input.requiredApprovalCount, "requiredApprovalCount", 1),
      expiresAt: exactUtc(input.expiresAt, "expiresAt"), approvals: [], state: "awaiting_approval", productionLocked: false,
    };
    if (Number(state.requiredApprovalCount) > (state.requiredApprovalRoles as unknown as string[]).length) throw new CommercialOperationsError("VALIDATION_FAILED", "required proof approvals exceed roles");
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B97.createProof", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "proof.approval", aggregateId: input.proofId, expectedVersion: null,
        state, eventType: "proof.created", event: { artifactSha256: state.artifactSha256, proofVersion: input.proofVersion, riskAnnotations: state.riskAnnotations },
      }).state,
    }).value as JsonObject;
  }

  issueProofLink(actor: CommercialActor, input: {
    readonly proofId: string;
    readonly intendedApproverId: string;
    readonly intendedRole: string;
    /** Digest of a high-entropy token generated and delivered by the authenticated edge; plaintext is never persisted here. */
    readonly tokenSha256: string;
    readonly expiresAt: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const proof = this.#required<JsonObject>(actor.tenantId, "proof.approval", input.proofId);
    requireState(proof.state.state === "awaiting_approval", "proof is not accepting new approval links");
    if (!(proof.state.requiredApprovalRoles as unknown as string[]).includes(input.intendedRole)) throw new CommercialOperationsError("AUTHORIZATION_REQUIRED", "proof approval role is not required");
    const expiresAt = exactUtc(input.expiresAt, "expiresAt");
    if (Date.parse(expiresAt) > Date.parse(String(proof.state.expiresAt)) || Date.parse(expiresAt) <= this.#clock().getTime()) throw new CommercialOperationsError("VALIDATION_FAILED", "proof link expiry is outside the proof window");
    if (!/^[a-f0-9]{64}$/.test(input.tokenSha256)) throw new CommercialOperationsError("VALIDATION_FAILED", "proof token digest is invalid");
    const grantId = sha256(`${actor.tenantId}\n${input.proofId}\n${input.intendedApproverId}\n${input.tokenSha256}`).slice(0, 32);
    const state: JsonObject = {
      grantId, proofId: input.proofId, proofVersion: proof.state.proofVersion, artifactSha256: proof.state.artifactSha256,
      intendedApproverId: identifier(input.intendedApproverId, "intendedApproverId"), intendedRole: identifier(input.intendedRole, "intendedRole"),
      tokenSha256: input.tokenSha256, expiresAt, state: "active", publiclyIndexable: false,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B97.issueProofLink", request: { ...state, tokenSha256: state.tokenSha256 },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "proof.link", aggregateId: grantId, expectedVersion: null,
        state, eventType: "proof.linkIssued", event: { proofId: input.proofId, intendedApproverId: input.intendedApproverId, expiresAt },
      }).state,
    }).value as JsonObject;
  }

  approveProof(actor: CommercialActor, input: {
    readonly proofId: string;
    readonly grantId: string;
    readonly token: string;
    readonly decision: "approved" | "changes_requested";
    readonly comment: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    const proof = this.#required<JsonObject>(actor.tenantId, "proof.approval", input.proofId);
    const grant = this.#required<JsonObject>(actor.tenantId, "proof.link", input.grantId);
    if (grant.state.proofId !== input.proofId || grant.state.intendedApproverId !== actor.actorId ||
        !(actor.roles as readonly string[]).includes(String(grant.state.intendedRole)) || grant.state.tokenSha256 !== sha256(input.token) ||
        Date.parse(String(grant.state.expiresAt)) <= this.#clock().getTime() || grant.state.proofVersion !== proof.state.proofVersion ||
        grant.state.artifactSha256 !== proof.state.artifactSha256 || grant.state.state !== "active") {
      throw new CommercialOperationsError("AUTHORIZATION_REQUIRED", "proof approval link is expired, misbound, or for another version");
    }
    const approvals = proof.state.approvals as unknown as JsonValue[];
    if (approvals.some((entry) => (entry as JsonObject).actorId === actor.actorId)) conflict("approver already decided this proof version");
    const decision = { actorId: actor.actorId, role: grant.state.intendedRole, decision: input.decision, comment: nonEmpty(input.comment, "comment"), proofVersion: proof.state.proofVersion, artifactSha256: proof.state.artifactSha256 };
    const updated = [...approvals, decision];
    const approvedCount = updated.filter((entry) => (entry as JsonObject).decision === "approved").length;
    const nextState = input.decision === "changes_requested" ? "changes_requested" : approvedCount >= Number(proof.state.requiredApprovalCount) ? "approved" : "awaiting_approval";
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B97.approveProof", request: { proofId: input.proofId, grantId: input.grantId, decision },
      run: () => {
        this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "proof.link", aggregateId: grant.aggregateId, expectedVersion: grant.version,
          state: { ...grant.state, state: "consumed" }, eventType: "proof.linkConsumed", event: { proofId: input.proofId, actorId: actor.actorId },
        });
        return this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "proof.approval", aggregateId: proof.aggregateId, expectedVersion: proof.version,
          state: { ...proof.state, approvals: updated, state: nextState }, eventType: `proof.${nextState}`, event: decision,
        }).state;
      },
    }).value as JsonObject;
  }

  requestProofChange(actor: CommercialActor, input: {
    readonly proofId: string;
    readonly replacementProofId: string;
    readonly replacementArtifactId: string;
    readonly reason: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const proof = this.#required<JsonObject>(actor.tenantId, "proof.approval", input.proofId);
    requireState(proof.state.productionLocked === false, "production-locked proof bytes cannot be silently replaced");
    const artifact = this.#required<JsonObject>(actor.tenantId, "print.artifact", input.replacementArtifactId);
    requireState(artifact.state.status === "preflight_passed", "replacement proof requires fresh preflight");
    if (artifact.state.pdfSha256 === proof.state.artifactSha256) conflict("replacement proof must bind changed print bytes");
    const state: JsonObject = {
      ...proof.state, proofId: identifier(input.replacementProofId, "replacementProofId"), artifactId: input.replacementArtifactId,
      artifactSha256: artifact.state.pdfSha256, proofVersion: Number(proof.state.proofVersion) + 1,
      approvals: [], state: "awaiting_approval", productionLocked: false, predecessorProofId: input.proofId,
      changeReason: nonEmpty(input.reason, "reason"),
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B97.requestProofChange", request: { proofId: input.proofId, replacementProofId: input.replacementProofId, replacementArtifactId: input.replacementArtifactId, reason: input.reason },
      run: () => {
        this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "proof.approval", aggregateId: proof.aggregateId, expectedVersion: proof.version,
          state: { ...proof.state, state: "superseded" }, eventType: "proof.superseded", event: { replacementProofId: input.replacementProofId, reason: input.reason },
        });
        return this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "proof.approval", aggregateId: input.replacementProofId, expectedVersion: null,
          state, eventType: "proof.revisionCreated", event: { predecessorProofId: input.proofId, artifactSha256: state.artifactSha256, proofVersion: state.proofVersion },
        }).state;
      },
    }).value as JsonObject;
  }

  lockProofForProduction(actor: CommercialActor, input: {
    readonly proofId: string;
    readonly vendorId: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    const proof = this.#required<JsonObject>(actor.tenantId, "proof.approval", input.proofId);
    requireState(proof.state.state === "approved", "proof requires all configured approvals before production lock");
    const vendor = this.#required<JsonObject>(actor.tenantId, "vendor.profile", input.vendorId);
    requireState(vendor.state.status === "active", "inactive vendor cannot receive locked production files");
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B97.lockProof", request: { proofId: input.proofId, vendorId: input.vendorId, artifactSha256: proof.state.artifactSha256 },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "proof.approval", aggregateId: proof.aggregateId, expectedVersion: proof.version,
        state: { ...proof.state, state: "production_locked", productionLocked: true, lockedVendorId: input.vendorId, lockedArtifactSha256: proof.state.artifactSha256 },
        eventType: "proof.productionLocked", event: { vendorId: input.vendorId, artifactSha256: proof.state.artifactSha256, proofVersion: proof.state.proofVersion },
      }).state,
    }).value as JsonObject;
  }

  // B98 — recorded routing decisions and exclusive vendor production leases.
  routeOrder(actor: CommercialActor, input: {
    readonly orderId: string;
    readonly proofId: string;
    readonly productCapability: string;
    readonly quantity: number;
    readonly region: string;
    readonly requiredDataRegion: string;
    readonly deadlineAt: string;
    readonly maximumCostMinor: number;
    readonly routingRuleVersion: string;
    readonly candidateVendorIds: readonly string[];
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const proof = this.#required<JsonObject>(actor.tenantId, "proof.approval", input.proofId);
    requireState(proof.state.state === "production_locked", "routing requires a production-locked proof");
    const quantity = integer(input.quantity, "quantity", 1);
    const maximumCostMinor = minor(input.maximumCostMinor);
    const deadlineAt = exactUtc(input.deadlineAt, "deadlineAt");
    const today = this.#clock().toISOString().slice(0, 10);
    const candidates = sortedUnique(input.candidateVendorIds, "candidateVendorIds").map((vendorId) => {
      const vendor = this.#required<JsonObject>(actor.tenantId, "vendor.profile", vendorId).state;
      const capacity = this.#required<JsonObject>(actor.tenantId, "vendor.capacity", vendorId).state;
      const book = this.#repository.listEvents(actor.tenantId, "vendor.priceBook")
        .map((event) => event.payload)
        .find((candidate) => candidate.vendorId === vendorId && candidate.status === "approved" && String(candidate.effectiveFrom) <= today && String(candidate.effectiveUntil) >= today);
      const priceEntry = (book?.entries as readonly JsonObject[] | undefined)?.find((entry) => entry.product === input.productCapability && Number(entry.minimumQuantity) <= quantity);
      const subtotal = priceEntry === undefined ? Number.POSITIVE_INFINITY :
        Number(priceEntry.unitMinor) * quantity + Number(priceEntry.rushMinor) + Number(priceEntry.packagingMinor) + Number(priceEntry.shippingMinor);
      const quotedCostMinor = Number.isFinite(subtotal) ? subtotal + Math.floor(subtotal * Number(priceEntry?.taxBasisPoints ?? 0) / 10_000) : null;
      const slaEvent = [...this.#repository.listEvents(actor.tenantId, "vendor.sla")]
        .reverse().find((event) => event.aggregateId.startsWith(`${vendorId}:`));
      const sla = slaEvent === undefined ? undefined : this.#repository.get<JsonObject>(actor.tenantId, "vendor.sla", slaEvent.aggregateId)?.state;
      const thresholds = sla?.thresholdsSeconds as JsonObject | undefined;
      const fulfillmentSeconds = thresholds === undefined ? Number.POSITIVE_INFINITY :
        Number(thresholds.accept) + Number(thresholds.proof) + Number(thresholds.production) + Number(thresholds.quality) + Number(thresholds.ship) + Number(thresholds.deliver);
      const deadlineFeasible = Number.isFinite(fulfillmentSeconds) && this.#clock().getTime() + fulfillmentSeconds * 1_000 <= Date.parse(deadlineAt);
      const quality = this.#repository.listEvents(actor.tenantId, "quality.observation").map((event) => event.payload)
        .filter((observation) => observation.vendorId === vendorId && observation.eligible === true);
      const qualityScoreBasisPoints = quality.length === 0 ? null : Math.floor(quality.filter((observation) => observation.outcome === "pass").length * 10_000 / quality.length);
      const qualityEligible = qualityScoreBasisPoints === null || qualityScoreBasisPoints >= 8_000;
      const checks: JsonObject = {
        approved: vendor.status === "active", capability: (vendor.productCapabilities as unknown as string[]).includes(input.productCapability),
        dataRegion: (vendor.regions as unknown as string[]).includes(input.requiredDataRegion), capacity: Number(capacity.availableUnits) >= quantity,
        freshness: Date.parse(String(capacity.updatedAt)) >= this.#clock().getTime() - 15 * 60_000,
        health: Number(capacity.confidenceBasisPoints) >= 8_000, priceBook: priceEntry !== undefined,
        cost: quotedCostMinor !== null && quotedCostMinor <= maximumCostMinor, sla: sla !== undefined,
        deadline: deadlineFeasible, quality: qualityEligible,
      };
      const failedChecks = Object.entries(checks).filter(([, passed]) => passed !== true).map(([name]) => name);
      const capable = failedChecks.length === 0;
      return {
        vendorId, capable, capacityVersion: capacity.calendarVersion, priceBookVersion: book?.version ?? null,
        slaVersion: sla?.slaVersion ?? null, quotedCostMinor, qualityScoreBasisPoints,
        qualityBasis: quality.length === 0 ? "governed_new_vendor_probation" : "platform_observations",
        health: capable ? "eligible" : "ineligible", checks, reasons: capable ? Object.keys(checks).sort() : failedChecks,
      };
    });
    const selected = candidates.find((candidate) => candidate.capable);
    if (selected === undefined) throw new CommercialOperationsError("POLICY_BLOCKED", "no approved vendor satisfies capability, capacity, data-region, and health constraints");
    const state: JsonObject = {
      orderId: identifier(input.orderId, "orderId"), proofId: input.proofId, artifactSha256: proof.state.artifactSha256,
      productCapability: identifier(input.productCapability, "productCapability"), quantity,
      region: identifier(input.region, "region"), requiredDataRegion: identifier(input.requiredDataRegion, "requiredDataRegion"),
      deadlineAt, maximumCostMinor,
      routingRuleVersion: identifier(input.routingRuleVersion, "routingRuleVersion"), candidates, selectedVendorId: selected.vendorId,
      decisionReason: "first_eligible_under_approved_rule", manualOverride: null, state: "routed",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B98.routeOrder", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "fulfillment.routing", aggregateId: input.orderId, expectedVersion: null,
        state, eventType: "fulfillment.orderRouted", event: { candidates, selectedVendorId: selected.vendorId, routingRuleVersion: input.routingRuleVersion },
      }).state,
    }).value as JsonObject;
  }

  overrideRoute(actor: CommercialActor, input: {
    readonly orderId: string;
    readonly vendorId: string;
    readonly approverIds: readonly string[];
    readonly reason: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES, input.approverIds);
    const routing = this.#required<JsonObject>(actor.tenantId, "fulfillment.routing", input.orderId);
    requireState(routing.state.state === "routed", "route can only be overridden before vendor job creation");
    const candidate = (routing.state.candidates as unknown as Array<Record<string, JsonValue>>).find((entry) => entry.vendorId === input.vendorId && entry.capable === true);
    if (candidate === undefined) throw new CommercialOperationsError("POLICY_BLOCKED", "manual route override cannot select an unapproved or ineligible vendor");
    const approvals = sortedUnique(input.approverIds, "approverIds", 2);
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B98.overrideRoute", request: { orderId: input.orderId, vendorId: input.vendorId, approvals, reason: input.reason },
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "fulfillment.routing", aggregateId: routing.aggregateId, expectedVersion: routing.version,
        state: { ...routing.state, selectedVendorId: input.vendorId, manualOverride: { approvals, reason: nonEmpty(input.reason, "reason"), actorId: actor.actorId } },
        eventType: "fulfillment.routeOverridden", event: { vendorId: input.vendorId, approvals, reason: input.reason },
      }).state,
    }).value as JsonObject;
  }

  createVendorJob(actor: CommercialActor, input: {
    readonly jobId: string;
    readonly orderId: string;
    readonly purchaseOrderId: string;
    readonly quantity: number;
    readonly purchasePriceMinor: number;
    readonly currency: string;
    readonly fileReference: string;
    readonly dueAt: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const routing = this.#required<JsonObject>(actor.tenantId, "fulfillment.routing", input.orderId);
    requireState(routing.state.state === "routed", "order is not ready for a vendor job");
    if (!input.fileReference.startsWith("object-lock://") || input.fileReference.includes("?")) throw new CommercialOperationsError("VALIDATION_FAILED", "vendor print file must use a locked credential-free reference");
    if (this.#repository.get(actor.tenantId, "fulfillment.productionLease", input.orderId) !== undefined) conflict("order already has an active production lease");
    const vendorId = String(routing.state.selectedVendorId);
    const state: JsonObject = {
      jobId: identifier(input.jobId, "jobId"), orderId: input.orderId, purchaseOrderId: identifier(input.purchaseOrderId, "purchaseOrderId"),
      vendorId, quantity: integer(input.quantity, "quantity", 1), purchasePriceMinor: minor(input.purchasePriceMinor), currency: currency(input.currency),
      fileReference: input.fileReference, artifactSha256: routing.state.artifactSha256, dueAt: exactUtc(input.dueAt, "dueAt"),
      customerData: "minimum_fulfillment_reference_only", state: "requested", lastProviderSequence: 0, providerJobId: null,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B98.createVendorJob", request: state,
      run: () => {
        this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "fulfillment.productionLease", aggregateId: input.orderId, expectedVersion: null,
          state: { orderId: input.orderId, jobId: input.jobId, vendorId, state: "active" }, eventType: "fulfillment.productionLeaseAcquired", event: { jobId: input.jobId, vendorId },
        });
        this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "fulfillment.routing", aggregateId: routing.aggregateId, expectedVersion: routing.version,
          state: { ...routing.state, state: "job_created", jobId: input.jobId }, eventType: "fulfillment.vendorJobLinked", event: { jobId: input.jobId, vendorId },
        });
        return this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "fulfillment.vendorJob", aggregateId: input.jobId, expectedVersion: null,
          state, eventType: "fulfillment.vendorJobRequested", event: { orderId: input.orderId, vendorId, artifactSha256: state.artifactSha256, dueAt: input.dueAt },
        }).state;
      },
    }).value as JsonObject;
  }

  applyVendorJobFact(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "vendor.job");
    const job = this.#required<JsonObject>(actor.tenantId, "fulfillment.vendorJob", verified.subjectId);
    if (verified.provider !== `vendor:${String(job.state.vendorId)}`) throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "vendor job fact provider is not bound to the selected vendor");
    assertExactKeys(verified.payload, ["jobId", "providerJobId", "state", "acceptedQuantity", "artifactSha256"], "vendor job fact");
    const target = String(verified.payload.state);
    const allowed = ["accepted", "rejected", "scheduled", "producing", "quality_checked", "shipped", "failed", "cancelled"];
    if (!allowed.includes(target) || verified.payload.jobId !== job.aggregateId || verified.payload.artifactSha256 !== job.state.artifactSha256 ||
        Number(verified.payload.acceptedQuantity) < 0 || Number(verified.payload.acceptedQuantity) > Number(job.state.quantity)) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "vendor job fact is unknown, partial beyond order, or artifact-conflicting");
    }
    if (verified.sequence <= Number(job.state.lastProviderSequence)) throw new CommercialOperationsError("CONFLICT", "vendor job fact is stale or reordered");
    assertVendorTransition(String(job.state.state), target);
    const state = { ...job.state, state: target, providerJobId: verified.payload.providerJobId, acceptedQuantity: verified.payload.acceptedQuantity, lastProviderSequence: verified.sequence, lastFactId: verified.factId };
    return this.#atomicFact(actor, verified, idempotencyKey, "B98.applyVendorJobFact", { jobId: job.aggregateId, target }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "fulfillment.vendorJob", aggregateId: job.aggregateId, expectedVersion: job.version,
        state, eventType: `fulfillment.vendorJob.${target}`, event: { factId: verified.factId, sequence: verified.sequence, acceptedQuantity: verified.payload.acceptedQuantity },
      }).state);
  }

  rerouteVendorJob(actor: CommercialActor, input: {
    readonly jobId: string;
    readonly cancellationFact: SignedCommercialFact;
    readonly replacementVendorId: string;
    readonly approverIds: readonly string[];
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES, input.approverIds);
    const job = this.#required<JsonObject>(actor.tenantId, "fulfillment.vendorJob", input.jobId);
    requireState(["requested", "rejected", "failed"].includes(String(job.state.state)), "producing or shipped job cannot be rerouted automatically");
    const fact = this.#verifyFact(input.cancellationFact, actor.tenantId, "vendor.job-cancelled", input.jobId);
    if (fact.provider !== `vendor:${String(job.state.vendorId)}` || fact.payload.jobId !== input.jobId || fact.payload.cancelled !== true || fact.payload.productionStarted !== false) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "old vendor did not prove cancellation before production");
    }
    const replacement = this.#required<JsonObject>(actor.tenantId, "vendor.profile", input.replacementVendorId);
    requireState(replacement.state.status === "active", "replacement vendor is inactive");
    const lease = this.#required<JsonObject>(actor.tenantId, "fulfillment.productionLease", String(job.state.orderId));
    const approvals = sortedUnique(input.approverIds, "approverIds", 2);
    return this.#atomicFact(actor, fact, input.idempotencyKey, "B98.rerouteVendorJob", { jobId: input.jobId, replacementVendorId: input.replacementVendorId, approvals }, () => {
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "fulfillment.vendorJob", aggregateId: job.aggregateId, expectedVersion: job.version,
        state: { ...job.state, state: "cancelled_for_reroute", cancellationFactId: fact.factId }, eventType: "fulfillment.vendorJobCancelledForReroute", event: { factId: fact.factId },
      });
      return this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "fulfillment.productionLease", aggregateId: lease.aggregateId, expectedVersion: lease.version,
        state: { ...lease.state, state: "reroute_authorized", previousVendorId: job.state.vendorId, vendorId: input.replacementVendorId, replacementJobRequired: true },
        eventType: "fulfillment.productionLeaseRerouted", event: { previousVendorId: job.state.vendorId, replacementVendorId: input.replacementVendorId, approvals },
      }).state;
    });
  }

  // B99 — address validation, rate/label authority ports, and privacy-safe tracking.
  confirmShippingAddress(actor: CommercialActor, input: {
    readonly orderId: string;
    readonly addressId: string;
    readonly countryCode: string;
    readonly recipientName: string;
    readonly line1: string;
    readonly line2?: string;
    readonly city: string;
    readonly region: string;
    readonly postalCode: string;
    readonly phoneE164: string;
    readonly normalizationSuggestions: readonly string[];
    readonly serviceable: boolean;
    readonly userConfirmed: boolean;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    if (!/^[A-Z]{2}$/.test(input.countryCode)) throw new CommercialOperationsError("VALIDATION_FAILED", "countryCode must be ISO-3166 alpha-2");
    if (!/^\+[1-9]\d{6,14}$/.test(input.phoneE164)) throw new CommercialOperationsError("VALIDATION_FAILED", "phone must be canonical E.164");
    if (input.countryCode === "CN" && !/^\d{6}$/.test(input.postalCode)) throw new CommercialOperationsError("VALIDATION_FAILED", "China postal code must contain six digits");
    nonEmpty(input.postalCode, "postalCode", 32);
    requireState(input.serviceable, "address is outside the configured service area");
    requireState(input.userConfirmed, "normalization suggestions must be confirmed by the user and cannot silently change an address");
    const suggestions = sortedUnique(input.normalizationSuggestions, "normalizationSuggestions", 0);
    const state: JsonObject = {
      addressId: identifier(input.addressId, "addressId"), orderId: identifier(input.orderId, "orderId"), countryCode: input.countryCode,
      recipientName: nonEmpty(input.recipientName, "recipientName", 160), line1: nonEmpty(input.line1, "line1", 256),
      line2: input.line2 === undefined ? "" : nonEmpty(input.line2, "line2", 256), city: nonEmpty(input.city, "city", 128),
      region: nonEmpty(input.region, "region", 128), postalCode: input.postalCode, phoneE164: input.phoneE164,
      normalizationSuggestions: suggestions, serviceable: true, userConfirmed: true, state: "confirmed",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B99.confirmShippingAddress", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "shipping.address", aggregateId: input.addressId, expectedVersion: null,
        state, eventType: "shipping.addressConfirmed", event: { orderId: input.orderId, countryCode: input.countryCode, suggestionsAccepted: suggestions.length },
      }).state,
    }).value as JsonObject;
  }

  applyShippingQuoteFact(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "carrier.rate");
    assertExactKeys(verified.payload, ["quoteId", "orderId", "addressId", "productCode", "weightGrams", "dimensionsMm", "region", "serviceLevel", "insuranceMinor", "taxMinor", "baseRateMinor", "totalMinor", "currency", "contractVersion", "expiresAt"], "carrier rate fact");
    const address = this.#required<JsonObject>(actor.tenantId, "shipping.address", String(verified.payload.addressId));
    if (address.state.orderId !== verified.payload.orderId || verified.payload.quoteId !== verified.subjectId ||
        !Array.isArray(verified.payload.dimensionsMm) || verified.payload.dimensionsMm.length !== 3) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "carrier quote is not bound to the confirmed order/address and package dimensions");
    }
    const dimensions = (verified.payload.dimensionsMm as readonly JsonValue[]).map((value, index) => integer(Number(value), `dimensionsMm[${index}]`, 1));
    const insurance = minor(Number(verified.payload.insuranceMinor), "insuranceMinor", true);
    const tax = minor(Number(verified.payload.taxMinor), "taxMinor", true);
    const base = minor(Number(verified.payload.baseRateMinor), "baseRateMinor", true);
    const total = minor(Number(verified.payload.totalMinor), "totalMinor", true);
    if (base + insurance + tax !== total || Date.parse(exactUtc(String(verified.payload.expiresAt), "expiresAt")) <= this.#clock().getTime()) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "carrier quote controls or expiry are invalid");
    }
    const state: JsonObject = {
      ...verified.payload, dimensionsMm: dimensions, currency: currency(String(verified.payload.currency)),
      weightGrams: integer(Number(verified.payload.weightGrams), "weightGrams", 1), provider: verified.provider,
      factId: verified.factId, state: "quoted",
    };
    return this.#atomicFact(actor, verified, idempotencyKey, "B99.applyShippingQuoteFact", { quoteId: verified.subjectId }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "shipping.quote", aggregateId: verified.subjectId, expectedVersion: null,
        state, eventType: "shipping.quoteVerified", event: { orderId: verified.payload.orderId, provider: verified.provider, totalMinor: total, expiresAt: verified.payload.expiresAt },
      }).state);
  }

  applyShippingLabelFact(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "carrier.label");
    assertExactKeys(verified.payload, ["shipmentId", "orderId", "quoteId", "operation", "trackingNumber", "labelArtifactSha256", "handoffCode", "necessaryAddressFields"], "carrier label fact");
    const quote = this.#required<JsonObject>(actor.tenantId, "shipping.quote", String(verified.payload.quoteId));
    const operation = String(verified.payload.operation);
    if (!['purchase', 'cancel', 'reprint', 'handoff'].includes(operation) || quote.state.provider !== verified.provider ||
        quote.state.orderId !== verified.payload.orderId || verified.payload.shipmentId !== verified.subjectId ||
        !Array.isArray(verified.payload.necessaryAddressFields)) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "carrier label is not bound to the selected quote");
    }
    const fields = sortedUnique(verified.payload.necessaryAddressFields.map(String), "necessaryAddressFields");
    const allowedAddressFields = new Set(["recipientName", "line1", "line2", "city", "region", "postalCode", "countryCode", "phoneE164"]);
    if (fields.some((field) => !allowedAddressFields.has(field))) throw new CommercialOperationsError("POLICY_BLOCKED", "label requests address data outside minimum fulfillment fields");
    const existing = this.#repository.get<JsonObject>(actor.tenantId, "shipping.shipment", verified.subjectId);
    const previous = existing === undefined ? "none" : String(existing.state.state);
    const targets: Readonly<Record<string, readonly string[]>> = {
      purchase: ["none"], cancel: ["label_purchased", "label_reprinted"], reprint: ["label_purchased", "label_reprinted"], handoff: ["label_purchased", "label_reprinted"],
    };
    requireState(targets[operation]?.includes(previous) === true, `label operation ${operation} is invalid from ${previous}`);
    const stateName = operation === "purchase" ? "label_purchased" : operation === "cancel" ? "cancelled" : operation === "reprint" ? "label_reprinted" : "handed_off";
    const state: JsonObject = {
      shipmentId: verified.subjectId, orderId: verified.payload.orderId, quoteId: verified.payload.quoteId, provider: verified.provider,
      trackingNumber: verified.payload.trackingNumber, labelArtifactSha256: verified.payload.labelArtifactSha256,
      handoffCode: verified.payload.handoffCode, necessaryAddressFields: fields, state: stateName,
      lastLabelFactId: verified.factId, lastProviderSequence: verified.sequence,
    };
    return this.#atomicFact(actor, verified, idempotencyKey, "B99.applyShippingLabelFact", { shipmentId: verified.subjectId, operation }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "shipping.shipment", aggregateId: verified.subjectId, expectedVersion: existing?.version ?? null,
        state, eventType: `shipping.label.${operation}`, event: { factId: verified.factId, provider: verified.provider, operation },
      }).state);
  }

  applyTrackingFact(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "carrier.tracking");
    assertExactKeys(verified.payload, ["shipmentId", "trackingNumber", "state", "carrierCode", "eventAt", "locationCode", "exceptionCode"], "carrier tracking fact");
    const shipment = this.#required<JsonObject>(actor.tenantId, "shipping.shipment", verified.subjectId);
    const stateName = String(verified.payload.state);
    if (shipment.state.provider !== verified.provider || verified.payload.shipmentId !== shipment.aggregateId ||
        verified.payload.trackingNumber !== shipment.state.trackingNumber || !TRACKING_STATES.includes(stateName as typeof TRACKING_STATES[number])) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "tracking fact is not bound to the purchased label");
    }
    exactUtc(String(verified.payload.eventAt), "tracking eventAt");
    const lastSequence = Number(shipment.state.lastTrackingSequence ?? 0);
    const ignoredOutOfOrder = verified.sequence <= lastSequence;
    const previousIndex = TRACKING_STATES.indexOf(String(shipment.state.trackingState ?? "label_created") as typeof TRACKING_STATES[number]);
    const targetIndex = TRACKING_STATES.indexOf(stateName as typeof TRACKING_STATES[number]);
    const nonRegressive = stateName === "exception" || stateName === "returned" || targetIndex >= previousIndex;
    const apply = !ignoredOutOfOrder && nonRegressive;
    const state: JsonObject = {
      ...shipment.state,
      trackingState: apply ? stateName : shipment.state.trackingState ?? "label_created",
      lastTrackingSequence: apply ? verified.sequence : lastSequence,
      lastTrackingEventAt: apply ? verified.payload.eventAt : shipment.state.lastTrackingEventAt ?? null,
      lastTrackingFactId: apply ? verified.factId : shipment.state.lastTrackingFactId ?? null,
      ignoredTrackingFactIds: ignoredOutOfOrder || !nonRegressive
        ? [...((shipment.state.ignoredTrackingFactIds as readonly JsonValue[] | undefined) ?? []), verified.factId]
        : (shipment.state.ignoredTrackingFactIds ?? []),
    };
    return this.#atomicFact(actor, verified, idempotencyKey, "B99.applyTrackingFact", { shipmentId: verified.subjectId, sequence: verified.sequence }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "shipping.shipment", aggregateId: shipment.aggregateId, expectedVersion: shipment.version,
        state, eventType: apply ? "shipping.trackingAdvanced" : "shipping.trackingIgnored", event: { factId: verified.factId, state: stateName, sequence: verified.sequence, ignored: !apply },
      }).state);
  }

  createPublicTrackingAccess(actor: CommercialActor, input: {
    readonly accessId: string;
    readonly shipmentId: string;
    readonly tokenSha256: string;
    readonly expiresAt: string;
    readonly whiteLabelPartnerId?: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const shipment = this.#required<JsonObject>(actor.tenantId, "shipping.shipment", input.shipmentId);
    if (!/^[a-f0-9]{64}$/.test(input.tokenSha256)) throw new CommercialOperationsError("VALIDATION_FAILED", "tokenSha256 is invalid");
    const expiresAt = exactUtc(input.expiresAt, "expiresAt");
    const lifetime = Date.parse(expiresAt) - this.#clock().getTime();
    if (lifetime < 1 || lifetime > 86_400_000) throw new CommercialOperationsError("POLICY_BLOCKED", "public tracking access must expire within 24 hours");
    const state: JsonObject = {
      accessId: identifier(input.accessId, "accessId"), shipmentId: shipment.aggregateId, orderId: shipment.state.orderId,
      tokenSha256: input.tokenSha256, expiresAt, whiteLabelPartnerId: input.whiteLabelPartnerId ?? null, state: "active",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B99.createPublicTrackingAccess", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "shipping.trackingAccess", aggregateId: input.accessId, expectedVersion: null,
        state, eventType: "shipping.publicTrackingAccessCreated", event: { shipmentId: input.shipmentId, expiresAt, whiteLabelPartnerId: input.whiteLabelPartnerId ?? null },
      }).state,
    }).value as JsonObject;
  }

  publicTracking(tenantId: string, accessId: string, token: string): JsonObject {
    const access = this.#required<JsonObject>(tenantId, "shipping.trackingAccess", accessId);
    if (access.state.state !== "active" || Date.parse(String(access.state.expiresAt)) <= this.#clock().getTime() || sha256(token) !== access.state.tokenSha256) {
      throw new CommercialOperationsError("AUTHORIZATION_REQUIRED", "public tracking credential is invalid or expired");
    }
    const shipment = this.#required<JsonObject>(tenantId, "shipping.shipment", String(access.state.shipmentId));
    return freeze({
      shipmentId: shipment.aggregateId, trackingState: shipment.state.trackingState ?? "label_created",
      carrier: shipment.state.provider, trackingNumberSuffix: String(shipment.state.trackingNumber).slice(-4),
      lastEventAt: shipment.state.lastTrackingEventAt ?? null, whiteLabelPartnerId: access.state.whiteLabelPartnerId,
      address: "redacted", phone: "redacted",
    });
  }

  // B100 — inventory, atomic reservations, freshness-aware ATP, and explicit preorder.
  configureStockItem(actor: CommercialActor, input: {
    readonly stockId: string;
    readonly sku: string;
    readonly material: string;
    readonly packaging: string;
    readonly locationType: "warehouse" | "vendor";
    readonly locationId: string;
    readonly lotId: string;
    readonly unit: string;
    readonly onHand: number;
    readonly inTransit: number;
    readonly safetyStock: number;
    readonly inventoryProvider: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    const onHand = integer(input.onHand, "onHand", 0);
    const inTransit = integer(input.inTransit, "inTransit", 0);
    const safetyStock = integer(input.safetyStock, "safetyStock", 0);
    const state: JsonObject = {
      stockId: identifier(input.stockId, "stockId"), sku: identifier(input.sku, "sku"), material: identifier(input.material, "material"),
      packaging: identifier(input.packaging, "packaging"), locationType: input.locationType, locationId: identifier(input.locationId, "locationId"),
      lotId: identifier(input.lotId, "lotId"), unit: identifier(input.unit, "unit"), onHand, inTransit, safetyStock,
      reserved: 0, available: Math.max(0, onHand - safetyStock), inventoryProvider: identifier(input.inventoryProvider, "inventoryProvider"),
      lastSupplierFactAt: null, anomaly: false,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B100.configureStockItem", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "inventory.stock", aggregateId: input.stockId, expectedVersion: null,
        state, eventType: "inventory.stockConfigured", event: { sku: input.sku, locationId: input.locationId, lotId: input.lotId, onHand, safetyStock },
      }).state,
    }).value as JsonObject;
  }

  reserveStock(actor: CommercialActor, input: {
    readonly reservationId: string;
    readonly orderId: string;
    readonly stockId: string;
    readonly quantity: number;
    readonly expiresAt: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const stock = this.#required<JsonObject>(actor.tenantId, "inventory.stock", input.stockId);
    const quantity = integer(input.quantity, "quantity", 1);
    const expiresAt = exactUtc(input.expiresAt, "expiresAt");
    if (Date.parse(expiresAt) <= this.#clock().getTime()) throw new CommercialOperationsError("VALIDATION_FAILED", "reservation expiry must be in the future");
    const available = Number(stock.state.onHand) - Number(stock.state.reserved) - Number(stock.state.safetyStock);
    requireState(available >= quantity, "insufficient ATP for atomic reservation");
    const reservation: JsonObject = {
      reservationId: identifier(input.reservationId, "reservationId"), orderId: identifier(input.orderId, "orderId"), stockId: input.stockId,
      quantity, expiresAt, state: "held", transitionHistory: ["checkout_reserved"],
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B100.reserveStock", request: reservation,
      run: () => {
        const reserved = Number(stock.state.reserved) + quantity;
        this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "inventory.stock", aggregateId: stock.aggregateId, expectedVersion: stock.version,
          state: { ...stock.state, reserved, available: Math.max(0, Number(stock.state.onHand) - reserved - Number(stock.state.safetyStock)) },
          eventType: "inventory.stockReserved", event: { reservationId: input.reservationId, orderId: input.orderId, quantity, expiresAt },
        });
        return this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "inventory.reservation", aggregateId: input.reservationId, expectedVersion: null,
          state: reservation, eventType: "inventory.reservationCreated", event: { stockId: input.stockId, quantity, expiresAt },
        }).state;
      },
    }).value as JsonObject;
  }

  transitionReservation(actor: CommercialActor, input: {
    readonly reservationId: string;
    readonly action: "payment_confirmed" | "cancelled" | "route_confirmed" | "production_consumed" | "returned" | "expired";
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const reservation = this.#required<JsonObject>(actor.tenantId, "inventory.reservation", input.reservationId);
    const stock = this.#required<JsonObject>(actor.tenantId, "inventory.stock", String(reservation.state.stockId));
    const current = String(reservation.state.state);
    const allowed: Readonly<Record<string, readonly string[]>> = {
      payment_confirmed: ["held"], route_confirmed: ["paid"], production_consumed: ["routed"],
      cancelled: ["held", "paid", "routed"], expired: ["held"], returned: ["consumed"],
    };
    requireState(allowed[input.action]?.includes(current) === true, `reservation action ${input.action} is invalid from ${current}`);
    if (input.action === "expired" && Date.parse(String(reservation.state.expiresAt)) > this.#clock().getTime()) {
      throw new CommercialOperationsError("STATE_TRANSITION_INVALID", "reservation has not expired");
    }
    const target = input.action === "payment_confirmed" ? "paid" : input.action === "route_confirmed" ? "routed" :
      input.action === "production_consumed" ? "consumed" : input.action === "returned" ? "returned" : "released";
    const quantity = Number(reservation.state.quantity);
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B100.transitionReservation",
      request: { reservationId: input.reservationId, action: input.action },
      run: () => {
        let reserved = Number(stock.state.reserved);
        let onHand = Number(stock.state.onHand);
        if (["cancelled", "expired", "production_consumed"].includes(input.action)) reserved -= quantity;
        if (input.action === "production_consumed") onHand -= quantity;
        if (input.action === "returned") onHand += quantity;
        requireState(reserved >= 0 && onHand >= 0, "inventory transition would create negative stock");
        this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "inventory.stock", aggregateId: stock.aggregateId, expectedVersion: stock.version,
          state: { ...stock.state, reserved, onHand, available: Math.max(0, onHand - reserved - Number(stock.state.safetyStock)) },
          eventType: `inventory.stock.${input.action}`, event: { reservationId: input.reservationId, quantity },
        });
        return this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "inventory.reservation", aggregateId: reservation.aggregateId, expectedVersion: reservation.version,
          state: { ...reservation.state, state: target, transitionHistory: [...(reservation.state.transitionHistory as readonly JsonValue[]), input.action] },
          eventType: `inventory.reservation.${input.action}`, event: { stockId: stock.aggregateId, quantity, target },
        }).state;
      },
    }).value as JsonObject;
  }

  availabilityPromise(input: {
    readonly tenantId: string;
    readonly stockId: string;
    readonly quantity: number;
    readonly capacityId: string;
    readonly procurementLeadDays: number;
    readonly deliveryDays: number;
    readonly maximumSupplierAgeMs: number;
  }): JsonObject {
    const stock = this.#required<JsonObject>(input.tenantId, "inventory.stock", input.stockId);
    const capacity = this.#required<JsonObject>(input.tenantId, "vendor.capacity", input.capacityId);
    const quantity = integer(input.quantity, "quantity", 1);
    const capacityAge = this.#clock().getTime() - Date.parse(String(capacity.state.updatedAt));
    const supplierAge = stock.state.lastSupplierFactAt === null ? Number.POSITIVE_INFINITY : this.#clock().getTime() - Date.parse(String(stock.state.lastSupplierFactAt));
    const fresh = capacityAge >= 0 && supplierAge >= 0 && capacityAge <= input.maximumSupplierAgeMs && supplierAge <= input.maximumSupplierAgeMs;
    const inventoryAvailable = Number(stock.state.onHand) - Number(stock.state.reserved) - Number(stock.state.safetyStock);
    const capacityAvailable = Number(capacity.state.availableUnits);
    const mode = fresh && inventoryAvailable >= quantity && capacityAvailable >= quantity ? "live" :
      Number(stock.state.inTransit) + Math.max(0, inventoryAvailable) >= quantity ? "preorder" : "unavailable";
    return freeze({
      stockId: input.stockId, quantity, mode, supplierDataFresh: fresh,
      inventoryAvailable, capacityAvailable: fresh ? capacityAvailable : null,
      leadDays: integer(input.procurementLeadDays, "procurementLeadDays", 0) + integer(input.deliveryDays, "deliveryDays", 0),
      staleDataCannotPromiseLive: !fresh,
    });
  }

  configurePreorder(actor: CommercialActor, input: {
    readonly preorderId: string;
    readonly sku: string;
    readonly promisedDeliveryDate: string;
    readonly refundPolicyVersion: string;
    readonly notificationPlanVersion: string;
    readonly substitutionAllowed: boolean;
    readonly substitutionApprovalRequired: boolean;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    requireState(!input.substitutionAllowed || input.substitutionApprovalRequired, "material/specification substitution must require explicit approval");
    const state: JsonObject = {
      preorderId: identifier(input.preorderId, "preorderId"), sku: identifier(input.sku, "sku"),
      promisedDeliveryDate: dateOnly(input.promisedDeliveryDate, "promisedDeliveryDate"),
      refundPolicyVersion: identifier(input.refundPolicyVersion, "refundPolicyVersion"),
      notificationPlanVersion: identifier(input.notificationPlanVersion, "notificationPlanVersion"),
      substitutionAllowed: input.substitutionAllowed, substitutionApprovalRequired: input.substitutionApprovalRequired, state: "offered",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B100.configurePreorder", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "inventory.preorder", aggregateId: input.preorderId, expectedVersion: null,
        state, eventType: "inventory.preorderConfigured", event: { sku: input.sku, promisedDeliveryDate: input.promisedDeliveryDate, substitutionApprovalRequired: input.substitutionApprovalRequired },
      }).state,
    }).value as JsonObject;
  }

  applyInventoryFact(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "inventory.adjustment");
    assertExactKeys(verified.payload, ["stockId", "adjustmentType", "quantity", "reportedOnHand", "reasonCode", "evidenceSha256"], "inventory adjustment fact");
    const stock = this.#required<JsonObject>(actor.tenantId, "inventory.stock", verified.subjectId);
    if (verified.provider !== stock.state.inventoryProvider || verified.payload.stockId !== stock.aggregateId ||
        !["adjustment", "count", "loss", "supplier_sync"].includes(String(verified.payload.adjustmentType)) ||
        !/^[a-f0-9]{64}$/.test(String(verified.payload.evidenceSha256))) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "inventory fact provider, reason, or evidence is invalid");
    }
    const reported = integer(Number(verified.payload.reportedOnHand), "reportedOnHand", 0);
    const quantity = integer(Number(verified.payload.quantity), "quantity", 0);
    const previous = Number(stock.state.onHand);
    if (String(verified.payload.adjustmentType) === "loss" && reported > previous) throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "loss fact cannot increase on-hand stock");
    const reserved = Number(stock.state.reserved);
    const oversubscribed = reported < reserved;
    const anomaly = oversubscribed || Math.abs(reported - previous) > Math.max(10, Math.ceil(previous * 0.2));
    const state: JsonObject = {
      ...stock.state, onHand: reported, available: Math.max(0, reported - reserved - Number(stock.state.safetyStock)),
      lastSupplierFactAt: verified.occurredAt, lastInventoryFactId: verified.factId, anomaly, oversubscribed,
      lastAdjustment: { type: verified.payload.adjustmentType, quantity, reasonCode: verified.payload.reasonCode, evidenceSha256: verified.payload.evidenceSha256 },
    };
    return this.#atomicFact(actor, verified, idempotencyKey, "B100.applyInventoryFact", { stockId: stock.aggregateId, reported }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "inventory.stock", aggregateId: stock.aggregateId, expectedVersion: stock.version,
        state, eventType: anomaly ? "inventory.adjustmentAnomaly" : "inventory.adjusted", event: { factId: verified.factId, previousOnHand: previous, reportedOnHand: reported, reserved, anomaly, oversubscribed, reasonCode: verified.payload.reasonCode },
      }).state);
  }

  // B101 — eligibility, minimized evidence, one replacement chain, and recovery claims.
  configureReturnPolicy(actor: CommercialActor, input: {
    readonly policyId: string;
    readonly version: string;
    readonly regions: readonly string[];
    readonly productTypes: readonly string[];
    readonly customProductsReturnable: boolean;
    readonly returnWindowDays: number;
    readonly exceptionApprovalRequired: boolean;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    const state: JsonObject = {
      policyId: identifier(input.policyId, "policyId"), version: identifier(input.version, "version"),
      regions: sortedUnique(input.regions, "regions"), productTypes: sortedUnique(input.productTypes, "productTypes"),
      customProductsReturnable: input.customProductsReturnable, returnWindowDays: integer(input.returnWindowDays, "returnWindowDays", 0),
      exceptionApprovalRequired: input.exceptionApprovalRequired, state: "active",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B101.configureReturnPolicy", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "returns.policy", aggregateId: input.policyId, expectedVersion: null,
        state, eventType: "returns.policyConfigured", event: { version: input.version, returnWindowDays: input.returnWindowDays },
      }).state,
    }).value as JsonObject;
  }

  openReturnAuthorization(actor: CommercialActor, input: {
    readonly authorizationId: string;
    readonly orderId: string;
    readonly policyId: string;
    readonly region: string;
    readonly productType: string;
    readonly customized: boolean;
    readonly deliveredAt: string;
    readonly reasonCode: typeof CLAIM_REASONS[number];
    readonly requestedRemedy: "return" | "replacement" | "refund";
    readonly exceptionApproverIds?: readonly string[];
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const policy = this.#required<JsonObject>(actor.tenantId, "returns.policy", input.policyId);
    const deliveredAt = exactUtc(input.deliveredAt, "deliveredAt");
    const elapsedDays = Math.floor((this.#clock().getTime() - Date.parse(deliveredAt)) / 86_400_000);
    const standardEligible = (policy.state.regions as readonly JsonValue[]).includes(input.region) &&
      (policy.state.productTypes as readonly JsonValue[]).includes(input.productType) && elapsedDays >= 0 &&
      elapsedDays <= Number(policy.state.returnWindowDays) && (!input.customized || policy.state.customProductsReturnable === true);
    const exception = !standardEligible && policy.state.exceptionApprovalRequired === true && input.exceptionApproverIds !== undefined;
    if (exception) assertActor(actor, APPROVER_ROLES, input.exceptionApproverIds);
    requireState(standardEligible || exception, "return/replacement/refund request is ineligible under the bound policy");
    if (!CLAIM_REASONS.includes(input.reasonCode)) throw new CommercialOperationsError("VALIDATION_FAILED", "return reason is not standardized");
    const state: JsonObject = {
      authorizationId: identifier(input.authorizationId, "authorizationId"), orderId: identifier(input.orderId, "orderId"),
      policyId: input.policyId, policyVersion: policy.state.version, region: input.region, productType: input.productType,
      customized: input.customized, deliveredAt, reasonCode: input.reasonCode, requestedRemedy: input.requestedRemedy,
      eligibility: standardEligible ? "standard" : "approved_exception",
      exceptionApproverIds: exception ? sortedUnique(input.exceptionApproverIds ?? [], "exceptionApproverIds", 2) : [],
      state: "authorized", replacementOrderId: null, recoveryClaimId: null,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B101.openReturnAuthorization", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "returns.authorization", aggregateId: input.authorizationId, expectedVersion: null,
        state, eventType: "returns.authorized", event: { orderId: input.orderId, reasonCode: input.reasonCode, remedy: input.requestedRemedy, eligibility: state.eligibility },
      }).state,
    }).value as JsonObject;
  }

  attachClaimEvidence(actor: CommercialActor, input: {
    readonly authorizationId: string;
    readonly evidenceId: string;
    readonly artifactSha256: string;
    readonly mimeType: "image/jpeg" | "image/png" | "application/pdf";
    readonly malwareScan: "clean";
    readonly containsFace: boolean;
    readonly containsChild: boolean;
    readonly containsPrivateConversation: boolean;
    readonly expiresAt: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const authorization = this.#required<JsonObject>(actor.tenantId, "returns.authorization", input.authorizationId);
    if (!/^[a-f0-9]{64}$/.test(input.artifactSha256) || input.malwareScan !== "clean") throw new CommercialOperationsError("VALIDATION_FAILED", "claim evidence digest or malware scan is invalid");
    if (input.containsFace || input.containsChild || input.containsPrivateConversation) throw new CommercialOperationsError("POLICY_BLOCKED", "claim evidence must exclude unrelated faces, children, and private conversations");
    const expiresAt = exactUtc(input.expiresAt, "expiresAt");
    if (Date.parse(expiresAt) <= this.#clock().getTime() || Date.parse(expiresAt) - this.#clock().getTime() > 30 * 86_400_000) {
      throw new CommercialOperationsError("POLICY_BLOCKED", "claim evidence access must be short-lived");
    }
    const evidence: JsonObject = {
      evidenceId: identifier(input.evidenceId, "evidenceId"), authorizationId: authorization.aggregateId,
      artifactSha256: input.artifactSha256, mimeType: input.mimeType, malwareScan: input.malwareScan, expiresAt,
      dataMinimized: true, rawMediaPersisted: false,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B101.attachClaimEvidence", request: evidence,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "returns.evidence", aggregateId: input.evidenceId, expectedVersion: null,
        state: evidence, eventType: "returns.evidenceAttached", event: { authorizationId: input.authorizationId, artifactSha256: input.artifactSha256, expiresAt, dataMinimized: true },
      }).state,
    }).value as JsonObject;
  }

  createReplacementOrder(actor: CommercialActor, input: {
    readonly authorizationId: string;
    readonly replacementOrderId: string;
    readonly originalSpecificationId: string;
    readonly originalProofId: string;
    readonly originalArtifactSha256: string;
    readonly newFulfillmentChainId: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const authorization = this.#required<JsonObject>(actor.tenantId, "returns.authorization", input.authorizationId);
    requireState(authorization.state.requestedRemedy === "replacement" && authorization.state.replacementOrderId === null, "replacement is not authorized or already exists");
    const state: JsonObject = {
      replacementOrderId: identifier(input.replacementOrderId, "replacementOrderId"), authorizationId: authorization.aggregateId,
      originalOrderId: authorization.state.orderId, originalSpecificationId: identifier(input.originalSpecificationId, "originalSpecificationId"),
      originalProofId: identifier(input.originalProofId, "originalProofId"), originalArtifactSha256: input.originalArtifactSha256,
      newFulfillmentChainId: identifier(input.newFulfillmentChainId, "newFulfillmentChainId"), chargeMinor: 0,
      inventoryReservationState: "new_required", productionState: "not_started", state: "created",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B101.createReplacementOrder", request: state,
      run: () => {
        this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "returns.authorization", aggregateId: authorization.aggregateId, expectedVersion: authorization.version,
          state: { ...authorization.state, state: "replacement_created", replacementOrderId: input.replacementOrderId },
          eventType: "returns.replacementLinked", event: { replacementOrderId: input.replacementOrderId, chargeMinor: 0 },
        });
        return this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "returns.replacement", aggregateId: input.replacementOrderId, expectedVersion: null,
          state, eventType: "returns.replacementCreated", event: { authorizationId: input.authorizationId, newFulfillmentChainId: input.newFulfillmentChainId, originalArtifactSha256: input.originalArtifactSha256 },
        }).state;
      },
    }).value as JsonObject;
  }

  createRecoveryClaim(actor: CommercialActor, input: {
    readonly claimId: string;
    readonly authorizationId: string;
    readonly liableProvider: string;
    readonly providerType: "vendor" | "carrier";
    readonly amountMinor: number;
    readonly currency: string;
    readonly evidenceIds: readonly string[];
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    const authorization = this.#required<JsonObject>(actor.tenantId, "returns.authorization", input.authorizationId);
    const evidenceIds = sortedUnique(input.evidenceIds, "evidenceIds");
    for (const evidenceId of evidenceIds) this.#required(actor.tenantId, "returns.evidence", evidenceId);
    const provider = `${input.providerType}:${identifier(input.liableProvider, "liableProvider")}`;
    const state: JsonObject = {
      claimId: identifier(input.claimId, "claimId"), authorizationId: authorization.aggregateId, orderId: authorization.state.orderId,
      reasonCode: authorization.state.reasonCode, liableProvider: provider, amountMinor: minor(input.amountMinor), currency: currency(input.currency),
      evidenceIds, state: "submitted", recoveredMinor: 0, ledgerAdjustment: "pending", qualityFeedback: "recorded",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B101.createRecoveryClaim", request: state,
      run: () => {
        this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "returns.authorization", aggregateId: authorization.aggregateId, expectedVersion: authorization.version,
          state: { ...authorization.state, recoveryClaimId: input.claimId }, eventType: "returns.recoveryClaimLinked", event: { claimId: input.claimId, provider },
        });
        return this.#repository.put({
          tenantId: actor.tenantId, aggregateType: "returns.recoveryClaim", aggregateId: input.claimId, expectedVersion: null,
          state, eventType: "returns.recoveryClaimSubmitted", event: { authorizationId: input.authorizationId, orderId: authorization.state.orderId, provider, amountMinor: input.amountMinor, qualityFeedback: true },
        }).state;
      },
    }).value as JsonObject;
  }

  applyRecoveryFact(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "claim.recovery");
    assertExactKeys(verified.payload, ["claimId", "decision", "liability", "recoveredMinor", "currency", "settlementReference"], "claim recovery fact");
    const claim = this.#required<JsonObject>(actor.tenantId, "returns.recoveryClaim", verified.subjectId);
    if (verified.provider !== claim.state.liableProvider || verified.payload.claimId !== claim.aggregateId ||
        verified.payload.currency !== claim.state.currency || !["accepted", "rejected", "settled"].includes(String(verified.payload.decision))) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "recovery fact is not bound to the liable provider and claim");
    }
    const recoveredMinor = minor(Number(verified.payload.recoveredMinor), "recoveredMinor", true);
    if (recoveredMinor > Number(claim.state.amountMinor)) throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "recovery exceeds the asserted claim");
    const state: JsonObject = {
      ...claim.state, state: verified.payload.decision, liability: verified.payload.liability, recoveredMinor,
      settlementReference: verified.payload.settlementReference, ledgerAdjustment: recoveredMinor > 0 ? "required" : "none",
      recoveryFactId: verified.factId,
    };
    return this.#atomicFact(actor, verified, idempotencyKey, "B101.applyRecoveryFact", { claimId: claim.aggregateId, recoveredMinor }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "returns.recoveryClaim", aggregateId: claim.aggregateId, expectedVersion: claim.version,
        state, eventType: "returns.recoveryDecisionRecorded", event: { factId: verified.factId, decision: verified.payload.decision, recoveredMinor, ledgerAdjustment: state.ledgerAdjustment, qualityFeedback: true },
      }).state);
  }

  // B102 — platform-derived quality facts, governed decisions, settlements, and CAPA.
  recordQualityObservation(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "quality.observation");
    assertExactKeys(verified.payload, ["vendorId", "orderId", "metric", "outcome", "eligible", "exclusionReason", "latencyMs", "sourceReference"], "quality observation fact");
    if (verified.provider.startsWith("vendor:") || verified.payload.sourceReference === "vendor_self_report") {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "vendor self-report cannot override platform quality facts");
    }
    const metrics = ["acceptance", "production", "first_pass", "on_time_ship", "delivery", "damage", "rework", "loss", "complaint", "deletion", "api_health"];
    if (!metrics.includes(String(verified.payload.metric)) || !["pass", "fail"].includes(String(verified.payload.outcome)) || verified.payload.orderId !== verified.subjectId) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "quality observation has an unknown metric, outcome, or subject");
    }
    const state: JsonObject = {
      observationId: verified.factId, vendorId: verified.payload.vendorId, orderId: verified.payload.orderId,
      metric: verified.payload.metric, outcome: verified.payload.outcome, eligible: verified.payload.eligible,
      exclusionReason: verified.payload.exclusionReason, latencyMs: integer(Number(verified.payload.latencyMs), "latencyMs", 0),
      sourceReference: verified.payload.sourceReference, provider: verified.provider, occurredAt: verified.occurredAt,
    };
    return this.#atomicFact(actor, verified, idempotencyKey, "B102.recordQualityObservation", { factId: verified.factId }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "quality.observation", aggregateId: verified.factId, expectedVersion: null,
        state, eventType: "quality.observationRecorded", event: state,
      }).state);
  }

  vendorScorecard(input: {
    readonly tenantId: string;
    readonly vendorId: string;
    readonly from: string;
    readonly through: string;
    readonly maximumLatencyMs: number;
  }): JsonObject {
    const from = exactUtc(input.from, "from");
    const through = exactUtc(input.through, "through");
    if (through < from) throw new CommercialOperationsError("VALIDATION_FAILED", "scorecard interval is inverted");
    const observations = this.#repository.listEvents(input.tenantId, "quality.observation")
      .map((event) => event.payload)
      .filter((event) => event.vendorId === input.vendorId && String(event.occurredAt) >= from && String(event.occurredAt) <= through);
    const eligible = observations.filter((event) => event.eligible === true);
    const passed = eligible.filter((event) => event.outcome === "pass").length;
    const denominator = eligible.length;
    const excluded = observations.length - denominator;
    const late = eligible.filter((event) => Number(event.latencyMs) > input.maximumLatencyMs).length;
    const metricCounts = Object.fromEntries(
      ["acceptance", "production", "first_pass", "on_time_ship", "delivery", "damage", "rework", "loss", "complaint", "deletion", "api_health"]
        .map((metric) => [metric, eligible.filter((event) => event.metric === metric).length]),
    ) as JsonObject;
    return freeze({
      vendorId: input.vendorId, from, through, numerator: passed, denominator, excluded, late,
      scoreBasisPoints: denominator === 0 ? null : Math.floor((passed * 10_000) / denominator),
      metricCounts, sampleUncertainty: denominator < 30 ? "high" : denominator < 100 ? "medium" : "low",
      dataAuthority: "platform_signed_facts_only",
    });
  }

  recommendVendorAction(actor: CommercialActor, input: {
    readonly recommendationId: string;
    readonly vendorId: string;
    readonly scorecard: JsonObject;
    readonly thresholdBasisPoints: number;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, SUPPLY_ROLES);
    const threshold = basisPoints(input.thresholdBasisPoints, "thresholdBasisPoints");
    if (input.scorecard.vendorId !== input.vendorId || input.scorecard.dataAuthority !== "platform_signed_facts_only") {
      throw new CommercialOperationsError("VALIDATION_FAILED", "recommendation requires a platform-derived scorecard for the selected vendor");
    }
    const score = input.scorecard.scoreBasisPoints;
    const recommendation = score === null ? "manual_review_insufficient_data" : Number(score) < threshold ? "review_for_degradation" : "continue";
    const state: JsonObject = {
      recommendationId: identifier(input.recommendationId, "recommendationId"), vendorId: identifier(input.vendorId, "vendorId"),
      thresholdBasisPoints: threshold, scoreBasisPoints: score, denominator: input.scorecard.denominator,
      recommendation, state: "advisory_only", automaticallyApplied: false,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B102.recommendVendorAction", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "quality.recommendation", aggregateId: input.recommendationId, expectedVersion: null,
        state, eventType: "quality.vendorActionRecommended", event: { vendorId: input.vendorId, recommendation, automaticallyApplied: false },
      }).state,
    }).value as JsonObject;
  }

  decideVendorAction(actor: CommercialActor, input: {
    readonly decisionId: string;
    readonly recommendationId: string;
    readonly action: "continue" | "probation" | "degrade" | "suspend" | "terminate";
    readonly explanation: string;
    readonly contractClause: string;
    readonly noticeReference: string;
    readonly appealDueAt: string;
    readonly approverIds: readonly string[];
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES, input.approverIds);
    const recommendation = this.#required<JsonObject>(actor.tenantId, "quality.recommendation", input.recommendationId);
    const approvals = sortedUnique(input.approverIds, "approverIds", 2);
    const appealDueAt = exactUtc(input.appealDueAt, "appealDueAt");
    if (Date.parse(appealDueAt) <= this.#clock().getTime()) throw new CommercialOperationsError("VALIDATION_FAILED", "appeal deadline must be in the future");
    const state: JsonObject = {
      decisionId: identifier(input.decisionId, "decisionId"), recommendationId: recommendation.aggregateId,
      vendorId: recommendation.state.vendorId, action: input.action, explanation: nonEmpty(input.explanation, "explanation", 1_000),
      contractClause: nonEmpty(input.contractClause, "contractClause", 256), noticeReference: nonEmpty(input.noticeReference, "noticeReference", 256),
      appealDueAt, approverIds: approvals, state: "notified_appealable",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B102.decideVendorAction", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "quality.vendorDecision", aggregateId: input.decisionId, expectedVersion: null,
        state, eventType: "quality.vendorActionDecided", event: { vendorId: state.vendorId, action: input.action, contractClause: input.contractClause, noticeReference: input.noticeReference, appealDueAt, approverIds: approvals },
      }).state,
    }).value as JsonObject;
  }

  createSlaSettlement(actor: CommercialActor, input: {
    readonly settlementId: string;
    readonly vendorId: string;
    readonly orderId: string;
    readonly breachCode: "late_acceptance" | "late_production" | "late_delivery" | "damage" | "rework" | "loss" | "privacy";
    readonly remedy: "service_credit" | "cash_recovery" | "bonus" | "debit";
    readonly amountMinor: number;
    readonly currency: string;
    readonly contractVersion: string;
    readonly capaId?: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    if (input.breachCode === "privacy" && (input.remedy === "service_credit" || input.capaId === undefined)) {
      throw new CommercialOperationsError("POLICY_BLOCKED", "privacy breach requires remediation/CAPA and cannot be settled only by service credit");
    }
    const aggregateId = `${identifier(input.orderId, "orderId")}:${input.breachCode}`;
    const state: JsonObject = {
      settlementId: identifier(input.settlementId, "settlementId"), vendorId: identifier(input.vendorId, "vendorId"), orderId: input.orderId,
      breachCode: input.breachCode, remedy: input.remedy, amountMinor: minor(input.amountMinor), currency: currency(input.currency),
      contractVersion: identifier(input.contractVersion, "contractVersion"), capaId: input.capaId ?? null,
      payoutAdjustment: { direction: input.remedy === "bonus" ? "credit_vendor" : "debit_vendor", amountMinor: input.amountMinor },
      ledgerInstruction: { sourceType: "vendor_sla_settlement", sourceReference: input.settlementId }, state: "pending_settlement",
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B102.createSlaSettlement", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "quality.slaSettlement", aggregateId, expectedVersion: null,
        state, eventType: "quality.slaSettlementCreated", event: { settlementId: input.settlementId, vendorId: input.vendorId, orderId: input.orderId, breachCode: input.breachCode, amountMinor: input.amountMinor, ledgerInstruction: state.ledgerInstruction, payoutAdjustment: state.payoutAdjustment },
      }).state,
    }).value as JsonObject;
  }

  createCapa(actor: CommercialActor, input: {
    readonly capaId: string;
    readonly vendorId: string;
    readonly reviewPeriod: string;
    readonly rootCause: string;
    readonly correctiveActions: readonly string[];
    readonly preventiveActions: readonly string[];
    readonly retestCriteria: readonly string[];
    readonly ownerId: string;
    readonly dueAt: string;
    readonly idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    const state: JsonObject = {
      capaId: identifier(input.capaId, "capaId"), vendorId: identifier(input.vendorId, "vendorId"), reviewPeriod: identifier(input.reviewPeriod, "reviewPeriod"),
      rootCause: nonEmpty(input.rootCause, "rootCause", 1_000), correctiveActions: sortedUnique(input.correctiveActions, "correctiveActions"),
      preventiveActions: sortedUnique(input.preventiveActions, "preventiveActions"), retestCriteria: sortedUnique(input.retestCriteria, "retestCriteria"),
      ownerId: identifier(input.ownerId, "ownerId"), dueAt: exactUtc(input.dueAt, "dueAt"), state: "open", retestFactId: null, cleanupFactId: null,
    };
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey: input.idempotencyKey, operation: "B102.createCapa", request: state,
      run: () => this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "quality.capa", aggregateId: input.capaId, expectedVersion: null,
        state, eventType: "quality.capaCreated", event: { vendorId: input.vendorId, reviewPeriod: input.reviewPeriod, ownerId: input.ownerId, dueAt: input.dueAt },
      }).state,
    }).value as JsonObject;
  }

  applyCapaRetestFact(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "quality.capa-retest");
    assertExactKeys(verified.payload, ["capaId", "vendorId", "passed", "criteriaResults", "evidenceSha256"], "CAPA retest fact");
    const capa = this.#required<JsonObject>(actor.tenantId, "quality.capa", verified.subjectId);
    const results = Array.isArray(verified.payload.criteriaResults) ? verified.payload.criteriaResults as readonly JsonValue[] : [];
    const normalizedResults = results.map((result) => {
      if (result === null || typeof result !== "object" || Array.isArray(result)) throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "CAPA criterion result is invalid");
      const item = result as JsonObject;
      assertExactKeys(item, ["criterion", "passed"], "CAPA criterion result");
      if (typeof item.criterion !== "string" || typeof item.passed !== "boolean") throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "CAPA criterion result types are invalid");
      return { criterion: item.criterion, passed: item.passed };
    });
    const expectedCriteria = [...(capa.state.retestCriteria as readonly string[])].sort();
    const actualCriteria = normalizedResults.map((result) => result.criterion).sort();
    if (verified.payload.capaId !== capa.aggregateId || verified.payload.vendorId !== capa.state.vendorId ||
        actualCriteria.length !== expectedCriteria.length || actualCriteria.some((criterion, index) => criterion !== expectedCriteria[index]) ||
        (verified.payload.passed === true && normalizedResults.some((result) => !result.passed)) ||
        !/^[a-f0-9]{64}$/.test(String(verified.payload.evidenceSha256))) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "CAPA retest is not bound to the CAPA/vendor/criteria evidence");
    }
    const state: JsonObject = { ...capa.state, state: verified.payload.passed === true ? "retest_passed_cleanup_pending" : "retest_failed", retestFactId: verified.factId, retestEvidenceSha256: verified.payload.evidenceSha256 };
    return this.#atomicFact(actor, verified, idempotencyKey, "B102.applyCapaRetestFact", { capaId: capa.aggregateId }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "quality.capa", aggregateId: capa.aggregateId, expectedVersion: capa.version,
        state, eventType: "quality.capaRetested", event: { factId: verified.factId, passed: verified.payload.passed, evidenceSha256: verified.payload.evidenceSha256 },
      }).state);
  }

  applyCapaCleanupFact(actor: CommercialActor, fact: SignedCommercialFact, idempotencyKey: string): JsonObject {
    assertActor(actor, APPROVER_ROLES);
    const verified = this.#verifyFact(fact, actor.tenantId, "quality.cleanup");
    assertExactKeys(verified.payload, ["capaId", "vendorId", "deleted", "deletionScope", "evidenceSha256"], "CAPA cleanup fact");
    const capa = this.#required<JsonObject>(actor.tenantId, "quality.capa", verified.subjectId);
    requireState(capa.state.state === "retest_passed_cleanup_pending", "CAPA cleanup requires a passed independent retest");
    if (verified.payload.capaId !== capa.aggregateId || verified.payload.vendorId !== capa.state.vendorId || verified.payload.deleted !== true ||
        !/^[a-f0-9]{64}$/.test(String(verified.payload.evidenceSha256))) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "cleanup fact is not bound to the CAPA/vendor deletion evidence");
    }
    const state: JsonObject = { ...capa.state, state: "closed", cleanupFactId: verified.factId, cleanupEvidenceSha256: verified.payload.evidenceSha256, closedAt: verified.occurredAt };
    return this.#atomicFact(actor, verified, idempotencyKey, "B102.applyCapaCleanupFact", { capaId: capa.aggregateId }, () =>
      this.#repository.put({
        tenantId: actor.tenantId, aggregateType: "quality.capa", aggregateId: capa.aggregateId, expectedVersion: capa.version,
        state, eventType: "quality.capaClosed", event: { factId: verified.factId, deletionScope: verified.payload.deletionScope, evidenceSha256: verified.payload.evidenceSha256 },
      }).state);
  }

  #verifyFact(fact: SignedCommercialFact, tenantId: string, factKind: string, subjectId?: string): VerifiedCommercialFact {
    return this.#facts.verify(fact, { tenantId, factKind, ...(subjectId === undefined ? {} : { subjectId }) });
  }

  #atomicFact(
    actor: CommercialActor,
    fact: VerifiedCommercialFact,
    idempotencyKey: string,
    operation: string,
    request: JsonObject,
    run: () => JsonObject,
  ): JsonObject {
    return this.#repository.execute({
      tenantId: actor.tenantId, idempotencyKey, operation, request: { ...request, factSha256: fact.factSha256 },
      run: () => {
        this.#repository.claimExternalFact({
          tenantId: actor.tenantId, factId: fact.factId, factSha256: fact.factSha256, provider: fact.provider,
          factKind: fact.factKind, subjectId: fact.subjectId, sequence: fact.sequence, occurredAt: fact.occurredAt,
        });
        return run();
      },
    }).value as JsonObject;
  }

  #required<T extends JsonObject>(tenantId: string, aggregateType: string, aggregateId: string): AggregateSnapshot<T> {
    const value = this.#repository.get<T>(tenantId, aggregateType, aggregateId);
    if (value === undefined) throw new CommercialOperationsError("NOT_FOUND", `${aggregateType}/${aggregateId} was not found`);
    return value;
  }
}

function integer(value: number, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new CommercialOperationsError("VALIDATION_FAILED", `${field} must be an integer >= ${minimum}`);
  return value;
}

function assertVendorTransition(current: string, target: string): void {
  const transitions: Readonly<Record<string, readonly string[]>> = {
    requested: ["accepted", "rejected", "failed", "cancelled"], accepted: ["scheduled", "failed", "cancelled"],
    scheduled: ["producing", "failed", "cancelled"], producing: ["quality_checked", "failed"],
    quality_checked: ["shipped", "failed"], rejected: [], failed: [], cancelled: [], shipped: [],
  };
  requireState(transitions[current]?.includes(target) === true, `vendor job transition ${current} -> ${target} is invalid`);
}
