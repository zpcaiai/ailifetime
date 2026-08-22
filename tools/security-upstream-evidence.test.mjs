import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  capabilityEvidenceScope,
  externalEvidenceSigningPayload,
  verifyUpstreamControlEvidence,
} from "../security/upstream-control-evidence.mjs";
import { sha256 } from "../security/lib/canonical.mjs";

const NOW = "2026-08-20T00:00:00Z";

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const reports = {
    B119: {
      version: "ltm.configuration-change-report.v1",
      changeId: "change-prod-1",
      targetEnvironment: "production",
      schemaVersion: "2026-08-20",
      changedFields: ["security.headers.csp"],
      driftFindingsCount: 0,
      disabledNonWaivableControls: [],
      rollbackVerified: true,
      violations: [],
      passed: true,
    },
    B121: {
      version: "ltm.capacity-test-report.v1",
      testRunId: "capacity-prod-1",
      scenarios: ["baseline", "peak", "burst", "soak", "dependency_degraded"],
      observedP95Ms: 175,
      maxP95Ms: 250,
      observedErrorRate: 0.001,
      maxErrorRate: 0.01,
      syntheticDataOnly: true,
      paidTasksProtected: true,
      tenantFairnessVerified: true,
      violations: [],
      passed: true,
    },
    B122: {
      version: "ltm.resilience-exercise-report.v1",
      exerciseId: "resilience-prod-1",
      targetRtoSeconds: 900,
      observedRtoSeconds: 480,
      targetRpoSeconds: 300,
      observedRpoSeconds: 120,
      failoverRegion: "cn-north-2",
      cancellationPriorityVerified: true,
      deletionResurrectionPrevented: true,
      duplicateSideEffectsPrevented: true,
      violations: [],
      passed: true,
    },
  };
  const policy = {
    B119: { operation: "approveConfigurationChange", kind: "configuration-change-report", provider: "change-control:service-now", subjectId: reports.B119.changeId },
    B121: { operation: "approveCapacityGate", kind: "capacity-test-report", provider: "load-test:k6-cloud", subjectId: reports.B121.testRunId },
    B122: { operation: "recordResilienceExercise", kind: "resilience-exercise-report", provider: "resilience-auditor:independent-lab", subjectId: reports.B122.exerciseId },
  };
  const artifacts = new Map();
  const keys = [];
  const controls = Object.keys(policy).map((batchId, index) => {
    const artifactPath = `${batchId.toLowerCase()}-report.json`;
    const artifact = Buffer.from(`${JSON.stringify(reports[batchId])}\n`, "utf8");
    artifacts.set(artifactPath, artifact);
    const binding = {
      tenantId: "tenant-production-1",
      batchId,
      operation: policy[batchId].operation,
      kind: policy[batchId].kind,
      provider: policy[batchId].provider,
      artifactSha256: sha256(artifact),
      environment: "production",
      subjectId: policy[batchId].subjectId,
    };
    const evidence = {
      version: "ltm.external-evidence.v1",
      evidenceId: `evidence-${batchId.toLowerCase()}-1`,
      tenantId: binding.tenantId,
      binding,
      scope: capabilityEvidenceScope(binding),
      issuer: "ltm-production-attestor",
      provider: binding.provider,
      artifactSha256: binding.artifactSha256,
      issuedAt: "2026-08-19T00:00:00Z",
      expiresAt: "2026-09-19T00:00:00Z",
      nonce: `nonce-${batchId.toLowerCase()}-${index}`,
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: "production-operational-key-1",
    };
    const signed = { ...evidence, signature: sign(null, externalEvidenceSigningPayload(evidence), privateKey).toString("base64url") };
    keys.push({
      issuer: signed.issuer,
      provider: signed.provider,
      keyId: signed.keyId,
      algorithm: "Ed25519",
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      allowedScopes: [signed.scope],
      allowedEnvironments: ["production"],
      notBefore: "2026-01-01T00:00:00Z",
      notAfter: "2027-01-01T00:00:00Z",
    });
    return { batchId, artifactPath, evidence: signed };
  });
  return {
    bundle: { version: "ltm.upstream-control-evidence-bundle.v1", tenantId: "tenant-production-1", environment: "production", controls },
    trustStore: { version: "ltm.upstream-control-trust-store.v1", keys },
    artifactResolver: (path) => artifacts.get(path),
    artifacts,
  };
}

test("B119/B121/B122 pass only with exact raw artifacts, signed scopes, and enrolled production keys", () => {
  const input = fixture();
  const result = verifyUpstreamControlEvidence({ ...input, now: NOW });
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.controls.map((item) => item.batchId), ["B119", "B121", "B122"]);
  assert.match(result.controls[0].scope, /^ltm-evidence:v1:[a-f0-9]{64}$/);
});

test("missing reports or issuer enrollment remain BLOCKED_EXTERNAL", () => {
  const input = fixture();
  assert.equal(verifyUpstreamControlEvidence({ bundle: undefined, trustStore: input.trustStore }).status, "BLOCKED_EXTERNAL");
  input.bundle.controls = input.bundle.controls.filter((item) => item.batchId !== "B122");
  assert.equal(verifyUpstreamControlEvidence({ ...input, now: NOW }).status, "BLOCKED_EXTERNAL");

  const unknown = fixture();
  unknown.trustStore.keys = [];
  assert.equal(verifyUpstreamControlEvidence({ ...unknown, now: NOW }).status, "BLOCKED_EXTERNAL");
});

test("tampered bytes, drifted scope, failing provider conclusions, and client boolean assertions fail closed", () => {
  const tampered = fixture();
  tampered.artifacts.set("b119-report.json", Buffer.from("{}\n"));
  assert.throws(() => verifyUpstreamControlEvidence({ ...tampered, now: NOW }), /artifact|report/);

  const wrongScope = fixture();
  wrongScope.bundle.controls[1].evidence.scope = `ltm-evidence:v1:${"a".repeat(64)}`;
  assert.throws(() => verifyUpstreamControlEvidence({ ...wrongScope, now: NOW }), /scope/);

  const failed = fixture();
  const report = JSON.parse(failed.artifacts.get("b121-report.json").toString("utf8"));
  report.observedP95Ms = 999;
  failed.artifacts.set("b121-report.json", Buffer.from(`${JSON.stringify(report)}\n`));
  assert.throws(() => verifyUpstreamControlEvidence({ ...failed, now: NOW }), /artifact|capacity/);

  const selfAttested = fixture();
  selfAttested.bundle.controls[0].driftCheckPassed = true;
  assert.throws(() => verifyUpstreamControlEvidence({ ...selfAttested, now: NOW }), /closed contract|self-attestation/);
});

test("CLI returns exit 2 when real upstream evidence is absent and zero only with explicit allow-blocked", () => {
  const blocked = spawnSync(process.execPath, ["tools/security-upstream-evidence.mjs"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).status, "BLOCKED_EXTERNAL");
  const allowed = spawnSync(process.execPath, ["tools/security-upstream-evidence.mjs", "--allow-blocked=true"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).status, "BLOCKED_EXTERNAL");
});
