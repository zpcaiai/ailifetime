import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { certifyB127, verifyB127Certification } from "./b127-certifier.mjs";
import {
  deploymentEvidenceScope,
  REQUIRED_DEPLOYMENT_CHECKS,
  certifyProductionDeployment,
  verifyProductionDeploymentEvidence,
} from "./deployment-evidence.mjs";
import { isProductionReleaseApproved, releaseGateOutcome } from "./release-gate-policy.mjs";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const COMMIT = "a".repeat(40);
const TENANT_ID = "tenant-production";
const LAUNCH_ID = "launch-production-2026";
const RELEASE_PROVIDER_ID = "control-plane-prod";
const APPROVAL_DECISIONS = {
  independentPenetrationTest: "passed",
  legalRegulatoryReview: "approved",
  manualAccessibilityReview: "passed",
  appleAppStoreDecision: "approved",
  googlePlayDecision: "approved",
  wechatMiniProgramDecision: "approved",
  disasterRecoveryDrill: "passed",
  productionChangeApproval: "approved",
};

test("B127 verifier independently validates production manifest, SBOM, record, consumption, and five Ed25519 signers", async (testContext) => {
  const fixture = createFixture(testContext);
  const result = await verifyB127Certification({ ...fixture.options, now: NOW });

  assert.equal(result.status, "PASS");
  assert.equal(result.recordId, "b127-record");
  assert.equal(result.evidence.count, 5);
  assert.equal(result.evidence.distinctTrustedSigners, 5);
  assert.equal(result.prerequisiteB126.evidence.count, 5);
  assert.equal(result.batchReports.batchCount, 128);
  assert.equal(result.batchReports.requirementCount, 640);
  assert.deepEqual(Object.keys(result.approvals).sort(), Object.keys(APPROVAL_DECISIONS).sort());
});

test("B127 verifier fails closed when the exact SBOM bytes change", async (testContext) => {
  const fixture = createFixture(testContext);
  writeFileSync(fixture.sbomPath, `${JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", components: [{ name: "tampered" }] })}\n`, { mode: 0o600 });

  const result = await certifyB127({ ...fixture.options, now: NOW });
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "SBOM_DIGEST_MISMATCH");
});

test("B127 verifier rejects a pentest/legal/store/DR approval artifact changed after the signed manifest", async (testContext) => {
  const fixture = createFixture(testContext);
  writeFileSync(fixture.approvalArtifactPaths.independentPenetrationTest, "tampered approval report\n", { mode: 0o600 });

  const result = await certifyB127({ ...fixture.options, now: NOW });
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "APPROVAL_ARTIFACT_DIGEST_MISMATCH");
});

test("B127 verifier rejects a changed B00-B127 certification report", async (testContext) => {
  const fixture = createFixture(testContext);
  writeFileSync(fixture.batchReportPath, "tampered batch report\n", { mode: 0o600 });

  const result = await certifyB127({ ...fixture.options, now: NOW });
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "BATCH_REPORT_ARTIFACT_DIGEST_MISMATCH");
});

test("B127 verifier keeps canary and regional waves intermediate", async (testContext) => {
  const fixture = createFixture(testContext, { wave: "consumer_canary", rolloutPercent: 5 });
  const result = await certifyB127({ ...fixture.options, now: NOW });

  assert.equal(result.status, "BLOCKED_EXTERNAL");
  assert.equal(result.code, "B127_FINAL_ROLLOUT_INCOMPLETE");
});

test("B127 verifier rejects an invalid B126 prerequisite signature", async (testContext) => {
  const fixture = createFixture(testContext, { tamperedB126SignatureIndex: 3 });
  const result = await certifyB127({ ...fixture.options, now: NOW });

  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "B126_EVIDENCE_SIGNATURE_INVALID");
});

test("B127 verifier blocks missing approval and unconsumed evidence", async (testContext) => {
  const missingApproval = createFixture(testContext, { missingApproval: "legalRegulatoryReview" });
  const approvalResult = await certifyB127({ ...missingApproval.options, now: NOW });
  assert.equal(approvalResult.status, "BLOCKED_EXTERNAL");
  assert.equal(approvalResult.code, "EXTERNAL_APPROVAL_MISSING");

  const unconsumed = createFixture(testContext, { unconsumedEvidenceIndex: 4 });
  const evidenceResult = await certifyB127({ ...unconsumed.options, now: NOW });
  assert.equal(evidenceResult.status, "BLOCKED_EXTERNAL", JSON.stringify(evidenceResult));
  assert.equal(evidenceResult.code, "B127_EVIDENCE_NOT_CONSUMED");
});

test("B127 verifier rejects an invalid stored Ed25519 signature", async (testContext) => {
  const fixture = createFixture(testContext, { tamperedSignatureIndex: 2 });
  const result = await certifyB127({ ...fixture.options, now: NOW });
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "B127_EVIDENCE_SIGNATURE_INVALID");
});

test("B127 verifier blocks expired production evidence", async (testContext) => {
  const fixture = createFixture(testContext, { expiredEvidenceIndex: 1 });
  const result = await certifyB127({ ...fixture.options, now: NOW });
  assert.equal(result.status, "BLOCKED_EXTERNAL", JSON.stringify(result));
  assert.equal(result.code, "B127_EVIDENCE_EXPIRED");
});

test("production B127 certification refuses a SQLite evidence copy", async (testContext) => {
  const fixture = createFixture(testContext);
  const result = await certifyB127({
    ...fixture.options,
    certificationProfile: "production",
    now: NOW,
  });

  assert.equal(result.status, "BLOCKED_EXTERNAL");
  assert.equal(result.code, "B127_PRODUCTION_SOURCE_INVALID");
});

test("production release decision requires every check to be exactly PASS", () => {
  assert.equal(isProductionReleaseApproved("production", [{ status: "PASS" }, { status: "PASS" }]), true);
  for (const status of ["FAIL", "BLOCKED", "BLOCKED_EXTERNAL", "NOT_RUN", "PASS_CONFIG_ONLY", "PASS_LIMITED"]) {
    assert.equal(isProductionReleaseApproved("production", [{ status: "PASS" }, { status }]), false, status);
  }
  assert.equal(isProductionReleaseApproved("ci", [{ status: "PASS" }]), false);
  assert.equal(releaseGateOutcome("production", [{ status: "PASS" }, { status: "PASS_CONFIG_ONLY" }]), "BLOCKED");
  assert.equal(releaseGateOutcome("production", [{ status: "PASS" }, { status: "FAIL" }]), "FAIL");
});

test("signed deployment evidence upgrades every required production integration and scan from exact artifacts", (testContext) => {
  const fixture = createDeploymentFixture(testContext);
  const result = verifyProductionDeploymentEvidence({ ...fixture.options, now: NOW });
  assert.equal(result.status, "PASS");
  assert.equal(Object.keys(result.checks).length, REQUIRED_DEPLOYMENT_CHECKS.length);
  assert.deepEqual(Object.keys(result.checks).sort(), [...REQUIRED_DEPLOYMENT_CHECKS].sort());
});

test("signed deployment evidence rejects a report artifact changed after attestation", (testContext) => {
  const fixture = createDeploymentFixture(testContext);
  writeFileSync(fixture.firstArtifactPath, "tampered\n", { mode: 0o600 });
  const result = certifyProductionDeployment({ ...fixture.options, now: NOW });
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "DEPLOYMENT_ARTIFACT_DIGEST_MISMATCH");
});

function createFixture(testContext, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ltm-b127-certifier-"));
  testContext.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "release-manifest.json");
  const trustedKeysPath = join(directory, "trusted-keys.json");
  const databasePath = join(directory, "runtime.sqlite");
  const artifact = (relativePath, value) => writeFixtureArtifact(directory, relativePath, value);
  const sbom = artifact("release.sbom.json", {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    components: [{ name: "ltm", version: "1.0.0" }],
  });
  const selectedProfile = {
    name: "full-commercial",
    version: "2.0.0",
    artifact: artifact("release/profile.json", { name: "full-commercial", version: "2.0.0" }).reference,
  };
  const componentNames = [
    "api", "web", "sdkTypeScript", "sdkPython", "sdkJava",
    "mobileIos", "mobileAndroid", "wechatMiniProgram", "productionConfiguration",
  ];
  const componentVersions = Object.fromEntries(componentNames.map((name) => [name, {
    version: "2.0.0",
    artifact: artifact(`release/components/${name}.json`, { component: name, version: "2.0.0", commit: COMMIT }).reference,
  }]));
  const componentSetSha256 = sha256(Buffer.from(canonicalJson(componentVersions)));
  const reportHashes = Object.fromEntries(Array.from({ length: 128 }, (_, index) => {
    const batchId = `B${String(index).padStart(2, "0")}`;
    return [batchId, sha256(Buffer.from(`production-report:${batchId}:${COMMIT}`))];
  }));
  const reportSetSha256 = sha256(Buffer.from(canonicalJson(reportHashes)));
  const batchReportDocument = {
    schemaVersion: "ltm.batch-certification-report.v1",
    repositoryCommit: COMMIT,
    profile: { name: selectedProfile.name, version: selectedProfile.version },
    generatedAt: "2026-08-20T09:40:00.000Z",
    status: "passed",
    batchCount: 128,
    requirementCount: 640,
    unresolvedBlockers: [],
    reportHashes,
    reportSetSha256,
  };
  const batchReportArtifact = artifact("release/batch-certification-report.json", batchReportDocument);
  const batchReports = {
    generatedAt: batchReportDocument.generatedAt,
    status: "passed",
    batchCount: 128,
    requirementCount: 640,
    unresolvedBlockers: [],
    reportHashes,
    reportSetSha256,
    artifact: batchReportArtifact.reference,
  };
  const b126Artifact = artifact("release/b126-commercial-e2e.json", {
    certificationId: "commercial-e2e-2026",
    state: "certified_for_staged_launch",
    commit: COMMIT,
  });
  const b126ProviderId = "commercial-auditor-prod";
  const b126EvidenceIds = Array.from({ length: 5 }, (_, index) => `b126-evidence-${index + 1}`);
  const b126ScopeValue = b126Scope({
    tenantId: TENANT_ID,
    provider: `e2e-auditor:${b126ProviderId}`,
    artifactSha256: b126Artifact.reference.sha256,
    certificationId: "commercial-e2e-2026",
  });
  const b126Certification = {
    certificationId: "commercial-e2e-2026",
    recordId: "b126-record",
    auditorProviderId: b126ProviderId,
    evidenceIds: b126EvidenceIds,
    artifact: b126Artifact.reference,
  };

  const keys = Array.from({ length: 5 }, (_, index) => {
    const pair = generateKeyPairSync("ed25519");
    return {
      issuer: `production-authority-${index + 1}`,
      keyId: `release-key-${index + 1}`,
      privateKey: pair.privateKey,
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
  });
  const evidenceIds = keys.map((_, index) => `release-evidence-${index + 1}`);
  const approvalNames = Object.keys(APPROVAL_DECISIONS);
  const approvalArtifactPaths = {};
  const approvals = Object.fromEntries(approvalNames.map((name, index) => {
    const keyIndex = index % keys.length;
    const approvalArtifact = artifact(`approvals/${name}.json`, { approval: name, decision: APPROVAL_DECISIONS[name] });
    approvalArtifactPaths[name] = approvalArtifact.path;
    return [name, {
      approvalId: `approval-${index + 1}`,
      authority: `Production Authority ${keyIndex + 1}`,
      issuer: keys[keyIndex].issuer,
      evidenceId: evidenceIds[keyIndex],
      artifact: approvalArtifact.reference,
      decision: APPROVAL_DECISIONS[name],
      approvedAt: "2026-08-20T10:00:00.000Z",
      expiresAt: "2026-08-21T12:00:00.000Z",
    }];
  }));
  if (options.missingApproval !== undefined) delete approvals[options.missingApproval];

  const wave = options.wave ?? "global";
  const rolloutPercent = options.rolloutPercent ?? 100;
  const waveStartedAt = "2026-08-20T11:00:00.000Z";
  const priorWaveNames = ["internal", "pilot", "consumer_canary", "partner", "regional"];
  const priorWavePercents = [1, 2, 5, 10, 25];
  const priorWaveStarts = [
    "2026-08-19T20:00:00.000Z", "2026-08-19T21:00:00.000Z", "2026-08-19T22:00:00.000Z",
    "2026-08-19T23:00:00.000Z", "2026-08-20T00:00:00.000Z",
  ];
  const priorWaveEnds = [
    "2026-08-19T21:00:00.000Z", "2026-08-19T22:00:00.000Z", "2026-08-19T23:00:00.000Z",
    "2026-08-20T00:00:00.000Z", "2026-08-20T01:00:00.000Z",
  ];
  const completedWaves = priorWaveNames.map((name, index) => ({
    wave: name,
    status: "passed",
    rolloutPercent: priorWavePercents[index],
    startedAt: priorWaveStarts[index],
    completedAt: priorWaveEnds[index],
    minimumObservationSeconds: 3_600,
    observedSeconds: 3_600,
    guardrailBreaches: 0,
    artifact: artifact(`release/waves/${name}.json`, { wave: name, state: "passed", guardrailBreaches: 0 }).reference,
  }));
  const operationsHandoffArtifact = artifact("release/operations-handoff.json", {
    handoffId: "operations-handoff-2026",
    status: "accepted",
  });
  const manifest = {
    schemaVersion: "ltm.production-release-manifest.v1",
    generatedAt: "2026-08-20T10:30:00.000Z",
    tenantId: TENANT_ID,
    launchId: LAUNCH_ID,
    environment: "production",
    deploymentScope: "production",
    releaseControlProviderId: RELEASE_PROVIDER_ID,
    repositoryCommit: COMMIT,
    artifactCommit: COMMIT,
    selectedProfile,
    componentVersions,
    componentSetSha256,
    batchReports,
    b126Certification,
    sbom: { ...sbom.reference, format: "cyclonedx-json" },
    rollout: {
      wave,
      rolloutPercent,
      waveStartedAt,
      rollbackExerciseId: "approval-7",
      automaticPausePolicyVersion: "pause-policy-v3",
      completedWaves,
    },
    approvals,
    goLive: {
      windowStart: "2026-08-20T10:45:00.000Z",
      windowEnd: "2026-08-20T11:15:00.000Z",
      scheduledAt: waveStartedAt,
      changeApprovalId: "approval-8",
    },
    operationsHandoff: {
      handoffId: "operations-handoff-2026",
      status: "accepted",
      acceptedAt: "2026-08-20T09:50:00.000Z",
      acceptedBy: "production-operations-lead",
      runbookVersion: "runbook-v3",
      onCallScheduleVersion: "oncall-v4",
      supportPlanVersion: "support-v2",
      artifact: operationsHandoffArtifact.reference,
    },
    exceptions: [],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
  const manifestSha256 = sha256(manifestBytes);
  const b127ScopeValue = b127Scope(manifestSha256);
  const trustDocument = {
    schemaVersion: "ltm.trusted-evidence-keys.v1",
    keys: keys.flatMap((key) => [
      trustedKey(key, `release-control:${RELEASE_PROVIDER_ID}`, b127ScopeValue),
      trustedKey(key, `e2e-auditor:${b126ProviderId}`, b126ScopeValue),
    ]),
  };
  writeFileSync(trustedKeysPath, `${JSON.stringify(trustDocument, null, 2)}\n`, { mode: 0o600 });

  const database = new DatabaseSync(databasePath);
  createFixtureSchema(database);
  const b126Record = {
    batchId: "B126",
    operation: "certifyCommercialE2e",
    operationMode: "attestation",
    executionState: "evidence_persisted",
    certificationId: b126Certification.certificationId,
    auditorProviderId: b126ProviderId,
    scenarioArtifactSha256: b126Artifact.reference.sha256,
    environment: "production_canary",
    entrypoints: ["web", "api", "mobile", "wechat_mini_program"],
    scenarios: ["consent", "generation", "payment", "refund", "physical_fulfillment", "support", "finance_close", "deletion"],
    financialControlTotalMinor: 10_000,
    ledgerControlTotalMinor: 10_000,
    deletionProofTargets: ["connector", "cdn", "vendor", "warehouse", "application"],
    criticalFailures: 0,
    entitlementReconciliationId: "entitlement-reconciliation-2026",
    externalEvidenceIds: b126EvidenceIds,
    evidenceScope: b126ScopeValue,
    state: "certified_for_staged_launch",
  };
  insertFixtureRecord(database, "b126-record", b126Record, "2026-08-20T09:45:00.000Z");
  const record = {
    batchId: "B127",
    operation: "approveStagedProductionLaunch",
    operationMode: "attestation",
    executionState: "evidence_persisted",
    state: "wave_approved",
    tenantId: TENANT_ID,
    launchId: LAUNCH_ID,
    releaseControlProviderId: RELEASE_PROVIDER_ID,
    providerEnvironment: "production",
    releaseManifestDigest: manifestSha256,
    repositoryCommit: COMMIT,
    artifactCommit: COMMIT,
    sbomDigest: sbom.reference.sha256,
    wave,
    rolloutPercent,
    waveStartedAt,
    releaseGates: Array.from({ length: 12 }, (_, index) => `G${index}`),
    monitoringDomains: ["quality", "payment", "refund", "support", "ledger", "supply", "privacy", "security"],
    approvalIds: approvalNames.map((_, index) => `approval-${index + 1}`),
    rollbackExerciseId: "approval-7",
    automaticPausePolicyVersion: "pause-policy-v3",
    activeGuardrailBreaches: 0,
    externalEvidenceIds: evidenceIds,
    evidenceScope: b127ScopeValue,
  };
  insertFixtureRecord(database, "b127-record", record, "2026-08-20T11:30:00.000Z");
  keys.forEach((key, index) => {
    insertFixtureEvidence(database, key, {
      evidenceId: b126EvidenceIds[index],
      provider: `e2e-auditor:${b126ProviderId}`,
      scope: b126ScopeValue,
      artifactSha256: b126Artifact.reference.sha256,
      issuedAt: "2026-08-20T08:30:00.000Z",
      verifiedAt: "2026-08-20T08:31:00.000Z",
      consumedAt: "2026-08-20T09:30:00.000Z",
      expiresAt: "2026-08-21T12:00:00.000Z",
      nonce: `b126-production-nonce-${index + 1}`,
      tampered: options.tamperedB126SignatureIndex === index,
    });
    insertFixtureEvidence(database, key, {
      evidenceId: evidenceIds[index],
      provider: `release-control:${RELEASE_PROVIDER_ID}`,
      scope: b127ScopeValue,
      artifactSha256: manifestSha256,
      issuedAt: "2026-08-20T10:45:00.000Z",
      verifiedAt: "2026-08-20T10:46:00.000Z",
      consumedAt: "2026-08-20T11:31:00.000Z",
      expiresAt: options.expiredEvidenceIndex === index ? "2026-08-20T11:30:00.000Z" : "2026-08-21T12:00:00.000Z",
      nonce: `production-release-nonce-${index + 1}`,
      tampered: options.tamperedSignatureIndex === index,
      consumed: options.unconsumedEvidenceIndex !== index,
    });
  });
  database.close();
  chmodSync(databasePath, 0o600);

  return {
    sbomPath: sbom.path,
    batchReportPath: batchReportArtifact.path,
    approvalArtifactPaths,
    options: {
      root: directory,
      databasePath,
      manifestPath,
      trustedKeysPath,
      tenantId: TENANT_ID,
      launchId: LAUNCH_ID,
      expectedCommit: COMMIT,
    },
  };
}

function writeFixtureArtifact(root, relativePath, value) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, reference: { path: relativePath, sha256: sha256(bytes) } };
}

function trustedKey(key, provider, scope) {
  return {
    issuer: key.issuer,
    provider,
    keyId: key.keyId,
    algorithm: "Ed25519",
    publicKeyPem: key.publicKeyPem,
    allowedScopes: [scope],
    allowedEnvironments: ["production"],
    notBefore: "2026-08-19T00:00:00.000Z",
    notAfter: "2026-08-22T00:00:00.000Z",
  };
}

function createFixtureSchema(database) {
  database.exec(`
    CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '3');
    CREATE TABLE records (
      tenant_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
      data_json TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, deleted_at TEXT,
      PRIMARY KEY (tenant_id, collection, id)
    ) STRICT;
    CREATE TABLE external_evidence (
      tenant_id TEXT NOT NULL, id TEXT NOT NULL, envelope_version TEXT NOT NULL,
      issuer TEXT NOT NULL, provider TEXT NOT NULL, environment TEXT NOT NULL,
      scope TEXT NOT NULL, artifact_sha256 TEXT NOT NULL, issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, nonce TEXT NOT NULL, replay_policy TEXT NOT NULL,
      algorithm TEXT NOT NULL, key_id TEXT NOT NULL, signature TEXT NOT NULL,
      status TEXT NOT NULL, version INTEGER NOT NULL, verified_at TEXT NOT NULL,
      revoked_at TEXT, revocation_reason TEXT,
      PRIMARY KEY (tenant_id, id)
    ) STRICT;
    CREATE TABLE evidence_consumptions (
      tenant_id TEXT NOT NULL, evidence_id TEXT NOT NULL, scope TEXT NOT NULL,
      consumption_key_hash TEXT NOT NULL, consumed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, evidence_id)
    ) STRICT;
  `);
}

function insertFixtureRecord(database, id, data, timestamp) {
  database.prepare(
    `INSERT INTO records(tenant_id, collection, id, data_json, version, created_at, updated_at, deleted_at)
     VALUES (?, 'capability.launching-complete-commercial-product', ?, ?, 1, ?, ?, NULL)`,
  ).run(TENANT_ID, id, JSON.stringify(data), timestamp, timestamp);
}

function insertFixtureEvidence(database, key, options) {
  const envelope = {
    version: "ltm.external-evidence.v1",
    evidenceId: options.evidenceId,
    tenantId: TENANT_ID,
    issuer: key.issuer,
    provider: options.provider,
    environment: "production",
    scope: options.scope,
    artifactSha256: options.artifactSha256,
    issuedAt: options.issuedAt,
    expiresAt: options.expiresAt,
    nonce: options.nonce,
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: key.keyId,
  };
  let signature = sign(null, Buffer.from(canonicalJson(envelope)), key.privateKey).toString("base64url");
  if (options.tampered === true) signature = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  database.prepare(
    `INSERT INTO external_evidence(
       tenant_id,id,envelope_version,issuer,provider,environment,scope,artifact_sha256,
       issued_at,expires_at,nonce,replay_policy,algorithm,key_id,signature,status,version,
       verified_at,revoked_at,revocation_reason
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'verified',1,?,NULL,NULL)`,
  ).run(
    TENANT_ID, envelope.evidenceId, envelope.version, envelope.issuer, envelope.provider,
    envelope.environment, envelope.scope, envelope.artifactSha256, envelope.issuedAt,
    envelope.expiresAt, envelope.nonce, envelope.replayPolicy, envelope.algorithm,
    envelope.keyId, signature, options.verifiedAt,
  );
  if (options.consumed !== false) {
    database.prepare(
      "INSERT INTO evidence_consumptions(tenant_id,evidence_id,scope,consumption_key_hash,consumed_at) VALUES (?,?,?,?,?)",
    ).run(TENANT_ID, envelope.evidenceId, envelope.scope, sha256(Buffer.from(`consume-${envelope.evidenceId}`)), options.consumedAt);
  }
}

function createDeploymentFixture(testContext) {
  const directory = mkdtempSync(join(tmpdir(), "ltm-deployment-evidence-"));
  testContext.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = "deployment-assurance:production-control";
  const deploymentId = "deployment-production-2026";
  const targetBaseUrl = "https://ltm.example.com/";
  const releaseManifestSha256 = "b".repeat(64);
  const signingPair = generateKeyPairSync("ed25519");
  const scope = deploymentEvidenceScope({
    tenantId: TENANT_ID,
    launchId: LAUNCH_ID,
    deploymentId,
    provider,
    commit: COMMIT,
    releaseManifestSha256,
    targetBaseUrl,
  });
  const checks = {};
  let firstArtifactPath;
  mkdirSync(join(directory, "reports"), { recursive: true, mode: 0o700 });
  for (const [index, checkId] of REQUIRED_DEPLOYMENT_CHECKS.entries()) {
    const relativePath = `reports/${String(index + 1).padStart(2, "0")}-${checkId}.json`;
    const artifactPath = join(directory, relativePath);
    const artifact = Buffer.from(`${JSON.stringify({ checkId, status: "passed", target: targetBaseUrl })}\n`);
    writeFileSync(artifactPath, artifact, { mode: 0o600 });
    firstArtifactPath ??= artifactPath;
    checks[checkId] = {
      status: "passed",
      observedAt: "2026-08-20T11:00:00.000Z",
      target: targetBaseUrl,
      artifact: { path: relativePath, sha256: sha256(artifact) },
    };
  }
  const unsigned = {
    schemaVersion: "ltm.production-deployment-evidence.v1",
    environment: "production",
    deploymentId,
    tenantId: TENANT_ID,
    launchId: LAUNCH_ID,
    commit: COMMIT,
    releaseManifestSha256,
    targetBaseUrl,
    issuedAt: "2026-08-20T11:30:00.000Z",
    expiresAt: "2026-08-21T11:30:00.000Z",
    issuer: "production-deployment-auditor",
    provider,
    keyId: "deployment-key-2026",
    algorithm: "Ed25519",
    scope,
    checks,
  };
  const signature = sign(null, Buffer.from(canonicalJson(unsigned)), signingPair.privateKey).toString("base64url");
  const evidencePath = join(directory, "deployment-evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify({ ...unsigned, signature }, null, 2)}\n`, { mode: 0o600 });
  const fillerKeys = Array.from({ length: 4 }, (_, index) => {
    const pair = generateKeyPairSync("ed25519");
    return {
      issuer: `production-release-filler-${index + 1}`,
      provider: `release-control:filler-${index + 1}`,
      keyId: `filler-key-${index + 1}`,
      algorithm: "Ed25519",
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedScopes: ["ltm-evidence:v1:*"],
      allowedEnvironments: ["production"],
    };
  });
  const trustedKeysPath = join(directory, "trusted-keys.json");
  writeFileSync(trustedKeysPath, `${JSON.stringify({
    schemaVersion: "ltm.trusted-evidence-keys.v1",
    keys: [...fillerKeys, {
      issuer: unsigned.issuer,
      provider,
      keyId: unsigned.keyId,
      algorithm: "Ed25519",
      publicKeyPem: signingPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedScopes: [scope],
      allowedEnvironments: ["production"],
      notBefore: "2026-08-19T00:00:00.000Z",
      notAfter: "2026-08-22T00:00:00.000Z",
    }],
  }, null, 2)}\n`, { mode: 0o600 });
  return {
    firstArtifactPath,
    options: {
      root: directory,
      evidencePath,
      trustedKeysPath,
      tenantId: TENANT_ID,
      launchId: LAUNCH_ID,
      expectedCommit: COMMIT,
      releaseManifestSha256,
      expectedTargetBaseUrl: targetBaseUrl,
    },
  };
}

function b127Scope(manifestSha256) {
  const fields = [
    "ltm-capability-evidence-v1",
    TENANT_ID,
    "B127",
    "approveStagedProductionLaunch",
    "release-control-plane",
    `release-control:${RELEASE_PROVIDER_ID}`,
    manifestSha256,
    "production",
    LAUNCH_ID,
  ];
  const canonical = fields.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return `ltm-evidence:v1:${sha256(Buffer.from(canonical))}`;
}

function b126Scope({ tenantId, provider, artifactSha256, certificationId }) {
  const fields = [
    "ltm-capability-evidence-v1",
    tenantId,
    "B126",
    "certifyCommercialE2e",
    "commercial-e2e",
    provider,
    artifactSha256,
    "production",
    certificationId,
  ];
  const canonical = fields.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return `ltm-evidence:v1:${sha256(Buffer.from(canonical))}`;
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
