import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { certifyProductionDeployment, REQUIRED_DEPLOYMENT_CHECKS } from "./deployment-evidence.mjs";
import { isProductionReleaseApproved, releaseGateOutcome } from "./release-gate-policy.mjs";

const args = new Map(process.argv.slice(2).map((argument) => {
  const [name, ...rest] = argument.replace(/^--/, "").split("=");
  return [name, rest.length === 0 ? "true" : rest.join("=")];
}));
const profile = args.get("profile") ?? "production";
if (profile !== "ci" && profile !== "production" && profile !== "local-single-node") {
  process.stderr.write("release-gate profile must be ci, production, or local-single-node\n");
  process.exit(64);
}
const root = process.cwd();
const checks = [];

checks.push(commandCheck(
  "source-integrity",
  process.execPath,
  ["tools/verify-source.mjs"],
  "Repository source placeholder and basic secret patterns",
));
checks.push(commandCheck(
  "secret-scan",
  process.execPath,
  ["tools/secret-scan.mjs"],
  "Tracked and untracked text source secret-pattern scan",
));
checks.push(commandCheck(
  "git-diff-check",
  "git",
  ["diff", "--check"],
  "Whitespace/error check for the current working tree",
));
checks.push({
  id: "node-runtime",
  status: Number(process.versions.node.split(".")[0]) >= 26 ? "PASS" : "FAIL",
  evidence: `node ${process.versions.node}`,
});

if (args.get("run-audit") === "true") {
  checks.push(commandCheck(
    "production-dependency-audit",
    "pnpm",
    ["audit", "--prod", "--audit-level", "high", "--registry=https://registry.npmjs.org"],
    "pnpm production audit against the official npm registry",
  ));
} else {
  checks.push({
    id: "production-dependency-audit",
    status: "NOT_RUN",
    evidence: "Run with --run-audit; the official registry is required because mirrors may omit audit endpoints",
  });
}

if (profile !== "production" && args.get("run-backup") === "true") {
  checks.push(commandCheck(
    "sqlite-backup-restore-drill",
    process.execPath,
    ["tools/backup-drill.mjs"],
    "Real online SQLite backup, independent integrity/hash-chain verification, and restore probe",
  ));
} else if (profile !== "production") {
  checks.push({ id: "sqlite-backup-restore-drill", status: "NOT_RUN", evidence: "Run with --run-backup after core build" });
}

for (const [id, executable] of [
  ["semgrep-static-analysis", "semgrep"],
  ["trivy-container-scan", "trivy"],
  ["grype-image-scan", "grype"],
  ["syft-sbom", "syft"],
  ["osv-scanner", "osv-scanner"],
  ["gitleaks-scan", "gitleaks"],
]) {
  const available = spawnSync(executable, ["--version"], { cwd: root, encoding: "utf8", timeout: 5_000 }).status === 0;
  checks.push({
    id,
    status: "NOT_RUN",
    evidence: available
      ? `${executable} is available but this gate did not execute a configured scan`
      : `${executable} is unavailable in the current environment`,
  });
}

let b127Certification;
let deploymentCertification;
if (profile === "production") {
  addProductionChecks();
  checks.push(commandCheck(
    "git-worktree-clean",
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    "Release source tree has no tracked or untracked changes",
    { requireEmptyStdout: true, failureStatus: "BLOCKED" },
  ));
  b127Certification = b127CertificationCheck();
  checks.push(b127Certification.check);
  deploymentCertification = deploymentCertificationCheck(b127Certification.result);
  checks.push(deploymentCertification.check);
  applyDeploymentEvidence(deploymentCertification.result);
}
if (profile === "local-single-node") addSingleNodeChecks();

addExternalApprovalChecks(b127Certification?.result);

const failed = checks.some((check) => check.status === "FAIL");
const productionReleaseApproved = isProductionReleaseApproved(profile, checks);
const manifest = {
  schemaVersion: "ltm.release-gate.v1",
  generatedAt: new Date().toISOString(),
  profile,
  commit: commandOutput("git", ["rev-parse", "HEAD"]) ?? "UNKNOWN",
  outcome: releaseGateOutcome(profile, checks),
  productionReleaseApproved,
  checks,
  limitations: [
    "The gate revalidates supplied signed approval evidence but does not itself perform legal review, store review, manual accessibility testing, or penetration testing.",
    "SQLite backup evidence covers only the local single-node runtime.",
  ],
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
const output = args.get("output");
if (output !== undefined && output !== "true") {
  const outputPath = resolve(root, output);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, serialized, { mode: 0o600 });
}
process.stdout.write(serialized);
if (failed) process.exitCode = 1;
else if (profile === "production" && !productionReleaseApproved) process.exitCode = 2;

function addProductionChecks() {
  const deploymentProfile = process.env.LTM_DEPLOYMENT_PROFILE ?? "distributed";
  const singleNodeAccepted = deploymentProfile === "single-node" && process.env.LTM_ALLOW_SINGLE_NODE_SQLITE === "true";
  const postgresRuntimeImplemented = existsSync(resolve(root, "packages/core/src/postgres-runtime.ts"));
  const postgresConfigured = productionPostgresConfigurationComplete();
  checks.push({
    id: "production-persistence",
    status: singleNodeAccepted ? "PASS_LIMITED" : postgresRuntimeImplemented && postgresConfigured ? "PASS_CONFIG_ONLY" : "BLOCKED",
    evidence: singleNodeAccepted
      ? "Explicit single-node SQLite exception accepted; no HA, multi-region, or PostgreSQL claim"
      : postgresRuntimeImplemented && postgresConfigured
        ? "PostgreSQL runtime and tenant-scoped transaction adapter are implemented and DATABASE_URL is configured; deployed connectivity/migration evidence is not present"
        : postgresRuntimeImplemented
          ? "PostgreSQL runtime and tenant-scoped transaction adapter are implemented; production DATABASE_URL and deployed connectivity evidence are required"
          : "PostgreSQL migrations exist but an executable production runtime adapter is not available",
  });
  const oidcConfigured = process.env.LTM_AUTH_MODE === "oidc" &&
    httpsUrl(process.env.LTM_OIDC_ISSUER) &&
    httpsUrl(process.env.LTM_OIDC_JWKS_URL) &&
    configured("LTM_OIDC_AUDIENCE");
  checks.push({
    id: "enterprise-authentication",
    status: oidcConfigured ? "PASS_CONFIG_ONLY" : "BLOCKED",
    evidence: oidcConfigured
      ? "OIDC JWT/JWKS verification is executable and HTTPS issuer, audience, and JWKS configuration are present; deployed issuer reachability and token exchange remain unverified"
      : "OIDC JWT/JWKS verification is implemented; production requires LTM_AUTH_MODE=oidc plus HTTPS issuer/JWKS and audience configuration",
  });
  const redisConfigured = secureRedisUrl(process.env.LTM_REDIS_URL ?? process.env.REDIS_URL);
  checks.push({
    id: "distributed-coordination",
    status: redisConfigured ? "PASS_CONFIG_ONLY" : "BLOCKED",
    evidence: redisConfigured
      ? "Redis-backed callback leases, replay state, and exact-envelope retries are implemented and a TLS Redis endpoint is configured; deployed reachability and HA evidence are not present"
      : "The Redis callback coordination adapter is implemented; production requires a TLS LTM_REDIS_URL and deployed reachability/HA evidence",
  });
  const objectStorageConfigured = configured("LTM_EVIDENCE_S3_BUCKET") && configured("LTM_EVIDENCE_S3_KMS_KEY_ID");
  checks.push({
    id: "durable-object-storage",
    status: objectStorageConfigured ? "PASS_CONFIG_ONLY" : "BLOCKED",
    evidence: objectStorageConfigured
      ? "S3 evidence storage with KMS encryption, SHA-256 confirmation, retention, and Object Lock is implemented and configured; live bucket policy/write evidence is not present"
      : "S3/KMS/Object-Lock evidence storage is implemented; production LTM_EVIDENCE_S3_BUCKET and LTM_EVIDENCE_S3_KMS_KEY_ID configuration are required",
  });
  const workerConfigured = productionWorkerConfigurationComplete();
  checks.push({
    id: "background-workers",
    status: workerConfigured ? "PASS_CONFIG_ONLY" : "BLOCKED",
    evidence: workerConfigured
      ? "Durable leased outbox worker and signed provider command publishers are executable and configured; an independently observed worker deployment is still required"
      : "Durable leased outbox worker and signed provider command publishers are implemented; external mode, tenant, command, and route adapter configuration are required",
  });
  checks.push({
    id: "external-provider-mode",
    status: process.env.LTM_PROVIDER_MODE === "external-verified" ? "BLOCKED_EXTERNAL" : "BLOCKED",
    evidence: process.env.LTM_PROVIDER_MODE === "external-verified"
      ? "Provider mode is declared; live provider credentials/callback evidence were not exercised by this gate"
      : "LTM_PROVIDER_MODE=external-verified is required; local/synthetic providers cannot certify production",
  });
  checks.push({
    id: "tls-and-proxy",
    status: /^https:\/\//.test(process.env.LTM_PUBLIC_BASE_URL ?? "") && process.env.LTM_TRUST_PROXY === "true"
      ? "PASS_CONFIG_ONLY"
      : "BLOCKED",
    evidence: "Requires HTTPS public base URL, trusted-proxy configuration, and separate deployed endpoint verification",
  });
  const managedSecretsConfigured = productionManagedSecretReferencesComplete();
  checks.push({
    id: "managed-secret-references",
    status: managedSecretsConfigured ? "PASS_CONFIG_ONLY" : "BLOCKED",
    evidence: managedSecretsConfigured
      ? "Every enabled gateway integration uses concrete secret-manager references and a projected workload token path; deployed workload identity and live secret access are not verified"
      : "AWS Secrets Manager resolution is implemented; production must configure the gateway signing/verification references, enabled-provider references, and a projected workload token file",
  });
  checks.push({
    id: "database-url-contract",
    status: postgresRuntimeImplemented && postgresConfigured ? "PASS_CONFIG_ONLY" : "BLOCKED",
    evidence: postgresRuntimeImplemented && postgresConfigured
      ? "PostgreSQL runtime is implemented and a URL contract is present; signed deployment evidence must prove connectivity and migrations"
      : "A PostgreSQL DATABASE_URL is required for the distributed production profile",
  });
  checks.push({
    id: "runtime-policy-authority",
    status: "BLOCKED_EXTERNAL",
    evidence: "Signed deployment evidence must prove the production API consent catalog and authenticated media-broker authority projection over HTTPS workload identity, bound to all three release policy digests",
  });
  checks.push({
    id: "production-backup-restore-drill",
    status: "BLOCKED_EXTERNAL",
    evidence: "A signed restore drill against the production persistence backend is required",
  });
}

function b127CertificationCheck() {
  const arguments_ = [
    "tools/b127-certifier.mjs",
    `--root=${root}`,
    "--profile=production",
    "--source=postgresql",
  ];
  const forwarded = [
    ["b127-postgres-url", "postgres-url"],
    ["release-manifest", "manifest"],
    ["trusted-evidence-keys", "trusted-keys"],
    ["release-tenant", "tenant"],
    ["release-launch-id", "launch-id"],
  ];
  for (const [gateName, certifierName] of forwarded) {
    const value = args.get(gateName);
    if (value !== undefined && value !== "true") arguments_.push(`--${certifierName}=${value}`);
  }
  const commit = commandOutput("git", ["rev-parse", "HEAD"]);
  if (commit !== undefined) arguments_.push(`--expected-commit=${commit}`);
  const result = spawnSync(process.execPath, arguments_, { cwd: root, encoding: "utf8", timeout: 60_000 });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      result: undefined,
      check: {
        id: "b127-production-certification",
        status: "FAIL",
        evidence: `B127 verifier returned an invalid result (exit ${result.status ?? "without status"})`,
      },
    };
  }
  const parsedStatus = ["PASS", "FAIL", "BLOCKED_EXTERNAL"].includes(parsed.status) ? parsed.status : "FAIL";
  const sourceProvesProduction = parsed.dataSource?.kind === "postgresql" &&
    parsed.dataSource?.tls === true &&
    parsed.dataSource?.transactionReadOnly === true &&
    parsed.dataSource?.tenantRls === "forced-and-observed" &&
    parsed.dataSource?.privileges === "select-only";
  const status = parsedStatus === "PASS" && !sourceProvesProduction ? "FAIL" : parsedStatus;
  return {
    result: parsed,
    check: {
      id: "b127-production-certification",
      status,
      evidence: status === "PASS"
        ? `B127 ${parsed.recordId} reverified from live PostgreSQL/FORCE-RLS using ${parsed.dataSource?.privileges ?? "unknown privileges"}: ${parsed.evidence?.count ?? 0} consumed production Ed25519 envelopes, manifest/SBOM/approval artifact digests, commit, and required approvals`
        : parsedStatus === "PASS" && !sourceProvesProduction
          ? "B127_SOURCE_PROOF_INVALID: production certification did not prove live TLS PostgreSQL, read-only transaction, FORCE RLS, and SELECT-only privileges"
          : `${parsed.code ?? "B127_CERTIFICATION_FAILED"}: ${parsed.evidence ?? "B127 certification was not proven"}`,
    },
  };
}

function deploymentCertificationCheck(b127Result) {
  if (b127Result?.status !== "PASS") {
    return {
      result: undefined,
      check: {
        id: "production-deployment-evidence",
        status: "BLOCKED_EXTERNAL",
        evidence: "Passing B127 certification is required before deployment evidence can be bound to the release",
      },
    };
  }
  const evidencePath = configuredArgument("deployment-evidence", "LTM_DEPLOYMENT_EVIDENCE_PATH");
  const trustedKeysPath = configuredArgument("trusted-evidence-keys", "LTM_TRUSTED_EVIDENCE_KEYS_FILE");
  const result = certifyProductionDeployment({
    root,
    evidencePath,
    trustedKeysPath,
    tenantId: b127Result.tenantId,
    launchId: b127Result.launchId,
    expectedCommit: b127Result.commit,
    releaseManifestSha256: b127Result.manifest?.sha256,
    expectedMediaAuthorityArtifactSha256: b127Result.policyAuthority?.mediaAuthorityArtifact?.sha256,
    expectedTargetBaseUrl: configured("LTM_PUBLIC_BASE_URL") ? process.env.LTM_PUBLIC_BASE_URL : undefined,
    expectedReleaseSubject: b127Result.releaseSubject,
  });
  return {
    result,
    check: {
      id: "production-deployment-evidence",
      status: result.status,
      evidence: result.status === "PASS"
        ? `Signed deployment ${result.deploymentId} reverified ${Object.keys(result.checks ?? {}).length} exact report artifacts for ${result.targetBaseUrl}`
        : `${result.code ?? "DEPLOYMENT_EVIDENCE_FAILED"}: ${result.evidence ?? "Deployment evidence was not proven"}`,
    },
  };
}

function applyDeploymentEvidence(result) {
  if (result?.status !== "PASS") return;
  for (const checkId of REQUIRED_DEPLOYMENT_CHECKS) {
    const check = checks.find((candidate) => candidate.id === checkId);
    const proof = result.checks?.[checkId];
    if (check === undefined || proof?.status !== "PASS") continue;
    check.status = "PASS";
    check.evidence = `Signed deployment evidence ${result.deploymentId}; observed ${proof.observedAt}; artifact SHA-256 ${proof.artifact.sha256}`;
  }
}

function addExternalApprovalChecks(certification) {
  const approved = certification?.status === "PASS";
  const approvalNames = new Set(Object.keys(certification?.approvals ?? {}));
  const definitions = [
    ["external-penetration-test", ["independentPenetrationTest"], "independent penetration test"],
    ["legal-regulatory-approval", ["legalRegulatoryReview"], "legal/regulatory review"],
    ["manual-accessibility-approval", ["manualAccessibilityReview"], "manual accessibility review"],
    ["app-store-and-marketplace-approval", ["appleAppStoreDecision", "googlePlayDecision", "wechatMiniProgramDecision"], "Apple, Google, and WeChat store decisions"],
    ["disaster-recovery-drill-approval", ["disasterRecoveryDrill"], "disaster recovery drill"],
    ["production-change-approval", ["productionChangeApproval"], "production change approval"],
  ];
  for (const [id, required, label] of definitions) {
    const present = approved && required.every((name) => approvalNames.has(name));
    checks.push({
      id,
      status: present ? "PASS" : "BLOCKED_EXTERNAL",
      evidence: present
        ? `Validated by the signed, digest-bound B127 production manifest: ${label}`
        : `No passing B127 certification currently proves ${label}`,
    });
  }
}

function addSingleNodeChecks() {
  checks.push({
    id: "deployment-scope",
    status: "PASS_LIMITED",
    evidence: "Local single-node scope only; no multi-region, HA, external provider, or enterprise identity claim",
  });
}

function configured(name) {
  return (process.env[name]?.trim().length ?? 0) > 0;
}

function configuredArgument(argumentName, environmentName) {
  const value = args.get(argumentName);
  if (value !== undefined && value !== "true") return value;
  return process.env[environmentName];
}

function httpsUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function secureRedisUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "rediss:" && url.hostname.length > 0 && url.hash.length === 0;
  } catch {
    return false;
  }
}

function productionManagedSecretReferencesComplete() {
  const baseReferences = [
    "LTM_EVIDENCE_PRIVATE_KEY_REFERENCE",
    "LTM_COMMERCE_BINDING_SIGNING_KEY_REFERENCE",
    "LTM_COMMERCE_BINDING_RESPONSE_KEY_REFERENCE",
  ];
  if (!baseReferences.every((name) => managedSecretReference(process.env[name]))) return false;
  if (!(process.env.LTM_API_BEARER_TOKEN_FILE ?? "").startsWith("/")) return false;
  if (process.env.LTM_APPLE_CALLBACKS_ENABLED === "true") {
    const references = (process.env.LTM_APPLE_ROOT_CERTIFICATE_REFERENCES ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    if (references.length === 0 || !references.every(managedSecretReference)) return false;
  }
  if (process.env.LTM_GOOGLE_AUTH_MODE === "managed-service-account" && !managedSecretReference(process.env.LTM_GOOGLE_SERVICE_ACCOUNT_REFERENCE)) {
    return false;
  }
  if (process.env.LTM_WECHAT_CALLBACKS_ENABLED === "true" && ![
    process.env.LTM_WECHAT_API_V3_KEY_REFERENCE,
    process.env.LTM_WECHAT_PLATFORM_KEY_MAP_REFERENCE,
  ].every(managedSecretReference)) return false;
  if (configured("LTM_PARTNER_WEBHOOK_POLICIES_REFERENCE") && !managedSecretReference(process.env.LTM_PARTNER_WEBHOOK_POLICIES_REFERENCE)) {
    return false;
  }
  return true;
}

function managedSecretReference(value) {
  return typeof value === "string" && /^secret-manager:[^\s]+$/.test(value);
}

function productionWorkerConfigurationComplete() {
  if (
    process.env.LTM_WORKER_MODE !== "external" ||
    !configured("LTM_WORKER_TENANT_ID") ||
    !/^[a-f0-9]{64}$/.test(process.env.LTM_METRICS_TOKEN_SHA256 ?? "") ||
    !productionWorkerDatabaseConfigurationComplete()
  ) return false;
  return adapterConfigurationIncludes(
    process.env.LTM_EXTERNAL_COMMAND_ADAPTERS_JSON,
    ["B05", "B10", "B13", "B14", "B16", "B23", "B26", "B29", "B36", "B38", "B40", "B65", "B67", "B74", "B83", "B89", "B98", "B101"],
  ) && adapterConfigurationIncludes(
    process.env.LTM_OUTBOX_ROUTE_ADAPTERS_JSON,
    ["media", "notification", "fulfillment", "integration", "data"],
  );
}

function productionWorkerDatabaseConfigurationComplete() {
  const deploymentProfile = process.env.LTM_DEPLOYMENT_PROFILE ?? "distributed";
  if (deploymentProfile === "distributed") {
    return !configured("LTM_DATABASE_PATH") && productionPostgresConfigurationComplete();
  }
  return deploymentProfile === "single-node" &&
    process.env.LTM_ALLOW_SINGLE_NODE_SQLITE === "true" &&
    process.env.LTM_DATABASE_PATH !== ":memory:";
}

function productionPostgresConfigurationComplete() {
  const value = process.env.DATABASE_URL;
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.username.length > 0 &&
      url.hostname.length > 0 &&
      url.pathname.length > 1 &&
      url.hash.length === 0 &&
      url.searchParams.get("sslmode") === "verify-full";
  } catch {
    return false;
  }
}

function adapterConfigurationIncludes(serialized, requiredKeys) {
  if (typeof serialized !== "string" || serialized.trim() === "") return false;
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return requiredKeys.every((key) => {
    const adapter = parsed[key];
    return adapter !== null && typeof adapter === "object" && !Array.isArray(adapter) &&
      httpsUrl(adapter.endpoint) &&
      typeof adapter.signingSecretReference === "string" &&
      adapter.signingSecretReference.startsWith("secret-manager:") &&
      adapter.signingSecretReference.length > "secret-manager:".length &&
      typeof adapter.responseVerificationKeyReference === "string" &&
      adapter.responseVerificationKeyReference.startsWith("secret-manager:") &&
      adapter.responseVerificationKeyReference.length > "secret-manager:".length &&
      ["hmac-sha256", "ed25519", "es256"].includes(adapter.responseSignatureScheme) &&
      (adapter.responseMaximumClockSkewSeconds === undefined ||
        (Number.isSafeInteger(adapter.responseMaximumClockSkewSeconds) &&
          adapter.responseMaximumClockSkewSeconds >= 30 &&
          adapter.responseMaximumClockSkewSeconds <= 900));
  });
}

function commandCheck(id, command, arguments_, evidence, options = {}) {
  const result = spawnSync(command, arguments_, { cwd: root, encoding: "utf8", timeout: 180_000 });
  const successful = result.status === 0 && (!options.requireEmptyStdout || result.stdout.trim() === "");
  return {
    id,
    status: successful ? "PASS" : options.failureStatus ?? "FAIL",
    evidence: successful
      ? evidence
      : options.requireEmptyStdout && result.status === 0
        ? `${evidence}; command reported working-tree changes`
        : `${evidence}; command exited ${result.status ?? "without status"}`,
  };
}

function commandOutput(command, arguments_) {
  const result = spawnSync(command, arguments_, { cwd: root, encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
