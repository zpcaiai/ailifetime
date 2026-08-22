import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { scanRepository, toSarif } from "../security/scanners/static-scanner.mjs";

function write(root, path, content) { const target = resolve(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); }
function safeFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "ltm-static-scan-"));
  write(root, "packages/example/index.ts", "export const safe = true;\n");
  write(root, "services/api/src/server.ts", "const controls = 'content-security-policy x-content-type-options FORBIDDEN_CONTEXT_HEADERS timingSafeEqual';\n");
  write(root, "apps/web/src/app.ts", "export const render = (value: string) => value;\n");
  write(root, "apps/mobile/src/index.ts", "export const secureStorage = true;\n");
  write(root, "apps/wechat-mini/src/index.ts", "export const serverVerified = true;\n");
  write(root, "infra/config.yaml", "service: safe\n");
  write(root, "services/api/Dockerfile", "FROM node@sha256:" + "a".repeat(64) + " AS runtime\nUSER 10001\n");
  write(root, "services/api/openapi.yaml", `openapi: 3.1.0\npaths:\n  /v1/capabilities:\n    post:\n      security:\n        - bearerAuth: []\n      parameters:\n        - $ref: '#/components/parameters/IdempotencyKey'\n  /v1/capabilities/{batchId}:\n    post:\n      security:\n        - bearerAuth: []\n      parameters:\n        - $ref: '#/components/parameters/IdempotencyKey'\n  /v1/commands:\n    post:\n      security:\n        - bearerAuth: []\n      parameters:\n        - $ref: '#/components/parameters/IdempotencyKey'\ncomponents:\n  securitySchemes:\n    bearerAuth:\n      type: http\n      scheme: bearer\n`);
  return root;
}

test("scans every required surface and emits a clean high-severity gate plus SARIF", () => {
  const report = scanRepository({ root: safeFixture(), ...externalEvidence() });
  assert.equal(report.status, "PASS");
  for (const category of ["sast", "frontend", "mobile", "mini", "iac", "container", "api", "sca"]) assert.ok(report.coverage[category]);
  assert.equal(toSarif(report).version, "2.1.0");
});

test("blocks exploitable source, insecure IaC, client token storage, and high dependency findings", () => {
  const root = safeFixture();
  write(root, "packages/example/vulnerable.ts", "const result = eval(userInput);\n");
  write(root, "apps/web/src/vulnerable.ts", "localStorage.setItem('access-token', token);\n");
  write(root, "infra/danger.yaml", "privileged: true\n");
  const report = scanRepository({ root, ...externalEvidence(), auditJson: auditEvidence({ high: 2 }) });
  assert.equal(report.status, "FAIL");
  assert.ok(report.findings.some((item) => item.ruleId === "LTM-SAST-001"));
  assert.ok(report.findings.some((item) => item.ruleId === "LTM-CLIENT-001"));
  assert.ok(report.findings.some((item) => item.ruleId === "LTM-IAC-001"));
  assert.ok(report.findings.some((item) => item.ruleId === "LTM-SCA-002"));
});

test("never reports B123 PASS when CodeQL, audit, Trivy image/config, secret, or DAST evidence is absent", () => {
  const report = scanRepository({ root: safeFixture() });
  assert.equal(report.status, "NOT_RUN");
  assert.deepEqual(report.missingRequiredEvidence.sort(), ["api", "container", "dast", "iac", "sast", "sca", "secret"].sort());
});

test("detects mutable Compose images", () => {
  const root = safeFixture();
  write(root, "compose.yaml", "services:\n  object-storage:\n    image: minio/minio:latest\n");
  const report = scanRepository({ root, ...externalEvidence() });
  assert.equal(report.status, "FAIL");
  assert.ok(report.findings.some((item) => item.ruleId === "LTM-IAC-006"));
});

test("rejects fake CodeQL and incomplete Trivy assertions", () => {
  const root = safeFixture();
  assert.throws(() => scanRepository({ root, ...externalEvidence(), codeqlSarif: { version: "2.1.0", runs: [{ tool: { driver: { name: "homemade-regex" } }, results: [] }] } }), /CodeQL/);
  assert.throws(() => scanRepository({ root, ...externalEvidence(), trivyConfigReport: { Results: [] } }), /Trivy/);
  assert.throws(() => scanRepository({ root, ...externalEvidence(), dastReport: { version: "ltm.dast-report.v1", status: "PASS", coveredCategories: ["auth"] } }), /DAST/);
});

function externalEvidence() {
  const trivy = { SchemaVersion: 2, CreatedAt: "2026-08-20T00:00:00Z", ArtifactName: "synthetic", ArtifactType: "filesystem", Results: [{ Target: "synthetic", Vulnerabilities: [], Misconfigurations: [], Secrets: [] }] };
  return {
    auditJson: auditEvidence(),
    secretReport: { status: "PASS", findings: 0, filesScanned: 10 },
    codeqlSarif: { version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL" } }, results: [] }] },
    trivyConfigReport: trivy,
    trivyImageReports: [trivy],
    expectedImageCount: 1,
    dastReport: { version: "ltm.dast-report.v1", status: "PASS", coveredCategories: ["auth", "tenant_idor", "upload_signed_url", "webhook_payment", "ssrf", "xss", "csrf", "admin"] },
  };
}

function auditEvidence(overrides = {}) {
  return { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...overrides }, totalDependencies: 10 } };
}
