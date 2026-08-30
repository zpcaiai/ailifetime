import {
  EnterpriseControlError, assertActor, exactKeys, exactUtc, hexDigest, identifier, integer,
  requireState, text, unique, type EnterpriseActor, type JsonObject,
} from "./common.js";
import { EnterpriseAttestationVerifier, type SignedEnterpriseAttestation, type VerifiedEnterpriseAttestation } from "./attestation.js";
import type { EnterpriseRepository, EnterpriseSnapshot } from "./store.js";

const SECURITY = ["security_admin", "compliance_admin", "release_manager"] as const;
const COMPLIANCE = ["compliance_admin", "privacy_officer", "legal_operator"] as const;
const SCAN_SURFACES = ["secret", "sast", "sca", "iac", "container", "api", "frontend", "mobile", "miniapp"] as const;
const DAST_SURFACES = ["authentication", "tenant_isolation", "idor", "upload", "signed_url", "webhook", "payment", "ssrf", "xss", "csrf", "admin"] as const;
const EVIDENCE_CATEGORIES = ["configuration", "access", "scan", "deletion", "vendor", "incident", "training", "finance", "release"] as const;
const APPLICABILITY_AREAS = ["generative_ai", "ai_label", "facial_processing", "privacy_impact_assessment", "children", "anthropomorphic_interaction"] as const;
type ScanSurface = typeof SCAN_SURFACES[number];
type DastSurface = typeof DAST_SURFACES[number];
type EvidenceCategory = typeof EVIDENCE_CATEGORIES[number];
type ApplicabilityArea = typeof APPLICABILITY_AREAS[number];

export class EnterpriseSecurityComplianceEngine {
  readonly #repository: EnterpriseRepository; readonly #facts: EnterpriseAttestationVerifier; readonly #clock: () => Date;
  constructor(input: { repository: EnterpriseRepository; attestationVerifier: EnterpriseAttestationVerifier; clock?: () => Date }) {
    this.#repository = input.repository; this.#facts = input.attestationVerifier; this.#clock = input.clock ?? (() => new Date());
  }

  // B123-R01 — signed provenance binds SBOM, dependencies, licenses, source and artifact.
  applyBuildProvenance(actor: EnterpriseActor, attestation: SignedEnterpriseAttestation, idempotencyKey: string): JsonObject {
    assertActor(actor, SECURITY); const fact = this.#facts.verify(attestation, { tenantId: actor.tenantId, factKind: "security.build-provenance" });
    exactKeys(fact.payload, ["buildId", "sourceRevision", "artifactSha256", "sbomSha256", "dependencyInventorySha256", "licenseInventorySha256", "provenanceSha256", "signatureVerified", "builderIdentity"], "build provenance");
    for (const field of ["artifactSha256", "sbomSha256", "dependencyInventorySha256", "licenseInventorySha256", "provenanceSha256"] as const) hexDigest(String(fact.payload[field]), field);
    if (fact.payload.signatureVerified !== true) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "build provenance signature is not verified");
    const state: JsonObject = { buildId: identifier(String(fact.payload.buildId), "buildId"), sourceRevision: identifier(String(fact.payload.sourceRevision), "sourceRevision"), artifactSha256: fact.payload.artifactSha256, sbomSha256: fact.payload.sbomSha256, dependencyInventorySha256: fact.payload.dependencyInventorySha256, licenseInventorySha256: fact.payload.licenseInventorySha256, provenanceSha256: fact.payload.provenanceSha256, builderIdentity: identifier(String(fact.payload.builderIdentity), "builderIdentity"), factId: fact.factId, state: "provenance_verified" };
    return this.#factWrite(actor, fact, idempotencyKey, "B123.applyBuildProvenance", { buildId: state.buildId }, "security.build", String(state.buildId), "security.buildProvenanceVerified", { factId: fact.factId, artifactSha256: state.artifactSha256 }, null, state);
  }

  // B123-R02 — exact nine-surface scan matrix with severity threshold release gate.
  applyScanMatrix(actor: EnterpriseActor, attestation: SignedEnterpriseAttestation, idempotencyKey: string): JsonObject {
    assertActor(actor, SECURITY); const fact = this.#facts.verify(attestation, { tenantId: actor.tenantId, factKind: "security.scan-matrix" }); const build = this.#required(actor.tenantId, "security.build", fact.subjectId);
    exactKeys(fact.payload, ["buildId", "artifactSha256", "scans", "criticalThreshold", "highThreshold", "reportSha256"], "scan matrix");
    if (fact.payload.buildId !== build.aggregateId || fact.payload.artifactSha256 !== build.state.artifactSha256) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "scan matrix is not bound to build artifact");
    const scans = fact.payload.scans as readonly JsonObject[]; requireExactInventory(scans.map((scan) => String(scan.surface) as ScanSurface), SCAN_SURFACES, "scan surfaces");
    let critical = 0; let high = 0; const normalized = scans.map((scan) => { exactKeys(scan, ["surface", "critical", "high", "medium", "reportSha256"], "scan result"); critical += integer(Number(scan.critical), "critical"); high += integer(Number(scan.high), "high"); return { surface: scan.surface, critical: scan.critical, high: scan.high, medium: integer(Number(scan.medium), "medium"), reportSha256: hexDigest(String(scan.reportSha256), "reportSha256") }; });
    const passed = critical <= integer(Number(fact.payload.criticalThreshold), "criticalThreshold") && high <= integer(Number(fact.payload.highThreshold), "highThreshold");
    const state: JsonObject = { ...build.state, scans: normalized, scanReportSha256: hexDigest(String(fact.payload.reportSha256), "reportSha256"), criticalFindings: critical, highFindings: high, releaseDecision: passed ? "passed" : "blocked", scanFactId: fact.factId, state: "scanned" };
    return this.#factWrite(actor, fact, idempotencyKey, "B123.applyScanMatrix", { buildId: build.aggregateId }, "security.build", build.aggregateId, passed ? "security.scanGatePassed" : "security.scanGateBlocked", { factId: fact.factId, critical, high }, build.version, state);
  }

  // B123-R03 — DAST must cover the complete authorization, tenant and callback attack surface.
  applyDastCoverage(actor: EnterpriseActor, attestation: SignedEnterpriseAttestation, idempotencyKey: string): JsonObject {
    assertActor(actor, SECURITY); const fact = this.#facts.verify(attestation, { tenantId: actor.tenantId, factKind: "security.dast" }); const build = this.#required(actor.tenantId, "security.build", fact.subjectId);
    exactKeys(fact.payload, ["buildId", "artifactSha256", "coveredSurfaces", "critical", "high", "reportSha256"], "DAST result");
    requireExactInventory((fact.payload.coveredSurfaces as readonly string[]).map((surface) => surface as DastSurface), DAST_SURFACES, "DAST surfaces");
    if (fact.payload.buildId !== build.aggregateId || fact.payload.artifactSha256 !== build.state.artifactSha256) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "DAST result is not artifact-bound");
    const passed = integer(Number(fact.payload.critical), "critical") === 0 && integer(Number(fact.payload.high), "high") === 0;
    const state: JsonObject = { ...build.state, dastCoveredSurfaces: [...DAST_SURFACES], dastReportSha256: hexDigest(String(fact.payload.reportSha256), "reportSha256"), dastFactId: fact.factId, dastDecision: passed ? "passed" : "blocked" };
    return this.#factWrite(actor, fact, idempotencyKey, "B123.applyDast", { buildId: build.aggregateId }, "security.build", build.aggregateId, passed ? "security.dastPassed" : "security.dastBlocked", { factId: fact.factId, passed }, build.version, state);
  }

  // B123-R04 — independent pentest has explicit scope/data/responsibility and cannot self-certify.
  registerPentestEngagement(actor: EnterpriseActor, input: { engagementId: string; releaseId: string; scopeSha256: string; controlledTestDataSha256: string; responsibilityMatrixSha256: string; providerContractId: string; idempotencyKey: string }): JsonObject {
    assertActor(actor, SECURITY); const state: JsonObject = { engagementId: identifier(input.engagementId, "engagementId"), releaseId: identifier(input.releaseId, "releaseId"), scopeSha256: hexDigest(input.scopeSha256, "scopeSha256"), controlledTestDataSha256: hexDigest(input.controlledTestDataSha256, "controlledTestDataSha256"), responsibilityMatrixSha256: hexDigest(input.responsibilityMatrixSha256, "responsibilityMatrixSha256"), providerContractId: identifier(input.providerContractId, "providerContractId"), certification: "NOT_CERTIFIED", state: "awaiting_independent_evidence" };
    return this.#write(actor, input.idempotencyKey, "B123.registerPentest", state, "security.pentest", input.engagementId, "security.pentestRegistered", state);
  }
  applyPentestAttestation(actor: EnterpriseActor, attestation: SignedEnterpriseAttestation, idempotencyKey: string): JsonObject {
    assertActor(actor, SECURITY); const fact = this.#facts.verify(attestation, { tenantId: actor.tenantId, factKind: "security.pentest", independent: true, issuerRole: "independent-pentest-authority" }); const engagement = this.#required(actor.tenantId, "security.pentest", fact.subjectId);
    exactKeys(fact.payload, ["engagementId", "releaseId", "scopeSha256", "controlledTestDataSha256", "responsibilityMatrixSha256", "criticalOpen", "highOpen", "remediationVerified", "retestReportSha256"], "pentest attestation");
    for (const field of ["engagementId", "releaseId", "scopeSha256", "controlledTestDataSha256", "responsibilityMatrixSha256"] as const) if (fact.payload[field] !== engagement.state[field]) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "pentest attestation binding mismatch");
    const passed = integer(Number(fact.payload.criticalOpen), "criticalOpen") === 0 && integer(Number(fact.payload.highOpen), "highOpen") === 0 && fact.payload.remediationVerified === true; const certification = passed ? externalCertification(fact.environment) : "NOT_CERTIFIED";
    const state: JsonObject = { ...engagement.state, criticalOpen: fact.payload.criticalOpen, highOpen: fact.payload.highOpen, remediationVerified: fact.payload.remediationVerified, retestReportSha256: hexDigest(String(fact.payload.retestReportSha256), "retestReportSha256"), factId: fact.factId, certification, state: passed ? "independently_verified" : "remediation_required" };
    return this.#factWrite(actor, fact, idempotencyKey, "B123.applyPentest", { engagementId: engagement.aggregateId }, "security.pentest", engagement.aggregateId, "security.pentestEvidenceApplied", { factId: fact.factId, certification }, engagement.version, state);
  }

  // B123-R05 — finding owner/SLA/exception/control/retest/disclosure lifecycle.
  registerFinding(actor: EnterpriseActor, input: { findingId: string; severity: "critical" | "high" | "medium" | "low"; ownerId: string; dueAt: string; disclosurePolicyId: string; reportSha256: string; idempotencyKey: string }): JsonObject {
    assertActor(actor, SECURITY); const state: JsonObject = { findingId: identifier(input.findingId, "findingId"), severity: input.severity, ownerId: identifier(input.ownerId, "ownerId"), dueAt: exactUtc(input.dueAt, "dueAt"), disclosurePolicyId: identifier(input.disclosurePolicyId, "disclosurePolicyId"), reportSha256: hexDigest(input.reportSha256, "reportSha256"), exception: null, retestFactId: null, state: "open" };
    return this.#write(actor, input.idempotencyKey, "B123.registerFinding", state, "security.finding", input.findingId, "security.findingRegistered", state);
  }
  grantFindingException(actor: EnterpriseActor, input: { findingId: string; approverIds: readonly string[]; compensatingControls: readonly string[]; expiresAt: string; rationale: string; idempotencyKey: string }): JsonObject {
    assertActor(actor, SECURITY, input.approverIds); const finding = this.#required(actor.tenantId, "security.finding", input.findingId); requireState(finding.state.state === "open", "only open findings can receive an exception");
    const expiresAt = exactUtc(input.expiresAt, "expiresAt"); if (Date.parse(expiresAt) <= this.#clock().getTime()) throw new EnterpriseControlError("POLICY_BLOCKED", "finding exception must expire in the future");
    const exception: JsonObject = { approverIds: unique(input.approverIds, "approverIds", 2), compensatingControls: unique(input.compensatingControls, "compensatingControls"), expiresAt, rationale: text(input.rationale, "rationale") }; const state: JsonObject = { ...finding.state, exception, state: "exception_active" };
    return this.#write(actor, input.idempotencyKey, "B123.grantFindingException", { findingId: input.findingId, exception }, "security.finding", input.findingId, "security.findingExceptionGranted", exception, finding.version, state);
  }
  applyFindingRetest(actor: EnterpriseActor, attestation: SignedEnterpriseAttestation, idempotencyKey: string): JsonObject {
    assertActor(actor, SECURITY); const fact = this.#facts.verify(attestation, { tenantId: actor.tenantId, factKind: "security.finding-retest", independent: true, issuerRole: "independent-security-retest-authority" }); const finding = this.#required(actor.tenantId, "security.finding", fact.subjectId);
    exactKeys(fact.payload, ["findingId", "reportSha256", "resolved", "retestReportSha256"], "finding retest"); if (fact.payload.findingId !== finding.aggregateId || fact.payload.reportSha256 !== finding.state.reportSha256 || fact.payload.resolved !== true) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "finding retest is not a resolved exact match");
    const state: JsonObject = { ...finding.state, retestFactId: fact.factId, retestReportSha256: hexDigest(String(fact.payload.retestReportSha256), "retestReportSha256"), state: "closed_verified" };
    return this.#factWrite(actor, fact, idempotencyKey, "B123.applyFindingRetest", { findingId: finding.aggregateId }, "security.finding", finding.aggregateId, "security.findingClosed", { factId: fact.factId }, finding.version, state);
  }

  // B124-R01 — closed control library maps obligation to control/system/owner/test/evidence/remediation.
  registerControlLibrary(actor: EnterpriseActor, input: { libraryId: string; version: string; controls: readonly { controlId: string; obligation: string; system: string; ownerId: string; frequency: string; testProcedureId: string; evidenceType: string; exceptionProcedureId: string; remediationProcedureId: string }[]; idempotencyKey: string }): JsonObject {
    assertActor(actor, COMPLIANCE); if (input.controls.length < 1) throw new EnterpriseControlError("VALIDATION_FAILED", "control library must be nonempty");
    const controls = input.controls.map((control) => ({ controlId: identifier(control.controlId, "controlId"), obligation: text(control.obligation, "obligation"), system: identifier(control.system, "system"), ownerId: identifier(control.ownerId, "ownerId"), frequency: identifier(control.frequency, "frequency"), testProcedureId: identifier(control.testProcedureId, "testProcedureId"), evidenceType: identifier(control.evidenceType, "evidenceType"), exceptionProcedureId: identifier(control.exceptionProcedureId, "exceptionProcedureId"), remediationProcedureId: identifier(control.remediationProcedureId, "remediationProcedureId") }));
    if (new Set(controls.map((control) => control.controlId)).size !== controls.length) throw new EnterpriseControlError("VALIDATION_FAILED", "control IDs must be unique");
    const state: JsonObject = { libraryId: identifier(input.libraryId, "libraryId"), version: identifier(input.version, "version"), controls, state: "active" };
    return this.#write(actor, input.idempotencyKey, "B124.registerControlLibrary", state, "compliance.controlLibrary", input.libraryId, "compliance.controlLibraryRegistered", state);
  }

  // B124-R02 — AI/facial/child/PIPL applicability is explicit; filings remain uncertified without legal authority.
  registerApplicabilityRecord(actor: EnterpriseActor, input: { recordId: string; productVersion: string; jurisdictions: readonly string[]; areas: readonly { area: ApplicabilityArea; applicable: boolean; rationale: string; requiredFiling: string | null; controlIds: readonly string[] }[]; idempotencyKey: string }): JsonObject {
    assertActor(actor, COMPLIANCE); requireExactInventory(input.areas.map((area) => area.area), APPLICABILITY_AREAS, "applicability areas");
    const areas = input.areas.map((area) => { if (area.applicable && area.controlIds.length < 1) throw new EnterpriseControlError("POLICY_BLOCKED", "applicable area requires controls"); return { area: area.area, applicable: area.applicable, rationale: text(area.rationale, "rationale"), requiredFiling: area.requiredFiling === null ? null : identifier(area.requiredFiling, "requiredFiling"), controlIds: unique(area.controlIds, "controlIds", area.applicable ? 1 : 0), filingCertification: area.requiredFiling === null ? "NOT_APPLICABLE" : "NOT_CERTIFIED" }; });
    const state: JsonObject = { recordId: identifier(input.recordId, "recordId"), productVersion: identifier(input.productVersion, "productVersion"), jurisdictions: unique(input.jurisdictions, "jurisdictions"), areas, legalCertification: "NOT_CERTIFIED", state: "impact_recorded" };
    return this.#write(actor, input.idempotencyKey, "B124.registerApplicability", state, "compliance.applicability", input.recordId, "compliance.applicabilityRegistered", state);
  }
  applyLegalFilingAttestation(actor: EnterpriseActor, attestation: SignedEnterpriseAttestation, idempotencyKey: string): JsonObject {
    assertActor(actor, COMPLIANCE); const fact = this.#facts.verify(attestation, { tenantId: actor.tenantId, factKind: "compliance.legal-filing", independent: true, issuerRole: "regulatory-filing-authority" }); const record = this.#required(actor.tenantId, "compliance.applicability", fact.subjectId);
    exactKeys(fact.payload, ["recordId", "productVersion", "jurisdictions", "filedRequirements", "authorityReceiptSha256", "validThrough"], "legal filing attestation");
    if (fact.payload.recordId !== record.aggregateId || fact.payload.productVersion !== record.state.productVersion || JSON.stringify(fact.payload.jurisdictions) !== JSON.stringify(record.state.jurisdictions)) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "legal filing attestation binding mismatch");
    const filed = unique(fact.payload.filedRequirements as readonly string[], "filedRequirements"); const required = (record.state.areas as readonly JsonObject[]).filter((area) => area.requiredFiling !== null).map((area) => String(area.requiredFiling)); if (required.some((item) => !filed.includes(item))) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "not every required legal filing is evidenced");
    const certification = externalCertification(fact.environment); const state: JsonObject = { ...record.state, legalCertification: certification, legalFactId: fact.factId, authorityReceiptSha256: hexDigest(String(fact.payload.authorityReceiptSha256), "authorityReceiptSha256"), validThrough: exactUtc(String(fact.payload.validThrough), "validThrough"), state: "legal_evidence_applied" };
    return this.#factWrite(actor, fact, idempotencyKey, "B124.applyLegalFiling", { recordId: record.aggregateId }, "compliance.applicability", record.aggregateId, "compliance.legalFilingEvidenceApplied", { factId: fact.factId, certification }, record.version, state);
  }

  // B124-R03 — signed, time-bound, artifact-hashed collection covers all evidence domains.
  applyEvidenceCollection(actor: EnterpriseActor, attestation: SignedEnterpriseAttestation, idempotencyKey: string): JsonObject {
    assertActor(actor, COMPLIANCE); const fact = this.#facts.verify(attestation, { tenantId: actor.tenantId, factKind: "compliance.evidence-collection" });
    exactKeys(fact.payload, ["collectionId", "periodStart", "periodEnd", "items", "manifestSha256"], "compliance evidence collection"); const items = fact.payload.items as readonly JsonObject[];
    requireExactInventory(items.map((item) => String(item.category) as EvidenceCategory), EVIDENCE_CATEGORIES, "evidence categories");
    const normalized = items.map((item) => { exactKeys(item, ["category", "artifactSha256", "capturedAt", "sourceSystem"], "evidence item"); return { category: item.category, artifactSha256: hexDigest(String(item.artifactSha256), "artifactSha256"), capturedAt: exactUtc(String(item.capturedAt), "capturedAt"), sourceSystem: identifier(String(item.sourceSystem), "sourceSystem") }; });
    const periodStart = exactUtc(String(fact.payload.periodStart), "periodStart"); const periodEnd = exactUtc(String(fact.payload.periodEnd), "periodEnd");
    if (periodEnd <= periodStart) throw new EnterpriseControlError("VALIDATION_FAILED", "evidence period is invalid");
    const state: JsonObject = { collectionId: identifier(String(fact.payload.collectionId), "collectionId"), periodStart, periodEnd, items: normalized, manifestSha256: hexDigest(String(fact.payload.manifestSha256), "manifestSha256"), factId: fact.factId, state: "evidence_verified" };
    return this.#factWrite(actor, fact, idempotencyKey, "B124.applyEvidenceCollection", { collectionId: state.collectionId }, "compliance.evidenceCollection", String(state.collectionId), "compliance.evidenceCollectionVerified", { factId: fact.factId, manifestSha256: state.manifestSha256 }, null, state);
  }

  // B124-R04 — two-person, tenant-scoped, encrypted/watermarked/expiring export with access events.
  issueAuditExport(actor: EnterpriseActor, input: { exportId: string; scope: readonly string[]; periodStart: string; periodEnd: string; tenantId: string; classifications: readonly string[]; approverIds: readonly string[]; encryptionKeyReference: string; watermark: string; expiresAt: string; artifactSha256: string; idempotencyKey: string }): JsonObject {
    assertActor(actor, COMPLIANCE, input.approverIds); if (input.tenantId !== actor.tenantId || !input.encryptionKeyReference.startsWith("kms://")) throw new EnterpriseControlError("POLICY_BLOCKED", "audit export must remain tenant-scoped and KMS-encrypted");
    const periodStart = exactUtc(input.periodStart, "periodStart"); const periodEnd = exactUtc(input.periodEnd, "periodEnd"); const expiresAt = exactUtc(input.expiresAt, "expiresAt"); if (periodEnd <= periodStart || Date.parse(expiresAt) <= this.#clock().getTime()) throw new EnterpriseControlError("VALIDATION_FAILED", "audit export period/expiry invalid");
    const state: JsonObject = { exportId: identifier(input.exportId, "exportId"), scope: unique(input.scope, "scope"), periodStart, periodEnd, tenantId: input.tenantId, classifications: unique(input.classifications, "classifications"), approverIds: unique(input.approverIds, "approverIds", 2), encryptionKeyReference: input.encryptionKeyReference, watermark: text(input.watermark, "watermark"), expiresAt, artifactSha256: hexDigest(input.artifactSha256, "artifactSha256"), accessCount: 0, state: "issued" };
    return this.#write(actor, input.idempotencyKey, "B124.issueAuditExport", state, "compliance.auditExport", input.exportId, "compliance.auditExportIssued", { exportId: input.exportId, scope: state.scope, periodStart, periodEnd, classifications: state.classifications, approverIds: state.approverIds, expiresAt, artifactSha256: state.artifactSha256 });
  }
  recordAuditExportAccess(actor: EnterpriseActor, input: { exportId: string; accessPurpose: string; recipientId: string; idempotencyKey: string }): JsonObject {
    assertActor(actor, COMPLIANCE); const value = this.#required(actor.tenantId, "compliance.auditExport", input.exportId); requireState(value.state.state === "issued" && String(value.state.expiresAt) > this.#clock().toISOString(), "audit export is expired or unavailable");
    const state: JsonObject = { ...value.state, accessCount: Number(value.state.accessCount) + 1, lastAccessedAt: this.#clock().toISOString(), lastRecipientId: identifier(input.recipientId, "recipientId") };
    return this.#write(actor, input.idempotencyKey, "B124.recordAuditExportAccess", { exportId: input.exportId, accessPurpose: text(input.accessPurpose, "accessPurpose"), recipientId: input.recipientId }, "compliance.auditExport", input.exportId, "compliance.auditExportAccessed", { accessPurpose: input.accessPurpose, recipientId: input.recipientId }, value.version, state);
  }

  // B124-R05 — control/legal/vendor/profile change blocks use until independent recertification.
  triggerImpactAssessment(actor: EnterpriseActor, input: { assessmentId: string; productVersion: string; changeKinds: readonly ("control" | "legal" | "vendor" | "profile")[]; changedArtifactSha256: string; affectedControlIds: readonly string[]; idempotencyKey: string }): JsonObject {
    assertActor(actor, COMPLIANCE); const kinds = unique(input.changeKinds, "changeKinds");
    const state: JsonObject = { assessmentId: identifier(input.assessmentId, "assessmentId"), productVersion: identifier(input.productVersion, "productVersion"), changeKinds: kinds, changedArtifactSha256: hexDigest(input.changedArtifactSha256, "changedArtifactSha256"), affectedControlIds: unique(input.affectedControlIds, "affectedControlIds"), releaseDecision: "blocked", recertification: "NOT_CERTIFIED", state: "reassessment_required" };
    return this.#write(actor, input.idempotencyKey, "B124.triggerImpactAssessment", state, "compliance.impactAssessment", input.assessmentId, "compliance.reassessmentTriggered", state);
  }
  applyRecertificationAttestation(actor: EnterpriseActor, attestation: SignedEnterpriseAttestation, idempotencyKey: string): JsonObject {
    assertActor(actor, COMPLIANCE); const fact = this.#facts.verify(attestation, { tenantId: actor.tenantId, factKind: "compliance.recertification", independent: true, issuerRole: "independent-compliance-authority" }); const assessment = this.#required(actor.tenantId, "compliance.impactAssessment", fact.subjectId);
    exactKeys(fact.payload, ["assessmentId", "productVersion", "changeKinds", "changedArtifactSha256", "affectedControlIds", "controlsPassed", "reportSha256"], "recertification attestation");
    for (const field of ["assessmentId", "productVersion", "changedArtifactSha256"] as const) if (fact.payload[field] !== assessment.state[field]) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "recertification binding mismatch");
    if (JSON.stringify(fact.payload.changeKinds) !== JSON.stringify(assessment.state.changeKinds) || JSON.stringify(fact.payload.affectedControlIds) !== JSON.stringify(assessment.state.affectedControlIds) || fact.payload.controlsPassed !== true) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "recertification does not cover the exact change");
    const certification = externalCertification(fact.environment); const state: JsonObject = { ...assessment.state, recertification: certification, releaseDecision: "passed", reportSha256: hexDigest(String(fact.payload.reportSha256), "reportSha256"), factId: fact.factId, state: "recertified" };
    return this.#factWrite(actor, fact, idempotencyKey, "B124.applyRecertification", { assessmentId: assessment.aggregateId }, "compliance.impactAssessment", assessment.aggregateId, "compliance.recertificationApplied", { factId: fact.factId, certification }, assessment.version, state);
  }

  #write(actor: EnterpriseActor, key: string, operation: string, request: JsonObject, aggregateType: string, aggregateId: string, eventType: string, event: JsonObject, expectedVersion: number | null = null, state: JsonObject = request): JsonObject {
    return this.#repository.execute(actor.tenantId, key, operation, request, () => this.#repository.put({ tenantId: actor.tenantId, aggregateType, aggregateId, expectedVersion, state, eventType, event }).state).value as JsonObject;
  }
  #factWrite(actor: EnterpriseActor, fact: VerifiedEnterpriseAttestation, key: string, operation: string, request: JsonObject, aggregateType: string, aggregateId: string, eventType: string, event: JsonObject, expectedVersion: number | null, state: JsonObject): JsonObject {
    return this.#repository.execute(actor.tenantId, key, operation, { ...request, factSha256: fact.factSha256 }, () => { this.#repository.claimFact({ tenantId: actor.tenantId, factId: fact.factId, factSha256: fact.factSha256, issuer: fact.issuer, factKind: fact.factKind, subjectId: fact.subjectId, sequence: fact.sequence, occurredAt: fact.occurredAt }); return this.#repository.put({ tenantId: actor.tenantId, aggregateType, aggregateId, expectedVersion, state, eventType, event }).state; }).value as JsonObject;
  }
  #required<T extends JsonObject = JsonObject>(tenantId: string, type: string, id: string): EnterpriseSnapshot<T> { const value = this.#repository.get<T>(tenantId, type, id); if (value === undefined) throw new EnterpriseControlError("NOT_FOUND", `${type}/${id} not found`); return value; }
}

function requireExactInventory<T extends string>(actual: readonly T[], required: readonly T[], field: string): void {
  if (actual.length !== required.length || new Set(actual).size !== required.length || required.some((value) => !actual.includes(value))) throw new EnterpriseControlError("VALIDATION_FAILED", `${field} must contain the exact mandatory inventory`);
}
function externalCertification(environment: string): "CERTIFIED" | "TEST_VERIFIED" { return environment === "production" ? "CERTIFIED" : "TEST_VERIFIED"; }
