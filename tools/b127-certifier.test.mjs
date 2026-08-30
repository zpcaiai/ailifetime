import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  certifyB127,
  PostgresB127CertificationSource,
  verifyB127Certification,
} from "./b127-certifier.mjs";
import {
  deploymentEvidenceScope,
  REQUIRED_DEPLOYMENT_CHECKS,
  certifyProductionDeployment,
  verifyProductionDeploymentEvidence,
} from "./deployment-evidence.mjs";
import { isProductionReleaseApproved, releaseGateOutcome } from "./release-gate-policy.mjs";
import {
  APPROVAL_AUTHORITY_ROLES,
  B127_PRODUCTION_RELEASE_AUTHORITY_ROLE,
  CHANGE_APPROVER_AUTHORITY_ROLES,
  CONTROL_ARTIFACT_AUTHORITY_ROLES,
  REQUIRED_SCHEMA5_FORCE_RLS_TABLES,
  productionReleaseSubjectSha256,
  validateReleaseSbom,
  validateProductionReleaseSubject,
} from "./production-evidence-contracts.mjs";
import {
  createB127ReleaseControlFixtures,
  createB127ReleaseSubjectFixture,
} from "./b127-release-fixture.mjs";

const NOW = new Date("2026-08-20T12:05:00.000Z");
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

test("PostgreSQL certifier pins pg_catalog immediately after BEGIN", async () => {
  const queries = [];
  const client = {
    async query(text) {
      queries.push(text);
      if (text.includes("current_setting('app.tenant_id'")) {
        return { rows: [{ tenant_id: "tenant-search-path", read_only: "on" }] };
      }
      if (text.includes("SELECT current_user,session_user")) {
        return {
          rows: [{
            current_user: "ltm_b127_reader",
            session_user: "ltm_b127_reader",
            server_version_num: "160000",
            database_name: "ltm",
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const source = new PostgresB127CertificationSource(
    "postgresql://ltm_b127_reader@127.0.0.1/ltm?sslmode=disable",
    {
      certificationProfile: "test",
      allowInsecureTestConnection: true,
      poolFactory: () => ({
        connect: async () => client,
        end: async () => undefined,
      }),
    },
  );
  await assert.rejects(
    () => source.load({
      tenantId: "tenant-search-path",
      launchId: "launch-search-path",
      b126CertificationId: "b126-search-path",
    }),
    (error) => error?.code === "B127_POSTGRES_VERSION_UNSUPPORTED",
  );
  assert.deepEqual(queries.slice(0, 3), [
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SET LOCAL search_path = pg_catalog",
    "SET LOCAL row_security = on",
  ]);
});

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
  assert.match(result.policyAuthority.mediaAuthorityArtifact.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.releaseControls.waveObservationSetSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.releaseControls.completedWaveObservations.length, 5);
  assert.equal(result.releaseControls.globalWaveObservation.wave, "global");
  assert.equal(result.releaseControls.globalWaveObservation.rolloutPercent, 100);
  assert.equal(result.releaseControls.globalWaveObservation.completedAt, "2026-08-20T12:00:00.000Z");
  assert.match(result.releaseControls.rollbackForwardDrill.scopeSetSha256, /^[a-f0-9]{64}$/);
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

test("B127 operations handoff artifact must bind the exact accepted release and operating plans", async (testContext) => {
  const fixture = createFixture(testContext, {
    mutateOperationsHandoffArtifact(document) {
      document.onCallScheduleVersion = "unbound-oncall-version";
    },
  });
  const result = await certifyB127({ ...fixture.options, now: NOW });
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "OPERATIONS_HANDOFF_ARTIFACT_CONTENT_MISMATCH");
});

test("B127 verifier keeps canary and regional waves intermediate", async (testContext) => {
  const fixture = createFixture(testContext, { wave: "consumer_canary", rolloutPercent: 5 });
  const result = await certifyB127({ ...fixture.options, now: NOW });

  assert.equal(result.status, "BLOCKED_EXTERNAL");
  assert.equal(result.code, "B127_FINAL_ROLLOUT_INCOMPLETE");
});

test("B127 verifier requires a completed duration-bound global wave observation", async (testContext) => {
  const changedBytes = createFixture(testContext);
  writeFileSync(changedBytes.waveObservationArtifactPaths.global, "tampered global wave report\n", { mode: 0o600 });
  const changedResult = await certifyB127({ ...changedBytes.options, now: NOW });
  assert.equal(changedResult.status, "FAIL");
  assert.equal(changedResult.code, "GLOBAL_WAVE_ARTIFACT_DIGEST_MISMATCH");

  const fixture = createFixture(testContext, {
    mutateWaveObservation(wave, report) {
      if (wave === "global") report.monitoringWindow.endedAt = "2026-08-20T11:59:00.000Z";
    },
  });
  const result = await certifyB127({ ...fixture.options, now: NOW });

  assert.equal(result.status, "BLOCKED_EXTERNAL");
  assert.equal(result.code, "GLOBAL_WAVE_OBSERVATION_INCOMPLETE");
});

test("B127 evidence consumption cannot predate the completed global observation", async (testContext) => {
  const fixture = createFixture(testContext, { earlyGlobalEvidenceConsumption: true });
  const result = await certifyB127({ ...fixture.options, now: NOW });

  assert.equal(result.status, "BLOCKED_EXTERNAL");
  assert.equal(result.code, "B127_EVIDENCE_CONSUMED_BEFORE_GLOBAL_OBSERVATION");
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

test("schema 7 release subject requires the exact runtime FORCE-RLS table set", () => {
  const subject = deploymentReleaseSubject({
    deploymentId: "deployment-production-2026",
    targetBaseUrl: "https://release.ailifetime.ai/",
  });
  assert.throws(
    () => validateProductionReleaseSubject({
      ...subject,
      forcedRlsTables: subject.forcedRlsTables.filter((table) => table !== "participants"),
    }),
    /exactly equal the schema 7 runtime tenant-table set/,
  );
  assert.throws(
    () => validateProductionReleaseSubject({
      ...subject,
      forcedRlsTables: [...subject.forcedRlsTables, "uncontrolled_extra_table"],
    }),
    /exactly equal the schema 7 runtime tenant-table set/,
  );
  const withoutConsentCatalog = { ...subject };
  delete withoutConsentCatalog.consentPolicyCatalogSha256;
  assert.throws(
    () => validateProductionReleaseSubject(withoutConsentCatalog),
    /fields do not match the closed contract/,
  );
  assert.notEqual(
    productionReleaseSubjectSha256(subject),
    productionReleaseSubjectSha256({
      ...subject,
      consentPolicyCatalogSha256: sha256(Buffer.from("different-consent-policy")),
    }),
  );
  assert.notEqual(
    productionReleaseSubjectSha256(subject),
    productionReleaseSubjectSha256({
      ...subject,
      waveObservationSetSha256: sha256(Buffer.from("different-wave-observation-set")),
    }),
  );
  const withoutRollbackDrill = { ...subject };
  delete withoutRollbackDrill.rollbackForwardDrillSha256;
  assert.throws(
    () => validateProductionReleaseSubject(withoutRollbackDrill),
    /fields do not match the closed contract/,
  );
});

test("B127 rejects a schema 7 manifest missing any controlled migration ID or path", async (testContext) => {
  const fixture = createFixture(testContext);
  const path = join(fixture.options.root, "infra/postgres/migrations/manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.migrations = manifest.migrations.filter((migration) => migration.id !== "004");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const result = await certifyB127({ ...fixture.options, now: NOW });
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "MIGRATION_MANIFEST_INVALID");
});

test("B127 rejects changed or release-mismatched media authority projection bytes", async (testContext) => {
  const changed = createFixture(testContext);
  writeFileSync(changed.mediaAuthorityArtifactPath, "tampered\n", { mode: 0o600 });
  const changedResult = await certifyB127({ ...changed.options, now: NOW });
  assert.equal(changedResult.status, "FAIL");
  assert.equal(changedResult.code, "MEDIA_AUTHORITY_ARTIFACT_DIGEST_MISMATCH");

  const mismatched = createFixture(testContext, { mediaAuthorityBindingMismatch: true });
  const mismatchResult = await certifyB127({ ...mismatched.options, now: NOW });
  assert.equal(mismatchResult.status, "FAIL");
  assert.equal(mismatchResult.code, "MEDIA_AUTHORITY_BINDING_MISMATCH");
});

test("B127 wave observations fail closed on tampering, field drift, cross-release scope, missing domains, and threshold breaches", async (testContext) => {
  const changedBytes = createFixture(testContext);
  writeFileSync(changedBytes.waveObservationArtifactPaths.internal, "tampered wave report\n", { mode: 0o600 });
  const changedResult = await certifyB127({ ...changedBytes.options, now: NOW });
  assert.equal(changedResult.status, "FAIL");
  assert.equal(changedResult.code, "PRIOR_WAVE_ARTIFACT_DIGEST_MISMATCH");

  const cases = [
    {
      name: "field drift",
      mutateWaveObservation(waveName, report) {
        if (waveName === "internal") report.clientAssertedPassed = true;
      },
      status: "FAIL",
      code: "WAVE_OBSERVATION_FIELDS_INVALID",
    },
    {
      name: "cross release",
      mutateWaveObservation(waveName, report) {
        if (waveName === "internal") report.launchId = "different-launch";
      },
      status: "FAIL",
      code: "WAVE_OBSERVATION_BINDING_MISMATCH",
    },
    {
      name: "missing domain",
      mutateWaveObservation(waveName, report) {
        if (waveName === "internal") report.measurements = report.measurements.filter((entry) => entry.domain !== "message");
      },
      status: "FAIL",
      code: "B127_CONTROL_ARRAY_INVALID",
    },
    {
      name: "threshold breach",
      mutateWaveObservation(waveName, report) {
        if (waveName === "internal") report.measurements[0].observedValue = report.measurements[0].threshold + 1;
      },
      status: "BLOCKED_EXTERNAL",
      code: "WAVE_OBSERVATION_THRESHOLD_BREACHED",
    },
    {
      name: "pause acknowledgement missing",
      mutateWaveObservation(waveName, report) {
        if (waveName === "internal") report.automaticPausePolicy.drill.conclusion = "not_paused";
      },
      status: "BLOCKED_EXTERNAL",
      code: "WAVE_AUTOMATIC_PAUSE_DRILL_INVALID",
    },
    {
      name: "measurement digest drift",
      mutateWaveObservation(waveName, report) {
        if (waveName === "internal") report.measurementSetSha256 = "0".repeat(64);
      },
      status: "FAIL",
      code: "WAVE_OBSERVATION_SET_DIGEST_MISMATCH",
    },
  ];
  for (const scenario of cases) {
    const fixture = createFixture(testContext, scenario);
    const result = await certifyB127({ ...fixture.options, now: NOW });
    assert.equal(result.status, scenario.status, scenario.name);
    assert.equal(result.code, scenario.code, scenario.name);
  }
});

test("B127 guardrail policy and raw wave evidence fail closed on numeric overflow and byte tampering", async (testContext) => {
  const oversizedRatio = createFixture(testContext, {
    mutateGuardrailPolicy(policy) { policy.controls[0].threshold = 1.01; },
  });
  const oversizedResult = await certifyB127({ ...oversizedRatio.options, now: NOW });
  assert.equal(oversizedResult.status, "FAIL");
  assert.equal(oversizedResult.code, "B127_CONTROL_NUMBER_INVALID");

  const changedRaw = createFixture(testContext);
  writeFileSync(changedRaw.rawObservationArtifactPaths["internal:quality:result"], "tampered raw result\n", { mode: 0o600 });
  const changedRawResult = await certifyB127({ ...changedRaw.options, now: NOW });
  assert.equal(changedRawResult.status, "FAIL");
  assert.equal(changedRawResult.code, "WAVE_RAW_EVIDENCE_DIGEST_MISMATCH");

  const reusedIdentity = createFixture(testContext, { reuseEvidenceIdentityAcrossWaves: true });
  const reusedIdentityResult = await certifyB127({ ...reusedIdentity.options, now: NOW });
  assert.equal(reusedIdentityResult.status, "FAIL");
  assert.equal(reusedIdentityResult.code, "WAVE_OBSERVATION_EVIDENCE_REUSED");
});

test("raw control producer attestations reject unknown, expired, wrong-role, imprecise, tampered, replayed, and shared keys", async (testContext) => {
  const changedAttestation = createFixture(testContext);
  writeFileSync(
    changedAttestation.controlAttestationArtifactPaths["internal:quality:monitoring_result"],
    "tampered detached producer attestation\n",
    { mode: 0o600 },
  );
  const changedAttestationResult = await certifyB127({ ...changedAttestation.options, now: NOW });
  assert.equal(changedAttestationResult.status, "FAIL");
  assert.equal(changedAttestationResult.code, "CONTROL_ARTIFACT_ATTESTATION_DIGEST_MISMATCH");

  const scenarios = [
    {
      name: "unknown producer key",
      options: {
        mutateControlAttestation(type, wave, domain, document) {
          if (type === "monitoring_query" && wave === "internal" && domain === "quality") document.keyId = "unknown-production-query-key";
        },
      },
      status: "BLOCKED_EXTERNAL",
      code: "CONTROL_ARTIFACT_ATTESTATION_TRUST_MISSING",
    },
    {
      name: "expired producer key",
      options: {
        mutateControlTrustedKeys(keys) {
          keys.find((key) => key.authorityRoles?.includes(CONTROL_ARTIFACT_AUTHORITY_ROLES.monitoring_query)).notAfter = "2026-08-20T11:59:59.000Z";
        },
      },
      status: "BLOCKED_EXTERNAL",
      code: "TRUST_KEY_EXPIRED",
    },
    {
      name: "wrong authority role",
      options: {
        mutateControlAttestation(type, wave, domain, document) {
          if (type === "monitoring_query" && wave === "internal" && domain === "quality") {
            document.authorityRole = CONTROL_ARTIFACT_AUTHORITY_ROLES.monitoring_result;
          }
        },
      },
      status: "FAIL",
      code: "CONTROL_ARTIFACT_ATTESTATION_AUTHORITY_INVALID",
    },
    {
      name: "wildcard producer scope",
      options: {
        mutateControlTrustedKeys(keys) {
          keys.find((key) => key.authorityRoles?.includes(CONTROL_ARTIFACT_AUTHORITY_ROLES.monitoring_query)).allowedScopes = ["ltm-control-artifact:v1:*"];
        },
      },
      status: "BLOCKED_EXTERNAL",
      code: "CONTROL_ARTIFACT_ATTESTATION_TRUST_MISSING",
    },
    {
      name: "multi-environment producer authority",
      options: {
        mutateControlTrustedKeys(keys) {
          keys.find((key) => key.authorityRoles?.includes(CONTROL_ARTIFACT_AUTHORITY_ROLES.monitoring_query)).allowedEnvironments = ["production", "staging"];
        },
      },
      status: "BLOCKED_EXTERNAL",
      code: "CONTROL_ARTIFACT_ATTESTATION_TRUST_MISSING",
    },
    {
      name: "post-signature attestation tampering",
      options: {
        mutateControlAttestation(type, wave, domain, document) {
          if (type === "monitoring_result" && wave === "internal" && domain === "quality") document.nonce = `${document.nonce}-tampered`;
        },
      },
      status: "FAIL",
      code: "CONTROL_ARTIFACT_ATTESTATION_SIGNATURE_INVALID",
    },
    {
      name: "validly signed cross-wave replay",
      options: {
        mutateControlAttestationBeforeSign(type, wave, domain, unsigned) {
          if (type === "monitoring_query" && wave === "pilot" && domain === "quality") unsigned.claims.wave = "internal";
        },
      },
      status: "FAIL",
      code: "CONTROL_ARTIFACT_ATTESTATION_BINDING_MISMATCH",
    },
    {
      name: "query and result share producer key",
      options: { reuseControlSignerIdentity: "query_result" },
      status: "FAIL",
      code: "TRUST_KEY_PUBLIC_KEY_REUSED",
    },
    {
      name: "pause command and receipt share producer key",
      options: { reuseControlSignerIdentity: "command_receipt" },
      status: "FAIL",
      code: "TRUST_KEY_PUBLIC_KEY_REUSED",
    },
    {
      name: "attestation identity replay",
      options: {
        mutateControlAttestationBeforeSign(type, wave, domain, unsigned) {
          if (type === "monitoring_query" && wave === "pilot" && domain === "quality") {
            unsigned.attestationId = "ltm-internal-quality-monitoring-query-attestation";
          }
        },
      },
      status: "FAIL",
      code: "CONTROL_ARTIFACT_ATTESTATION_REUSED",
    },
  ];
  for (const scenario of scenarios) {
    const fixture = createFixture(testContext, scenario.options);
    const result = await certifyB127({ ...fixture.options, now: NOW });
    assert.equal(result.status, scenario.status, scenario.name);
    assert.equal(result.code, scenario.code, scenario.name);
  }
});

test("production change rejects tampered, fake, reused, and executor-self approver identities", async (testContext) => {
  const cases = [
    ["tampered", (index, document) => { if (index === 0) document.claims.deploymentId = "different-deployment"; }],
    ["fake approver ID", (index, document) => { if (index === 0) document.approverId = "invented-unsigned-approver"; }],
    ["reused key ID", (index, document) => { if (index === 1) document.keyId = "production-change-approver-key-1"; }],
    ["reused issuer", (index, document) => { if (index === 1) document.issuer = "production-change-approver-1"; }],
    ["executor self approval", (index, document, _key, claims) => { if (index === 0) { document.approverId = claims.executor.actorId; document.issuer = claims.executor.issuer; document.keyId = claims.executor.keyId; } }],
  ];
  for (const [name, mutateChangeApprover] of cases) {
    const fixture = createFixture(testContext, { mutateChangeApprover });
    const result = await certifyB127({ ...fixture.options, now: NOW });
    assert.notEqual(result.status, "PASS", name);
    assert.match(result.code, /^CHANGE_APPROVER_/, name);
  }
});

test("production change trust rejects Ed25519 key material reused across executor, approver, and primary signer identities", async (testContext) => {
  const selectors = {
    executor: (key) => key.authorityRoles?.includes("production-change-executor"),
    riskApprover: (key) => key.authorityRoles?.includes("production-change-risk-approver"),
    primarySigner: (key) => key.provider === `release-control:${RELEASE_PROVIDER_ID}` &&
      key.authorityRoles?.includes(APPROVAL_AUTHORITY_ROLES.productionChangeApproval),
  };
  const cases = [
    ["executor and risk approver", "riskApprover", "executor"],
    ["executor and primary signer", "executor", "primarySigner"],
    ["risk approver and primary signer", "riskApprover", "primarySigner"],
  ];
  for (const [name, targetName, sourceName] of cases) {
    const fixture = createFixture(testContext);
    const trust = JSON.parse(readFileSync(fixture.options.trustedKeysPath, "utf8"));
    const target = trust.keys.find(selectors[targetName]);
    const source = trust.keys.find(selectors[sourceName]);
    assert.ok(target, `${name} target`);
    assert.ok(source, `${name} source`);
    assert.notEqual(`${target.issuer}\n${target.keyId}`, `${source.issuer}\n${source.keyId}`, name);
    target.publicKeyPem = source.publicKeyPem;
    writeFileSync(fixture.options.trustedKeysPath, `${JSON.stringify(trust, null, 2)}\n`, { mode: 0o600 });

    const result = await certifyB127({ ...fixture.options, now: NOW });
    assert.equal(result.status, "FAIL", name);
    assert.equal(result.code, "TRUST_KEY_PUBLIC_KEY_REUSED", name);
  }

  const crossProvider = createFixture(testContext);
  const trust = JSON.parse(readFileSync(crossProvider.options.trustedKeysPath, "utf8"));
  const source = trust.keys.find(selectors.executor);
  assert.ok(source, "cross-provider source");
  trust.keys.push({ ...source, provider: `${source.provider}-alternate` });
  writeFileSync(crossProvider.options.trustedKeysPath, `${JSON.stringify(trust, null, 2)}\n`, { mode: 0o600 });

  const result = await certifyB127({ ...crossProvider.options, now: NOW });
  assert.equal(result.status, "FAIL", "same issuer/keyId across different providers");
  assert.equal(result.code, "TRUST_KEY_PUBLIC_KEY_REUSED", "same issuer/keyId across different providers");
});

test("B127 rollback-forward drills fail closed on tampering, field drift, cross-release scope, incomplete surfaces, and unverifiable conclusions", async (testContext) => {
  const changedBytes = createFixture(testContext);
  writeFileSync(changedBytes.rollbackForwardDrillArtifactPath, "tampered rollback report\n", { mode: 0o600 });
  const changedResult = await certifyB127({ ...changedBytes.options, now: NOW });
  assert.equal(changedResult.status, "FAIL");
  assert.equal(changedResult.code, "ROLLBACK_DRILL_ARTIFACT_DIGEST_MISMATCH");

  const changedRawEvidence = createFixture(testContext);
  writeFileSync(
    Object.values(changedRawEvidence.rawRollbackArtifactPaths)[0],
    "tampered rollback operation evidence\n",
    { mode: 0o600 },
  );
  const changedRawResult = await certifyB127({ ...changedRawEvidence.options, now: NOW });
  assert.equal(changedRawResult.status, "FAIL");
  assert.equal(changedRawResult.code, "ROLLBACK_DRILL_EVIDENCE_DIGEST_MISMATCH");

  const cases = [
    {
      name: "field drift",
      mutateRollbackDrill(report) { report.rollbackVerified = true; },
      status: "FAIL",
      code: "ROLLBACK_DRILL_FIELDS_INVALID",
    },
    {
      name: "cross release",
      mutateRollbackDrill(report) { report.deploymentId = "different-deployment"; },
      status: "FAIL",
      code: "ROLLBACK_DRILL_BINDING_MISMATCH",
    },
    {
      name: "missing surface",
      mutateRollbackDrill(report) {
        report.scopes = report.scopes.filter((entry) => entry.scope !== "vendor_routing");
      },
      status: "FAIL",
      code: "B127_CONTROL_ARRAY_INVALID",
    },
    {
      name: "verification mismatch",
      mutateRollbackDrill(report) {
        report.scopes.find((entry) => entry.scope === "database").verifications[0].observedSha256 = "0".repeat(64);
      },
      status: "BLOCKED_EXTERNAL",
      code: "ROLLBACK_DRILL_VERIFICATION_FAILED",
    },
    {
      name: "scope digest drift",
      mutateRollbackDrill(report) { report.scopeSetSha256 = "0".repeat(64); },
      status: "FAIL",
      code: "ROLLBACK_DRILL_SET_DIGEST_MISMATCH",
    },
  ];
  for (const scenario of cases) {
    const fixture = createFixture(testContext, scenario);
    const result = await certifyB127({ ...fixture.options, now: NOW });
    assert.equal(result.status, scenario.status, scenario.name);
    assert.equal(result.code, scenario.code, scenario.name);
  }
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

test("signed deployment evidence rejects a typed report whose native conclusion failed", (testContext) => {
  const fixture = createDeploymentFixture(testContext, { invalidCheck: "production-dependency-audit" });
  const result = certifyProductionDeployment({ ...fixture.options, now: NOW });
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "EVIDENCE_CONTRACT_VALUE_INVALID");
});

test("deployment reports cannot scan a different image set or self-declare provider/RLS expectations", (testContext) => {
  const imageDrift = createDeploymentFixture(testContext, { mutateAssertions(checkId, assertions) {
    if (checkId === "trivy-container-scan") assertions.images[0].digest = `sha256:${"f".repeat(64)}`;
  } });
  assert.equal(certifyProductionDeployment({ ...imageDrift.options, now: NOW }).code, "DEPLOYMENT_REPORT_CONTENT_INVALID");

  const providerDrift = createDeploymentFixture(testContext, { mutateAssertions(checkId, assertions) {
    if (checkId === "external-provider-mode") assertions.providers = [{ providerId: "fake", accountId: "fake-account", commandId: "fake-command", callbackId: "fake-callback", reconciliationId: "fake-reconciliation", requestAccepted: true, callbackVerified: true, reconciled: true }];
  } });
  assert.equal(certifyProductionDeployment({ ...providerDrift.options, now: NOW }).code, "EVIDENCE_CONTRACT_ARRAY_INVALID");

  const persistenceDrift = createDeploymentFixture(testContext, { mutateAssertions(checkId, assertions) {
    if (checkId === "production-persistence") assertions.forcedRlsTables = ["fake_table"];
  } });
  assert.equal(certifyProductionDeployment({ ...persistenceDrift.options, now: NOW }).code, "DEPLOYMENT_REPORT_CONTENT_INVALID");
});

test("runtime policy authority report rejects drift in each release policy digest and probe trust state", (testContext) => {
  for (const field of ["consentPolicyCatalogSha256", "mediaLifecycleCatalogSha256", "mediaSafetyPolicySha256"]) {
    const fixture = createDeploymentFixture(testContext, { mutateAssertions(checkId, assertions) {
      if (checkId !== "runtime-policy-authority") return;
      if (field === "consentPolicyCatalogSha256") assertions.apiConsentMetadata.catalogSha256 = "0".repeat(64);
      else assertions.mediaAuthority[field] = "0".repeat(64);
    } });
    const result = certifyProductionDeployment({ ...fixture.options, now: NOW });
    assert.equal(result.status, "FAIL", field);
    assert.equal(result.code, "DEPLOYMENT_REPORT_CONTENT_INVALID", field);
  }

  const untrusted = createDeploymentFixture(testContext, { mutateAssertions(checkId, assertions) {
    if (checkId === "runtime-policy-authority") assertions.workloadIdentityVerified = false;
  } });
  assert.equal(certifyProductionDeployment({ ...untrusted.options, now: NOW }).code, "DEPLOYMENT_REPORT_CONTENT_INVALID");

  const differentBytes = createDeploymentFixture(testContext, { mutateAssertions(checkId, assertions) {
    if (checkId === "runtime-policy-authority") assertions.mediaAuthority.responseSha256 = "f".repeat(64);
  } });
  assert.equal(certifyProductionDeployment({ ...differentBytes.options, now: NOW }).code, "DEPLOYMENT_REPORT_CONTENT_INVALID");
});

test("B127 rejects approvals signed for a different deployment, control-evidence digest, app build, or accessibility matrix", async (testContext) => {
  for (const [approvalName, mutate] of [
    ["productionChangeApproval", (subject) => { subject.deploymentId = "different-deployment"; }],
    ["productionChangeApproval", (subject) => { subject.rollbackForwardDrillSha256 = "0".repeat(64); }],
    ["appleAppStoreDecision", (subject) => { subject.buildSha256 = "0".repeat(64); }],
    ["manualAccessibilityReview", (subject) => { subject.platforms = ["x"]; }],
  ]) {
    const fixture = createFixture(testContext, { mutateApproval(name, document) { if (name === approvalName) mutate(document.subject); } });
    const result = await certifyB127({ ...fixture.options, now: NOW });
    assert.equal(result.status, "FAIL");
    assert.equal(result.code, "APPROVAL_ARTIFACT_CONTENT_INVALID");
  }
});

test("production deployment rejects reserved and localhost release origins", () => {
  for (const targetBaseUrl of ["https://localhost/", "https://service.example.com/", "https://127.0.0.1/"]) {
    assert.throws(() => deploymentReleaseSubject({ deploymentId: "deployment-production-2026", targetBaseUrl }), /public DNS HTTPS origin/);
  }
});

test("B127 rejects arbitrary approval JSON even when its digest is signed", async (testContext) => {
  const fixture = createFixture(testContext, { invalidApprovalArtifact: "legalRegulatoryReview" });
  const result = await certifyB127({ ...fixture.options, now: NOW });
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "EVIDENCE_CONTRACT_FIELDS_INVALID");
});

test("B127 rejects an empty CycloneDX component set", async (testContext) => {
  const fixture = createFixture(testContext, { emptySbom: true });
  const result = await certifyB127({ ...fixture.options, now: NOW });
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "SBOM_SUPPLY_CHAIN_MISMATCH");
});

test("the repository supply-chain generator emits CycloneDX and SPDX accepted by the release contract", (testContext) => {
  const fixture = createFixture(testContext);
  assert.equal(validateReleaseSbom(Buffer.from(JSON.stringify(fixture.supplyChainBundle.cycloneDx)), "cyclonedx-json").components > 0, true);
  assert.equal(validateReleaseSbom(Buffer.from(JSON.stringify(fixture.supplyChainBundle.spdx)), "spdx-json").components > 0, true);
});

test("B127 blocks an approval signer not enrolled for its authority role", async (testContext) => {
  const fixture = createFixture(testContext, { omitAuthorityRoles: true });
  const result = await certifyB127({ ...fixture.options, now: NOW });
  assert.equal(result.status, "BLOCKED_EXTERNAL");
  assert.equal(result.code, "APPROVAL_AUTHORITY_ROLE_NOT_TRUSTED");
});

test("B127 production evidence rejects ordinary gateway keys and non-exact release-authority policy", async (testContext) => {
  const scenarios = [
    {
      name: "ordinary key without the reserved B127 role",
      mutate(keys) {
        const key = keys.find((candidate) => candidate.provider === `release-control:${RELEASE_PROVIDER_ID}`);
        assert.ok(key);
        delete key.authorityRoles;
      },
      status: "BLOCKED_EXTERNAL",
      code: "B127_RELEASE_AUTHORITY_NOT_TRUSTED",
    },
    {
      name: "integration gateway identity claiming the reserved role",
      mutate(keys) {
        const key = keys.find((candidate) => candidate.provider === `release-control:${RELEASE_PROVIDER_ID}`);
        assert.ok(key);
        key.issuer = "prod:integration-gateway";
      },
      status: "FAIL",
      code: "B127_RELEASE_AUTHORITY_IDENTITY_INVALID",
    },
    {
      name: "wildcard B127 scope",
      mutate(keys) {
        const key = keys.find((candidate) => candidate.provider === `release-control:${RELEASE_PROVIDER_ID}`);
        assert.ok(key);
        key.allowedScopes = ["ltm-evidence:v1:*"];
      },
      status: "FAIL",
      code: "B127_RELEASE_AUTHORITY_POLICY_INVALID",
    },
  ];
  for (const scenario of scenarios) {
    const fixture = createFixture(testContext, { mutateControlTrustedKeys: scenario.mutate });
    const result = await certifyB127({ ...fixture.options, now: NOW });
    assert.equal(result.status, scenario.status, scenario.name);
    assert.equal(result.code, scenario.code, scenario.name);
  }
});

function createFixture(testContext, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ltm-b127-certifier-"));
  testContext.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "release-manifest.json");
  const trustedKeysPath = join(directory, "trusted-keys.json");
  const databasePath = join(directory, "runtime.sqlite");
  const artifact = (relativePath, value) => writeFixtureArtifact(directory, relativePath, value);
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
  const targetBaseUrl = "https://release.ailifetime.ai/";
  const deploymentId = "deployment-production-2026";
  const automaticPausePolicyVersion = "pause-policy-v3";
  const rollbackExerciseId = "rollback-forward-exercise-2026";
  const releaseControls = createB127ReleaseControlFixtures({
    artifact,
    tenantId: TENANT_ID,
    launchId: LAUNCH_ID,
    deploymentId,
    repositoryCommit: COMMIT,
    componentSetSha256,
    automaticPausePolicyVersion,
    rollbackExerciseId,
    idPrefix: "ltm",
    mutateGuardrailPolicy: options.mutateGuardrailPolicy,
    mutateControlAttestationBeforeSign: options.mutateControlAttestationBeforeSign,
    mutateControlAttestation: options.mutateControlAttestation,
    reuseControlSignerIdentity: options.reuseControlSignerIdentity,
    reuseEvidenceIdentityAcrossWaves: options.reuseEvidenceIdentityAcrossWaves,
    mutateWaveObservation: options.mutateWaveObservation,
    mutateRollbackDrill: options.mutateRollbackDrill,
  });
  const releaseFixture = createB127ReleaseSubjectFixture({
    root: directory,
    artifact,
    componentVersions,
    componentSetSha256,
    selectedProfile,
    repositoryCommit: COMMIT,
    targetBaseUrl,
    deploymentId,
    goLive: { windowStart: "2026-08-20T10:45:00.000Z", windowEnd: "2026-08-20T11:15:00.000Z", scheduledAt: "2026-08-20T11:00:00.000Z" },
    guardrailPolicySha256: releaseControls.guardrailPolicyArtifact.reference.sha256,
    waveObservationSetSha256: releaseControls.waveObservationSetSha256,
    rollbackForwardDrillSha256: releaseControls.rollbackForwardDrillArtifact.reference.sha256,
    idPrefix: "ltm",
  });
  const { sbom, supplyChainBundle, releaseSubject, releaseSubjectConfig, supplyChainTrustedKey, mediaAuthorityArtifact } = releaseFixture;
  if (options.mediaAuthorityBindingMismatch === true) {
    const authority = JSON.parse(readFileSync(mediaAuthorityArtifact.path, "utf8"));
    authority.mediaLifecycleCatalogSha256 = "0".repeat(64);
    releaseSubjectConfig.mediaAuthorityArtifact = artifact("release/evidence/media-authority.json", Buffer.from(JSON.stringify(authority), "utf8")).reference;
  }
  if (options.emptySbom === true) {
    const empty = structuredClone(supplyChainBundle.cycloneDx);
    empty.components = [];
    const changed = artifact("release-empty.sbom.json", empty);
    sbom.path = changed.path;
    sbom.reference = changed.reference;
  }

  const keys = Array.from({ length: 5 }, (_, index) => {
    const pair = generateKeyPairSync("ed25519");
    return {
      issuer: `production-authority-${index + 1}`,
      keyId: `release-key-${index + 1}`,
      privateKey: pair.privateKey,
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
  });
  const b126Keys = Array.from({ length: 5 }, (_, index) => {
    const pair = generateKeyPairSync("ed25519");
    return {
      issuer: `production-e2e-authority-${index + 1}`,
      keyId: `e2e-key-${index + 1}`,
      privateKey: pair.privateKey,
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
  });
  const evidenceIds = keys.map((_, index) => `release-evidence-${index + 1}`);
  const executorPair = generateKeyPairSync("ed25519");
  const executorKey = {
    issuer: "production-change-executor-issuer",
    keyId: "production-change-executor-key",
    privateKey: executorPair.privateKey,
    publicKeyPem: executorPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const executor = { actorId: "production-deployer", issuer: executorKey.issuer, keyId: executorKey.keyId };
  const changeClaims = {
    tenantId: TENANT_ID,
    launchId: LAUNCH_ID,
    changeId: "change-production-2026",
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
      issuer: `production-change-approver-${index + 1}`,
      keyId: `production-change-approver-key-${index + 1}`,
      privateKey: pair.privateKey,
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      authorityRole,
    };
    const unsigned = {
      schemaVersion: "ltm.production-change-approver-evidence.v1",
      evidenceId: `production-change-approver-evidence-${index + 1}`,
      approverId: `production-change-approver-${index + 1}`,
      issuer: key.issuer,
      keyId: key.keyId,
      authorityRole,
      algorithm: "Ed25519",
      approvedAt: "2026-08-20T10:00:00.000Z",
      claims: changeClaims,
    };
    const document = { ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned)), key.privateKey).toString("base64url") };
    options.mutateChangeApprover?.(index, document, key, changeClaims);
    const evidenceArtifact = artifact(`approvals/production-change-approver-${index + 1}.json`, document);
    return { ...key, evidenceArtifact };
  });
  const changeApprovalControls = {
    executor,
    approverEvidence: changeApproverKeys.map((key) => key.evidenceArtifact.reference),
  };
  const approvalNames = Object.keys(APPROVAL_DECISIONS);
  const approvalArtifactPaths = {};
  const approvals = Object.fromEntries(approvalNames.map((name, index) => {
    const keyIndex = index % keys.length;
    const approvalId = `approval-${index + 1}`;
    const authority = `Production Authority ${keyIndex + 1}`;
    const approvedAt = "2026-08-20T10:00:00.000Z";
    const expiresAt = "2026-08-21T12:00:00.000Z";
    const approvalDocument = releaseApprovalArtifact(name, {
      approvalId,
      authority,
      issuer: keys[keyIndex].issuer,
      tenantId: TENANT_ID,
      launchId: LAUNCH_ID,
      repositoryCommit: COMMIT,
      sbomSha256: sbom.reference.sha256,
      decision: APPROVAL_DECISIONS[name],
      approvedAt,
      expiresAt,
      componentSetSha256,
      releaseSubject,
      changeApprovalControls,
    });
    options.mutateApproval?.(name, approvalDocument, releaseSubject);
    const approvalArtifact = artifact(`approvals/${name}.json`, options.invalidApprovalArtifact === name
      ? { approval: name, decision: APPROVAL_DECISIONS[name] }
      : approvalDocument);
    approvalArtifactPaths[name] = approvalArtifact.path;
    return [name, {
      approvalId,
      authority,
      issuer: keys[keyIndex].issuer,
      evidenceId: evidenceIds[keyIndex],
      artifact: approvalArtifact.reference,
      decision: APPROVAL_DECISIONS[name],
      approvedAt,
      expiresAt,
    }];
  }));
  if (options.missingApproval !== undefined) delete approvals[options.missingApproval];

  const wave = options.wave ?? "global";
  const rolloutPercent = options.rolloutPercent ?? 100;
  const waveStartedAt = "2026-08-20T11:00:00.000Z";
  const completedWaves = releaseControls.completedWaves;
  const operationsHandoffSummary = {
    handoffId: "operations-handoff-2026",
    status: "accepted",
    acceptedAt: "2026-08-20T09:50:00.000Z",
    acceptedBy: "production-operations-lead",
    runbookVersion: "runbook-v3",
    onCallScheduleVersion: "oncall-v4",
    supportPlanVersion: "support-v2",
  };
  const operationsHandoffDocument = {
    schemaVersion: "ltm.operations-handoff.v1",
    releaseId: LAUNCH_ID,
    tenantId: TENANT_ID,
    launchId: LAUNCH_ID,
    deploymentId: releaseSubject.deploymentId,
    repositoryCommit: COMMIT,
    componentSetSha256,
    ...operationsHandoffSummary,
  };
  options.mutateOperationsHandoffArtifact?.(operationsHandoffDocument);
  const operationsHandoffArtifact = artifact("release/operations-handoff.json", operationsHandoffDocument);
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
    releaseSubject: releaseSubjectConfig,
    rollout: {
      wave,
      rolloutPercent,
      waveStartedAt,
      rollbackExerciseId,
      automaticPausePolicyVersion,
      guardrailPolicyArtifact: releaseControls.guardrailPolicyArtifact.reference,
      completedWaves,
      rollbackForwardDrillArtifact: releaseControls.rollbackForwardDrillArtifact.reference,
    },
    approvals,
    goLive: {
      windowStart: "2026-08-20T10:45:00.000Z",
      windowEnd: "2026-08-20T11:15:00.000Z",
      scheduledAt: waveStartedAt,
      changeApprovalId: "approval-8",
    },
    operationsHandoff: {
      ...operationsHandoffSummary,
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
    keys: [...keys.map((key) =>
      trustedKey(key, `release-control:${RELEASE_PROVIDER_ID}`, b127ScopeValue, [
        B127_PRODUCTION_RELEASE_AUTHORITY_ROLE,
        ...(options.omitAuthorityRoles === true ? [] : approvalNames
          .filter((_, approvalIndex) => approvalIndex % keys.length === keys.indexOf(key))
          .map((approvalName) => APPROVAL_AUTHORITY_ROLES[approvalName])),
      ]),
    ),
    ...b126Keys.map((key) => trustedKey(key, `e2e-auditor:${b126ProviderId}`, b126ScopeValue)),
    ...changeApproverKeys.map((key) => trustedKey(
      key,
      "change-approval:change-production-2026",
      `ltm-change-approval:v1:${sha256(Buffer.from(canonicalJson(changeClaims)))}`,
      [key.authorityRole],
    )),
    trustedKey(executorKey, "change-executor:production", "ltm-change-executor:production", ["production-change-executor"]),
    trustedKey(supplyChainTrustedKey, supplyChainTrustedKey.provider, supplyChainTrustedKey.scope, supplyChainTrustedKey.authorityRoles),
    ...releaseControls.controlArtifactTrustedKeys],
  };
  options.mutateControlTrustedKeys?.(trustDocument.keys);
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
    monitoringDomains: ["quality", "payment", "refund", "message", "support", "ledger", "supply", "privacy", "security", "cost", "slo"],
    approvalIds: approvalNames.map((_, index) => `approval-${index + 1}`),
    rollbackExerciseId,
    automaticPausePolicyVersion,
    guardrailPolicySha256: releaseControls.guardrailPolicyArtifact.reference.sha256,
    waveObservationSetSha256: releaseControls.waveObservationSetSha256,
    globalWaveObservationPath: releaseControls.globalWaveObservation.observationArtifact.path,
    globalWaveObservationSha256: releaseControls.globalWaveObservation.observationArtifact.sha256,
    rollbackForwardDrillSha256: releaseControls.rollbackForwardDrillArtifact.reference.sha256,
    changeApproverEvidenceIds: changeApproverKeys.map((key) => `production-change-approver-evidence-${changeApproverKeys.indexOf(key) + 1}`),
    activeGuardrailBreaches: 0,
    externalEvidenceIds: evidenceIds,
    evidenceScope: b127ScopeValue,
  };
  const priorWaveRecord = {
    ...record,
    wave: "regional",
    rolloutPercent: 25,
  };
  delete priorWaveRecord.globalWaveObservationPath;
  delete priorWaveRecord.globalWaveObservationSha256;
  insertFixtureRecord(database, "b127-prior-wave-record", priorWaveRecord, "2026-08-20T01:05:00.000Z");
  insertFixtureRecord(database, "b127-record", record, "2026-08-20T12:02:00.000Z");
  b126Keys.forEach((key, index) => {
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
  });
  keys.forEach((key, index) => {
    insertFixtureEvidence(database, key, {
      evidenceId: evidenceIds[index],
      provider: `release-control:${RELEASE_PROVIDER_ID}`,
      scope: b127ScopeValue,
      artifactSha256: manifestSha256,
      issuedAt: "2026-08-20T10:45:00.000Z",
      verifiedAt: "2026-08-20T10:46:00.000Z",
      consumedAt: options.earlyGlobalEvidenceConsumption === true
        ? "2026-08-20T11:59:00.000Z"
        : "2026-08-20T12:01:00.000Z",
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
    mediaAuthorityArtifactPath: mediaAuthorityArtifact.path,
    guardrailPolicyArtifactPath: releaseControls.guardrailPolicyArtifact.path,
    rawObservationArtifactPaths: Object.fromEntries(
      [...releaseControls.rawObservationArtifacts].map(([name, item]) => [name, item.path]),
    ),
    rawRollbackArtifactPaths: Object.fromEntries(
      [...releaseControls.rawRollbackArtifacts].map(([name, item]) => [name, item.path]),
    ),
    controlAttestationArtifactPaths: Object.fromEntries(
      [...releaseControls.controlAttestationArtifacts].map(([name, item]) => [name, item.path]),
    ),
    changeApproverArtifactPaths: changeApproverKeys.map((key) => key.evidenceArtifact.path),
    waveObservationArtifactPaths: Object.fromEntries(
      [...releaseControls.observationArtifacts].map(([waveName, item]) => [waveName, item.path]),
    ),
    rollbackForwardDrillArtifactPath: releaseControls.rollbackForwardDrillArtifact.path,
    approvalArtifactPaths,
    supplyChainBundle,
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

function cycloneDxFixture(name) {
  const packageDigest = sha256(Buffer.from(`${name}:package`));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": `pkg:npm/${name}@1.0.0`,
        name,
        version: "1.0.0",
        hashes: [{ alg: "SHA-256", content: sha256(Buffer.from(`${name}:artifacts`)) }],
      },
      properties: [{ name: "ltm:pnpm-lock-sha256", value: sha256(Buffer.from(`${name}:lockfile`)) }],
    },
    components: [{
      type: "library",
      "bom-ref": `pkg:npm/${name}-dependency@1.0.0`,
      name: `${name}-dependency`,
      version: "1.0.0",
      purl: `pkg:npm/${name}-dependency@1.0.0`,
      hashes: [{ alg: "SHA-256", content: packageDigest }],
    }],
  };
}

function releaseApprovalArtifact(name, input) {
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
    repositoryCommit: input.repositoryCommit,
    sbomSha256: input.sbomSha256,
    decision: input.decision,
    approvedAt: input.approvedAt,
    expiresAt: input.expiresAt,
    subject: approvalSubject(name, input),
  };
}

function approvalSubject(name, input) {
  const digest = (suffix) => sha256(Buffer.from(`${name}:${suffix}`));
  switch (name) {
    case "independentPenetrationTest": return {
      engagementId: "pentest-engagement-2026", providerId: "independent-security-labs", targetOrigin: input.releaseSubject.penetrationTest.targetOrigin,
      reportArtifactSha256: input.releaseSubject.penetrationTest.reportArtifactSha256, findingRegistrySha256: input.releaseSubject.penetrationTest.findingRegistrySha256,
      scopeCategories: ["authentication", "tenant_isolation", "idor", "upload", "signed_url", "webhook", "payment", "ssrf", "xss", "csrf", "admin_operations"],
      independentThirdParty: true, conflictsDisclosed: true, unresolvedCritical: 0, unresolvedHigh: 0, retestPassed: true,
    };
    case "legalRegulatoryReview": return {
      reviewId: "legal-review-2026", legalEntityId: input.releaseSubject.legal.legalEntityId, jurisdictions: input.releaseSubject.legal.jurisdictions, productVersion: input.releaseSubject.profileVersion,
      scopes: ["privacy", "ai", "minors", "commerce", "payments", "tax", "consumer_terms"], unresolvedRestrictions: [], signingAuthorityVerified: true,
    };
    case "manualAccessibilityReview": return {
      auditId: "accessibility-audit-2026", ...input.releaseSubject.accessibility,
      unresolvedCritical: 0, unresolvedHigh: 0, manualTesting: true, retestPassed: true,
    };
    case "appleAppStoreDecision": return storeApproval(name, input);
    case "googlePlayDecision": return storeApproval(name, input);
    case "wechatMiniProgramDecision": return storeApproval(name, input);
    case "disasterRecoveryDrill": return {
      exerciseId: "dr-exercise-2026", deploymentId: input.releaseSubject.deploymentId, reportArtifactSha256: input.releaseSubject.disasterRecovery.reportArtifactSha256,
      backupId: "backup-production-2026", sourceRegion: input.releaseSubject.disasterRecovery.sourceRegion, failoverRegion: input.releaseSubject.disasterRecovery.failoverRegion, restoreTargetId: "restore-isolated-2026",
      schemaVersion: input.releaseSubject.disasterRecovery.schemaVersion, targetRtoSeconds: input.releaseSubject.disasterRecovery.targetRtoSeconds, observedRtoSeconds: 600, targetRpoSeconds: input.releaseSubject.disasterRecovery.targetRpoSeconds, observedRpoSeconds: 120,
      failoverVerified: true, failbackVerified: true, forcedRlsVerified: true, auditChainVerified: true, ledgerBalanced: true,
      deletionNonResurrection: true, duplicateSideEffectsPrevented: true,
    };
    case "productionChangeApproval": return {
      changeId: "change-production-2026", ticketUrl: "https://changes.ailifetime.ai/tickets/change-production-2026", deploymentId: input.releaseSubject.deploymentId,
      componentSetSha256: input.releaseSubject.componentSetSha256,
      guardrailPolicySha256: input.releaseSubject.guardrailPolicySha256,
      waveObservationSetSha256: input.releaseSubject.waveObservationSetSha256,
      rollbackForwardDrillSha256: input.releaseSubject.rollbackForwardDrillSha256,
      executor: input.changeApprovalControls.executor,
      approverEvidence: input.changeApprovalControls.approverEvidence,
      windowStart: input.releaseSubject.goLive.windowStart, windowEnd: input.releaseSubject.goLive.windowEnd,
    };
    default: throw new Error(`unknown approval ${name}`);
  }
}

function storeApproval(name, input) {
  const application = input.releaseSubject.applications[name];
  return {
    ...application, decisionId: `${application.store}-decision-2026`, reviewEnvironment: "production",
    reviewedAt: "2026-08-20T09:55:00.000Z", nativeReceiptVerificationPassed: true,
  };
}

function deploymentProducer(checkId) {
  const names = {
    "production-dependency-audit": "pnpm-audit",
    "production-backup-restore-drill": "ltm-postgres-restore-verifier",
    "semgrep-static-analysis": "semgrep",
    "trivy-container-scan": "trivy",
    "grype-image-scan": "grype",
    "syft-sbom": "syft",
    "osv-scanner": "osv-scanner",
    "gitleaks-scan": "gitleaks",
    "production-persistence": "ltm-postgres-runtime-probe",
    "enterprise-authentication": "ltm-oidc-production-probe",
    "distributed-coordination": "ltm-redis-production-probe",
    "durable-object-storage": "ltm-object-storage-production-probe",
    "background-workers": "ltm-worker-production-probe",
    "external-provider-mode": "ltm-provider-production-reconciliation",
    "tls-and-proxy": "ltm-tls-production-probe",
    "managed-secret-references": "ltm-managed-secrets-production-probe",
    "database-url-contract": "ltm-database-contract-probe",
    "runtime-policy-authority": "ltm-runtime-policy-authority-probe",
  };
  return { name: names[checkId], version: "1.0.0", invocationId: `probe-${checkId}` };
}

function deploymentAssertions(checkId, { targetBaseUrl, observedAt, producer, releaseSubject, mediaAuthorityArtifactSha256 }) {
  const hash = (suffix) => sha256(Buffer.from(`${checkId}:${suffix}`));
  const images = releaseSubject.workloadImages.map((image) => ({ ...image }));
  const tool = producer.name;
  const toolVersion = producer.version;
  switch (checkId) {
    case "production-dependency-audit": return { tool, toolVersion, registry: "https://registry.npmjs.org/", lockfileSha256: releaseSubject.lockfileSha256, dependencyCount: 42, skippedCount: 0, high: 0, critical: 0, exitCode: 0 };
    case "production-backup-restore-drill": return { tool, toolVersion, backend: "postgresql", serverMajor: 17, schemaVersion: "7", backupId: "backup-2026", sourceEnvironment: "production", restoreTargetId: "restore-isolated-2026", restorePoint: observedAt, backupSha256: hash("backup"), restoredSha256: hash("restore"), targetRtoSeconds: 900, observedRtoSeconds: 600, targetRpoSeconds: 300, observedRpoSeconds: 120, pointInTimeRecoveryVerified: true, crossRegion: true, integrityChecks: { database: true, forcedRls: true, tenantIsolation: true, auditChain: true, ledgerBalance: true, evidenceChain: true, deletionNonResurrection: true, duplicateSideEffectsPrevented: true }, exitCode: 0 };
    case "semgrep-static-analysis": return { tool, toolVersion, rulesetSha256: hash("rules"), scannedFiles: 680, scanErrors: 0, high: 0, critical: 0, sarifSha256: hash("sarif"), exitCode: 0 };
    case "trivy-container-scan": return { tool, toolVersion, databaseUpdatedAt: "2026-08-20T10:00:00.000Z", configurationScanned: true, images, scanErrors: 0, high: 0, critical: 0, exitCode: 0 };
    case "grype-image-scan": return { tool, toolVersion, databaseUpdatedAt: "2026-08-20T10:00:00.000Z", images, scanErrors: 0, high: 0, critical: 0, exitCode: 0 };
    case "syft-sbom": return { tool, toolVersion, images, sboms: images.map((image) => ({ role: image.role, imageDigest: image.digest, artifactSha256: hash(`sbom-${image.role}`), format: "cyclonedx-json", componentCount: 10 })), componentCount: images.length * 10, signedBundleSha256: releaseSubject.supplyChain.bundleSha256, provenanceSha256: releaseSubject.supplyChain.provenanceSha256, productionTrustKeyId: releaseSubject.supplyChain.trustKeyId, exitCode: 0 };
    case "osv-scanner": return { tool, toolVersion, lockfileSha256: releaseSubject.lockfileSha256, componentSetSha256: releaseSubject.componentSetSha256, scannedPackages: 42, skippedPackages: 0, high: 0, critical: 0, exitCode: 0 };
    case "gitleaks-scan": return { tool, toolVersion, commit: COMMIT, scanScope: "full-history-and-worktree", scannedFiles: 680, findings: 0, exitCode: 0 };
    case "production-persistence": return { tool, toolVersion, engine: "postgresql", serverMajor: 17, schemaVersion: "7", tlsMode: "verify-full", hostnameVerified: true, role: "ltm_runtime", superuser: false, bypassRls: false, forcedRlsTables: releaseSubject.forcedRlsTables, tenantIsolationNegativeTest: true, migrationsSha256: releaseSubject.migrationManifestSha256, readWriteProbe: true, exitCode: 0 };
    case "enterprise-authentication": return { tool, toolVersion, protocol: "oidc", issuer: "https://identity.example.com/", jwksUrl: "https://identity.example.com/.well-known/jwks.json", audience: "ltm-production", algorithms: ["RS256", "ES256"], tokenExchangeVerified: true, claimsVerified: { issuer: true, audience: true, tenant: true, roles: true, purposes: true, mfaStepUp: true }, rejections: { expired: true, wrongIssuer: true, wrongAudience: true, wrongTenant: true, unknownRole: true, missingPurpose: true, unsigned: true }, exitCode: 0 };
    case "distributed-coordination": return { tool, toolVersion, engine: "redis", tlsVerified: true, clusterNodes: 3, leaseOwnershipVerified: true, replayPreventionVerified: true, concurrentClaimVerified: true, failoverVerified: true, duplicateSideEffects: 0, exitCode: 0 };
    case "durable-object-storage": return { tool, toolVersion, provider: "aws-s3", bucket: "ltm-production-evidence", kmsKeyReference: "arn:aws:kms:cn-north-1:000000000000:key/example", objectLockMode: "COMPLIANCE", versioningEnabled: true, retentionDays: 365, writeReadDigestVerified: true, deleteBeforeRetentionRejected: true, crossAccountDenyVerified: true, exitCode: 0 };
    case "background-workers": return { tool, toolVersion, commit: COMMIT, workloadImageDigest: images.find((item) => item.role === "workers").digest, replicas: 3, routes: ["media", "notification", "fulfillment", "integration", "data"], externalCommandMappings: 18, leaseRecoveryVerified: true, retryVerified: true, deadLetterVerified: true, reconciliationFreezeVerified: true, healthObserved: true, exitCode: 0 };
    case "external-provider-mode": return { tool, toolVersion, mode: "external-verified", providers: releaseSubject.requiredProviderIds.map((providerId) => ({ providerId, accountId: `${providerId}-account`, commandId: `${providerId}-command`, callbackId: `${providerId}-callback`, reconciliationId: `${providerId}-reconciliation`, requestAccepted: true, callbackVerified: true, reconciled: true })), exitCode: 0 };
    case "tls-and-proxy": return { tool, toolVersion, publicOrigin: targetBaseUrl, certificateSha256: hash("certificate"), notBefore: "2026-08-01T00:00:00.000Z", notAfter: "2026-12-01T00:00:00.000Z", minimumProtocol: "TLSv1.2", hostnameVerified: true, chainVerified: true, hstsMaxAgeSeconds: 31_536_000, proxyHeadersSanitized: true, externalProbeVerified: true, exitCode: 0 };
    case "managed-secret-references": return { tool, toolVersion, provider: "aws-secrets-manager", workloadIdentitySubject: "system:serviceaccount:ltm-production:ltm-api", secretReferences: releaseSubject.secretReferences, inlineSecretCount: 0, authorizedReadVerified: true, unauthorizedReadDenied: true, rotationObserved: true, reportContainsSecretValues: false, exitCode: 0 };
    case "database-url-contract": return { tool, toolVersion, reference: releaseSubject.databaseUrlReference, scheme: "postgresql", tlsMode: "verify-full", hostnameVerified: true, caVerified: true, credentialsInline: false, applicationName: "ltm-api", serverMajor: 17, schemaVersion: "7", role: "ltm_runtime", superuser: false, bypassRls: false, migrationsSha256: releaseSubject.migrationManifestSha256, connectionVerified: true, exitCode: 0 };
    case "runtime-policy-authority": return {
      tool,
      toolVersion,
      workloadIdentitySubject: "system:serviceaccount:ltm-production:policy-authority-probe",
      workloadIdentityVerified: true,
      mutualTlsVerified: true,
      apiReady: { endpoint: new URL("/health/ready", targetBaseUrl).toString(), statusCode: 200, ready: true, responseSha256: hash("api-ready-response") },
      apiConsentMetadata: {
        endpoint: new URL("/v1/consent-policy/authority", targetBaseUrl).toString(),
        statusCode: 200,
        responseSha256: hash("api-consent-authority-response"),
        schemaVersion: "ltm.consent-policy-catalog-metadata.v1",
        catalogId: "ltm-production-consent-policy-v1",
        issuer: "ltm-production-consent-policy-authority",
        environment: "production",
        catalogSha256: releaseSubject.consentPolicyCatalogSha256,
        issuedAt: "2026-08-19T00:00:00.000Z",
        expiresAt: "2026-08-22T00:00:00.000Z",
        jurisdiction: "CN",
        locale: "zh-CN",
        policyVersions: ["ltm-consent-v1"],
      },
      mediaBrokerReady: { endpoint: "https://client-integration-broker.ltm-production.svc.cluster.local/health/ready", statusCode: 200, ready: true, responseSha256: hash("media-ready-response") },
      mediaAuthority: {
        endpoint: "https://client-integration-broker.ltm-production.svc.cluster.local/v1/media/lifecycle/authority",
        statusCode: 200,
        responseSha256: mediaAuthorityArtifactSha256,
        schemaVersion: "ltm.media-authority.v1",
        mediaLifecycleCatalogSha256: releaseSubject.mediaLifecycleCatalogSha256,
        mediaSafetyPolicySha256: releaseSubject.mediaSafetyPolicySha256,
        lifecycleIssuer: "ltm-media-lifecycle-authority",
        lifecycleEnvironment: "production",
        lifecycleExpiresAt: "2026-08-22T00:00:00.000Z",
        scannerProvider: "production-media-safety-scanner",
        scannerPolicyId: "ltm-media-safety-policy-v1",
        scannerModelVersion: "production-v1",
        scannerKeyId: "ltm-media-safety-key-v1",
        scannerEnvironment: "production",
      },
      exitCode: 0,
    };
    default: throw new Error(`unknown deployment check ${checkId}`);
  }
}

function trustedKey(key, provider, scope, authorityRoles = []) {
  return {
    issuer: key.issuer,
    provider,
    keyId: key.keyId,
    algorithm: "Ed25519",
    publicKeyPem: key.publicKeyPem,
    allowedScopes: [scope],
    allowedEnvironments: ["production"],
    ...(authorityRoles.length === 0 ? {} : { authorityRoles }),
    notBefore: "2026-08-19T00:00:00.000Z",
    notAfter: "2026-08-22T00:00:00.000Z",
  };
}

function createFixtureSchema(database) {
  database.exec(`
    CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '5');
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

function deploymentReleaseSubject({ deploymentId, targetBaseUrl }) {
  const digest = (label) => sha256(Buffer.from(`deployment-release-subject:${label}`));
  const workloadImages = ["api", "workers", "integration-gateway", "client-integration-broker", "migrator"]
    .map((role, index) => ({ role, digest: `sha256:${String(index + 1).repeat(64)}` }));
  return validateProductionReleaseSubject({
    schemaVersion: "ltm.production-release-subject.v1", deploymentId, targetBaseUrl, repositoryCommit: COMMIT,
    profileVersion: "2.0.0", componentSetSha256: digest("components"), lockfileSha256: digest("lockfile"), migrationManifestSha256: digest("migrations"), workloadImages,
    consentPolicyCatalogSha256: digest("consent-policy-catalog"),
    mediaLifecycleCatalogSha256: digest("media-lifecycle-catalog"),
    mediaSafetyPolicySha256: digest("media-safety-policy"),
    guardrailPolicySha256: digest("guardrail-policy"),
    waveObservationSetSha256: digest("wave-observation-set"),
    rollbackForwardDrillSha256: digest("rollback-forward-drill"),
    requiredProviderIds: ["apple-store-production", "wechat-pay-production"],
    secretReferences: ["managed:ltm-production-api", "managed:ltm-production-database"],
    forcedRlsTables: [...REQUIRED_SCHEMA5_FORCE_RLS_TABLES], databaseUrlReference: "secrets-manager:ltm/production/database-url",
    legal: { legalEntityId: "ltm-legal-entity", jurisdictions: ["CN", "EU", "US"] },
    accessibility: { standard: "WCAG-2.2-AA", platforms: ["android", "ios", "web"], browsers: ["chrome", "firefox", "safari"], assistiveTechnologies: ["nvda", "talkback", "voiceover"], journeys: ["capture", "checkout", "generation", "signup", "support"] },
    applications: {
      appleAppStoreDecision: { store: "apple-app-store", applicationId: "com.ailifetime.ios", accountId: "apple-production", version: "2.0.0", buildSha256: digest("ios") },
      googlePlayDecision: { store: "google-play", applicationId: "com.ailifetime.android", accountId: "google-production", version: "2.0.0", buildSha256: digest("android") },
      wechatMiniProgramDecision: { store: "wechat-mini-program", applicationId: "wxailifetimeprod", accountId: "wechat-production", version: "2.0.0", buildSha256: digest("wechat") },
    },
    penetrationTest: { targetOrigin: targetBaseUrl, reportArtifactSha256: digest("pentest"), findingRegistrySha256: digest("findings") },
    disasterRecovery: { deploymentId, reportArtifactSha256: digest("dr"), sourceRegion: "cn-east-1", failoverRegion: "cn-north-1", schemaVersion: "7", targetRtoSeconds: 900, targetRpoSeconds: 300 },
    goLive: { windowStart: "2026-08-20T10:45:00.000Z", windowEnd: "2026-08-20T11:15:00.000Z", scheduledAt: "2026-08-20T11:00:00.000Z" },
    supplyChain: { bundleSha256: digest("bundle"), provenanceSha256: digest("provenance"), trustKeyId: "production-supply-chain-key" },
  });
}

function createDeploymentFixture(testContext, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ltm-deployment-evidence-"));
  testContext.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = "deployment-assurance:production-control";
  const deploymentId = "deployment-production-2026";
  const targetBaseUrl = "https://release.ailifetime.ai/";
  const releaseManifestSha256 = "b".repeat(64);
  const releaseSubject = deploymentReleaseSubject({ deploymentId, targetBaseUrl });
  const releaseSubjectSha256 = productionReleaseSubjectSha256(releaseSubject);
  const mediaAuthorityArtifactSha256 = sha256(Buffer.from("deployment-media-authority-artifact"));
  const signingPair = generateKeyPairSync("ed25519");
  const scope = deploymentEvidenceScope({
    tenantId: TENANT_ID,
    launchId: LAUNCH_ID,
    deploymentId,
    provider,
    commit: COMMIT,
    releaseManifestSha256,
    releaseSubjectSha256,
    targetBaseUrl,
  });
  const checks = {};
  let firstArtifactPath;
  mkdirSync(join(directory, "reports"), { recursive: true, mode: 0o700 });
  for (const [index, checkId] of REQUIRED_DEPLOYMENT_CHECKS.entries()) {
    const relativePath = `reports/${String(index + 1).padStart(2, "0")}-${checkId}.json`;
    const artifactPath = join(directory, relativePath);
    const observedAt = "2026-08-20T11:00:00.000Z";
    const producer = deploymentProducer(checkId);
    const assertions = deploymentAssertions(checkId, {
      targetBaseUrl,
      observedAt,
      producer,
      releaseSubject,
      mediaAuthorityArtifactSha256,
    });
    options.mutateAssertions?.(checkId, assertions, releaseSubject);
    const artifact = Buffer.from(`${JSON.stringify({
      schemaVersion: "ltm.production-deployment-check-report.v1",
      checkId,
      status: "passed",
      environment: "production",
      tenantId: TENANT_ID,
      launchId: LAUNCH_ID,
      deploymentId,
      commit: COMMIT,
      releaseManifestSha256,
      releaseSubjectSha256,
      targetBaseUrl,
      observedAt,
      producer,
      assertions: {
        ...assertions,
        ...(options.invalidCheck === checkId ? { high: 1 } : {}),
      },
    })}\n`);
    writeFileSync(artifactPath, artifact, { mode: 0o600 });
    firstArtifactPath ??= artifactPath;
    checks[checkId] = {
      status: "passed",
      observedAt,
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
    releaseSubjectSha256,
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
      expectedMediaAuthorityArtifactSha256: mediaAuthorityArtifactSha256,
      expectedTargetBaseUrl: targetBaseUrl,
      expectedReleaseSubject: releaseSubject,
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
