import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import {
  CertificationError,
  PostgresB127CertificationSource,
  verifyB127Certification,
} from "./b127-certifier.mjs";
import {
  APPROVAL_AUTHORITY_ROLES,
  B127_PRODUCTION_RELEASE_AUTHORITY_ROLE,
  CHANGE_APPROVER_AUTHORITY_ROLES,
} from "./production-evidence-contracts.mjs";
import {
  createB127ReleaseControlFixtures,
  createB127ReleaseSubjectFixture,
} from "./b127-release-fixture.mjs";

const TEST_POSTGRES_URL = process.env.LTM_TEST_POSTGRES_URL;
const TEST_POSTGRES_ADMIN_URL = process.env.LTM_TEST_POSTGRES_ADMIN_URL;
const COMMIT = "c".repeat(40);
const RELEASE_PROVIDER_ID = "pg-control-plane";
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

test("production PostgreSQL source rejects a non-TLS connection before opening it", () => {
  assert.throws(
    () => new PostgresB127CertificationSource("postgresql://certifier@127.0.0.1/ltm?sslmode=disable", {
      certificationProfile: "production",
    }),
    (error) => error instanceof CertificationError && error.code === "B127_POSTGRES_TLS_CONFIG_INVALID",
  );
  assert.throws(
    () => new PostgresB127CertificationSource(
      "postgresql://certifier@db.production.example/ltm?sslmode=verify-full&sslmode=disable",
      { certificationProfile: "production" },
    ),
    (error) => error instanceof CertificationError && error.code === "B127_POSTGRES_URL_PARAMETER_INVALID",
  );
  for (const query of [
    "sslmode=verify-full&options=-c%20search_path%3Dltm",
    "sslmode=verify-full&opt%69ons=-c%20search_path%3Dltm",
    "sslmode=verify-full&OPTIONS=-c%20search_path%3Dltm",
    "sslmode=verify-full&sslMode=verify-full",
  ]) {
    assert.throws(
      () => new PostgresB127CertificationSource(
        `postgresql://certifier@db.production.example/ltm?${query}`,
        { certificationProfile: "production" },
      ),
      (error) => error instanceof CertificationError && error.code === "B127_POSTGRES_URL_PARAMETER_INVALID",
      query,
    );
  }
});

test("live PostgreSQL fixture uses the shared canonical release-subject and production supply-chain builder", (testContext) => {
  const fixture = createFileFixture(testContext);
  assert.equal(fixture.releaseSubject.schemaVersion, "ltm.production-release-subject.v1");
  assert.equal(fixture.releaseSubject.workloadImages.length, 5);
  assert.equal(fixture.releaseSubject.supplyChain.trustKeyId.startsWith("ed25519:"), true);
  assert.equal(fixture.manifest.releaseSubject.schemaVersion, "ltm.production-release-subject-config.v1");
});

test("PostgreSQL 17 B127 source proves SELECT-only FORCE-RLS evidence and rejects privileged roles", {
  skip: TEST_POSTGRES_URL === undefined
    ? "LTM_TEST_POSTGRES_URL is not configured"
    : TEST_POSTGRES_ADMIN_URL === undefined
      ? "LTM_TEST_POSTGRES_ADMIN_URL is required when the PostgreSQL integration test is enabled"
      : false,
}, async (testContext) => {
  const fixture = createFileFixture(testContext);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const readerRole = `ltm_b127_reader_${suffix}`;
  const bypassRole = `ltm_b127_bypass_${suffix}`;
  const readerPassword = `R-${randomUUID()}`;
  const bypassPassword = `B-${randomUUID()}`;
  const admin = new Pool({ connectionString: TEST_POSTGRES_ADMIN_URL, max: 1 });
  testContext.after(async () => {
    await dropRole(admin, readerRole);
    await dropRole(admin, bypassRole);
    await admin.end();
  });

  await provisionRole(admin, readerRole, readerPassword, false);
  await provisionRole(admin, bypassRole, bypassPassword, true);
  await admin.query(`ALTER ROLE ${quoteIdentifier(readerRole)} SET search_path TO ltm, public`);
  await seedRelease(admin, fixture);

  const readerUrl = roleUrl(TEST_POSTGRES_URL, readerRole, readerPassword);
  const readerProbe = new Pool({ connectionString: readerUrl, max: 1 });
  try {
    const configuredSearchPath = await readerProbe.query("SHOW search_path");
    assert.equal(configuredSearchPath.rows[0]?.search_path, "ltm, public");
  } finally {
    await readerProbe.end();
  }
  const result = await verifyB127Certification({
    ...fixture.options,
    certificationProfile: "test",
    source: new PostgresB127CertificationSource(readerUrl, {
      certificationProfile: "test",
      allowInsecureTestConnection: true,
    }),
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.dataSource.kind, "postgresql");
  assert.equal(result.dataSource.currentUser, readerRole);
  assert.equal(result.dataSource.privileges, "select-only");
  assert.equal(result.dataSource.transactionReadOnly, true);
  assert.equal(result.dataSource.tenantRls, "forced-and-observed");
  assert.equal(result.prerequisiteB126.evidence.count, 5);
  assert.equal(result.batchReports.batchCount, 128);
  assert.ok(Number(result.dataSource.serverVersion) >= 170000);

  const schemaVersion = await admin.query("SELECT value FROM ltm.schema_metadata WHERE key='runtime_schema_version'");
  await admin.query("UPDATE ltm.schema_metadata SET value='999' WHERE key='runtime_schema_version'");
  try {
    await assert.rejects(
      () => new PostgresB127CertificationSource(readerUrl, {
        certificationProfile: "test",
        allowInsecureTestConnection: true,
      }).load({
        tenantId: fixture.tenantId,
        launchId: fixture.launchId,
        b126CertificationId: fixture.b126Record.certificationId,
      }),
      (error) => error instanceof CertificationError && error.code === "B127_POSTGRES_SCHEMA_UNSUPPORTED",
    );
  } finally {
    await admin.query("UPDATE ltm.schema_metadata SET value=$1 WHERE key='runtime_schema_version'", [schemaVersion.rows[0].value]);
  }

  await admin.query("ALTER POLICY tenant_isolation ON ltm.participants USING (true) WITH CHECK (tenant_id = ltm.current_tenant())");
  try {
    await assert.rejects(
      () => new PostgresB127CertificationSource(readerUrl, {
        certificationProfile: "test",
        allowInsecureTestConnection: true,
      }).load({
        tenantId: fixture.tenantId,
        launchId: fixture.launchId,
        b126CertificationId: fixture.b126Record.certificationId,
      }),
      (error) => error instanceof CertificationError && error.code === "B127_POSTGRES_RLS_POLICY_INVALID",
    );
  } finally {
    await admin.query("ALTER POLICY tenant_isolation ON ltm.participants USING (tenant_id = ltm.current_tenant()) WITH CHECK (tenant_id = ltm.current_tenant())");
  }

  const currentTenantFunction = await admin.query(
    "SELECT pg_get_functiondef('ltm.current_tenant()'::regprocedure) AS definition",
  );
  await admin.query(
    "CREATE OR REPLACE FUNCTION ltm.current_tenant() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'tampered-tenant'::text $$",
  );
  try {
    await assert.rejects(
      () => new PostgresB127CertificationSource(readerUrl, {
        certificationProfile: "test",
        allowInsecureTestConnection: true,
      }).load({
        tenantId: fixture.tenantId,
        launchId: fixture.launchId,
        b126CertificationId: fixture.b126Record.certificationId,
      }),
      (error) => error instanceof CertificationError && error.code === "B127_POSTGRES_FUNCTION_DRIFT",
    );
  } finally {
    await admin.query(currentTenantFunction.rows[0].definition);
  }

  await assert.rejects(
    () => new PostgresB127CertificationSource(TEST_POSTGRES_ADMIN_URL, {
      certificationProfile: "test",
      allowInsecureTestConnection: true,
    }).load({ tenantId: fixture.tenantId, launchId: fixture.launchId }),
    (error) => error instanceof CertificationError && error.code === "B127_POSTGRES_ROLE_PRIVILEGED",
  );
  await assert.rejects(
    () => new PostgresB127CertificationSource(roleUrl(TEST_POSTGRES_URL, bypassRole, bypassPassword), {
      certificationProfile: "test",
      allowInsecureTestConnection: true,
    }).load({ tenantId: fixture.tenantId, launchId: fixture.launchId }),
    (error) => error instanceof CertificationError && error.code === "B127_POSTGRES_ROLE_PRIVILEGED",
  );
  await assert.rejects(
    () => new PostgresB127CertificationSource(TEST_POSTGRES_URL, {
      certificationProfile: "test",
      allowInsecureTestConnection: true,
    }).load({ tenantId: fixture.tenantId, launchId: fixture.launchId }),
    (error) => error instanceof CertificationError && error.code === "B127_POSTGRES_PRIVILEGES_NOT_MINIMAL",
  );
});

function createFileFixture(testContext) {
  const root = mkdtempSync(join(tmpdir(), "ltm-b127-postgres-"));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  const tenantId = `tenant-pg-${randomUUID()}`;
  const launchId = `launch-pg-${randomUUID()}`;
  const now = new Date();
  const approvedAt = new Date(now.getTime() - 3 * 60 * 60_000).toISOString();
  const generatedAt = new Date(now.getTime() - 150 * 60_000).toISOString();
  const issuedAt = new Date(now.getTime() - 45 * 60_000).toISOString();
  const verifiedAt = new Date(now.getTime() - 40 * 60_000).toISOString();
  const consumedAt = new Date(now.getTime() - 30 * 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
  const manifestPath = join(root, "release-manifest.json");
  const trustedKeysPath = join(root, "trusted-keys.json");
  const artifact = (relativePath, value) => writePgArtifact(root, relativePath, value);
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
  const waveStartedAt = new Date(now.getTime() - 2 * 60 * 60_000).toISOString();
  const globalWaveCompletedAt = new Date(now.getTime() - 60 * 60_000).toISOString();
  const goLive = {
    windowStart: new Date(new Date(waveStartedAt).getTime() - 60_000).toISOString(),
    windowEnd: new Date(new Date(waveStartedAt).getTime() + 10 * 60_000).toISOString(),
    scheduledAt: waveStartedAt,
  };
  const deploymentId = `pg-deployment-${suffixId(tenantId)}`;
  const automaticPausePolicyVersion = "pause-policy-pg-v1";
  const rollbackExerciseId = `pg-rollback-forward-${suffixId(tenantId)}`;
  const priorWaveNames = ["internal", "pilot", "consumer_canary", "partner", "regional"];
  const priorWavePercents = [1, 2, 5, 10, 25];
  const releaseControlWaves = priorWaveNames.map((wave, index) => ({
    wave,
    rolloutPercent: priorWavePercents[index],
    startedAt: new Date(new Date(waveStartedAt).getTime() - (priorWaveNames.length - index) * 60 * 60_000).toISOString(),
    completedAt: new Date(new Date(waveStartedAt).getTime() - (priorWaveNames.length - index - 1) * 60 * 60_000).toISOString(),
  })).concat({
    wave: "global",
    rolloutPercent: 100,
    startedAt: waveStartedAt,
    completedAt: globalWaveCompletedAt,
  });
  const releaseControls = createB127ReleaseControlFixtures({
    artifact,
    tenantId,
    launchId,
    deploymentId,
    repositoryCommit: COMMIT,
    componentSetSha256,
    automaticPausePolicyVersion,
    rollbackExerciseId,
    waves: releaseControlWaves,
    idPrefix: `pg${suffixId(tenantId)}`,
  });
  const releaseFixture = createB127ReleaseSubjectFixture({
    root,
    artifact,
    componentVersions,
    componentSetSha256,
    selectedProfile,
    repositoryCommit: COMMIT,
    targetBaseUrl: "https://pg-release.ailifetime.ai/",
    deploymentId,
    goLive,
    guardrailPolicySha256: releaseControls.guardrailPolicyArtifact.reference.sha256,
    waveObservationSetSha256: releaseControls.waveObservationSetSha256,
    rollbackForwardDrillSha256: releaseControls.rollbackForwardDrillArtifact.reference.sha256,
    idPrefix: `pg${suffixId(tenantId)}`,
  });
  const { sbom, releaseSubject, releaseSubjectConfig, supplyChainTrustedKey } = releaseFixture;
  const reportHashes = Object.fromEntries(Array.from({ length: 128 }, (_, index) => {
    const batchId = `B${String(index).padStart(2, "0")}`;
    return [batchId, sha256(Buffer.from(`postgres-production-report:${batchId}:${COMMIT}`))];
  }));
  const reportSetSha256 = sha256(Buffer.from(canonicalJson(reportHashes)));
  const batchReportGeneratedAt = new Date(Date.parse(generatedAt) - 30 * 60_000).toISOString();
  const batchReportDocument = {
    schemaVersion: "ltm.batch-certification-report.v1",
    repositoryCommit: COMMIT,
    profile: { name: selectedProfile.name, version: selectedProfile.version },
    generatedAt: batchReportGeneratedAt,
    status: "passed",
    batchCount: 128,
    requirementCount: 640,
    unresolvedBlockers: [],
    reportHashes,
    reportSetSha256,
  };
  const batchReportArtifact = artifact("release/batch-certification-report.json", batchReportDocument);
  const batchReports = {
    generatedAt: batchReportGeneratedAt,
    status: "passed",
    batchCount: 128,
    requirementCount: 640,
    unresolvedBlockers: [],
    reportHashes,
    reportSetSha256,
    artifact: batchReportArtifact.reference,
  };
  const b126ProviderId = `pg-e2e-auditor-${suffixId(tenantId)}`;
  const b126CertificationId = `pg-e2e-${suffixId(tenantId)}`;
  const b126RecordId = `b126-${suffixId(tenantId)}`;
  const b126Artifact = artifact("release/b126-commercial-e2e.json", {
    certificationId: b126CertificationId,
    state: "certified_for_staged_launch",
    commit: COMMIT,
  });
  const keys = Array.from({ length: 5 }, (_, index) => {
    const pair = generateKeyPairSync("ed25519");
    return {
      issuer: `production-pg-authority-${index + 1}`,
      keyId: `pg-release-key-${index + 1}`,
      privateKey: pair.privateKey,
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
  });
  const b126Keys = Array.from({ length: 5 }, (_, index) => {
    const pair = generateKeyPairSync("ed25519");
    return {
      issuer: `production-pg-e2e-authority-${suffixId(tenantId)}-${index + 1}`,
      keyId: `pg-e2e-key-${suffixId(tenantId)}-${index + 1}`,
      privateKey: pair.privateKey,
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
  });
  const evidenceIds = keys.map((_, index) => `pg-release-evidence-${suffixId(tenantId)}-${index + 1}`);
  const b126EvidenceIds = keys.map((_, index) => `pg-b126-evidence-${suffixId(tenantId)}-${index + 1}`);
  const b126ScopeValue = b126Scope({
    tenantId,
    provider: `e2e-auditor:${b126ProviderId}`,
    artifactSha256: b126Artifact.reference.sha256,
    certificationId: b126CertificationId,
  });
  const executorPair = generateKeyPairSync("ed25519");
  const executorKey = {
    issuer: `production-pg-executor-${suffixId(tenantId)}`,
    keyId: `pg-executor-key-${suffixId(tenantId)}`,
    privateKey: executorPair.privateKey,
    publicKeyPem: executorPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const changeId = `pg-change-${suffixId(tenantId)}`;
  const executor = { actorId: `pg-deployer-${suffixId(tenantId)}`, issuer: executorKey.issuer, keyId: executorKey.keyId };
  const changeClaims = {
    tenantId,
    launchId,
    changeId,
    deploymentId: releaseSubject.deploymentId,
    repositoryCommit: COMMIT,
    componentSetSha256: releaseSubject.componentSetSha256,
    guardrailPolicySha256: releaseSubject.guardrailPolicySha256,
    waveObservationSetSha256: releaseSubject.waveObservationSetSha256,
    rollbackForwardDrillSha256: releaseSubject.rollbackForwardDrillSha256,
    windowStart: releaseSubject.goLive.windowStart,
    windowEnd: releaseSubject.goLive.windowEnd,
    executor,
    decision: "approved",
  };
  const changeApproverKeys = CHANGE_APPROVER_AUTHORITY_ROLES.map((authorityRole, index) => {
    const pair = generateKeyPairSync("ed25519");
    const key = {
      issuer: `production-pg-change-approver-${suffixId(tenantId)}-${index + 1}`,
      keyId: `pg-change-approver-key-${suffixId(tenantId)}-${index + 1}`,
      privateKey: pair.privateKey,
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      authorityRole,
    };
    const unsigned = {
      schemaVersion: "ltm.production-change-approver-evidence.v1",
      evidenceId: `pg-change-approver-evidence-${suffixId(tenantId)}-${index + 1}`,
      approverId: `pg-change-approver-${suffixId(tenantId)}-${index + 1}`,
      issuer: key.issuer,
      keyId: key.keyId,
      authorityRole,
      algorithm: "Ed25519",
      approvedAt,
      claims: changeClaims,
    };
    const document = { ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned)), key.privateKey).toString("base64url") };
    const evidenceArtifact = artifact(`approvals/production-change-approver-${index + 1}.json`, document);
    return { ...key, evidenceArtifact };
  });
  const changeApprovalControls = { executor, approverEvidence: changeApproverKeys.map((key) => key.evidenceArtifact.reference) };
  const approvalNames = Object.keys(APPROVAL_DECISIONS);
  const approvals = Object.fromEntries(approvalNames.map((name, index) => {
    const approvalId = `pg-approval-${suffixId(tenantId)}-${index + 1}`;
    const authority = `PostgreSQL Production Authority ${(index % keys.length) + 1}`;
    const issuer = keys[index % keys.length].issuer;
    const approvalArtifact = artifact(`approvals/${name}.json`, pgReleaseApprovalArtifact(name, {
      approvalId,
      authority,
      issuer,
      tenantId,
      launchId,
      sbomSha256: sbom.reference.sha256,
      approvedAt,
      expiresAt,
      componentSetSha256,
      releaseSubject,
      changeApprovalControls,
    }));
    return [name, {
      approvalId,
      authority,
      issuer,
      evidenceId: evidenceIds[index % keys.length],
      artifact: approvalArtifact.reference,
      decision: APPROVAL_DECISIONS[name],
      approvedAt,
      expiresAt,
    }];
  }));
  const completedWaves = releaseControls.completedWaves;
  const operationsHandoffSummary = {
    handoffId: `pg-operations-${suffixId(tenantId)}`,
    status: "accepted",
    acceptedAt: approvedAt,
    acceptedBy: `pg-operations-lead-${suffixId(tenantId)}`,
    runbookVersion: "runbook-v1",
    onCallScheduleVersion: "oncall-v1",
    supportPlanVersion: "support-v1",
  };
  const operationsHandoff = artifact("release/operations-handoff.json", {
    schemaVersion: "ltm.operations-handoff.v1",
    releaseId: launchId,
    tenantId,
    launchId,
    deploymentId: releaseSubject.deploymentId,
    repositoryCommit: COMMIT,
    componentSetSha256,
    ...operationsHandoffSummary,
  });
  const manifest = {
    schemaVersion: "ltm.production-release-manifest.v1",
    generatedAt,
    tenantId,
    launchId,
    environment: "production",
    deploymentScope: "production",
    releaseControlProviderId: RELEASE_PROVIDER_ID,
    repositoryCommit: COMMIT,
    artifactCommit: COMMIT,
    selectedProfile,
    componentVersions,
    componentSetSha256,
    batchReports,
    b126Certification: {
      certificationId: b126CertificationId,
      recordId: b126RecordId,
      auditorProviderId: b126ProviderId,
      evidenceIds: b126EvidenceIds,
      artifact: b126Artifact.reference,
    },
    sbom: { ...sbom.reference, format: "cyclonedx-json" },
    releaseSubject: releaseSubjectConfig,
    rollout: {
      wave: "global",
      rolloutPercent: 100,
      waveStartedAt,
      rollbackExerciseId,
      automaticPausePolicyVersion,
      guardrailPolicyArtifact: releaseControls.guardrailPolicyArtifact.reference,
      completedWaves,
      rollbackForwardDrillArtifact: releaseControls.rollbackForwardDrillArtifact.reference,
    },
    approvals,
    goLive: {
      ...goLive,
      changeApprovalId: approvals.productionChangeApproval.approvalId,
    },
    operationsHandoff: {
      ...operationsHandoffSummary,
      artifact: operationsHandoff.reference,
    },
    exceptions: [],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
  const manifestSha256 = sha256(manifestBytes);
  const scope = b127Scope({ tenantId, launchId, manifestSha256 });
  writeFileSync(trustedKeysPath, `${JSON.stringify({
    schemaVersion: "ltm.trusted-evidence-keys.v1",
    keys: [...keys.map((key) =>
      pgTrustedKey(key, `release-control:${RELEASE_PROVIDER_ID}`, scope, now, [
        B127_PRODUCTION_RELEASE_AUTHORITY_ROLE,
        ...approvalNames
          .filter((_, approvalIndex) => approvalIndex % keys.length === keys.indexOf(key))
          .map((approvalName) => APPROVAL_AUTHORITY_ROLES[approvalName]),
      ]),
    ),
    ...b126Keys.map((key) => pgTrustedKey(key, `e2e-auditor:${b126ProviderId}`, b126ScopeValue, now)),
    ...changeApproverKeys.map((key) => pgTrustedKey(
      key,
      `change-approval:${changeId}`,
      `ltm-change-approval:v1:${sha256(Buffer.from(canonicalJson(changeClaims)))}`,
      now,
      [key.authorityRole],
    )),
    pgTrustedKey(executorKey, "change-executor:production", "ltm-change-executor:production", now, ["production-change-executor"]),
    pgTrustedKey(supplyChainTrustedKey, supplyChainTrustedKey.provider, supplyChainTrustedKey.scope, now, supplyChainTrustedKey.authorityRoles),
    ...releaseControls.controlArtifactTrustedKeys],
  }, null, 2)}\n`, { mode: 0o600 });
  const evidence = keys.map((key, index) => {
    const envelope = {
      version: "ltm.external-evidence.v1",
      evidenceId: evidenceIds[index],
      tenantId,
      issuer: key.issuer,
      provider: `release-control:${RELEASE_PROVIDER_ID}`,
      environment: "production",
      scope,
      artifactSha256: manifestSha256,
      issuedAt,
      expiresAt,
      nonce: `production-pg-${suffixId(tenantId)}-${index + 1}`,
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: key.keyId,
    };
    return {
      ...envelope,
      signature: sign(null, Buffer.from(canonicalJson(envelope)), key.privateKey).toString("base64url"),
      verifiedAt,
      consumedAt,
    };
  });
  const b126IssuedAt = new Date(now.getTime() - 8 * 60 * 60_000).toISOString();
  const b126VerifiedAt = new Date(now.getTime() - 8 * 60 * 60_000 + 60_000).toISOString();
  const b126ConsumedAt = new Date(now.getTime() - 7 * 60 * 60_000).toISOString();
  const b126CreatedAt = new Date(now.getTime() - 6 * 60 * 60_000).toISOString();
  const b126Evidence = b126Keys.map((key, index) => {
    const envelope = {
      version: "ltm.external-evidence.v1",
      evidenceId: b126EvidenceIds[index],
      tenantId,
      issuer: key.issuer,
      provider: `e2e-auditor:${b126ProviderId}`,
      environment: "production",
      scope: b126ScopeValue,
      artifactSha256: b126Artifact.reference.sha256,
      issuedAt: b126IssuedAt,
      expiresAt,
      nonce: `production-pg-b126-${suffixId(tenantId)}-${index + 1}`,
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: key.keyId,
    };
    return {
      ...envelope,
      signature: sign(null, Buffer.from(canonicalJson(envelope)), key.privateKey).toString("base64url"),
      verifiedAt: b126VerifiedAt,
      consumedAt: b126ConsumedAt,
    };
  });
  const b126Record = {
    batchId: "B126",
    operation: "certifyCommercialE2e",
    operationMode: "attestation",
    executionState: "evidence_persisted",
    certificationId: b126CertificationId,
    auditorProviderId: b126ProviderId,
    scenarioArtifactSha256: b126Artifact.reference.sha256,
    environment: "production_canary",
    entrypoints: ["web", "api", "mobile", "wechat_mini_program"],
    scenarios: ["consent", "generation", "payment", "refund", "physical_fulfillment", "support", "finance_close", "deletion"],
    financialControlTotalMinor: 10_000,
    ledgerControlTotalMinor: 10_000,
    deletionProofTargets: ["connector", "cdn", "vendor", "warehouse", "application"],
    criticalFailures: 0,
    entitlementReconciliationId: `pg-reconciliation-${suffixId(tenantId)}`,
    externalEvidenceIds: b126EvidenceIds,
    evidenceScope: b126ScopeValue,
    state: "certified_for_staged_launch",
  };
  const record = {
    batchId: "B127",
    operation: "approveStagedProductionLaunch",
    operationMode: "attestation",
    executionState: "evidence_persisted",
    state: "wave_approved",
    tenantId,
    launchId,
    releaseControlProviderId: RELEASE_PROVIDER_ID,
    providerEnvironment: "production",
    releaseManifestDigest: manifestSha256,
    repositoryCommit: COMMIT,
    artifactCommit: COMMIT,
    sbomDigest: sbom.reference.sha256,
    wave: "global",
    rolloutPercent: 100,
    waveStartedAt,
    releaseGates: Array.from({ length: 12 }, (_, index) => `G${index}`),
    monitoringDomains: ["quality", "payment", "refund", "message", "support", "ledger", "supply", "privacy", "security", "cost", "slo"],
    approvalIds: Object.values(approvals).map((approval) => approval.approvalId),
    rollbackExerciseId,
    automaticPausePolicyVersion,
    guardrailPolicySha256: releaseControls.guardrailPolicyArtifact.reference.sha256,
    waveObservationSetSha256: releaseControls.waveObservationSetSha256,
    globalWaveObservationPath: releaseControls.globalWaveObservation.observationArtifact.path,
    globalWaveObservationSha256: releaseControls.globalWaveObservation.observationArtifact.sha256,
    rollbackForwardDrillSha256: releaseControls.rollbackForwardDrillArtifact.reference.sha256,
    changeApproverEvidenceIds: changeApproverKeys.map((_, index) => `pg-change-approver-evidence-${suffixId(tenantId)}-${index + 1}`),
    activeGuardrailBreaches: 0,
    externalEvidenceIds: evidenceIds,
    evidenceScope: scope,
  };
  const priorWaveRecord = {
    ...record,
    wave: "regional",
    rolloutPercent: 25,
  };
  delete priorWaveRecord.globalWaveObservationPath;
  delete priorWaveRecord.globalWaveObservationSha256;
  return {
    root,
    manifest,
    releaseSubject,
    tenantId,
    launchId,
    b126RecordId,
    b126Record,
    b126CreatedAt,
    record,
    priorWaveRecord,
    evidence,
    b126Evidence,
    options: {
      root,
      tenantId,
      launchId,
      expectedCommit: COMMIT,
      manifestPath,
      trustedKeysPath,
      now,
    },
  };
}

async function seedRelease(admin, fixture) {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO ltm.records(
         tenant_id,collection,id,processing_purpose,owner_actor_id,participant_ids,contains_minor,data,version,created_at,updated_at,deleted_at
       ) VALUES ($1,'capability.launching-complete-commercial-product',$2,'release_certification',NULL,'{}',false,$3::jsonb,1,$4,$4,NULL)`,
      [
        fixture.tenantId,
        `b127-prior-${suffixId(fixture.tenantId)}`,
        JSON.stringify(fixture.priorWaveRecord),
        new Date(Date.parse(fixture.record.waveStartedAt) - 60 * 60_000).toISOString(),
      ],
    );
    await client.query(
      `INSERT INTO ltm.records(
         tenant_id,collection,id,processing_purpose,owner_actor_id,participant_ids,contains_minor,data,version,created_at,updated_at,deleted_at
       ) VALUES ($1,'capability.launching-complete-commercial-product',$2,'release_certification',NULL,'{}',false,$3::jsonb,1,$4,$4,NULL)`,
      [fixture.tenantId, fixture.b126RecordId, JSON.stringify(fixture.b126Record), fixture.b126CreatedAt],
    );
    await client.query(
      `INSERT INTO ltm.records(
         tenant_id,collection,id,processing_purpose,owner_actor_id,participant_ids,contains_minor,data,version,created_at,updated_at,deleted_at
       ) VALUES ($1,'capability.launching-complete-commercial-product',$2,'release_certification',NULL,'{}',false,$3::jsonb,1,clock_timestamp(),clock_timestamp(),NULL)`,
      [fixture.tenantId, `b127-${suffixId(fixture.tenantId)}`, JSON.stringify(fixture.record)],
    );
    for (const item of [...fixture.b126Evidence, ...fixture.evidence]) {
      await client.query(
        `INSERT INTO ltm.external_evidence(
           tenant_id,id,envelope_version,issuer,provider,environment,scope,artifact_sha256,
           issued_at,expires_at,nonce,replay_policy,algorithm,key_id,signature,status,version,
           verified_at,revoked_at,revocation_reason
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'verified',1,$16,NULL,NULL)`,
        [
          item.tenantId, item.evidenceId, item.version, item.issuer, item.provider,
          item.environment, item.scope, item.artifactSha256, item.issuedAt, item.expiresAt,
          item.nonce, item.replayPolicy, item.algorithm, item.keyId, item.signature, item.verifiedAt,
        ],
      );
      await client.query(
        `INSERT INTO ltm.evidence_consumptions(tenant_id,evidence_id,scope,consumption_key_hash,consumed_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [item.tenantId, item.evidenceId, item.scope, sha256(Buffer.from(`consume-${item.evidenceId}`)), item.consumedAt],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function writePgArtifact(root, relativePath, value) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, reference: { path: relativePath, sha256: sha256(bytes) } };
}

function pgReleaseApprovalArtifact(name, input) {
  return {
    schemaVersion: "ltm.release-approval-artifact.v1",
    approvalType: name,
    approvalId: input.approvalId,
    authorityRole: APPROVAL_AUTHORITY_ROLES[name],
    authority: input.authority,
    issuer: input.issuer,
    tenantId: input.tenantId,
    launchId: input.launchId,
    environment: "production",
    repositoryCommit: COMMIT,
    sbomSha256: input.sbomSha256,
    decision: APPROVAL_DECISIONS[name],
    approvedAt: input.approvedAt,
    expiresAt: input.expiresAt,
    subject: pgApprovalSubject(name, input),
  };
}

function pgApprovalSubject(name, input) {
  const release = input.releaseSubject;
  if (name === "independentPenetrationTest") return { engagementId: `pg-pentest-${suffixId(input.tenantId)}`, providerId: "pg-independent-security-labs", targetOrigin: release.penetrationTest.targetOrigin, reportArtifactSha256: release.penetrationTest.reportArtifactSha256, findingRegistrySha256: release.penetrationTest.findingRegistrySha256, scopeCategories: ["authentication", "tenant_isolation", "idor", "upload", "signed_url", "webhook", "payment", "ssrf", "xss", "csrf", "admin_operations"], independentThirdParty: true, conflictsDisclosed: true, unresolvedCritical: 0, unresolvedHigh: 0, retestPassed: true };
  if (name === "legalRegulatoryReview") return { reviewId: `pg-legal-${suffixId(input.tenantId)}`, legalEntityId: release.legal.legalEntityId, jurisdictions: release.legal.jurisdictions, productVersion: release.profileVersion, scopes: ["privacy", "ai", "minors", "commerce", "payments", "tax", "consumer_terms"], unresolvedRestrictions: [], signingAuthorityVerified: true };
  if (name === "manualAccessibilityReview") return { auditId: `pg-a11y-${suffixId(input.tenantId)}`, ...release.accessibility, unresolvedCritical: 0, unresolvedHigh: 0, manualTesting: true, retestPassed: true };
  if (["appleAppStoreDecision", "googlePlayDecision", "wechatMiniProgramDecision"].includes(name)) {
    const application = release.applications[name];
    return { ...application, decisionId: `${application.store}-${suffixId(input.tenantId)}`, reviewEnvironment: "production", reviewedAt: input.approvedAt, nativeReceiptVerificationPassed: true };
  }
  if (name === "disasterRecoveryDrill") return { exerciseId: `pg-dr-${suffixId(input.tenantId)}`, deploymentId: release.deploymentId, reportArtifactSha256: release.disasterRecovery.reportArtifactSha256, backupId: `pg-backup-${suffixId(input.tenantId)}`, sourceRegion: release.disasterRecovery.sourceRegion, failoverRegion: release.disasterRecovery.failoverRegion, restoreTargetId: `pg-restore-${suffixId(input.tenantId)}`, schemaVersion: release.disasterRecovery.schemaVersion, targetRtoSeconds: release.disasterRecovery.targetRtoSeconds, observedRtoSeconds: 600, targetRpoSeconds: release.disasterRecovery.targetRpoSeconds, observedRpoSeconds: 120, failoverVerified: true, failbackVerified: true, forcedRlsVerified: true, auditChainVerified: true, ledgerBalanced: true, deletionNonResurrection: true, duplicateSideEffectsPrevented: true };
  if (name === "productionChangeApproval") return { changeId: `pg-change-${suffixId(input.tenantId)}`, ticketUrl: `https://changes.ailifetime.ai/tickets/${suffixId(input.tenantId)}`, deploymentId: release.deploymentId, componentSetSha256: release.componentSetSha256, guardrailPolicySha256: release.guardrailPolicySha256, waveObservationSetSha256: release.waveObservationSetSha256, rollbackForwardDrillSha256: release.rollbackForwardDrillSha256, executor: input.changeApprovalControls.executor, approverEvidence: input.changeApprovalControls.approverEvidence, windowStart: release.goLive.windowStart, windowEnd: release.goLive.windowEnd };
  throw new Error(`unknown approval ${name}`);
}

function pgTrustedKey(key, provider, scope, now, authorityRoles = []) {
  return {
    issuer: key.issuer,
    provider,
    keyId: key.keyId,
    algorithm: "Ed25519",
    publicKeyPem: key.publicKeyPem,
    allowedScopes: [scope],
    allowedEnvironments: ["production"],
    ...(authorityRoles.length === 0 ? {} : { authorityRoles }),
    notBefore: new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
    notAfter: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
  };
}

async function provisionRole(admin, role, password, bypassRls) {
  await admin.query(
    `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION ${bypassRls ? "BYPASSRLS" : "NOBYPASSRLS"}`,
  );
  await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName(TEST_POSTGRES_ADMIN_URL))} TO ${quoteIdentifier(role)}`);
  await admin.query(`GRANT USAGE ON SCHEMA ltm TO ${quoteIdentifier(role)}`);
  await admin.query(
    `GRANT SELECT ON ltm.schema_metadata,ltm.records,ltm.external_evidence,ltm.evidence_consumptions TO ${quoteIdentifier(role)}`,
  );
}

async function dropRole(admin, role) {
  try {
    await admin.query(`DROP OWNED BY ${quoteIdentifier(role)}`);
    await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
  } catch {
    // The ephemeral CI service is destroyed after the job; cleanup is best-effort.
  }
}

function roleUrl(value, role, password) {
  const url = new URL(value);
  url.username = role;
  url.password = password;
  url.searchParams.set("sslmode", "disable");
  return url.toString();
}

function databaseName(value) {
  return decodeURIComponent(new URL(value).pathname.slice(1));
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function suffixId(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function b127Scope({ tenantId, launchId, manifestSha256 }) {
  const fields = [
    "ltm-capability-evidence-v1",
    tenantId,
    "B127",
    "approveStagedProductionLaunch",
    "release-control-plane",
    `release-control:${RELEASE_PROVIDER_ID}`,
    manifestSha256,
    "production",
    launchId,
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
