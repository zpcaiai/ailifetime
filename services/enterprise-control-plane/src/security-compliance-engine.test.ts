import assert from "node:assert/strict";
import { test } from "node:test";
import { EnterpriseSecurityComplianceEngine } from "./security-compliance-engine.js";
import { ACTOR, APPROVERS, HASH, HASH2, fact, makeHarness } from "./test-fixtures.js";

const scanSurfaces = ["secret", "sast", "sca", "iac", "container", "api", "frontend", "mobile", "miniapp"] as const;
const dastSurfaces = ["authentication", "tenant_isolation", "idor", "upload", "signed_url", "webhook", "payment", "ssrf", "xss", "csrf", "admin"] as const;
const evidenceCategories = ["configuration", "access", "scan", "deletion", "vendor", "incident", "training", "finance", "release"] as const;
const applicabilityAreas = ["generative_ai", "ai_label", "facial_processing", "privacy_impact_assessment", "children", "anthropomorphic_interaction"] as const;

function build(engine: EnterpriseSecurityComplianceEngine, buildId = "build-1"): void {
  engine.applyBuildProvenance(ACTOR, fact("security.build-provenance", buildId, { buildId, sourceRevision: "revision-1", artifactSha256: HASH, sbomSha256: HASH, dependencyInventorySha256: HASH, licenseInventorySha256: HASH, provenanceSha256: HASH, signatureVerified: true, builderIdentity: "workload-builder" }), `build-${buildId}`);
}

test("B123-R01 ingests signed artifact-bound SBOM dependency license and source provenance", () => {
  const h = makeHarness(); const engine = new EnterpriseSecurityComplianceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); build(engine); const saved = h.repository.get(ACTOR.tenantId, "security.build", "build-1"); assert.equal(saved?.state.state, "provenance_verified"); assert.equal(saved?.state.artifactSha256, HASH); h.repository.close();
});

test("B123-R02 exact scan matrix applies severity hard release gates", () => {
  const h = makeHarness(); const engine = new EnterpriseSecurityComplianceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); build(engine);
  const result = engine.applyScanMatrix(ACTOR, fact("security.scan-matrix", "build-1", { buildId: "build-1", artifactSha256: HASH, scans: scanSurfaces.map((surface, index) => ({ surface, critical: 0, high: index === 0 ? 1 : 0, medium: 0, reportSha256: HASH })), criticalThreshold: 0, highThreshold: 0, reportSha256: HASH }), "scan"); assert.equal(result.releaseDecision, "blocked"); assert.equal(result.highFindings, 1); h.repository.close();
});

test("B123-R03 DAST covers auth tenant IDOR upload URLs callbacks payment SSRF XSS CSRF and admin", () => {
  const h = makeHarness(); const engine = new EnterpriseSecurityComplianceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); build(engine);
  assert.throws(() => engine.applyDastCoverage(ACTOR, fact("security.dast", "build-1", { buildId: "build-1", artifactSha256: HASH, coveredSurfaces: dastSurfaces.slice(1), critical: 0, high: 0, reportSha256: HASH }), "dast-missing"), /exact mandatory inventory/);
  const passed = engine.applyDastCoverage(ACTOR, fact("security.dast", "build-1", { buildId: "build-1", artifactSha256: HASH, coveredSurfaces: dastSurfaces, critical: 0, high: 0, reportSha256: HASH }), "dast"); assert.equal(passed.dastDecision, "passed"); h.repository.close();
});

test("B123-R04 independent pentest remains NOT_CERTIFIED until exact external evidence", () => {
  const h = makeHarness(); const engine = new EnterpriseSecurityComplianceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); engine.registerPentestEngagement(ACTOR, { engagementId: "pentest-1", releaseId: "release-1", scopeSha256: HASH, controlledTestDataSha256: HASH, responsibilityMatrixSha256: HASH, providerContractId: "provider-contract", idempotencyKey: "pentest" });
  const payload = { engagementId: "pentest-1", releaseId: "release-1", scopeSha256: HASH, controlledTestDataSha256: HASH, responsibilityMatrixSha256: HASH, criticalOpen: 0, highOpen: 0, remediationVerified: true, retestReportSha256: HASH };
  assert.throws(() => engine.applyPentestAttestation(ACTOR, fact("security.pentest", "pentest-1", payload), "pentest-general"), /scope mismatch/); const verified = engine.applyPentestAttestation(ACTOR, fact("security.pentest", "pentest-1", payload, true), "pentest-independent"); assert.equal(verified.certification, "TEST_VERIFIED"); h.repository.close();
});

test("B123-R05 finding lifecycle enforces owner SLA dual exception controls expiry and independent retest", () => {
  const h = makeHarness(); const engine = new EnterpriseSecurityComplianceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); engine.registerFinding(ACTOR, { findingId: "finding-1", severity: "high", ownerId: "security-owner", dueAt: "2026-09-01T00:00:00.000Z", disclosurePolicyId: "disclosure-1", reportSha256: HASH, idempotencyKey: "finding" });
  const excepted = engine.grantFindingException(ACTOR, { findingId: "finding-1", approverIds: APPROVERS, compensatingControls: ["waf-block"], expiresAt: "2026-09-15T00:00:00.000Z", rationale: "bounded remediation window", idempotencyKey: "exception" }); assert.equal(excepted.state, "exception_active");
  const closed = engine.applyFindingRetest(ACTOR, fact("security.finding-retest", "finding-1", { findingId: "finding-1", reportSha256: HASH, resolved: true, retestReportSha256: HASH2 }, true), "retest"); assert.equal(closed.state, "closed_verified"); h.repository.close();
});

test("B124-R01 control library requires full obligation system owner frequency test evidence exception remediation mapping", () => {
  const h = makeHarness(); const engine = new EnterpriseSecurityComplianceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); const library = engine.registerControlLibrary(ACTOR, { libraryId: "controls", version: "v1", controls: [{ controlId: "CTRL-1", obligation: "PIPL purpose limitation", system: "api", ownerId: "privacy-owner", frequency: "quarterly", testProcedureId: "test-1", evidenceType: "signed-event", exceptionProcedureId: "exception-1", remediationProcedureId: "remediation-1" }], idempotencyKey: "controls" }); assert.equal((library.controls as unknown[]).length, 1); h.repository.close();
});

test("B124-R02 records AI facial child PIPL applicability and requires independent filing evidence", () => {
  const h = makeHarness(); const engine = new EnterpriseSecurityComplianceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); engine.registerApplicabilityRecord(ACTOR, { recordId: "applicability-1", productVersion: "v1", jurisdictions: ["CN"], idempotencyKey: "applicability", areas: applicabilityAreas.map((area) => ({ area, applicable: true, rationale: `${area} is in product scope`, requiredFiling: area === "generative_ai" ? "GENAI-FILING" : null, controlIds: [`control-${area}`] })) });
  const initial = h.repository.get(ACTOR.tenantId, "compliance.applicability", "applicability-1"); assert.equal(initial?.state.legalCertification, "NOT_CERTIFIED");
  const applied = engine.applyLegalFilingAttestation(ACTOR, fact("compliance.legal-filing", "applicability-1", { recordId: "applicability-1", productVersion: "v1", jurisdictions: ["CN"], filedRequirements: ["GENAI-FILING"], authorityReceiptSha256: HASH, validThrough: "2027-08-28T00:00:00.000Z" }, true), "legal"); assert.equal(applied.legalCertification, "TEST_VERIFIED"); h.repository.close();
});

test("B124-R03 signed evidence collection covers all nine domains with time and artifact hashes", () => {
  const h = makeHarness(); const engine = new EnterpriseSecurityComplianceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); const collection = engine.applyEvidenceCollection(ACTOR, fact("compliance.evidence-collection", "collection-1", { collectionId: "collection-1", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-08-28T00:00:00.000Z", items: evidenceCategories.map((category) => ({ category, artifactSha256: HASH, capturedAt: "2026-08-27T00:00:00.000Z", sourceSystem: `source-${category}` })), manifestSha256: HASH }), "collection"); assert.equal((collection.items as unknown[]).length, 9); h.repository.close();
});

test("B124-R04 audit export is tenant-scoped dual-approved encrypted watermarked expiring and access-logged", () => {
  const h = makeHarness(); const engine = new EnterpriseSecurityComplianceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); const issued = engine.issueAuditExport(ACTOR, { exportId: "export-1", scope: ["controls", "events"], periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-08-28T00:00:00.000Z", tenantId: ACTOR.tenantId, classifications: ["confidential"], approverIds: APPROVERS, encryptionKeyReference: "kms://cn-east/audit", watermark: "tenant-enterprise / audit only", expiresAt: "2026-08-29T00:00:00.000Z", artifactSha256: HASH, idempotencyKey: "export" }); assert.equal(issued.accessCount, 0);
  const accessed = engine.recordAuditExportAccess(ACTOR, { exportId: "export-1", accessPurpose: "independent audit", recipientId: "auditor-1", idempotencyKey: "access" }); assert.equal(accessed.accessCount, 1); assert.equal(h.repository.events(ACTOR.tenantId, "compliance.auditExport").at(-1)?.eventType, "compliance.auditExportAccessed"); h.repository.close();
});

test("B124-R05 control legal vendor and profile changes block release until exact independent recertification", () => {
  const h = makeHarness(); const engine = new EnterpriseSecurityComplianceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); const triggered = engine.triggerImpactAssessment(ACTOR, { assessmentId: "impact-1", productVersion: "v2", changeKinds: ["control", "legal", "vendor", "profile"], changedArtifactSha256: HASH, affectedControlIds: ["CTRL-1", "CTRL-2"], idempotencyKey: "impact" }); assert.equal(triggered.releaseDecision, "blocked");
  const result = engine.applyRecertificationAttestation(ACTOR, fact("compliance.recertification", "impact-1", { assessmentId: "impact-1", productVersion: "v2", changeKinds: ["control", "legal", "profile", "vendor"], changedArtifactSha256: HASH, affectedControlIds: ["CTRL-1", "CTRL-2"], controlsPassed: true, reportSha256: HASH2 }, true), "recertify"); assert.equal(result.releaseDecision, "passed"); assert.equal(result.recertification, "TEST_VERIFIED"); h.repository.close();
});
