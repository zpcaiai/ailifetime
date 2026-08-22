import { createPublicKey, verify } from "node:crypto";
import { canonicalize, sha256 } from "./lib/canonical.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{80,100}$/;
const PRODUCTION_ENVIRONMENT = "production";
const MANDATORY_CAPACITY_SCENARIOS = ["baseline", "peak", "burst", "soak", "dependency_degraded"];

export const UPSTREAM_CONTROL_POLICIES = Object.freeze({
  B119: Object.freeze({
    operation: "approveConfigurationChange",
    kind: "configuration-change-report",
    providerPrefix: "change-control:",
    reportVersion: "ltm.configuration-change-report.v1",
    subjectField: "changeId",
  }),
  B121: Object.freeze({
    operation: "approveCapacityGate",
    kind: "capacity-test-report",
    providerPrefix: "load-test:",
    reportVersion: "ltm.capacity-test-report.v1",
    subjectField: "testRunId",
  }),
  B122: Object.freeze({
    operation: "recordResilienceExercise",
    kind: "resilience-exercise-report",
    providerPrefix: "resilience-auditor:",
    reportVersion: "ltm.resilience-exercise-report.v1",
    subjectField: "exerciseId",
  }),
});

const REQUIRED_BATCHES = Object.freeze(Object.keys(UPSTREAM_CONTROL_POLICIES));
const LEGACY_CLIENT_ASSERTIONS = new Set([
  "driftCheckPassed",
  "paidTasksProtected",
  "tenantFairnessVerified",
  "cancellationPriorityVerified",
  "deletionResurrectionPrevented",
  "duplicateSideEffectsPrevented",
]);

/**
 * Verify the exact signed reports that B119, B121, and B122 bind into their
 * capability scopes. Report conclusion booleans are accepted only inside the
 * externally attested artifact bytes; they are forbidden as bundle assertions.
 */
export function verifyUpstreamControlEvidence(options = {}) {
  if (options.bundle === undefined || options.bundle === null) {
    return blocked("the B119/B121/B122 production evidence bundle was not supplied");
  }
  const bundle = exactObject(options.bundle, "upstream-control evidence bundle", ["version", "tenantId", "environment", "controls"]);
  if (bundle.version !== "ltm.upstream-control-evidence-bundle.v1") throw new Error("unsupported upstream-control evidence bundle version");
  const tenantId = identifier(bundle.tenantId, "bundle.tenantId");
  const requiredEnvironment = options.requiredEnvironment ?? PRODUCTION_ENVIRONMENT;
  if (bundle.environment !== requiredEnvironment) throw new Error("upstream-control bundle environment does not match the release gate");
  if (!Array.isArray(bundle.controls)) throw new Error("bundle.controls must be an array");

  const controls = new Map();
  for (const candidate of bundle.controls) {
    const control = exactObject(candidate, "upstream-control entry", ["batchId", "artifactPath", "evidence"]);
    rejectClientAssertions(control);
    if (typeof control.batchId !== "string" || UPSTREAM_CONTROL_POLICIES[control.batchId] === undefined) {
      throw new Error(`unsupported upstream-control batch ${String(control.batchId)}`);
    }
    if (controls.has(control.batchId)) throw new Error(`duplicate upstream-control evidence for ${control.batchId}`);
    if (typeof control.artifactPath !== "string" || control.artifactPath.trim() === "" || control.artifactPath.includes("\0")) {
      throw new Error(`${control.batchId} artifactPath is invalid`);
    }
    controls.set(control.batchId, control);
  }
  const missing = REQUIRED_BATCHES.filter((batchId) => !controls.has(batchId));
  if (missing.length > 0) return blocked(`missing required signed operational reports: ${missing.join(", ")}`);
  if (controls.size !== REQUIRED_BATCHES.length) throw new Error("upstream-control bundle contains an unexpected control report");

  const trustStore = options.trustStore;
  if (trustStore === undefined || trustStore === null) return blocked("the production upstream-control trust store was not supplied");
  const trustedKeys = validateTrustStore(trustStore);
  if (trustedKeys.length === 0) return blocked("no production upstream-control issuer keys are enrolled");
  if (typeof options.artifactResolver !== "function") return blocked("signed operational report artifact bytes were not supplied");

  const now = Date.parse(timestamp(options.now ?? new Date().toISOString(), "verification time"));
  const verified = [];
  const evidenceIds = new Set();
  const artifactDigests = new Set();
  for (const batchId of REQUIRED_BATCHES) {
    const control = controls.get(batchId);
    let artifact;
    try {
      artifact = options.artifactResolver(control.artifactPath, batchId);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return blocked(`the ${batchId} signed report artifact is unavailable`);
      }
      throw error;
    }
    if (!(artifact instanceof Uint8Array)) return blocked(`the ${batchId} signed report artifact is unavailable`);
    const artifactSha256 = sha256(artifact);
    const evidence = exactObject(control.evidence, `${batchId} evidence envelope`, [
      "version", "evidenceId", "tenantId", "binding", "scope", "issuer", "provider", "artifactSha256",
      "canonicalClaimsSha256?", "businessEventSha256?", "issuedAt", "expiresAt", "nonce", "replayPolicy",
      "algorithm", "keyId", "signature",
    ]);
    if (evidenceIds.has(evidence.evidenceId)) throw new Error("upstream-control evidence IDs must be unique");
    evidenceIds.add(evidence.evidenceId);
    if (artifactDigests.has(artifactSha256)) throw new Error("each upstream control requires a distinct report artifact");
    artifactDigests.add(artifactSha256);

    const policy = UPSTREAM_CONTROL_POLICIES[batchId];
    const report = parseOperationalReport(batchId, artifact);
    try {
      verifyBoundEvidence({
        evidence,
        policy,
        batchId,
        tenantId,
        requiredEnvironment,
        artifactSha256,
        report,
        trustedKeys,
        now,
      });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "BLOCKED_EXTERNAL") return blocked(error.message);
      throw error;
    }
    verified.push({
      batchId,
      operation: policy.operation,
      kind: policy.kind,
      subjectId: report[policy.subjectField],
      provider: evidence.provider,
      evidenceId: evidence.evidenceId,
      artifactSha256,
      scope: evidence.scope,
    });
  }
  return {
    status: "PASS",
    gate: "upstream-production-controls",
    tenantId,
    environment: requiredEnvironment,
    controls: verified,
    external: true,
  };
}

export function capabilityEvidenceScope(binding) {
  const values = [
    "ltm-capability-evidence-v1",
    binding.tenantId,
    binding.batchId,
    binding.operation,
    binding.kind,
    binding.provider,
    binding.artifactSha256,
    binding.environment,
    binding.subjectId,
  ];
  if (values.some((value) => typeof value !== "string")) throw new Error("capability evidence binding values must be strings");
  const canonical = values.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return `ltm-evidence:v1:${sha256(Buffer.from(canonical, "utf8"))}`;
}

export function externalEvidenceSigningPayload(evidence) {
  return Buffer.from(canonicalize({
    version: evidence.version,
    evidenceId: evidence.evidenceId,
    tenantId: evidence.tenantId,
    issuer: evidence.issuer,
    provider: evidence.provider,
    environment: evidence.binding.environment,
    scope: evidence.scope,
    artifactSha256: evidence.artifactSha256,
    ...(evidence.canonicalClaimsSha256 === undefined ? {} : { canonicalClaimsSha256: evidence.canonicalClaimsSha256 }),
    ...(evidence.businessEventSha256 === undefined ? {} : { businessEventSha256: evidence.businessEventSha256 }),
    issuedAt: evidence.issuedAt,
    expiresAt: evidence.expiresAt,
    nonce: evidence.nonce,
    replayPolicy: evidence.replayPolicy,
    algorithm: evidence.algorithm,
    keyId: evidence.keyId,
  }), "utf8");
}

function verifyBoundEvidence(input) {
  const { evidence, policy, batchId, tenantId, requiredEnvironment, artifactSha256, report, trustedKeys, now } = input;
  if (evidence.version !== "ltm.external-evidence.v1" || evidence.algorithm !== "Ed25519") throw new Error(`${batchId} evidence version or algorithm is unsupported`);
  identifier(evidence.evidenceId, `${batchId} evidenceId`);
  identifier(evidence.issuer, `${batchId} issuer`);
  identifier(evidence.keyId, `${batchId} keyId`);
  identifier(evidence.nonce, `${batchId} nonce`);
  if (isTestIssuer(evidence.issuer) && requiredEnvironment === PRODUCTION_ENVIRONMENT) throw new Error(`${batchId} production evidence cannot use a test issuer`);
  const binding = exactObject(evidence.binding, `${batchId} evidence binding`, [
    "tenantId", "batchId", "operation", "kind", "provider", "artifactSha256", "environment", "subjectId",
  ]);
  const expectedSubject = report[policy.subjectField];
  const provider = identifier(binding.provider, `${batchId} binding.provider`);
  if (!provider.startsWith(policy.providerPrefix) || provider.length === policy.providerPrefix.length) throw new Error(`${batchId} provider is outside the required authority type`);
  const expected = {
    tenantId,
    batchId,
    operation: policy.operation,
    kind: policy.kind,
    provider,
    artifactSha256,
    environment: requiredEnvironment,
    subjectId: expectedSubject,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (binding[field] !== value) throw new Error(`${batchId} evidence binding ${field} does not match the exact production report`);
  }
  const expectedScope = capabilityEvidenceScope(expected);
  if (evidence.scope !== expectedScope) throw new Error(`${batchId} evidence scope does not match its exact binding`);
  if (evidence.tenantId !== tenantId || evidence.provider !== provider || evidence.artifactSha256 !== artifactSha256) {
    throw new Error(`${batchId} evidence envelope is inconsistent with its binding`);
  }
  if ((evidence.canonicalClaimsSha256 === undefined) !== (evidence.businessEventSha256 === undefined)) {
    throw new Error(`${batchId} business evidence digests must be supplied together`);
  }
  if (evidence.canonicalClaimsSha256 !== undefined) digest(evidence.canonicalClaimsSha256, `${batchId} canonicalClaimsSha256`);
  if (evidence.businessEventSha256 !== undefined) digest(evidence.businessEventSha256, `${batchId} businessEventSha256`);
  if (evidence.replayPolicy !== "reusable" && evidence.replayPolicy !== "single_use") throw new Error(`${batchId} evidence replay policy is invalid`);
  const issuedAt = Date.parse(timestamp(evidence.issuedAt, `${batchId} issuedAt`));
  const expiresAt = Date.parse(timestamp(evidence.expiresAt, `${batchId} expiresAt`));
  if (issuedAt > now || expiresAt <= now || expiresAt <= issuedAt) throw new Error(`${batchId} evidence is not currently valid`);

  const key = trustedKeys.find((candidate) => candidate.issuer === evidence.issuer && candidate.provider === evidence.provider && candidate.keyId === evidence.keyId);
  if (key === undefined) throw blockedError(`${batchId} issuer/provider key is not enrolled for production evidence`);
  if (!key.allowedEnvironments.includes(requiredEnvironment) || !scopeAllowed(key.allowedScopes, expectedScope)) {
    throw new Error(`${batchId} trust policy does not authorize the exact environment and scope`);
  }
  if (key.notBefore !== undefined && evidence.issuedAt < key.notBefore) throw new Error(`${batchId} evidence predates the trusted key window`);
  if (key.notAfter !== undefined && (evidence.issuedAt > key.notAfter || evidence.expiresAt > key.notAfter)) throw new Error(`${batchId} evidence exceeds the trusted key window`);
  if (key.revokedAt !== undefined && now >= Date.parse(key.revokedAt)) throw new Error(`${batchId} evidence key is revoked`);
  if (typeof evidence.signature !== "string" || !SIGNATURE.test(evidence.signature)) throw new Error(`${batchId} evidence signature encoding is invalid`);
  const signature = Buffer.from(evidence.signature, "base64url");
  if (signature.toString("base64url") !== evidence.signature) throw new Error(`${batchId} evidence signature is not canonical base64url`);
  if (!verify(null, externalEvidenceSigningPayload(evidence), key.publicKey, signature)) throw new Error(`${batchId} evidence signature is invalid`);
}

function validateTrustStore(input) {
  const trustStore = exactObject(input, "upstream-control trust store", ["version", "keys"]);
  if (trustStore.version !== "ltm.upstream-control-trust-store.v1") throw new Error("unsupported upstream-control trust-store version");
  if (!Array.isArray(trustStore.keys)) throw new Error("upstream-control trust-store keys must be an array");
  const identities = new Set();
  return trustStore.keys.map((candidate, index) => {
    const key = exactObject(candidate, `trusted key ${index}`, [
      "issuer", "provider", "keyId", "algorithm", "publicKeyPem", "allowedScopes", "allowedEnvironments",
      "notBefore?", "notAfter?", "revokedAt?",
    ]);
    identifier(key.issuer, `trusted key ${index} issuer`);
    identifier(key.provider, `trusted key ${index} provider`);
    identifier(key.keyId, `trusted key ${index} keyId`);
    if (key.algorithm !== "Ed25519") throw new Error("upstream-control trust keys must use Ed25519");
    if (isTestIssuer(key.issuer)) throw new Error("test issuers cannot be enrolled in the production upstream-control trust store");
    if (!Array.isArray(key.allowedScopes) || key.allowedScopes.length === 0 || key.allowedScopes.some((scope) => typeof scope !== "string" || scope.trim() === "" || (scope.includes("*") && !scope.endsWith("*")))) {
      throw new Error("trusted keys require exact scopes or suffix wildcards");
    }
    if (!Array.isArray(key.allowedEnvironments) || key.allowedEnvironments.length === 0 || key.allowedEnvironments.some((environment) => !["test", "sandbox", "staging", "production"].includes(environment))) {
      throw new Error("trusted keys require valid allowed environments");
    }
    if (key.notBefore !== undefined) timestamp(key.notBefore, `trusted key ${index} notBefore`);
    if (key.notAfter !== undefined) timestamp(key.notAfter, `trusted key ${index} notAfter`);
    if (key.revokedAt !== undefined) timestamp(key.revokedAt, `trusted key ${index} revokedAt`);
    if (key.notBefore !== undefined && key.notAfter !== undefined && key.notAfter <= key.notBefore) throw new Error("trusted key validity window is invalid");
    let publicKey;
    try { publicKey = createPublicKey(key.publicKeyPem); } catch { throw new Error(`trusted key ${index} publicKeyPem is invalid`); }
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("upstream-control trust keys must be Ed25519");
    const identity = `${key.issuer}\0${key.provider}\0${key.keyId}`;
    if (identities.has(identity)) throw new Error("duplicate upstream-control trusted key identity");
    identities.add(identity);
    return { ...key, publicKey };
  });
}

function parseOperationalReport(batchId, bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(`${batchId} operational report is not valid UTF-8 JSON`); }
  const policy = UPSTREAM_CONTROL_POLICIES[batchId];
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${batchId} operational report must be a JSON object`);
  if (value.version !== policy.reportVersion) throw new Error(`${batchId} operational report version is unsupported`);
  switch (batchId) {
    case "B119": return configurationChangeReport(value);
    case "B121": return capacityTestReport(value);
    case "B122": return resilienceExerciseReport(value);
    default: throw new Error(`unsupported operational report ${batchId}`);
  }
}

function configurationChangeReport(value) {
  exactFields(value, "B119 configuration change report", [
    "version", "changeId", "targetEnvironment", "schemaVersion", "changedFields", "driftFindingsCount",
    "disabledNonWaivableControls", "rollbackVerified", "violations", "passed",
  ]);
  const report = {
    ...value,
    changeId: boundedString(value.changeId, "B119 changeId", 128),
    schemaVersion: boundedString(value.schemaVersion, "B119 schemaVersion", 128),
    changedFields: stringArray(value.changedFields, "B119 changedFields", 1),
    disabledNonWaivableControls: stringArray(value.disabledNonWaivableControls, "B119 disabledNonWaivableControls"),
    violations: stringArray(value.violations, "B119 violations"),
  };
  if (!["local", "ci", "staging", "production"].includes(value.targetEnvironment)) throw new Error("B119 targetEnvironment is invalid");
  if (value.targetEnvironment !== PRODUCTION_ENVIRONMENT) throw new Error("B119 production gate requires a production configuration report");
  if (!Number.isSafeInteger(value.driftFindingsCount) || value.driftFindingsCount !== 0 || report.disabledNonWaivableControls.length !== 0 || value.rollbackVerified !== true) {
    throw new Error("B119 report has unresolved drift, disables a non-waivable control, or lacks verified rollback");
  }
  assertPassing(value, report.violations, "B119");
  return report;
}

function capacityTestReport(value) {
  exactFields(value, "B121 capacity test report", [
    "version", "testRunId", "scenarios", "observedP95Ms", "maxP95Ms", "observedErrorRate", "maxErrorRate",
    "syntheticDataOnly", "paidTasksProtected", "tenantFairnessVerified", "violations", "passed",
  ]);
  const report = {
    ...value,
    testRunId: boundedString(value.testRunId, "B121 testRunId", 128),
    scenarios: stringArray(value.scenarios, "B121 scenarios", 5),
    violations: stringArray(value.violations, "B121 violations"),
  };
  for (const scenario of MANDATORY_CAPACITY_SCENARIOS) if (!report.scenarios.includes(scenario)) throw new Error(`B121 report is missing ${scenario}`);
  number(value.observedP95Ms, "B121 observedP95Ms", 0);
  number(value.maxP95Ms, "B121 maxP95Ms", 1);
  number(value.observedErrorRate, "B121 observedErrorRate", 0, 1);
  number(value.maxErrorRate, "B121 maxErrorRate", 0, 1);
  if (value.observedP95Ms > value.maxP95Ms || value.observedErrorRate > value.maxErrorRate || value.syntheticDataOnly !== true || value.paidTasksProtected !== true || value.tenantFairnessVerified !== true) {
    throw new Error("B121 report fails capacity, synthetic-data, paid-task, or tenant-fairness policy");
  }
  assertPassing(value, report.violations, "B121");
  return report;
}

function resilienceExerciseReport(value) {
  exactFields(value, "B122 resilience exercise report", [
    "version", "exerciseId", "targetRtoSeconds", "observedRtoSeconds", "targetRpoSeconds", "observedRpoSeconds",
    "failoverRegion", "cancellationPriorityVerified", "deletionResurrectionPrevented", "duplicateSideEffectsPrevented",
    "violations", "passed",
  ]);
  const report = {
    ...value,
    exerciseId: boundedString(value.exerciseId, "B122 exerciseId", 128),
    failoverRegion: boundedString(value.failoverRegion, "B122 failoverRegion", 128),
    violations: stringArray(value.violations, "B122 violations"),
  };
  for (const field of ["targetRtoSeconds", "observedRtoSeconds", "targetRpoSeconds", "observedRpoSeconds"]) number(value[field], `B122 ${field}`, 0);
  if (value.observedRtoSeconds > value.targetRtoSeconds || value.observedRpoSeconds > value.targetRpoSeconds || value.cancellationPriorityVerified !== true || value.deletionResurrectionPrevented !== true || value.duplicateSideEffectsPrevented !== true) {
    throw new Error("B122 report fails RTO/RPO or lifecycle safety policy");
  }
  assertPassing(value, report.violations, "B122");
  return report;
}

function rejectClientAssertions(value) {
  const rejected = Object.keys(value).filter((key) => LEGACY_CLIENT_ASSERTIONS.has(key));
  if (rejected.length > 0) throw new Error(`client boolean self-attestation is forbidden: ${rejected.join(", ")}`);
}

function exactObject(value, label, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const optional = new Set(fields.filter((field) => field.endsWith("?")).map((field) => field.slice(0, -1)));
  const required = fields.filter((field) => !field.endsWith("?"));
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).filter((field) => !allowed.has(field));
  const missing = required.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (extra.length > 0 || missing.length > 0) throw new Error(`${label} does not match its closed contract`);
  return value;
}

function exactFields(value, label, fields) {
  const extra = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (extra.length > 0 || missing.length > 0) throw new Error(`${label} does not match its closed schema`);
}

function stringArray(value, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 256 || value.some((item) => typeof item !== "string" || item.trim() === "" || item.length > 256) || new Set(value).size !== value.length) {
    throw new Error(`${label} must be a bounded unique string array`);
  }
  return [...value];
}

function boundedString(value, label, maximum) {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximum || /[\u0000-\u001f\u007f]/.test(value.trim())) throw new Error(`${label} is invalid`);
  return value.trim();
}

function number(value, label, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}

function assertPassing(value, violations, batchId) {
  if (value.passed !== true || violations.length !== 0) throw new Error(`${batchId} signed operational report does not pass server-side policy`);
}

function scopeAllowed(allowedScopes, scope) {
  return allowedScopes.some((allowed) => allowed === "*" || allowed === scope || (allowed.endsWith("*") && scope.startsWith(allowed.slice(0, -1))));
}

function blocked(reason) { return { status: "BLOCKED_EXTERNAL", gate: "upstream-production-controls", reason }; }
function blockedError(message) { const error = new Error(message); error.code = "BLOCKED_EXTERNAL"; return error; }
function identifier(value, label) { if (typeof value !== "string" || value.trim() !== value || !IDENTIFIER.test(value)) throw new Error(`${label} is invalid`); return value; }
function digest(value, label) { if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`); return value; }
function timestamp(value, label) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO-8601 UTC timestamp`); return value; }
function isTestIssuer(value) { return value === "test" || value.startsWith("test:") || value.startsWith("fixture:") || value.startsWith("sandbox:"); }
