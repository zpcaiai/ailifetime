import { createHash } from "node:crypto";
import { isIP } from "node:net";

const SHA256 = /^[a-f0-9]{64}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const APPROVAL_AUTHORITY_ROLES = Object.freeze({
  independentPenetrationTest: "independent-security-assessor",
  legalRegulatoryReview: "legal-regulatory-counsel",
  manualAccessibilityReview: "independent-accessibility-auditor",
  appleAppStoreDecision: "apple-app-store-authority",
  googlePlayDecision: "google-play-authority",
  wechatMiniProgramDecision: "wechat-mini-program-authority",
  disasterRecoveryDrill: "independent-resilience-auditor",
  productionChangeApproval: "production-change-authority",
});

/**
 * Reserved trust role for the primary evidence envelopes that authorize a
 * final B127 production release. Integration-gateway and provider callback
 * attestations must never be enrolled under this role.
 */
export const B127_PRODUCTION_RELEASE_AUTHORITY_ROLE = "b127-production-release-authority";

export const SUPPLY_CHAIN_AUTHORITY_ROLE = "production-supply-chain-signer";
export const CHANGE_APPROVER_AUTHORITY_ROLES = Object.freeze([
  "production-change-risk-approver",
  "production-change-operations-approver",
]);
export const CONTROL_ARTIFACT_AUTHORITY_ROLES = Object.freeze({
  monitoring_query: "production-monitoring-query-signer",
  monitoring_result: "production-monitoring-result-signer",
  pause_command: "production-rollout-pause-controller",
  pause_receipt: "production-rollout-pause-receipt-authority",
});
export const REQUIRED_WORKLOAD_ROLES = Object.freeze(["api", "workers", "integration-gateway", "client-integration-broker", "migrator"]);
export const REQUIRED_APPROVAL_NAMES = Object.freeze(Object.keys(APPROVAL_AUTHORITY_ROLES));
export const REQUIRED_SCHEMA7_FORCE_RLS_TABLES = Object.freeze([
  "records",
  "consents",
  "idempotency",
  "inbox",
  "outbox",
  "audit_log",
  "ledger_transactions",
  "ledger_lines",
  "external_evidence",
  "evidence_consumptions",
  "external_commands",
  "external_command_transitions",
  "evidence_decisions",
  "external_business_events",
  "participants",
  "guardian_authorizations",
  "authorized_agent_authorizations",
  "data_tracking_queue",
  "data_warehouse_state",
  "commerce_finance_state",
  "growth_operations_state",
  "partner_settlement_state",
  "referral_rewards",
  "lifecycle_deliveries",
  "partner_usage_events",
  "partner_rate_contracts",
  "partner_settlement_statements",
  "partner_anomaly_decisions",
].sort((left, right) => left.localeCompare(right)));
// Compatibility export retained for existing fixture/tool callers; new
// releases use the schema-7 table set above.
export const REQUIRED_SCHEMA5_FORCE_RLS_TABLES = REQUIRED_SCHEMA7_FORCE_RLS_TABLES;

export function validateProductionReleaseSubject(value) {
  const subject = exactObject(value, "production releaseSubject", [
    "schemaVersion", "deploymentId", "targetBaseUrl", "repositoryCommit", "profileVersion",
    "componentSetSha256", "lockfileSha256", "migrationManifestSha256", "consentPolicyCatalogSha256",
    "mediaLifecycleCatalogSha256", "mediaSafetyPolicySha256", "guardrailPolicySha256", "waveObservationSetSha256",
    "rollbackForwardDrillSha256", "workloadImages",
    "requiredProviderIds", "secretReferences", "forcedRlsTables", "databaseUrlReference",
    "legal", "accessibility", "applications", "penetrationTest", "disasterRecovery",
    "goLive", "supplyChain",
  ]);
  if (subject.schemaVersion !== "ltm.production-release-subject.v1") subjectInvalid("schemaVersion is unsupported");
  identifier(subject.deploymentId, "releaseSubject.deploymentId");
  const targetBaseUrl = publicHttpsOrigin(subject.targetBaseUrl, "releaseSubject.targetBaseUrl");
  if (!COMMIT.test(subject.repositoryCommit)) subjectInvalid("repositoryCommit must be a full lowercase Git object ID");
  visible(subject.profileVersion, "releaseSubject.profileVersion", 128);
  digest(subject.componentSetSha256, "releaseSubject.componentSetSha256");
  digest(subject.lockfileSha256, "releaseSubject.lockfileSha256");
  digest(subject.migrationManifestSha256, "releaseSubject.migrationManifestSha256");
  digest(subject.consentPolicyCatalogSha256, "releaseSubject.consentPolicyCatalogSha256");
  digest(subject.mediaLifecycleCatalogSha256, "releaseSubject.mediaLifecycleCatalogSha256");
  digest(subject.mediaSafetyPolicySha256, "releaseSubject.mediaSafetyPolicySha256");
  digest(subject.guardrailPolicySha256, "releaseSubject.guardrailPolicySha256");
  digest(subject.waveObservationSetSha256, "releaseSubject.waveObservationSetSha256");
  digest(subject.rollbackForwardDrillSha256, "releaseSubject.rollbackForwardDrillSha256");
  const workloadImageSet = workloadImages(subject.workloadImages, "releaseSubject.workloadImages");
  const requiredProviderIds = sortedStringArray(subject.requiredProviderIds, "releaseSubject.requiredProviderIds", 1, 100);
  const secretReferences = sortedStringArray(subject.secretReferences, "releaseSubject.secretReferences", 1, 200);
  if (secretReferences.some((item) => /(?:password|secret|token)=/i.test(item))) subjectInvalid("secretReferences contains inline secret material");
  const forcedRlsTables = sortedStringArray(subject.forcedRlsTables, "releaseSubject.forcedRlsTables", 1, 200);
  if (!sameArray(forcedRlsTables, REQUIRED_SCHEMA7_FORCE_RLS_TABLES)) {
    subjectInvalid("forcedRlsTables must exactly equal the schema 7 runtime tenant-table set");
  }
  visible(subject.databaseUrlReference, "releaseSubject.databaseUrlReference", 512);
  if (/postgres(?:ql)?:\/\//i.test(subject.databaseUrlReference)) subjectInvalid("databaseUrlReference must not contain connection credentials");

  const legal = exactObject(subject.legal, "releaseSubject.legal", ["legalEntityId", "jurisdictions"]);
  identifier(legal.legalEntityId, "releaseSubject.legal.legalEntityId");
  const jurisdictions = sortedStringArray(legal.jurisdictions, "releaseSubject.legal.jurisdictions", 1, 100);

  const accessibility = exactObject(subject.accessibility, "releaseSubject.accessibility", [
    "standard", "platforms", "browsers", "assistiveTechnologies", "journeys",
  ]);
  if (accessibility.standard !== "WCAG-2.2-AA") subjectInvalid("accessibility standard must be WCAG-2.2-AA");
  const normalizedAccessibility = {
    standard: accessibility.standard,
    platforms: sortedStringArray(accessibility.platforms, "releaseSubject.accessibility.platforms", 1, 20),
    browsers: sortedStringArray(accessibility.browsers, "releaseSubject.accessibility.browsers", 1, 20),
    assistiveTechnologies: sortedStringArray(accessibility.assistiveTechnologies, "releaseSubject.accessibility.assistiveTechnologies", 1, 20),
    journeys: sortedStringArray(accessibility.journeys, "releaseSubject.accessibility.journeys", 1, 100),
  };

  const applicationsValue = exactObject(subject.applications, "releaseSubject.applications", [
    "appleAppStoreDecision", "googlePlayDecision", "wechatMiniProgramDecision",
  ]);
  const expectedStores = {
    appleAppStoreDecision: "apple-app-store",
    googlePlayDecision: "google-play",
    wechatMiniProgramDecision: "wechat-mini-program",
  };
  const applications = Object.fromEntries(Object.entries(expectedStores).map(([name, store]) => {
    const application = exactObject(applicationsValue[name], `releaseSubject.applications.${name}`, [
      "store", "applicationId", "accountId", "version", "buildSha256",
    ]);
    if (application.store !== store) subjectInvalid(`${name} store identity is invalid`);
    for (const field of ["applicationId", "accountId", "version"]) visible(application[field], `releaseSubject.applications.${name}.${field}`, 256);
    digest(application.buildSha256, `releaseSubject.applications.${name}.buildSha256`);
    return [name, { ...application }];
  }));

  const penetrationTest = exactObject(subject.penetrationTest, "releaseSubject.penetrationTest", [
    "targetOrigin", "reportArtifactSha256", "findingRegistrySha256",
  ]);
  if (publicHttpsOrigin(penetrationTest.targetOrigin, "releaseSubject.penetrationTest.targetOrigin") !== targetBaseUrl) subjectInvalid("penetration-test origin must equal the production target");
  digest(penetrationTest.reportArtifactSha256, "releaseSubject.penetrationTest.reportArtifactSha256");
  digest(penetrationTest.findingRegistrySha256, "releaseSubject.penetrationTest.findingRegistrySha256");

  const disasterRecovery = exactObject(subject.disasterRecovery, "releaseSubject.disasterRecovery", [
    "deploymentId", "reportArtifactSha256", "sourceRegion", "failoverRegion", "schemaVersion",
    "targetRtoSeconds", "targetRpoSeconds",
  ]);
  if (disasterRecovery.deploymentId !== subject.deploymentId) subjectInvalid("DR deploymentId must equal the release deployment");
  digest(disasterRecovery.reportArtifactSha256, "releaseSubject.disasterRecovery.reportArtifactSha256");
  identifier(disasterRecovery.sourceRegion, "releaseSubject.disasterRecovery.sourceRegion");
  identifier(disasterRecovery.failoverRegion, "releaseSubject.disasterRecovery.failoverRegion");
  if (disasterRecovery.sourceRegion === disasterRecovery.failoverRegion || disasterRecovery.schemaVersion !== "7") subjectInvalid("DR regions/schema are invalid");
  positive(disasterRecovery.targetRtoSeconds, "releaseSubject.disasterRecovery.targetRtoSeconds");
  positive(disasterRecovery.targetRpoSeconds, "releaseSubject.disasterRecovery.targetRpoSeconds");

  const goLive = exactObject(subject.goLive, "releaseSubject.goLive", ["windowStart", "windowEnd", "scheduledAt"]);
  const windowStart = timestamp(goLive.windowStart, "releaseSubject.goLive.windowStart");
  const windowEnd = timestamp(goLive.windowEnd, "releaseSubject.goLive.windowEnd");
  const scheduledAt = timestamp(goLive.scheduledAt, "releaseSubject.goLive.scheduledAt");
  if (Date.parse(windowEnd) <= Date.parse(windowStart) || Date.parse(scheduledAt) < Date.parse(windowStart) || Date.parse(scheduledAt) > Date.parse(windowEnd)) subjectInvalid("go-live window is invalid");

  const supplyChain = exactObject(subject.supplyChain, "releaseSubject.supplyChain", [
    "bundleSha256", "provenanceSha256", "trustKeyId",
  ]);
  digest(supplyChain.bundleSha256, "releaseSubject.supplyChain.bundleSha256");
  digest(supplyChain.provenanceSha256, "releaseSubject.supplyChain.provenanceSha256");
  identifier(supplyChain.trustKeyId, "releaseSubject.supplyChain.trustKeyId");

  return {
    ...subject,
    targetBaseUrl,
    workloadImages: workloadImageSet.map((item) => ({ ...item })),
    requiredProviderIds,
    secretReferences,
    forcedRlsTables,
    legal: { legalEntityId: legal.legalEntityId, jurisdictions },
    accessibility: normalizedAccessibility,
    applications,
    penetrationTest: { ...penetrationTest, targetOrigin: targetBaseUrl },
    disasterRecovery: { ...disasterRecovery },
    goLive: { windowStart, windowEnd, scheduledAt },
    supplyChain: { ...supplyChain },
  };
}

export function productionReleaseSubjectSha256(value) {
  const subject = validateProductionReleaseSubject(value);
  return createHash("sha256").update(canonicalJson(subject)).digest("hex");
}

export class EvidenceContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvidenceContractError";
    this.code = code;
  }
}

export function validateDeploymentCheckReport(bytes, expected) {
  const releaseSubject = validateProductionReleaseSubject(expected.releaseSubject);
  const releaseSubjectSha256 = productionReleaseSubjectSha256(releaseSubject);
  if (expected.releaseSubjectSha256 !== releaseSubjectSha256) invalidDeployment(expected.checkId, "releaseSubjectSha256 does not match the controlled release subject");
  expected = { ...expected, releaseSubject, releaseSubjectSha256 };
  const report = parseJson(bytes, `${expected.checkId} deployment report`, "DEPLOYMENT_REPORT_JSON_INVALID");
  exactObject(report, `${expected.checkId} deployment report`, [
    "schemaVersion", "checkId", "status", "environment", "tenantId", "launchId",
    "deploymentId", "commit", "releaseManifestSha256", "releaseSubjectSha256", "targetBaseUrl", "observedAt",
    "producer", "assertions",
  ]);
  if (report.schemaVersion !== "ltm.production-deployment-check-report.v1") invalidDeployment(expected.checkId, "schemaVersion is unsupported");
  for (const [field, value] of Object.entries({
    checkId: expected.checkId,
    status: "passed",
    environment: "production",
    tenantId: expected.tenantId,
    launchId: expected.launchId,
    deploymentId: expected.deploymentId,
    commit: expected.commit,
    releaseManifestSha256: expected.releaseManifestSha256,
    releaseSubjectSha256: expected.releaseSubjectSha256,
    targetBaseUrl: expected.targetBaseUrl,
    observedAt: expected.observedAt,
  })) {
    if (report[field] !== value) invalidDeployment(expected.checkId, `${field} is not bound to the signed deployment evidence`);
  }
  if (publicHttpsOrigin(expected.target, `${expected.checkId}.target`) !== expected.targetBaseUrl) invalidDeployment(expected.checkId, "outer target must be the exact production base URL");
  const producer = exactObject(report.producer, `${expected.checkId}.producer`, ["name", "version", "invocationId"]);
  visible(producer.name, `${expected.checkId}.producer.name`, 128);
  visible(producer.version, `${expected.checkId}.producer.version`, 128);
  identifier(producer.invocationId, `${expected.checkId}.producer.invocationId`);
  const assertions = object(report.assertions, `${expected.checkId}.assertions`);
  const summary = deploymentAssertionValidators[expected.checkId]?.(assertions, expected, producer);
  if (summary === undefined) invalidDeployment(expected.checkId, "has no registered closed report contract");
  return { producer: { ...producer }, summary };
}

const deploymentAssertionValidators = Object.freeze({
  "production-dependency-audit": (value, expected, producer) => {
    exactFields(value, expected.checkId, ["tool", "toolVersion", "registry", "lockfileSha256", "dependencyCount", "skippedCount", "high", "critical", "exitCode"]);
    exactTool(value, producer, "pnpm-audit", expected.checkId);
    if (httpsOrigin(value.registry, "registry") !== "https://registry.npmjs.org/") invalidDeployment(expected.checkId, "must use the official npm registry");
    if (digest(value.lockfileSha256, "lockfileSha256") !== expected.releaseSubject.lockfileSha256) invalidDeployment(expected.checkId, "lockfile digest does not match the checked-out release");
    positive(value.dependencyCount, "dependencyCount");
    zero(value.skippedCount, "skippedCount"); zero(value.high, "high"); zero(value.critical, "critical"); zero(value.exitCode, "exitCode");
    return { dependencies: value.dependencyCount, lockfileSha256: value.lockfileSha256 };
  },
  "production-backup-restore-drill": (value, expected, producer) => {
    exactFields(value, expected.checkId, [
      "tool", "toolVersion", "backend", "serverMajor", "schemaVersion", "backupId", "sourceEnvironment",
      "restoreTargetId", "restorePoint", "backupSha256", "restoredSha256", "targetRtoSeconds",
      "observedRtoSeconds", "targetRpoSeconds", "observedRpoSeconds", "pointInTimeRecoveryVerified",
      "crossRegion", "integrityChecks", "exitCode",
    ]);
    exactTool(value, producer, "ltm-postgres-restore-verifier", expected.checkId);
    if (value.backend !== "postgresql" || integer(value.serverMajor, "serverMajor", 17) < 17 || value.schemaVersion !== "7") invalidDeployment(expected.checkId, "requires restored PostgreSQL 17+ schema 7");
    identifier(value.backupId, "backupId"); identifier(value.restoreTargetId, "restoreTargetId"); timestamp(value.restorePoint, "restorePoint");
    digest(value.backupSha256, "backupSha256"); digest(value.restoredSha256, "restoredSha256");
    if (value.backupSha256 === value.restoredSha256) invalidDeployment(expected.checkId, "backup and restored verification artifacts must be distinct");
    if (value.sourceEnvironment !== "production" || value.pointInTimeRecoveryVerified !== true || value.crossRegion !== true) invalidDeployment(expected.checkId, "requires a production cross-region point-in-time restore");
    boundedObjective(value, "RtoSeconds", expected.checkId); boundedObjective(value, "RpoSeconds", expected.checkId);
    const integrity = exactObject(value.integrityChecks, "integrityChecks", ["database", "forcedRls", "tenantIsolation", "auditChain", "ledgerBalance", "evidenceChain", "deletionNonResurrection", "duplicateSideEffectsPrevented"]);
    allTrue(integrity, expected.checkId, "restore integrity checks"); zero(value.exitCode, "exitCode");
    return { backupId: value.backupId, restoreTargetId: value.restoreTargetId, observedRtoSeconds: value.observedRtoSeconds, observedRpoSeconds: value.observedRpoSeconds };
  },
  "semgrep-static-analysis": (value, expected, producer) => scanner(value, expected, producer, "semgrep", ["rulesetSha256", "scannedFiles", "scanErrors", "high", "critical", "sarifSha256"]),
  "trivy-container-scan": (value, expected, producer) => imageScanner(value, expected, producer, "trivy", true),
  "grype-image-scan": (value, expected, producer) => imageScanner(value, expected, producer, "grype", false),
  "syft-sbom": (value, expected, producer) => {
    exactFields(value, expected.checkId, ["tool", "toolVersion", "images", "sboms", "componentCount", "signedBundleSha256", "provenanceSha256", "productionTrustKeyId", "exitCode"]);
    exactTool(value, producer, "syft", expected.checkId);
    const images = workloadImages(value.images, "images");
    assertExactWorkloadImages(images, expected.releaseSubject.workloadImages, expected.checkId);
    const sboms = array(value.sboms, "sboms", REQUIRED_WORKLOAD_ROLES.length, REQUIRED_WORKLOAD_ROLES.length).map((entry, index) => {
      const item = exactObject(entry, `sboms[${index}]`, ["role", "imageDigest", "artifactSha256", "format", "componentCount"]);
      identifier(item.role, `sboms[${index}].role`); ociDigest(item.imageDigest, `sboms[${index}].imageDigest`); digest(item.artifactSha256, `sboms[${index}].artifactSha256`);
      if (!new Set(["cyclonedx-json", "spdx-json"]).has(item.format)) invalidDeployment(expected.checkId, "SBOM format is unsupported");
      positive(item.componentCount, `sboms[${index}].componentCount`);
      return item;
    });
    const imageBindings = images.map((item) => `${item.role}\0${item.digest}`).sort();
    const sbomBindings = sboms.map((item) => `${item.role}\0${item.imageDigest}`).sort();
    if (JSON.stringify(imageBindings) !== JSON.stringify(sbomBindings)) invalidDeployment(expected.checkId, "every exact workload image digest requires one SBOM");
    positive(value.componentCount, "componentCount");
    if (value.componentCount !== sboms.reduce((total, item) => total + item.componentCount, 0)) invalidDeployment(expected.checkId, "aggregate component count does not match workload SBOMs");
    if (digest(value.signedBundleSha256, "signedBundleSha256") !== expected.releaseSubject.supplyChain.bundleSha256) invalidDeployment(expected.checkId, "SBOM bundle digest does not match the verified production attestation");
    if (digest(value.provenanceSha256, "provenanceSha256") !== expected.releaseSubject.supplyChain.provenanceSha256) invalidDeployment(expected.checkId, "provenance digest does not match the verified production attestation");
    if (identifier(value.productionTrustKeyId, "productionTrustKeyId") !== expected.releaseSubject.supplyChain.trustKeyId) invalidDeployment(expected.checkId, "supply-chain key does not match the trusted production signer");
    zero(value.exitCode, "exitCode");
    return { images: images.length, components: value.componentCount, signedBundleSha256: value.signedBundleSha256 };
  },
  "osv-scanner": (value, expected, producer) => {
    exactFields(value, expected.checkId, ["tool", "toolVersion", "lockfileSha256", "componentSetSha256", "scannedPackages", "skippedPackages", "high", "critical", "exitCode"]);
    exactTool(value, producer, "osv-scanner", expected.checkId);
    if (digest(value.lockfileSha256, "lockfileSha256") !== expected.releaseSubject.lockfileSha256 || digest(value.componentSetSha256, "componentSetSha256") !== expected.releaseSubject.componentSetSha256) invalidDeployment(expected.checkId, "OSV scan is not bound to the release lockfile/component set");
    positive(value.scannedPackages, "scannedPackages"); zero(value.skippedPackages, "skippedPackages"); zero(value.high, "high"); zero(value.critical, "critical"); zero(value.exitCode, "exitCode");
    return { scannedPackages: value.scannedPackages, componentSetSha256: value.componentSetSha256 };
  },
  "gitleaks-scan": (value, expected, producer) => {
    exactFields(value, expected.checkId, ["tool", "toolVersion", "commit", "scanScope", "scannedFiles", "findings", "exitCode"]);
    exactTool(value, producer, "gitleaks", expected.checkId);
    if (value.commit !== expected.commit || value.scanScope !== "full-history-and-worktree") invalidDeployment(expected.checkId, "secret scan must bind the exact commit and full history/worktree");
    positive(value.scannedFiles, "scannedFiles"); zero(value.findings, "findings"); zero(value.exitCode, "exitCode");
    return { scannedFiles: value.scannedFiles, commit: value.commit };
  },
  "production-persistence": (value, expected, producer) => {
    exactFields(value, expected.checkId, ["tool", "toolVersion", "engine", "serverMajor", "schemaVersion", "tlsMode", "hostnameVerified", "role", "superuser", "bypassRls", "forcedRlsTables", "tenantIsolationNegativeTest", "migrationsSha256", "readWriteProbe", "exitCode"]);
    exactTool(value, producer, "ltm-postgres-runtime-probe", expected.checkId);
    if (value.engine !== "postgresql" || integer(value.serverMajor, "serverMajor", 17) < 17 || value.schemaVersion !== "7" || value.tlsMode !== "verify-full") invalidDeployment(expected.checkId, "requires PostgreSQL 17+ schema 7 over verify-full TLS");
    identifier(value.role, "role");
    if (value.hostnameVerified !== true || value.superuser !== false || value.bypassRls !== false || value.tenantIsolationNegativeTest !== true || value.readWriteProbe !== true) invalidDeployment(expected.checkId, "PostgreSQL role, TLS, RLS, or read/write probes failed");
    const tables = sortedStringArray(value.forcedRlsTables, "forcedRlsTables", 1, 200);
    if (!sameArray(tables, expected.releaseSubject.forcedRlsTables)) invalidDeployment(expected.checkId, "FORCE RLS table set does not match the controlled release subject");
    if (digest(value.migrationsSha256, "migrationsSha256") !== expected.releaseSubject.migrationManifestSha256) invalidDeployment(expected.checkId, "migration manifest digest does not match the checked-out release");
    return { serverMajor: value.serverMajor, schemaVersion: value.schemaVersion, forcedRlsTables: tables.length };
  },
  "enterprise-authentication": (value, expected, producer) => {
    exactFields(value, expected.checkId, ["tool", "toolVersion", "protocol", "issuer", "jwksUrl", "audience", "algorithms", "tokenExchangeVerified", "claimsVerified", "rejections", "exitCode"]);
    exactTool(value, producer, "ltm-oidc-production-probe", expected.checkId);
    if (value.protocol !== "oidc") invalidDeployment(expected.checkId, "enterprise authentication must use OIDC");
    httpsUrl(value.issuer, "issuer"); httpsUrl(value.jwksUrl, "jwksUrl"); visible(value.audience, "audience", 512);
    const algorithms = stringArray(value.algorithms, "algorithms", 1, 8);
    if (algorithms.some((item) => !["RS256", "PS256", "ES256", "EdDSA"].includes(item))) invalidDeployment(expected.checkId, "OIDC algorithm allowlist contains an unsupported algorithm");
    if (value.tokenExchangeVerified !== true) invalidDeployment(expected.checkId, "a live production token exchange was not verified");
    allTrue(exactObject(value.claimsVerified, "claimsVerified", ["issuer", "audience", "tenant", "roles", "purposes", "mfaStepUp"]), expected.checkId, "OIDC claims");
    allTrue(exactObject(value.rejections, "rejections", ["expired", "wrongIssuer", "wrongAudience", "wrongTenant", "unknownRole", "missingPurpose", "unsigned"]), expected.checkId, "OIDC negative tests");
    zero(value.exitCode, "exitCode"); return { issuer: value.issuer, algorithms };
  },
  "distributed-coordination": (value, expected, producer) => {
    exactFields(value, expected.checkId, ["tool", "toolVersion", "engine", "tlsVerified", "clusterNodes", "leaseOwnershipVerified", "replayPreventionVerified", "concurrentClaimVerified", "failoverVerified", "duplicateSideEffects", "exitCode"]);
    exactTool(value, producer, "ltm-redis-production-probe", expected.checkId);
    if (value.engine !== "redis" || value.tlsVerified !== true || integer(value.clusterNodes, "clusterNodes", 3) < 3 || value.leaseOwnershipVerified !== true || value.replayPreventionVerified !== true || value.concurrentClaimVerified !== true || value.failoverVerified !== true) invalidDeployment(expected.checkId, "Redis TLS/HA/lease/replay/failover probes are incomplete");
    zero(value.duplicateSideEffects, "duplicateSideEffects"); zero(value.exitCode, "exitCode");
    return { clusterNodes: value.clusterNodes, failoverVerified: true };
  },
  "durable-object-storage": (value, expected, producer) => {
    exactFields(value, expected.checkId, ["tool", "toolVersion", "provider", "bucket", "kmsKeyReference", "objectLockMode", "versioningEnabled", "retentionDays", "writeReadDigestVerified", "deleteBeforeRetentionRejected", "crossAccountDenyVerified", "exitCode"]);
    exactTool(value, producer, "ltm-object-storage-production-probe", expected.checkId);
    identifier(value.provider, "provider"); visible(value.bucket, "bucket", 255); visible(value.kmsKeyReference, "kmsKeyReference", 512);
    if (value.objectLockMode !== "COMPLIANCE" || value.versioningEnabled !== true || integer(value.retentionDays, "retentionDays", 1) < 1 || value.writeReadDigestVerified !== true || value.deleteBeforeRetentionRejected !== true || value.crossAccountDenyVerified !== true) invalidDeployment(expected.checkId, "KMS/Object Lock/versioning/retention probes are incomplete");
    zero(value.exitCode, "exitCode"); return { provider: value.provider, bucket: value.bucket, retentionDays: value.retentionDays };
  },
  "background-workers": (value, expected, producer) => {
    exactFields(value, expected.checkId, ["tool", "toolVersion", "commit", "workloadImageDigest", "replicas", "routes", "externalCommandMappings", "leaseRecoveryVerified", "retryVerified", "deadLetterVerified", "reconciliationFreezeVerified", "healthObserved", "exitCode"]);
    exactTool(value, producer, "ltm-worker-production-probe", expected.checkId);
    if (value.commit !== expected.commit) invalidDeployment(expected.checkId, "worker probe commit does not match the release");
    const workerImage = expected.releaseSubject.workloadImages.find((item) => item.role === "workers");
    if (ociDigest(value.workloadImageDigest, "workloadImageDigest") !== workerImage?.digest) invalidDeployment(expected.checkId, "worker image does not match the released worker workload");
    if (integer(value.replicas, "replicas", 2) < 2 || integer(value.externalCommandMappings, "externalCommandMappings", 18) !== 18) invalidDeployment(expected.checkId, "workers require HA replicas and all 18 external command mappings");
    const routes = stringArray(value.routes, "routes", 5, 5).sort();
    if (JSON.stringify(routes) !== JSON.stringify(["data", "fulfillment", "integration", "media", "notification"])) invalidDeployment(expected.checkId, "worker route set is incomplete");
    for (const field of ["leaseRecoveryVerified", "retryVerified", "deadLetterVerified", "reconciliationFreezeVerified", "healthObserved"]) if (value[field] !== true) invalidDeployment(expected.checkId, `${field} was not verified`);
    zero(value.exitCode, "exitCode"); return { replicas: value.replicas, routes, externalCommandMappings: 18 };
  },
  "external-provider-mode": (value, expected, producer) => {
    exactFields(value, expected.checkId, ["tool", "toolVersion", "mode", "providers", "exitCode"]);
    exactTool(value, producer, "ltm-provider-production-reconciliation", expected.checkId);
    if (value.mode !== "external-verified") invalidDeployment(expected.checkId, "provider mode is not external-verified");
    const required = expected.releaseSubject.requiredProviderIds;
    const providers = array(value.providers, "providers", required.length, required.length).map((entry, index) => {
      const item = exactObject(entry, `providers[${index}]`, ["providerId", "accountId", "commandId", "callbackId", "reconciliationId", "requestAccepted", "callbackVerified", "reconciled"]);
      for (const field of ["providerId", "accountId", "commandId", "callbackId", "reconciliationId"]) identifier(item[field], `providers[${index}].${field}`);
      if (item.requestAccepted !== true || item.callbackVerified !== true || item.reconciled !== true) invalidDeployment(expected.checkId, `provider ${item.providerId} lacks a real accepted command/callback/reconciliation`);
      return item;
    });
    const actual = providers.map((item) => item.providerId).sort();
    if (JSON.stringify(required) !== JSON.stringify(actual) || new Set(actual).size !== actual.length) invalidDeployment(expected.checkId, "provider evidence does not cover the exact required provider set");
    zero(value.exitCode, "exitCode"); return { providers: actual };
  },
  "tls-and-proxy": (value, expected, producer) => {
    exactFields(value, expected.checkId, ["tool", "toolVersion", "publicOrigin", "certificateSha256", "notBefore", "notAfter", "minimumProtocol", "hostnameVerified", "chainVerified", "hstsMaxAgeSeconds", "proxyHeadersSanitized", "externalProbeVerified", "exitCode"]);
    exactTool(value, producer, "ltm-tls-production-probe", expected.checkId);
    if (httpsOrigin(value.publicOrigin, "publicOrigin") !== new URL(expected.targetBaseUrl).origin + "/") invalidDeployment(expected.checkId, "TLS probe target does not match the release target");
    digest(value.certificateSha256, "certificateSha256");
    const notBefore = Date.parse(timestamp(value.notBefore, "notBefore")); const notAfter = Date.parse(timestamp(value.notAfter, "notAfter"));
    if (notAfter <= notBefore || notAfter <= Date.parse(expected.observedAt) + 30 * 86_400_000) invalidDeployment(expected.checkId, "certificate validity is expired or too close to expiry");
    if (!new Set(["TLSv1.2", "TLSv1.3"]).has(value.minimumProtocol) || value.hostnameVerified !== true || value.chainVerified !== true || integer(value.hstsMaxAgeSeconds, "hstsMaxAgeSeconds", 15_552_000) < 15_552_000 || value.proxyHeadersSanitized !== true || value.externalProbeVerified !== true) invalidDeployment(expected.checkId, "TLS, HSTS, proxy, or external reachability probes are incomplete");
    zero(value.exitCode, "exitCode"); return { publicOrigin: value.publicOrigin, minimumProtocol: value.minimumProtocol, notAfter: value.notAfter };
  },
  "managed-secret-references": (value, expected, producer) => {
    exactFields(value, expected.checkId, ["tool", "toolVersion", "provider", "workloadIdentitySubject", "secretReferences", "inlineSecretCount", "authorizedReadVerified", "unauthorizedReadDenied", "rotationObserved", "reportContainsSecretValues", "exitCode"]);
    exactTool(value, producer, "ltm-managed-secrets-production-probe", expected.checkId);
    identifier(value.provider, "provider"); visible(value.workloadIdentitySubject, "workloadIdentitySubject", 512);
    const references = sortedStringArray(value.secretReferences, "secretReferences", 1, 200);
    if (references.some((item) => /(?:password|secret|token)=/i.test(item))) invalidDeployment(expected.checkId, "secretReferences contains inline secret material");
    if (!sameArray(references, expected.releaseSubject.secretReferences)) invalidDeployment(expected.checkId, "secret reference set does not match the controlled release subject");
    zero(value.inlineSecretCount, "inlineSecretCount");
    if (value.authorizedReadVerified !== true || value.unauthorizedReadDenied !== true || value.rotationObserved !== true || value.reportContainsSecretValues !== false) invalidDeployment(expected.checkId, "workload identity, deny, rotation, or redaction probes are incomplete");
    zero(value.exitCode, "exitCode"); return { provider: value.provider, references: references.length };
  },
  "database-url-contract": (value, expected, producer) => {
    exactFields(value, expected.checkId, ["tool", "toolVersion", "reference", "scheme", "tlsMode", "hostnameVerified", "caVerified", "credentialsInline", "applicationName", "serverMajor", "schemaVersion", "role", "superuser", "bypassRls", "migrationsSha256", "connectionVerified", "exitCode"]);
    exactTool(value, producer, "ltm-database-contract-probe", expected.checkId);
    visible(value.reference, "reference", 512); identifier(value.applicationName, "applicationName"); identifier(value.role, "role");
    if (/postgres(?:ql)?:\/\//i.test(value.reference) || value.scheme !== "postgresql" || value.tlsMode !== "verify-full" || value.hostnameVerified !== true || value.caVerified !== true || value.credentialsInline !== false || integer(value.serverMajor, "serverMajor", 17) < 17 || value.schemaVersion !== "7" || value.superuser !== false || value.bypassRls !== false || value.connectionVerified !== true) invalidDeployment(expected.checkId, "database contract must use a redacted reference and verified least-privilege PostgreSQL 17+ TLS connection");
    if (value.reference !== expected.releaseSubject.databaseUrlReference) invalidDeployment(expected.checkId, "database reference does not match the controlled release subject");
    if (digest(value.migrationsSha256, "migrationsSha256") !== expected.releaseSubject.migrationManifestSha256) invalidDeployment(expected.checkId, "database contract migration digest does not match the checked-out release");
    return { reference: value.reference, serverMajor: value.serverMajor, schemaVersion: value.schemaVersion };
  },
  "runtime-policy-authority": (value, expected, producer) => {
    exactFields(value, expected.checkId, [
      "tool", "toolVersion", "workloadIdentitySubject", "workloadIdentityVerified",
      "mutualTlsVerified", "apiReady", "apiConsentMetadata", "mediaBrokerReady",
      "mediaAuthority", "exitCode",
    ]);
    exactTool(value, producer, "ltm-runtime-policy-authority-probe", expected.checkId);
    identifier(value.workloadIdentitySubject, "workloadIdentitySubject");
    if (value.workloadIdentityVerified !== true || value.mutualTlsVerified !== true) {
      invalidDeployment(expected.checkId, "requires verified workload identity and mutual TLS");
    }

    const expectedApiOrigin = new URL(expected.targetBaseUrl);
    const apiReady = exactObject(value.apiReady, "apiReady", ["endpoint", "statusCode", "ready", "responseSha256"]);
    assertExactServiceEndpoint(apiReady.endpoint, expectedApiOrigin, "/health/ready", "apiReady.endpoint", expected.checkId);
    assertSuccessfulReadyProbe(apiReady, "apiReady", expected.checkId);

    const api = exactObject(value.apiConsentMetadata, "apiConsentMetadata", [
      "endpoint", "statusCode", "responseSha256", "schemaVersion", "catalogId", "issuer",
      "environment", "catalogSha256", "issuedAt", "expiresAt", "jurisdiction", "locale",
      "policyVersions",
    ]);
    assertExactServiceEndpoint(api.endpoint, expectedApiOrigin, "/v1/consent-policy/authority", "apiConsentMetadata.endpoint", expected.checkId);
    if (api.statusCode !== 200 || api.schemaVersion !== "ltm.consent-policy-catalog-metadata.v1" || api.environment !== "production") {
      invalidDeployment(expected.checkId, "API consent metadata probe did not return a ready production catalog");
    }
    digest(api.responseSha256, "apiConsentMetadata.responseSha256");
    identifier(api.catalogId, "apiConsentMetadata.catalogId");
    identifier(api.issuer, "apiConsentMetadata.issuer");
    visible(api.jurisdiction, "apiConsentMetadata.jurisdiction", 64);
    visible(api.locale, "apiConsentMetadata.locale", 64);
    stringArray(api.policyVersions, "apiConsentMetadata.policyVersions", 1, 1_000);
    if (digest(api.catalogSha256, "apiConsentMetadata.catalogSha256") !== expected.releaseSubject.consentPolicyCatalogSha256) {
      invalidDeployment(expected.checkId, "API consent catalog digest does not match the controlled release subject");
    }
    assertAuthorityWindow(api.issuedAt, api.expiresAt, expected.observedAt, "API consent catalog", expected.checkId);

    const mediaReady = exactObject(value.mediaBrokerReady, "mediaBrokerReady", ["endpoint", "statusCode", "ready", "responseSha256"]);
    const mediaReadyUrl = serviceEndpoint(mediaReady.endpoint, "/health/ready", "mediaBrokerReady.endpoint", expected.checkId);
    assertSuccessfulReadyProbe(mediaReady, "mediaBrokerReady", expected.checkId);

    const media = exactObject(value.mediaAuthority, "mediaAuthority", [
      "endpoint", "statusCode", "responseSha256", "schemaVersion", "mediaLifecycleCatalogSha256",
      "mediaSafetyPolicySha256", "lifecycleIssuer", "lifecycleEnvironment", "lifecycleExpiresAt",
      "scannerProvider", "scannerPolicyId", "scannerModelVersion", "scannerKeyId", "scannerEnvironment",
    ]);
    const mediaUrl = serviceEndpoint(media.endpoint, "/v1/media/lifecycle/authority", "mediaAuthority.endpoint", expected.checkId);
    if (mediaUrl.origin !== mediaReadyUrl.origin) invalidDeployment(expected.checkId, "media readiness and authority probes must target the same broker origin");
    if (media.statusCode !== 200 || media.schemaVersion !== "ltm.media-authority.v1") {
      invalidDeployment(expected.checkId, "media authority probe did not return the supported authority projection");
    }
    if (digest(media.responseSha256, "mediaAuthority.responseSha256") !== expected.mediaAuthorityArtifactSha256) {
      invalidDeployment(expected.checkId, "media authority response bytes do not match the immutable B127 artifact");
    }
    if (
      digest(media.mediaLifecycleCatalogSha256, "mediaAuthority.mediaLifecycleCatalogSha256") !== expected.releaseSubject.mediaLifecycleCatalogSha256 ||
      digest(media.mediaSafetyPolicySha256, "mediaAuthority.mediaSafetyPolicySha256") !== expected.releaseSubject.mediaSafetyPolicySha256
    ) {
      invalidDeployment(expected.checkId, "media authority digests do not match the controlled release subject");
    }
    identifier(media.lifecycleIssuer, "mediaAuthority.lifecycleIssuer");
    identifier(media.scannerProvider, "mediaAuthority.scannerProvider");
    identifier(media.scannerPolicyId, "mediaAuthority.scannerPolicyId");
    visible(media.scannerModelVersion, "mediaAuthority.scannerModelVersion", 128);
    identifier(media.scannerKeyId, "mediaAuthority.scannerKeyId");
    if (media.lifecycleEnvironment !== "production" || media.scannerEnvironment !== "production") {
      invalidDeployment(expected.checkId, "media lifecycle and scanner authorities must both be production scoped");
    }
    if (Date.parse(timestamp(media.lifecycleExpiresAt, "mediaAuthority.lifecycleExpiresAt")) <= Date.parse(expected.observedAt)) {
      invalidDeployment(expected.checkId, "media lifecycle authority was expired when probed");
    }
    zero(value.exitCode, "exitCode");
    return {
      workloadIdentitySubject: value.workloadIdentitySubject,
      consentPolicyCatalogSha256: api.catalogSha256,
      mediaLifecycleCatalogSha256: media.mediaLifecycleCatalogSha256,
      mediaSafetyPolicySha256: media.mediaSafetyPolicySha256,
    };
  },
});

export function validateReleaseApprovalArtifact(bytes, expected) {
  expected = { ...expected, releaseSubject: validateProductionReleaseSubject(expected.releaseSubject) };
  const label = `${expected.approvalName} approval artifact`;
  const artifact = parseJson(bytes, label, "APPROVAL_ARTIFACT_JSON_INVALID");
  exactObject(artifact, label, [
    "schemaVersion", "approvalType", "approvalId", "authorityRole", "authority", "issuer",
    "tenantId", "launchId", "environment", "repositoryCommit", "sbomSha256", "decision",
    "approvedAt", "expiresAt", "subject",
  ]);
  const role = APPROVAL_AUTHORITY_ROLES[expected.approvalName];
  if (role === undefined) invalidApproval(expected.approvalName, "is not a supported approval type");
  for (const [field, value] of Object.entries({
    schemaVersion: "ltm.release-approval-artifact.v1",
    approvalType: expected.approvalName,
    approvalId: expected.approvalId,
    authorityRole: role,
    authority: expected.authority,
    issuer: expected.issuer,
    tenantId: expected.tenantId,
    launchId: expected.launchId,
    environment: "production",
    repositoryCommit: expected.repositoryCommit,
    sbomSha256: expected.sbomSha256,
    decision: expected.decision,
    approvedAt: expected.approvedAt,
    expiresAt: expected.expiresAt ?? null,
  })) {
    if (artifact[field] !== value) invalidApproval(expected.approvalName, `${field} does not match the signed release manifest`);
  }
  const subject = object(artifact.subject, `${label}.subject`);
  approvalSubjectValidators[expected.approvalName](subject, expected);
  return { authorityRole: role, subject: structuredClone(subject) };
}

const approvalSubjectValidators = Object.freeze({
  independentPenetrationTest(value, expected) {
    exactFields(value, expected.approvalName, ["engagementId", "providerId", "targetOrigin", "reportArtifactSha256", "findingRegistrySha256", "scopeCategories", "independentThirdParty", "conflictsDisclosed", "unresolvedCritical", "unresolvedHigh", "retestPassed"]);
    identifier(value.engagementId, "engagementId"); identifier(value.providerId, "providerId"); httpsOrigin(value.targetOrigin, "targetOrigin"); digest(value.reportArtifactSha256, "reportArtifactSha256"); digest(value.findingRegistrySha256, "findingRegistrySha256");
    const required = ["authentication", "tenant_isolation", "idor", "upload", "signed_url", "webhook", "payment", "ssrf", "xss", "csrf", "admin_operations"];
    const actual = new Set(stringArray(value.scopeCategories, "scopeCategories", required.length, 100));
    if (required.some((item) => !actual.has(item)) || value.independentThirdParty !== true || value.conflictsDisclosed !== true || value.retestPassed !== true) invalidApproval(expected.approvalName, "independence, mandatory scope, or retest is incomplete");
    if (
      publicHttpsOrigin(value.targetOrigin, "targetOrigin") !== expected.releaseSubject.penetrationTest.targetOrigin ||
      value.reportArtifactSha256 !== expected.releaseSubject.penetrationTest.reportArtifactSha256 ||
      value.findingRegistrySha256 !== expected.releaseSubject.penetrationTest.findingRegistrySha256
    ) invalidApproval(expected.approvalName, "pentest target/report/finding registry does not match this release");
    zero(value.unresolvedCritical, "unresolvedCritical"); zero(value.unresolvedHigh, "unresolvedHigh");
  },
  legalRegulatoryReview(value, expected) {
    exactFields(value, expected.approvalName, ["reviewId", "legalEntityId", "jurisdictions", "productVersion", "scopes", "unresolvedRestrictions", "signingAuthorityVerified"]);
    identifier(value.reviewId, "reviewId"); identifier(value.legalEntityId, "legalEntityId"); visible(value.productVersion, "productVersion", 128);
    const jurisdictions = sortedStringArray(value.jurisdictions, "jurisdictions", 1, 100);
    const required = ["privacy", "ai", "minors", "commerce", "payments", "tax", "consumer_terms"];
    const scopes = new Set(stringArray(value.scopes, "scopes", required.length, 100));
    if (required.some((item) => !scopes.has(item)) || array(value.unresolvedRestrictions, "unresolvedRestrictions", 0, 0).length !== 0 || value.signingAuthorityVerified !== true) invalidApproval(expected.approvalName, "legal scope, authority, or unresolved restrictions are invalid");
    if (value.legalEntityId !== expected.releaseSubject.legal.legalEntityId || value.productVersion !== expected.releaseSubject.profileVersion || !sameArray(jurisdictions, expected.releaseSubject.legal.jurisdictions)) invalidApproval(expected.approvalName, "legal entity, product version, or jurisdiction set does not match this release");
  },
  manualAccessibilityReview(value, expected) {
    exactFields(value, expected.approvalName, ["auditId", "standard", "platforms", "browsers", "assistiveTechnologies", "journeys", "unresolvedCritical", "unresolvedHigh", "manualTesting", "retestPassed"]);
    identifier(value.auditId, "auditId"); if (value.standard !== "WCAG-2.2-AA") invalidApproval(expected.approvalName, "must certify WCAG 2.2 AA");
    const platforms = sortedStringArray(value.platforms, "platforms", 1, 20);
    const browsers = sortedStringArray(value.browsers, "browsers", 1, 20);
    const assistiveTechnologies = sortedStringArray(value.assistiveTechnologies, "assistiveTechnologies", 1, 20);
    const journeys = sortedStringArray(value.journeys, "journeys", 1, 100);
    zero(value.unresolvedCritical, "unresolvedCritical"); zero(value.unresolvedHigh, "unresolvedHigh");
    if (value.manualTesting !== true || value.retestPassed !== true) invalidApproval(expected.approvalName, "manual assistive-technology testing and retest are required");
    const matrix = expected.releaseSubject.accessibility;
    if (value.standard !== matrix.standard || !sameArray(platforms, matrix.platforms) || !sameArray(browsers, matrix.browsers) || !sameArray(assistiveTechnologies, matrix.assistiveTechnologies) || !sameArray(journeys, matrix.journeys)) invalidApproval(expected.approvalName, "accessibility matrix does not match this release");
  },
  appleAppStoreDecision: (value, expected) => storeDecision(value, expected, "apple-app-store"),
  googlePlayDecision: (value, expected) => storeDecision(value, expected, "google-play"),
  wechatMiniProgramDecision: (value, expected) => storeDecision(value, expected, "wechat-mini-program"),
  disasterRecoveryDrill(value, expected) {
    exactFields(value, expected.approvalName, ["exerciseId", "deploymentId", "reportArtifactSha256", "backupId", "sourceRegion", "failoverRegion", "restoreTargetId", "schemaVersion", "targetRtoSeconds", "observedRtoSeconds", "targetRpoSeconds", "observedRpoSeconds", "failoverVerified", "failbackVerified", "forcedRlsVerified", "auditChainVerified", "ledgerBalanced", "deletionNonResurrection", "duplicateSideEffectsPrevented"]);
    identifier(value.exerciseId, "exerciseId"); identifier(value.deploymentId, "deploymentId"); digest(value.reportArtifactSha256, "reportArtifactSha256"); identifier(value.backupId, "backupId"); identifier(value.sourceRegion, "sourceRegion"); identifier(value.failoverRegion, "failoverRegion"); identifier(value.restoreTargetId, "restoreTargetId");
    if (value.sourceRegion === value.failoverRegion || value.schemaVersion !== "7") invalidApproval(expected.approvalName, "DR must restore schema 7 into a distinct region");
    boundedObjective(value, "RtoSeconds", expected.approvalName); boundedObjective(value, "RpoSeconds", expected.approvalName);
    for (const field of ["failoverVerified", "failbackVerified", "forcedRlsVerified", "auditChainVerified", "ledgerBalanced", "deletionNonResurrection", "duplicateSideEffectsPrevented"]) if (value[field] !== true) invalidApproval(expected.approvalName, `${field} is required`);
    const dr = expected.releaseSubject.disasterRecovery;
    if (value.deploymentId !== dr.deploymentId || value.reportArtifactSha256 !== dr.reportArtifactSha256 || value.sourceRegion !== dr.sourceRegion || value.failoverRegion !== dr.failoverRegion || value.schemaVersion !== dr.schemaVersion || value.targetRtoSeconds !== dr.targetRtoSeconds || value.targetRpoSeconds !== dr.targetRpoSeconds) invalidApproval(expected.approvalName, "DR deployment/report/regions/schema/objectives do not match this release");
  },
  productionChangeApproval(value, expected) {
    exactFields(value, expected.approvalName, [
      "changeId", "ticketUrl", "deploymentId", "componentSetSha256", "waveObservationSetSha256",
      "guardrailPolicySha256", "rollbackForwardDrillSha256", "executor", "approverEvidence",
      "windowStart", "windowEnd",
    ]);
    identifier(value.changeId, "changeId"); httpsUrl(value.ticketUrl, "ticketUrl"); identifier(value.deploymentId, "deploymentId"); digest(value.componentSetSha256, "componentSetSha256");
    digest(value.guardrailPolicySha256, "guardrailPolicySha256"); digest(value.waveObservationSetSha256, "waveObservationSetSha256"); digest(value.rollbackForwardDrillSha256, "rollbackForwardDrillSha256");
    const executor = exactObject(value.executor, "production change executor", ["actorId", "issuer", "keyId"]);
    identifier(executor.actorId, "executor.actorId"); identifier(executor.issuer, "executor.issuer"); identifier(executor.keyId, "executor.keyId");
    const approverEvidence = array(value.approverEvidence, "approverEvidence", 2, 10).map((entry, index) => {
      const reference = exactObject(entry, `approverEvidence[${index}]`, ["path", "sha256"]);
      visible(reference.path, `approverEvidence[${index}].path`, 1024); digest(reference.sha256, `approverEvidence[${index}].sha256`);
      return { ...reference };
    });
    if (new Set(approverEvidence.map((entry) => entry.path)).size !== approverEvidence.length || new Set(approverEvidence.map((entry) => entry.sha256)).size !== approverEvidence.length) invalidApproval(expected.approvalName, "production change approver evidence references must be distinct");
    const start = Date.parse(timestamp(value.windowStart, "windowStart")); const end = Date.parse(timestamp(value.windowEnd, "windowEnd"));
    if (end <= start || end - start > 72 * 60 * 60_000) invalidApproval(expected.approvalName, "change window is invalid");
    const release = expected.releaseSubject;
    if (
      value.deploymentId !== release.deploymentId ||
      value.componentSetSha256 !== release.componentSetSha256 ||
      value.guardrailPolicySha256 !== release.guardrailPolicySha256 ||
      value.waveObservationSetSha256 !== release.waveObservationSetSha256 ||
      value.rollbackForwardDrillSha256 !== release.rollbackForwardDrillSha256 ||
      value.windowStart !== release.goLive.windowStart ||
      value.windowEnd !== release.goLive.windowEnd
    ) invalidApproval(expected.approvalName, "change approval is not bound to this deployment/component/control-evidence set/go-live window");
  },
});

export function validateReleaseSbom(bytes, format) {
  const sbom = parseJson(bytes, "SBOM", "SBOM_CONTENT_INVALID");
  if (format === "cyclonedx-json") return validateCycloneDx(sbom);
  if (format === "spdx-json") return validateSpdx(sbom);
  throw new EvidenceContractError("SBOM_CONTENT_INVALID", "SBOM format is unsupported");
}

function validateCycloneDx(sbom) {
  if (sbom.bomFormat !== "CycloneDX" || !["1.5", "1.6"].includes(sbom.specVersion) || !Number.isSafeInteger(sbom.version) || sbom.version < 1) sbomInvalid("CycloneDX identity/version is invalid");
  const metadata = object(sbom.metadata, "CycloneDX metadata");
  const application = object(metadata.component, "CycloneDX metadata.component");
  if (application.type !== "application") sbomInvalid("CycloneDX metadata component must identify the application");
  visible(application.name, "CycloneDX application name", 256); visible(application.version, "CycloneDX application version", 128); visible(application["bom-ref"], "CycloneDX application bom-ref", 512);
  const appHashes = array(application.hashes, "CycloneDX application hashes", 1, 20);
  if (!appHashes.some((item) => item?.alg === "SHA-256" && SHA256.test(item?.content))) sbomInvalid("CycloneDX application is not bound to a SHA-256 artifact manifest");
  const properties = array(metadata.properties, "CycloneDX metadata properties", 1, 100);
  if (!properties.some((item) => item?.name === "ltm:pnpm-lock-sha256" && SHA256.test(item?.value))) sbomInvalid("CycloneDX metadata is not bound to the exact pnpm lockfile");
  const components = array(sbom.components, "CycloneDX components", 1, 100_000);
  const identities = new Set();
  for (const [index, componentValue] of components.entries()) {
    const component = object(componentValue, `CycloneDX component ${index}`);
    if (!new Set(["library", "application", "framework", "operating-system"]).has(component.type)) sbomInvalid(`CycloneDX component ${index} has an unsupported type`);
    visible(component.name, `CycloneDX component ${index} name`, 512); visible(component.version, `CycloneDX component ${index} version`, 256);
    if (typeof component.purl !== "string" || !component.purl.startsWith("pkg:") || typeof component["bom-ref"] !== "string" || component["bom-ref"].length === 0) sbomInvalid(`CycloneDX component ${index} lacks a stable purl identity`);
    if (identities.has(component.purl)) sbomInvalid("CycloneDX component identities must be unique"); identities.add(component.purl);
    const hashes = array(component.hashes, `CycloneDX component ${index} hashes`, 1, 20);
    if (!hashes.some((item) => validAlgorithmDigest(item?.alg, item?.content, true))) sbomInvalid(`CycloneDX component ${index} lacks a package integrity digest`);
  }
  return { format: "cyclonedx-json", components: components.length };
}

function validateSpdx(sbom) {
  if (sbom.spdxVersion !== "SPDX-2.3" || sbom.dataLicense !== "CC0-1.0" || sbom.SPDXID !== "SPDXRef-DOCUMENT") sbomInvalid("SPDX document identity/version is invalid");
  visible(sbom.name, "SPDX name", 512); absoluteUri(sbom.documentNamespace, "SPDX documentNamespace");
  const creation = object(sbom.creationInfo, "SPDX creationInfo"); timestamp(creation.created, "SPDX creationInfo.created"); stringArray(creation.creators, "SPDX creationInfo.creators", 1, 100);
  const packages = array(sbom.packages, "SPDX packages", 1, 100_000);
  const identities = new Set();
  for (const [index, packageValue] of packages.entries()) {
    const item = object(packageValue, `SPDX package ${index}`);
    identifier(item.SPDXID, `SPDX package ${index} SPDXID`); visible(item.name, `SPDX package ${index} name`, 512); visible(item.versionInfo, `SPDX package ${index} versionInfo`, 256);
    if (identities.has(item.SPDXID)) sbomInvalid("SPDX package IDs must be unique"); identities.add(item.SPDXID);
    const refs = array(item.externalRefs, `SPDX package ${index} externalRefs`, 1, 20);
    if (!refs.some((ref) => ref?.referenceType === "purl" && typeof ref?.referenceLocator === "string" && ref.referenceLocator.startsWith("pkg:"))) sbomInvalid(`SPDX package ${index} lacks a purl identity`);
    const checksums = array(item.checksums, `SPDX package ${index} checksums`, 1, 20);
    if (!checksums.some((entry) => validAlgorithmDigest(entry?.algorithm, entry?.checksumValue, false))) sbomInvalid(`SPDX package ${index} lacks a package integrity digest`);
  }
  return { format: "spdx-json", components: packages.length };
}

function scanner(value, expected, producer, tool, additional) {
  exactFields(value, expected.checkId, ["tool", "toolVersion", ...additional, "exitCode"]);
  exactTool(value, producer, tool, expected.checkId); digest(value.rulesetSha256, "rulesetSha256"); digest(value.sarifSha256, "sarifSha256");
  positive(value.scannedFiles, "scannedFiles"); zero(value.scanErrors, "scanErrors"); zero(value.high, "high"); zero(value.critical, "critical"); zero(value.exitCode, "exitCode");
  return { scannedFiles: value.scannedFiles, rulesetSha256: value.rulesetSha256, sarifSha256: value.sarifSha256 };
}

function imageScanner(value, expected, producer, tool, includeConfiguration) {
  exactFields(value, expected.checkId, ["tool", "toolVersion", "databaseUpdatedAt", ...(includeConfiguration ? ["configurationScanned"] : []), "images", "scanErrors", "high", "critical", "exitCode"]);
  exactTool(value, producer, tool, expected.checkId); timestamp(value.databaseUpdatedAt, "databaseUpdatedAt");
  if (Date.parse(expected.observedAt) - Date.parse(value.databaseUpdatedAt) > 7 * 86_400_000) invalidDeployment(expected.checkId, "vulnerability database is older than seven days");
  if (includeConfiguration && value.configurationScanned !== true) invalidDeployment(expected.checkId, "IaC/container configuration was not scanned");
  const images = workloadImages(value.images, "images");
  assertExactWorkloadImages(images, expected.releaseSubject.workloadImages, expected.checkId);
  zero(value.scanErrors, "scanErrors"); zero(value.high, "high"); zero(value.critical, "critical"); zero(value.exitCode, "exitCode");
  return { images: images.map((item) => ({ role: item.role, digest: item.digest })) };
}

function workloadImages(value, label) {
  const images = array(value, label, REQUIRED_WORKLOAD_ROLES.length, REQUIRED_WORKLOAD_ROLES.length).map((entry, index) => {
    const item = exactObject(entry, `${label}[${index}]`, ["role", "digest"]);
    identifier(item.role, `${label}[${index}].role`); ociDigest(item.digest, `${label}[${index}].digest`); return item;
  });
  const roles = images.map((item) => item.role);
  for (const required of REQUIRED_WORKLOAD_ROLES) if (!roles.includes(required)) throw new EvidenceContractError("DEPLOYMENT_REPORT_CONTENT_INVALID", `${label} is missing ${required}`);
  if (new Set(roles).size !== roles.length || new Set(images.map((item) => item.digest)).size !== images.length) throw new EvidenceContractError("DEPLOYMENT_REPORT_CONTENT_INVALID", `${label} roles and digests must be unique`);
  return images;
}

function assertExactWorkloadImages(actual, expected, label) {
  const normalizedActual = actual.map((item) => `${item.role}\0${item.digest}`).sort();
  const normalizedExpected = expected.map((item) => `${item.role}\0${item.digest}`).sort();
  if (!sameArray(normalizedActual, normalizedExpected)) invalidDeployment(label, "workload image set does not match the controlled release subject");
}

function storeDecision(value, expected, store) {
  exactFields(value, expected.approvalName, ["store", "applicationId", "accountId", "version", "buildSha256", "decisionId", "reviewEnvironment", "reviewedAt", "nativeReceiptVerificationPassed"]);
  if (value.store !== store || value.reviewEnvironment !== "production" || value.nativeReceiptVerificationPassed !== true) invalidApproval(expected.approvalName, "store, environment, or native verification does not match");
  for (const field of ["applicationId", "accountId", "version", "decisionId"]) visible(value[field], field, 256);
  digest(value.buildSha256, "buildSha256"); timestamp(value.reviewedAt, "reviewedAt");
  const application = expected.releaseSubject.applications[expected.approvalName];
  for (const field of ["store", "applicationId", "accountId", "version", "buildSha256"]) {
    if (value[field] !== application[field]) invalidApproval(expected.approvalName, `${field} does not match the released application build`);
  }
  if (Date.parse(value.reviewedAt) > Date.parse(expected.approvedAt)) invalidApproval(expected.approvalName, "store review occurred after the approval envelope");
}

function exactTool(value, producer, tool, checkId) {
  if (value.tool !== tool || value.toolVersion !== producer.version || producer.name !== tool) invalidDeployment(checkId, `must be produced by ${tool} with an exact version`);
  visible(value.toolVersion, "toolVersion", 128);
}

function boundedObjective(value, suffix, label) {
  const target = integer(value[`target${suffix}`], `target${suffix}`, 0);
  const observed = integer(value[`observed${suffix}`], `observed${suffix}`, 0);
  if (observed > target) throw new EvidenceContractError("DEPLOYMENT_REPORT_CONTENT_INVALID", `${label} observed ${suffix} exceeds its target`);
}

function allTrue(value, label, subject) {
  if (Object.values(value).some((item) => item !== true)) throw new EvidenceContractError("DEPLOYMENT_REPORT_CONTENT_INVALID", `${label} ${subject} are incomplete`);
}

function exactFields(value, label, fields) { return exactObject(value, `${label}.assertions`, fields); }

function exactObject(value, label, fields) {
  const result = object(value, label);
  const actual = Object.keys(result).sort(); const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new EvidenceContractError("EVIDENCE_CONTRACT_FIELDS_INVALID", `${label} fields do not match the closed contract`);
  return result;
}

function parseJson(bytes, label, code) {
  let serialized;
  try { serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new EvidenceContractError(code, `${label} is not valid UTF-8`); }
  let value;
  try { value = JSON.parse(serialized); } catch { throw new EvidenceContractError(code, `${label} is not valid JSON`); }
  return object(value, label);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new EvidenceContractError("EVIDENCE_CONTRACT_OBJECT_INVALID", `${label} must be an object`);
  return value;
}

function array(value, label, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new EvidenceContractError("EVIDENCE_CONTRACT_ARRAY_INVALID", `${label} must contain ${minimum}..${maximum} items`);
  return value;
}

function stringArray(value, label, minimum, maximum) {
  const values = array(value, label, minimum, maximum);
  if (values.some((item) => typeof item !== "string" || item.trim() !== item || item.length === 0 || item.length > 512 || /[\u0000-\u001f\u007f]/.test(item)) || new Set(values).size !== values.length) throw new EvidenceContractError("EVIDENCE_CONTRACT_ARRAY_INVALID", `${label} must contain unique visible strings`);
  return values;
}

function sortedStringArray(value, label, minimum, maximum) {
  return [...stringArray(value, label, minimum, maximum)].sort((left, right) => left.localeCompare(right));
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new EvidenceContractError("EVIDENCE_CONTRACT_IDENTIFIER_INVALID", `${label} is invalid`);
  return value;
}

function visible(value, label, maximum) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new EvidenceContractError("EVIDENCE_CONTRACT_TEXT_INVALID", `${label} is invalid`);
  return value;
}

function digest(value, label) { if (typeof value !== "string" || !SHA256.test(value)) throw new EvidenceContractError("EVIDENCE_CONTRACT_DIGEST_INVALID", `${label} must be a lowercase SHA-256 digest`); return value; }
function ociDigest(value, label) { if (typeof value !== "string" || !OCI_DIGEST.test(value)) throw new EvidenceContractError("EVIDENCE_CONTRACT_DIGEST_INVALID", `${label} must be an immutable sha256 OCI digest`); return value; }
function zero(value, label) { if (!Number.isSafeInteger(value) || value !== 0) throw new EvidenceContractError("EVIDENCE_CONTRACT_VALUE_INVALID", `${label} must be zero`); return value; }
function positive(value, label) { if (!Number.isSafeInteger(value) || value < 1) throw new EvidenceContractError("EVIDENCE_CONTRACT_VALUE_INVALID", `${label} must be a positive integer`); return value; }
function integer(value, label, minimum) { if (!Number.isSafeInteger(value) || value < minimum) throw new EvidenceContractError("EVIDENCE_CONTRACT_VALUE_INVALID", `${label} must be an integer >= ${minimum}`); return value; }

function timestamp(value, label) {
  if (typeof value !== "string") throw new EvidenceContractError("EVIDENCE_CONTRACT_TIMESTAMP_INVALID", `${label} must be a timestamp`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new EvidenceContractError("EVIDENCE_CONTRACT_TIMESTAMP_INVALID", `${label} must be RFC 3339 UTC`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new EvidenceContractError("EVIDENCE_CONTRACT_TIMESTAMP_INVALID", `${label} must be RFC 3339 UTC`);
  return value;
}

function httpsUrl(value, label) {
  let url; try { url = new URL(value); } catch { throw new EvidenceContractError("EVIDENCE_CONTRACT_URL_INVALID", `${label} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new EvidenceContractError("EVIDENCE_CONTRACT_URL_INVALID", `${label} must be credential-free HTTPS without a fragment`);
  return url.toString();
}

function serviceEndpoint(value, expectedPath, label, checkId) {
  const url = new URL(httpsUrl(value, label));
  if (url.pathname !== expectedPath || url.search !== "") {
    invalidDeployment(checkId, `${label} must use exact path ${expectedPath} without a query`);
  }
  return url;
}

function assertExactServiceEndpoint(value, expectedOrigin, expectedPath, label, checkId) {
  const url = serviceEndpoint(value, expectedPath, label, checkId);
  if (url.origin !== expectedOrigin.origin) invalidDeployment(checkId, `${label} does not target the controlled production API origin`);
}

function assertSuccessfulReadyProbe(value, label, checkId) {
  digest(value.responseSha256, `${label}.responseSha256`);
  if (value.statusCode !== 200 || value.ready !== true) invalidDeployment(checkId, `${label} did not return HTTP 200 ready=true`);
}

function assertAuthorityWindow(issuedAtValue, expiresAtValue, observedAtValue, label, checkId) {
  const issuedAt = Date.parse(timestamp(issuedAtValue, `${label}.issuedAt`));
  const expiresAt = Date.parse(timestamp(expiresAtValue, `${label}.expiresAt`));
  const observedAt = Date.parse(timestamp(observedAtValue, `${label}.observedAt`));
  if (issuedAt > observedAt || expiresAt <= observedAt || expiresAt <= issuedAt) {
    invalidDeployment(checkId, `${label} was not active at probe time`);
  }
}

function httpsOrigin(value, label) {
  const url = new URL(httpsUrl(value, label));
  if (url.pathname !== "/" || url.search) throw new EvidenceContractError("EVIDENCE_CONTRACT_URL_INVALID", `${label} must be an HTTPS origin`);
  return url.toString();
}

function publicHttpsOrigin(value, label) {
  const url = new URL(httpsOrigin(value, label));
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const reservedSuffixes = [".localhost", ".local", ".test", ".invalid", ".example"];
  const reservedExamples = ["example.com", "example.net", "example.org"];
  if (
    isIP(hostname) !== 0 ||
    !hostname.includes(".") ||
    hostname === "localhost" ||
    reservedSuffixes.some((suffix) => hostname.endsWith(suffix)) ||
    reservedExamples.some((name) => hostname === name || hostname.endsWith(`.${name}`)) ||
    (url.port !== "" && url.port !== "443")
  ) throw new EvidenceContractError("EVIDENCE_CONTRACT_URL_INVALID", `${label} must be a public DNS HTTPS origin`);
  return url.toString();
}

function absoluteUri(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new EvidenceContractError("EVIDENCE_CONTRACT_URL_INVALID", `${label} must be an absolute URI`); }
  if (url.protocol.length < 2 || url.username || url.password || url.hash) throw new EvidenceContractError("EVIDENCE_CONTRACT_URL_INVALID", `${label} must be a credential-free absolute URI without a fragment`);
  return url.toString();
}

function validAlgorithmDigest(algorithm, content, dashed) {
  const lengths = dashed
    ? { "SHA-256": 64, "SHA-384": 96, "SHA-512": 128 }
    : { SHA256: 64, SHA384: 96, SHA512: 128 };
  return Number.isSafeInteger(lengths[algorithm]) && new RegExp(`^[a-fA-F0-9]{${lengths[algorithm]}}$`).test(content);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function invalidDeployment(checkId, message) { throw new EvidenceContractError("DEPLOYMENT_REPORT_CONTENT_INVALID", `${checkId} ${message}`); }
function invalidApproval(name, message) { throw new EvidenceContractError("APPROVAL_ARTIFACT_CONTENT_INVALID", `${name} ${message}`); }
function sbomInvalid(message) { throw new EvidenceContractError("SBOM_CONTENT_INVALID", message); }
function subjectInvalid(message) { throw new EvidenceContractError("RELEASE_SUBJECT_INVALID", message); }
