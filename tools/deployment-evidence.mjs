import { createHash, verify as verifySignature } from "node:crypto";
import { resolve } from "node:path";
import {
  CertificationError,
  canonicalJson,
  loadTrustedKeys,
  readRootRelativeFile,
  readStableFile,
  scopeAllowed,
  sha256Bytes,
} from "./b127-certifier.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_EVIDENCE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

export const REQUIRED_DEPLOYMENT_CHECKS = Object.freeze([
  "production-dependency-audit",
  "production-backup-restore-drill",
  "semgrep-static-analysis",
  "trivy-container-scan",
  "grype-image-scan",
  "syft-sbom",
  "osv-scanner",
  "gitleaks-scan",
  "production-persistence",
  "enterprise-authentication",
  "distributed-coordination",
  "durable-object-storage",
  "background-workers",
  "external-provider-mode",
  "tls-and-proxy",
  "managed-secret-references",
  "database-url-contract",
]);

export function verifyProductionDeploymentEvidence(options) {
  const root = resolve(options.root ?? process.cwd());
  const now = validDate(options.now ?? new Date());
  const tenantId = identifier(options.tenantId, "tenantId");
  const launchId = identifier(options.launchId, "launchId");
  const expectedCommit = exactCommit(options.expectedCommit, "expectedCommit");
  const releaseManifestSha256 = exactSha256(options.releaseManifestSha256, "releaseManifestSha256");
  if (typeof options.evidencePath !== "string" || options.evidencePath.trim() === "") {
    throw blocked("DEPLOYMENT_EVIDENCE_REQUIRED", "Signed production deployment evidence is required");
  }
  const evidenceFile = readStableFile(resolve(options.evidencePath), "deployment evidence", MAX_EVIDENCE_BYTES);
  const document = parseObject(evidenceFile.bytes.toString("utf8"), "deployment evidence");
  const signature = text(document.signature, "deployment evidence signature", 256);
  const unsigned = { ...document };
  delete unsigned.signature;

  if (document.schemaVersion !== "ltm.production-deployment-evidence.v1") {
    throw new CertificationError("DEPLOYMENT_EVIDENCE_SCHEMA_INVALID", "Deployment evidence schemaVersion is unsupported");
  }
  if (document.environment !== "production") {
    throw new CertificationError("DEPLOYMENT_EVIDENCE_SCOPE_INVALID", "Deployment evidence must be production scoped");
  }
  if (document.tenantId !== tenantId || document.launchId !== launchId) {
    throw new CertificationError("DEPLOYMENT_EVIDENCE_IDENTITY_MISMATCH", "Deployment evidence tenant or launch ID does not match B127");
  }
  if (exactCommit(document.commit, "deployment evidence commit") !== expectedCommit) {
    throw new CertificationError("DEPLOYMENT_EVIDENCE_COMMIT_MISMATCH", "Deployment evidence commit does not match B127 and the checked-out release");
  }
  if (exactSha256(document.releaseManifestSha256, "deployment evidence releaseManifestSha256") !== releaseManifestSha256) {
    throw new CertificationError("DEPLOYMENT_EVIDENCE_MANIFEST_MISMATCH", "Deployment evidence is not bound to the verified B127 manifest");
  }
  const deploymentId = identifier(document.deploymentId, "deploymentId");
  const issuer = identifier(document.issuer, "deployment evidence issuer");
  const provider = identifier(document.provider, "deployment evidence provider");
  const keyId = identifier(document.keyId, "deployment evidence keyId");
  if (!provider.startsWith("deployment-assurance:")) {
    throw new CertificationError("DEPLOYMENT_EVIDENCE_PROVIDER_INVALID", "Deployment evidence must use a deployment-assurance provider identity");
  }
  if (/^(?:test|sandbox)(?:[:._-]|$)/i.test(issuer) || /^(?:test|sandbox)(?:[:._-]|$)/i.test(provider)) {
    throw new CertificationError("TEST_DEPLOYMENT_EVIDENCE", "Production deployment evidence cannot use a test or sandbox identity");
  }
  if (document.algorithm !== "Ed25519") {
    throw new CertificationError("DEPLOYMENT_EVIDENCE_ALGORITHM_INVALID", "Deployment evidence must use Ed25519");
  }
  const targetBaseUrl = httpsUrl(document.targetBaseUrl, "deployment targetBaseUrl").toString();
  if (options.expectedTargetBaseUrl !== undefined && targetBaseUrl !== httpsUrl(options.expectedTargetBaseUrl, "expected targetBaseUrl").toString()) {
    throw new CertificationError("DEPLOYMENT_TARGET_MISMATCH", "Deployment evidence target does not match LTM_PUBLIC_BASE_URL");
  }
  const issuedAt = canonicalTimestamp(document.issuedAt, "deployment evidence issuedAt");
  const expiresAt = canonicalTimestamp(document.expiresAt, "deployment evidence expiresAt");
  if (
    issuedAt.getTime() > now.getTime() + CLOCK_SKEW_MS ||
    expiresAt.getTime() <= now.getTime() ||
    expiresAt <= issuedAt ||
    expiresAt.getTime() - issuedAt.getTime() > MAX_EVIDENCE_LIFETIME_MS
  ) {
    throw blocked("DEPLOYMENT_EVIDENCE_EXPIRED", "Deployment evidence is expired or outside its allowed validity window");
  }
  const expectedScope = deploymentEvidenceScope({
    tenantId,
    launchId,
    deploymentId,
    provider,
    commit: expectedCommit,
    releaseManifestSha256,
    targetBaseUrl,
  });
  if (document.scope !== expectedScope) {
    throw new CertificationError("DEPLOYMENT_EVIDENCE_SCOPE_MISMATCH", "Deployment evidence scope is not bound to this exact release and target");
  }

  const keys = loadTrustedKeys(options.trustedKeysPath, now);
  const key = keys.find((candidate) =>
    candidate.issuer === issuer && candidate.provider === provider && candidate.keyId === keyId,
  );
  if (key === undefined) {
    throw blocked("DEPLOYMENT_TRUST_KEY_MISSING", "No trusted key is configured for the deployment assurance issuer");
  }
  if (!key.allowedEnvironments.includes("production") || !scopeAllowed(key.allowedScopes, expectedScope)) {
    throw new CertificationError("DEPLOYMENT_TRUST_POLICY_MISMATCH", "Deployment assurance key policy does not permit this release scope");
  }
  if (
    (key.notBefore !== undefined && document.issuedAt < key.notBefore) ||
    (key.notAfter !== undefined && (document.issuedAt > key.notAfter || document.expiresAt > key.notAfter))
  ) {
    throw new CertificationError("DEPLOYMENT_TRUST_WINDOW_MISMATCH", "Deployment evidence is outside its trusted key validity window");
  }
  if (!validBase64Url(signature) || !verifySignature(
    null,
    Buffer.from(canonicalJson(unsigned), "utf8"),
    key.publicKey,
    Buffer.from(signature, "base64url"),
  )) {
    throw new CertificationError("DEPLOYMENT_EVIDENCE_SIGNATURE_INVALID", "Deployment evidence failed Ed25519 signature verification");
  }

  const checks = plainObject(document.checks, "deployment evidence checks");
  const artifacts = new Set();
  const verifiedChecks = {};
  for (const checkId of REQUIRED_DEPLOYMENT_CHECKS) {
    if (!(checkId in checks)) {
      throw blocked("DEPLOYMENT_CHECK_MISSING", `Deployment evidence is missing ${checkId}`);
    }
    const check = plainObject(checks[checkId], `deployment check ${checkId}`);
    if (check.status !== "passed") {
      throw blocked("DEPLOYMENT_CHECK_NOT_PASSED", `Deployment check ${checkId} is not passed`);
    }
    const observedAt = canonicalTimestamp(check.observedAt, `${checkId}.observedAt`);
    if (observedAt.getTime() > issuedAt.getTime() || observedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) {
      throw new CertificationError("DEPLOYMENT_CHECK_TIME_INVALID", `Deployment check ${checkId} was observed after its signed evidence was issued`);
    }
    if (issuedAt.getTime() - observedAt.getTime() > MAX_EVIDENCE_LIFETIME_MS) {
      throw blocked("DEPLOYMENT_CHECK_STALE", `Deployment check ${checkId} is older than seven days`);
    }
    const artifact = plainObject(check.artifact, `${checkId}.artifact`);
    const path = relativePath(artifact.path, `${checkId}.artifact.path`);
    const expectedSha256 = exactSha256(artifact.sha256, `${checkId}.artifact.sha256`);
    if (artifacts.has(path)) {
      throw new CertificationError("DEPLOYMENT_ARTIFACT_REUSED", `Deployment check ${checkId} reuses another check's artifact path`);
    }
    artifacts.add(path);
    const artifactFile = readRootRelativeFile(root, path, `${checkId} artifact`, MAX_ARTIFACT_BYTES);
    const actualSha256 = sha256Bytes(artifactFile.bytes);
    if (actualSha256 !== expectedSha256) {
      throw new CertificationError("DEPLOYMENT_ARTIFACT_DIGEST_MISMATCH", `Deployment check ${checkId} artifact digest does not match`);
    }
    verifiedChecks[checkId] = {
      status: "PASS",
      observedAt: observedAt.toISOString(),
      target: text(check.target, `${checkId}.target`, 2_048),
      artifact: { path: artifactFile.path, sha256: actualSha256 },
    };
  }
  return {
    schemaVersion: "ltm.production-deployment-evidence-result.v1",
    status: "PASS",
    verifiedAt: now.toISOString(),
    deploymentId,
    tenantId,
    launchId,
    commit: expectedCommit,
    releaseManifestSha256,
    targetBaseUrl,
    issuer,
    provider,
    keyId,
    scope: expectedScope,
    evidencePath: evidenceFile.path,
    checks: verifiedChecks,
  };
}

export function certifyProductionDeployment(options) {
  try {
    return verifyProductionDeploymentEvidence(options);
  } catch (error) {
    if (error instanceof CertificationError) {
      return {
        schemaVersion: "ltm.production-deployment-evidence-result.v1",
        status: error.status,
        verifiedAt: validDate(options.now ?? new Date()).toISOString(),
        code: error.code,
        evidence: error.message,
      };
    }
    return {
      schemaVersion: "ltm.production-deployment-evidence-result.v1",
      status: "FAIL",
      verifiedAt: new Date().toISOString(),
      code: "UNEXPECTED_DEPLOYMENT_EVIDENCE_ERROR",
      evidence: "Deployment evidence verification failed unexpectedly",
    };
  }
}

export function deploymentEvidenceScope({
  tenantId,
  launchId,
  deploymentId,
  provider,
  commit,
  releaseManifestSha256,
  targetBaseUrl,
}) {
  const fields = [
    "ltm-production-deployment-evidence-v1",
    tenantId,
    launchId,
    deploymentId,
    provider,
    commit,
    releaseManifestSha256,
    targetBaseUrl,
  ];
  const canonical = fields.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return `ltm-deployment:v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

function parseObject(serialized, label) {
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new CertificationError("DEPLOYMENT_JSON_INVALID", `${label} is not valid JSON`);
  }
  return plainObject(parsed, label);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CertificationError("DEPLOYMENT_OBJECT_INVALID", `${label} must be a JSON object`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new CertificationError("DEPLOYMENT_IDENTIFIER_INVALID", `${label} has an invalid format`);
  }
  return value;
}

function exactSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new CertificationError("DEPLOYMENT_SHA256_INVALID", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function exactCommit(value, label) {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new CertificationError("DEPLOYMENT_COMMIT_INVALID", `${label} must be a full lowercase Git object ID`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") throw new CertificationError("DEPLOYMENT_TIMESTAMP_INVALID", `${label} must be a timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new CertificationError("DEPLOYMENT_TIMESTAMP_INVALID", `${label} must be canonical UTC ISO-8601`);
  }
  return parsed;
}

function validDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CertificationError("DEPLOYMENT_CLOCK_INVALID", "Deployment verification clock is invalid");
  }
  return value;
}

function httpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CertificationError("DEPLOYMENT_URL_INVALID", `${label} must be an HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new CertificationError("DEPLOYMENT_URL_INVALID", `${label} must be credential-free HTTPS without a fragment`);
  }
  return url;
}

function relativePath(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > 2_048 || value.includes("\0")) {
    throw new CertificationError("DEPLOYMENT_PATH_INVALID", `${label} must be a non-empty relative path`);
  }
  return value;
}

function text(value, label, maximum) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CertificationError("DEPLOYMENT_TEXT_INVALID", `${label} must contain valid visible text`);
  }
  return value;
}

function validBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{80,100}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").toString("base64url") === value;
  } catch {
    return false;
  }
}

function blocked(code, message) {
  return new CertificationError(code, message, "BLOCKED_EXTERNAL");
}
