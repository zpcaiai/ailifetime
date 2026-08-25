import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSupplyChainBundle } from "../security/supply-chain.mjs";
import {
  CONTROL_ARTIFACT_AUTHORITY_ROLES,
  REQUIRED_SCHEMA5_FORCE_RLS_TABLES,
  SUPPLY_CHAIN_AUTHORITY_ROLE,
  validateProductionReleaseSubject,
} from "./production-evidence-contracts.mjs";
import {
  CONTROL_ARTIFACT_ATTESTATION_SCHEMA_VERSION,
  REQUIRED_B127_MONITORING_DOMAINS,
  REQUIRED_B127_MONITORING_SIGNALS,
  REQUIRED_B127_ROLLBACK_SCOPES,
  REQUIRED_B127_ROLLBACK_VERIFICATIONS,
  controlArtifactAttestationScope,
  controlArtifactAttestationSigningBytes,
  waveObservationArtifactSetSha256,
} from "./b127-release-controls.mjs";

const DEFAULT_WAVES = Object.freeze([
  Object.freeze({ wave: "internal", rolloutPercent: 1, startedAt: "2026-08-19T20:00:00.000Z", completedAt: "2026-08-19T21:00:00.000Z" }),
  Object.freeze({ wave: "pilot", rolloutPercent: 2, startedAt: "2026-08-19T21:00:00.000Z", completedAt: "2026-08-19T22:00:00.000Z" }),
  Object.freeze({ wave: "consumer_canary", rolloutPercent: 5, startedAt: "2026-08-19T22:00:00.000Z", completedAt: "2026-08-19T23:00:00.000Z" }),
  Object.freeze({ wave: "partner", rolloutPercent: 10, startedAt: "2026-08-19T23:00:00.000Z", completedAt: "2026-08-20T00:00:00.000Z" }),
  Object.freeze({ wave: "regional", rolloutPercent: 25, startedAt: "2026-08-20T00:00:00.000Z", completedAt: "2026-08-20T01:00:00.000Z" }),
]);

export function createB127ReleaseControlFixtures({
  artifact,
  tenantId,
  launchId,
  deploymentId,
  repositoryCommit,
  componentSetSha256,
  automaticPausePolicyVersion,
  rollbackExerciseId,
  waves = DEFAULT_WAVES,
  idPrefix = "ltm",
  mutateWaveObservation,
  mutateRollbackDrill,
  mutateGuardrailPolicy,
  mutateControlAttestationBeforeSign,
  mutateControlAttestation,
  reuseControlSignerIdentity,
  reuseEvidenceIdentityAcrossWaves = false,
}) {
  const controls = REQUIRED_B127_MONITORING_DOMAINS.map((domain) => {
    const signal = REQUIRED_B127_MONITORING_SIGNALS[domain];
    return {
      domain,
      signalId: signal.signalId,
      unit: signal.unit,
      comparator: "lte",
      threshold: signal.unit === "count" ? 0 : signal.unit === "minor_currency" ? 5_000 : 0.05,
    };
  });
  const guardrailPolicy = {
    schemaVersion: "ltm.rollout-guardrail-policy.v1",
    policyId: `${idPrefix}-production-guardrails`,
    policyVersion: automaticPausePolicyVersion,
    releaseId: launchId,
    tenantId,
    launchId,
    deploymentId,
    repositoryCommit,
    componentSetSha256,
    controls,
    controlSetSha256: sha256(Buffer.from(canonicalJson(controls), "utf8")),
    producer: {
      name: "ltm-production-guardrail-authority",
      version: "1.0.0",
      invocationId: `${idPrefix}-guardrail-policy-run`,
    },
  };
  mutateGuardrailPolicy?.(guardrailPolicy);
  const guardrailPolicyArtifact = artifact("release/policies/rollout-guardrails.json", guardrailPolicy);
  const observationArtifacts = new Map();
  const rawObservationArtifacts = new Map();
  const controlAttestationArtifacts = new Map();
  const controlSignerTypes = ["monitoring_query", "monitoring_result", "pause_command", "pause_receipt"];
  const controlSignerProfiles = Object.fromEntries(controlSignerTypes.map((artifactType) => {
    const pair = generateKeyPairSync("ed25519");
    return [artifactType, {
      issuer: `${idPrefix}-${artifactType.replaceAll("_", "-")}-producer`,
      keyId: `${idPrefix}-${artifactType.replaceAll("_", "-")}-key`,
      privateKey: pair.privateKey,
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    }];
  }));
  for (const [left, right] of reuseControlSignerIdentity === "query_result"
    ? [["monitoring_query", "monitoring_result"]]
    : reuseControlSignerIdentity === "command_receipt"
      ? [["pause_command", "pause_receipt"]]
      : []) {
    controlSignerProfiles[right] = { ...controlSignerProfiles[left] };
  }
  const controlProviderByType = {
    monitoring_query: `monitoring-query:${deploymentId}`,
    monitoring_result: `monitoring-result:${deploymentId}`,
    pause_command: `rollout-controller:${deploymentId}`,
    pause_receipt: `rollout-actuator:${deploymentId}`,
  };
  const controlScopesByType = Object.fromEntries(controlSignerTypes.map((artifactType) => [artifactType, new Set()]));
  const earliestWaveStart = Math.min(...waves.map((wave) => Date.parse(wave.startedAt)));
  const latestWaveEnd = Math.max(...waves.map((wave) => Date.parse(wave.completedAt)));
  const controlTrustNotBefore = new Date(earliestWaveStart - 60 * 60_000).toISOString();
  const controlTrustNotAfter = new Date(latestWaveEnd + 48 * 60 * 60_000).toISOString();
  const controlAttestationExpiresAt = new Date(latestWaveEnd + 24 * 60 * 60_000).toISOString();

  const attestControlArtifact = ({ artifactType, wave, domain, rawArtifact, claims }) => {
    const signer = controlSignerProfiles[artifactType];
    const unsigned = {
      schemaVersion: CONTROL_ARTIFACT_ATTESTATION_SCHEMA_VERSION,
      attestationId: `${idPrefix}-${wave}-${domain}-${artifactType.replaceAll("_", "-")}-attestation`,
      nonce: `${idPrefix}-${wave}-${domain}-${artifactType.replaceAll("_", "-")}-nonce`,
      issuer: signer.issuer,
      provider: controlProviderByType[artifactType],
      environment: "production",
      authorityRole: CONTROL_ARTIFACT_AUTHORITY_ROLES[artifactType],
      algorithm: "Ed25519",
      keyId: signer.keyId,
      issuedAt: claims.eventAt,
      expiresAt: controlAttestationExpiresAt,
      scope: "pending",
      claims,
    };
    mutateControlAttestationBeforeSign?.(artifactType, wave, domain, unsigned);
    unsigned.scope = controlArtifactAttestationScope(unsigned.claims);
    const document = {
      ...unsigned,
      signature: sign(null, controlArtifactAttestationSigningBytes(unsigned), signer.privateKey).toString("base64url"),
    };
    mutateControlAttestation?.(artifactType, wave, domain, document);
    const pathSuffix = artifactType.replaceAll("_", "-");
    const attestationArtifact = artifact(
      `release/waves/${wave}/attestations/${domain}-${pathSuffix}.json`,
      document,
    );
    controlScopesByType[artifactType].add(document.scope);
    controlAttestationArtifacts.set(`${wave}:${domain}:${artifactType}`, attestationArtifact);
    return {
      ...rawArtifact.reference,
      attestation: attestationArtifact.reference,
    };
  };
  const completedWaves = waves.map((wave, waveIndex) => {
    const measurements = REQUIRED_B127_MONITORING_DOMAINS.map((domain, domainIndex) => {
      const signal = REQUIRED_B127_MONITORING_SIGNALS[domain];
      const threshold = signal.unit === "count" ? 0 : signal.unit === "minor_currency" ? 5_000 : 0.05;
      const observedValue = signal.unit === "count" ? 0 : signal.unit === "minor_currency" ? 3_200 : 0.01;
      const queryId = reuseEvidenceIdentityAcrossWaves && waveIndex === 1 && domainIndex === 0
        ? `${idPrefix}-internal-quality-query`
        : `${idPrefix}-${wave.wave}-${domain}-query`;
      const resultId = reuseEvidenceIdentityAcrossWaves && waveIndex === 1 && domainIndex === 0
        ? `${idPrefix}-internal-quality-result`
        : `${idPrefix}-${wave.wave}-${domain}-result`;
      const query = artifact(`release/waves/${wave.wave}/raw/${domain}-query.json`, {
        schemaVersion: "ltm.rollout-monitoring-query.v1",
        queryId,
        releaseId: launchId,
        tenantId,
        launchId,
        deploymentId,
        repositoryCommit,
        componentSetSha256,
        guardrailPolicySha256: guardrailPolicyArtifact.reference.sha256,
        wave: wave.wave,
        domain,
        signalId: signal.signalId,
        unit: signal.unit,
        windowStart: wave.startedAt,
        windowEnd: wave.completedAt,
        queryLanguage: domain === "ledger" ? "sql" : "promql",
        queryText: domain === "ledger" ? `SELECT ledger_unbalanced_count FROM production_metrics WHERE wave = '${wave.wave}'` : `${signal.signalId}{release_id=\"${launchId}\",wave=\"${wave.wave}\"}`,
      });
      const result = artifact(`release/waves/${wave.wave}/raw/${domain}-result.json`, {
        schemaVersion: "ltm.rollout-monitoring-result.v1",
        resultId,
        queryId,
        queryArtifactSha256: query.reference.sha256,
        releaseId: launchId,
        tenantId,
        launchId,
        deploymentId,
        repositoryCommit,
        componentSetSha256,
        guardrailPolicySha256: guardrailPolicyArtifact.reference.sha256,
        wave: wave.wave,
        domain,
        signalId: signal.signalId,
        unit: signal.unit,
        windowStart: wave.startedAt,
        windowEnd: wave.completedAt,
        observedValue,
        sampleCount: 1_000 + waveIndex * 100 + domainIndex,
        threshold,
        status: "complete",
        producedAt: new Date(Date.parse(wave.completedAt) - 5 * 60_000).toISOString(),
      });
      const queryReference = attestControlArtifact({
        artifactType: "monitoring_query",
        wave: wave.wave,
        domain,
        rawArtifact: query,
        claims: controlArtifactClaims({
          artifactType: "monitoring_query",
          artifactId: queryId,
          artifactSha256: query.reference.sha256,
          relatedArtifactSha256: null,
          tenantId,
          launchId,
          deploymentId,
          repositoryCommit,
          componentSetSha256,
          guardrailPolicySha256: guardrailPolicyArtifact.reference.sha256,
          wave,
          domain,
          signalId: signal.signalId,
          unit: signal.unit,
          eventAt: wave.startedAt,
          threshold,
          observedValue: null,
          state: "query_defined",
        }),
      });
      const resultReference = attestControlArtifact({
        artifactType: "monitoring_result",
        wave: wave.wave,
        domain,
        rawArtifact: result,
        claims: controlArtifactClaims({
          artifactType: "monitoring_result",
          artifactId: resultId,
          artifactSha256: result.reference.sha256,
          relatedArtifactSha256: query.reference.sha256,
          tenantId,
          launchId,
          deploymentId,
          repositoryCommit,
          componentSetSha256,
          guardrailPolicySha256: guardrailPolicyArtifact.reference.sha256,
          wave,
          domain,
          signalId: signal.signalId,
          unit: signal.unit,
          eventAt: new Date(Date.parse(wave.completedAt) - 5 * 60_000).toISOString(),
          threshold,
          observedValue,
          state: "result_complete",
        }),
      });
      rawObservationArtifacts.set(`${wave.wave}:${domain}:query`, query);
      rawObservationArtifacts.set(`${wave.wave}:${domain}:result`, result);
      return {
        domain,
        signalId: signal.signalId,
        unit: signal.unit,
        comparator: "lte",
        threshold,
        observedValue,
        sampleCount: 1_000 + waveIndex * 100 + domainIndex,
        queryArtifact: queryReference,
        resultArtifact: resultReference,
        conclusion: "within_threshold",
      };
    });
    const commandIssuedAt = new Date(Date.parse(wave.startedAt) + 10 * 60_000).toISOString();
    const commandAcknowledgedAt = new Date(Date.parse(wave.startedAt) + 11 * 60_000).toISOString();
    const pauseCommandId = `${idPrefix}-${wave.wave}-pause-command`;
    const pauseDrillId = `${idPrefix}-${wave.wave}-pause-drill`;
    const pauseCommand = artifact(`release/waves/${wave.wave}/raw/pause-command.json`, {
      schemaVersion: "ltm.rollout-pause-command.v1",
      commandId: pauseCommandId,
      releaseId: launchId,
      tenantId,
      launchId,
      deploymentId,
      repositoryCommit,
      componentSetSha256,
      guardrailPolicySha256: guardrailPolicyArtifact.reference.sha256,
      wave: wave.wave,
      drillId: pauseDrillId,
      domain: "slo",
      signalId: REQUIRED_B127_MONITORING_SIGNALS.slo.signalId,
      threshold: 0.05,
      observedValue: 0.1,
      action: "pause_wave",
      issuedAt: commandIssuedAt,
      status: "issued",
    });
    const pauseReceipt = artifact(`release/waves/${wave.wave}/raw/pause-receipt.json`, {
      schemaVersion: "ltm.rollout-pause-receipt.v1",
      receiptId: `${idPrefix}-${wave.wave}-pause-receipt`,
      commandId: pauseCommandId,
      commandArtifactSha256: pauseCommand.reference.sha256,
      releaseId: launchId,
      tenantId,
      launchId,
      deploymentId,
      repositoryCommit,
      componentSetSha256,
      guardrailPolicySha256: guardrailPolicyArtifact.reference.sha256,
      wave: wave.wave,
      drillId: pauseDrillId,
      domain: "slo",
      signalId: REQUIRED_B127_MONITORING_SIGNALS.slo.signalId,
      threshold: 0.05,
      observedValue: 0.1,
      acknowledgedAt: commandAcknowledgedAt,
      resultingState: "paused",
    });
    const pauseCommandReference = attestControlArtifact({
      artifactType: "pause_command",
      wave: wave.wave,
      domain: "slo",
      rawArtifact: pauseCommand,
      claims: controlArtifactClaims({
        artifactType: "pause_command",
        artifactId: pauseCommandId,
        artifactSha256: pauseCommand.reference.sha256,
        relatedArtifactSha256: null,
        tenantId,
        launchId,
        deploymentId,
        repositoryCommit,
        componentSetSha256,
        guardrailPolicySha256: guardrailPolicyArtifact.reference.sha256,
        wave,
        domain: "slo",
        signalId: REQUIRED_B127_MONITORING_SIGNALS.slo.signalId,
        unit: REQUIRED_B127_MONITORING_SIGNALS.slo.unit,
        eventAt: commandIssuedAt,
        threshold: 0.05,
        observedValue: 0.1,
        state: "pause_issued",
      }),
    });
    const pauseReceiptReference = attestControlArtifact({
      artifactType: "pause_receipt",
      wave: wave.wave,
      domain: "slo",
      rawArtifact: pauseReceipt,
      claims: controlArtifactClaims({
        artifactType: "pause_receipt",
        artifactId: `${idPrefix}-${wave.wave}-pause-receipt`,
        artifactSha256: pauseReceipt.reference.sha256,
        relatedArtifactSha256: pauseCommand.reference.sha256,
        tenantId,
        launchId,
        deploymentId,
        repositoryCommit,
        componentSetSha256,
        guardrailPolicySha256: guardrailPolicyArtifact.reference.sha256,
        wave,
        domain: "slo",
        signalId: REQUIRED_B127_MONITORING_SIGNALS.slo.signalId,
        unit: REQUIRED_B127_MONITORING_SIGNALS.slo.unit,
        eventAt: commandAcknowledgedAt,
        threshold: 0.05,
        observedValue: 0.1,
        state: "pause_acknowledged",
      }),
    });
    rawObservationArtifacts.set(`${wave.wave}:pause-command`, pauseCommand);
    rawObservationArtifacts.set(`${wave.wave}:pause-receipt`, pauseReceipt);
    const report = {
      schemaVersion: "ltm.rollout-wave-observation.v1",
      reportId: `${idPrefix}-${wave.wave}-observation-v1`,
      releaseId: launchId,
      tenantId,
      launchId,
      deploymentId,
      repositoryCommit,
      componentSetSha256,
      guardrailPolicySha256: guardrailPolicyArtifact.reference.sha256,
      wave: wave.wave,
      rolloutPercent: wave.rolloutPercent,
      monitoringWindow: {
        startedAt: wave.startedAt,
        endedAt: wave.completedAt,
        minimumObservationSeconds: 3_600,
        observedSeconds: 3_600,
        collectionIntervalSeconds: 60,
      },
      automaticPausePolicy: {
        policyVersion: automaticPausePolicyVersion,
        action: "pause_wave",
        evaluationMode: "server_side",
        evaluatedAt: new Date(Date.parse(wave.completedAt) - 15 * 60_000).toISOString(),
        drill: {
          drillId: pauseDrillId,
          injectedDomain: "slo",
          signalId: REQUIRED_B127_MONITORING_SIGNALS.slo.signalId,
          threshold: 0.05,
          observedValue: 0.1,
          pauseCommandId,
          commandIssuedAt,
          commandAcknowledgedAt,
          commandArtifact: pauseCommandReference,
          receiptArtifact: pauseReceiptReference,
          conclusion: "paused",
        },
      },
      measurements,
      measurementSetSha256: sha256(Buffer.from(canonicalJson(measurements), "utf8")),
      conclusion: { status: "passed", decision: "continue", breachCount: 0 },
      producer: {
        name: "ltm-production-wave-observer",
        version: "1.0.0",
        invocationId: `${idPrefix}-${wave.wave}-observer-run`,
      },
    };
    mutateWaveObservation?.(wave.wave, report);
    const observationArtifact = artifact(`release/waves/${wave.wave}-observation.json`, report);
    observationArtifacts.set(wave.wave, observationArtifact);
    return {
      wave: wave.wave,
      status: "passed",
      rolloutPercent: wave.rolloutPercent,
      startedAt: wave.startedAt,
      completedAt: wave.completedAt,
      minimumObservationSeconds: 3_600,
      observedSeconds: 3_600,
      guardrailBreaches: 0,
      observationArtifact: observationArtifact.reference,
    };
  });
  const waveObservationSetSha256 = waveObservationArtifactSetSha256(
    completedWaves.map((wave) => ({ wave: wave.wave, sha256: wave.observationArtifact.sha256 })),
  );

  const scopes = REQUIRED_B127_ROLLBACK_SCOPES.map((scope, scopeIndex) => {
    const baselineStateSha256 = sha256(Buffer.from(`${idPrefix}:${scope}:release-state`));
    const rollbackStartedAt = new Date(Date.parse("2026-08-19T18:00:00.000Z") + scopeIndex * 5 * 60_000).toISOString();
    const rollbackCompletedAt = new Date(Date.parse(rollbackStartedAt) + 60_000).toISOString();
    const forwardStartedAt = new Date(Date.parse(rollbackCompletedAt) + 60_000).toISOString();
    const forwardCompletedAt = new Date(Date.parse(forwardStartedAt) + 60_000).toISOString();
    return {
      scope,
      targetId: `${idPrefix}-${scope}-target`,
      fromVersion: "2.0.0",
      rollbackVersion: "1.9.0",
      forwardVersion: "2.0.0",
      baselineStateSha256,
      rollback: {
        operationId: `${idPrefix}-${scope}-rollback`,
        startedAt: rollbackStartedAt,
        completedAt: rollbackCompletedAt,
        result: "passed",
        stateSha256: sha256(Buffer.from(`${idPrefix}:${scope}:rollback-state`)),
        evidenceSha256: sha256(Buffer.from(`${idPrefix}:${scope}:rollback-evidence`)),
      },
      forward: {
        operationId: `${idPrefix}-${scope}-forward`,
        startedAt: forwardStartedAt,
        completedAt: forwardCompletedAt,
        result: "passed",
        stateSha256: baselineStateSha256,
        evidenceSha256: sha256(Buffer.from(`${idPrefix}:${scope}:forward-evidence`)),
      },
      verifications: REQUIRED_B127_ROLLBACK_VERIFICATIONS[scope].map((checkId) => {
        const resultSha256 = sha256(Buffer.from(`${idPrefix}:${scope}:${checkId}:expected-result`));
        return {
          checkId,
          expectedSha256: resultSha256,
          observedSha256: resultSha256,
          evidenceSha256: sha256(Buffer.from(`${idPrefix}:${scope}:${checkId}:raw-evidence`)),
          conclusion: "passed",
        };
      }),
      conclusion: "passed",
    };
  });
  const rollbackForwardDrill = {
    schemaVersion: "ltm.rollback-forward-drill.v1",
    reportId: `${idPrefix}-rollback-forward-report-v1`,
    exerciseId: rollbackExerciseId,
    releaseId: launchId,
    tenantId,
    launchId,
    deploymentId,
    repositoryCommit,
    componentSetSha256,
    startedAt: "2026-08-19T18:00:00.000Z",
    completedAt: "2026-08-19T19:00:00.000Z",
    scopes,
    scopeSetSha256: sha256(Buffer.from(canonicalJson(scopes), "utf8")),
    conclusion: {
      status: "passed",
      decision: "release_compatible",
      failedScopes: [],
      dataLossEvents: 0,
    },
    producer: {
      name: "ltm-production-rollback-verifier",
      version: "1.0.0",
      invocationId: `${idPrefix}-rollback-forward-run`,
    },
  };
  mutateRollbackDrill?.(rollbackForwardDrill);
  const rollbackForwardDrillArtifact = artifact(
    "release/evidence/rollback-forward-drill.json",
    rollbackForwardDrill,
  );
  const controlArtifactTrustedKeys = controlSignerTypes.map((artifactType) => ({
    issuer: controlSignerProfiles[artifactType].issuer,
    provider: controlProviderByType[artifactType],
    keyId: controlSignerProfiles[artifactType].keyId,
    algorithm: "Ed25519",
    publicKeyPem: controlSignerProfiles[artifactType].publicKeyPem,
    allowedScopes: [...controlScopesByType[artifactType]].sort(),
    allowedEnvironments: ["production"],
    authorityRoles: [CONTROL_ARTIFACT_AUTHORITY_ROLES[artifactType]],
    notBefore: controlTrustNotBefore,
    notAfter: controlTrustNotAfter,
  }));
  return {
    guardrailPolicyArtifact,
    completedWaves,
    waveObservationSetSha256,
    observationArtifacts,
    rawObservationArtifacts,
    controlAttestationArtifacts,
    controlArtifactTrustedKeys,
    rollbackForwardDrillArtifact,
  };
}

function controlArtifactClaims({
  artifactType,
  artifactId,
  artifactSha256,
  relatedArtifactSha256,
  tenantId,
  launchId,
  deploymentId,
  repositoryCommit,
  componentSetSha256,
  guardrailPolicySha256,
  wave,
  domain,
  signalId,
  unit,
  eventAt,
  threshold,
  observedValue,
  state,
}) {
  return {
    artifactType,
    artifactId,
    artifactSha256,
    relatedArtifactSha256,
    releaseId: launchId,
    tenantId,
    launchId,
    deploymentId,
    repositoryCommit,
    componentSetSha256,
    guardrailPolicySha256,
    wave: wave.wave,
    domain,
    signalId,
    unit,
    windowStart: wave.startedAt,
    windowEnd: wave.completedAt,
    eventAt,
    threshold,
    observedValue,
    state,
  };
}

export function createB127ReleaseSubjectFixture({
  root,
  artifact,
  componentVersions,
  componentSetSha256,
  selectedProfile,
  repositoryCommit,
  targetBaseUrl,
  deploymentId,
  goLive,
  guardrailPolicySha256,
  waveObservationSetSha256,
  rollbackForwardDrillSha256,
  idPrefix = "ltm",
}) {
  const dependencyIntegrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
  const lockfileBytes = Buffer.from(`lockfileVersion: '9.0'\n\npackages:\n\n  'safe-lib@1.2.3':\n    resolution: {integrity: ${dependencyIntegrity}}\n\nsnapshots:\n`);
  writeFileSync(join(root, "pnpm-lock.yaml"), lockfileBytes, { mode: 0o600 });

  const migrationDirectory = join(root, "infra/postgres/migrations");
  mkdirSync(migrationDirectory, { recursive: true, mode: 0o700 });
  const fixtureMigrations = [
    ["001", "001_core.sql"],
    ["002", "002_external_evidence.sql"],
    ["003", "003_runtime_compatibility.sql"],
    ["004", "004_external_business_events.sql"],
    ["005", "005_participant_authority_and_processing_purpose.sql"],
  ].map(([id, path]) => {
    const bytes = Buffer.from(`BEGIN;\nSELECT '${id}'::text;\nCOMMIT;\n`);
    writeFileSync(join(migrationDirectory, path), bytes, { mode: 0o600 });
    return { id, path, sha256: sha256(bytes) };
  });
  const migrationManifestBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: "ltm.postgres-migration-manifest.v1",
    database: "postgresql",
    runtimeSchemaVersion: "5",
    migrations: fixtureMigrations,
  }, null, 2)}\n`);
  writeFileSync(join(migrationDirectory, "manifest.json"), migrationManifestBytes, { mode: 0o600 });

  const supplyChainPair = generateKeyPairSync("ed25519");
  const supplyChainBundle = generateSupplyChainBundle({
    root,
    privateKeyPem: supplyChainPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    artifactPaths: ["release/components"],
    licenses: { MIT: [{ name: "safe-lib", versions: ["1.2.3"], license: "MIT" }] },
    sourceDateEpoch: 1_700_000_000,
    environment: "production",
    trustTier: "production",
    sourceRevision: repositoryCommit,
  });
  const supplyChainArtifact = artifact("release/supply-chain-bundle.json", supplyChainBundle);
  const sbom = artifact("release.sbom.json", supplyChainBundle.cycloneDx);

  const workloadImages = ["api", "workers", "integration-gateway", "client-integration-broker", "migrator"]
    .map((role, index) => ({ role, digest: `sha256:${String(index + 1).repeat(64)}` }));
  const requiredProviderIds = ["apple-store-production", "wechat-pay-production"].sort();
  const secretReferences = [
    "arn:aws:secretsmanager:cn-north-1:000000000000:secret:ltm/production/api",
    "arn:aws:secretsmanager:cn-north-1:000000000000:secret:ltm/production/database-url",
  ].sort();
  const forcedRlsTables = [...REQUIRED_SCHEMA5_FORCE_RLS_TABLES];
  const consentPolicyCatalogSha256 = sha256(Buffer.from(`${idPrefix}:consent-policy-catalog:v1`));
  const mediaLifecycleCatalogSha256 = sha256(Buffer.from(`${idPrefix}:media-lifecycle-catalog:v1`));
  const mediaSafetyPolicySha256 = sha256(Buffer.from(`${idPrefix}:media-safety-policy:v1`));
  const lifecycleExpiresAt = new Date(Date.parse(goLive.windowEnd) + 7 * 24 * 60 * 60_000).toISOString();
  const mediaAuthority = {
    schemaVersion: "ltm.media-authority.v1",
    mediaLifecycleCatalogSha256,
    mediaSafetyPolicySha256,
    lifecycleIssuer: `${idPrefix}-media-lifecycle-authority`,
    lifecycleEnvironment: "production",
    lifecycleExpiresAt,
    scannerProvider: "production-media-safety-scanner",
    scannerPolicyId: `${idPrefix}-media-safety-policy-v1`,
    scannerModelVersion: "production-v1",
    scannerKeyId: `${idPrefix}-media-safety-key-v1`,
    scannerEnvironment: "production",
  };
  // Preserve the exact bytes returned by the authenticated broker authority endpoint.
  const mediaAuthorityArtifact = artifact(
    "release/evidence/media-authority.json",
    Buffer.from(JSON.stringify(mediaAuthority), "utf8"),
  );
  const pentestReport = artifact("release/evidence/pentest-report.json", { engagementId: `${idPrefix}-pentest`, status: "passed" });
  const findingRegistry = artifact("release/evidence/pentest-findings.json", { engagementId: `${idPrefix}-pentest`, unresolvedCritical: 0, unresolvedHigh: 0 });
  const drReport = artifact("release/evidence/disaster-recovery.json", { exerciseId: `${idPrefix}-dr`, status: "passed" });
  const accessibility = {
    standard: "WCAG-2.2-AA",
    platforms: ["android", "ios", "web"],
    browsers: ["chrome", "firefox", "safari"],
    assistiveTechnologies: ["nvda", "talkback", "voiceover"],
    journeys: ["capture", "checkout", "generation", "signup", "support"],
  };
  const applications = {
    appleAppStoreDecision: { store: "apple-app-store", applicationId: `com.ailifetime.${idPrefix}.ios`, accountId: `${idPrefix}-apple-production`, version: componentVersions.mobileIos.version, buildSha256: componentVersions.mobileIos.artifact.sha256 },
    googlePlayDecision: { store: "google-play", applicationId: `com.ailifetime.${idPrefix}.android`, accountId: `${idPrefix}-google-production`, version: componentVersions.mobileAndroid.version, buildSha256: componentVersions.mobileAndroid.artifact.sha256 },
    wechatMiniProgramDecision: { store: "wechat-mini-program", applicationId: `wx${idPrefix}prod`, accountId: `${idPrefix}-wechat-production`, version: componentVersions.wechatMiniProgram.version, buildSha256: componentVersions.wechatMiniProgram.artifact.sha256 },
  };
  const releaseSubject = validateProductionReleaseSubject({
    schemaVersion: "ltm.production-release-subject.v1",
    deploymentId,
    targetBaseUrl,
    repositoryCommit,
    profileVersion: selectedProfile.version,
    componentSetSha256,
    lockfileSha256: sha256(lockfileBytes),
    migrationManifestSha256: sha256(migrationManifestBytes),
    consentPolicyCatalogSha256,
    mediaLifecycleCatalogSha256,
    mediaSafetyPolicySha256,
    guardrailPolicySha256,
    waveObservationSetSha256,
    rollbackForwardDrillSha256,
    workloadImages,
    requiredProviderIds,
    secretReferences,
    forcedRlsTables,
    databaseUrlReference: "secrets-manager:ltm/production/database-url",
    legal: { legalEntityId: `${idPrefix}-legal-entity`, jurisdictions: ["CN", "EU", "US"] },
    accessibility,
    applications,
    penetrationTest: { targetOrigin: targetBaseUrl, reportArtifactSha256: pentestReport.reference.sha256, findingRegistrySha256: findingRegistry.reference.sha256 },
    disasterRecovery: { deploymentId, reportArtifactSha256: drReport.reference.sha256, sourceRegion: "cn-east-1", failoverRegion: "cn-north-1", schemaVersion: "5", targetRtoSeconds: 900, targetRpoSeconds: 300 },
    goLive,
    supplyChain: { bundleSha256: supplyChainArtifact.reference.sha256, provenanceSha256: supplyChainBundle.attestation.claims.documents.provenance.sha256, trustKeyId: supplyChainBundle.attestation.keyId },
  });
  const releaseSubjectConfig = {
    schemaVersion: "ltm.production-release-subject-config.v1",
    deploymentId,
    targetBaseUrl,
    workloadImages,
    requiredProviderIds,
    secretReferences,
    forcedRlsTables,
    consentPolicyCatalogSha256,
    mediaLifecycleCatalogSha256,
    mediaSafetyPolicySha256,
    guardrailPolicySha256,
    waveObservationSetSha256,
    rollbackForwardDrillSha256,
    mediaAuthorityArtifact: mediaAuthorityArtifact.reference,
    databaseUrlReference: releaseSubject.databaseUrlReference,
    legal: releaseSubject.legal,
    accessibility,
    applications: Object.fromEntries(Object.entries(applications).map(([name, application]) => [name, { applicationId: application.applicationId, accountId: application.accountId }])),
    penetrationTest: { reportArtifact: pentestReport.reference, findingRegistryArtifact: findingRegistry.reference },
    disasterRecovery: { reportArtifact: drReport.reference, sourceRegion: "cn-east-1", failoverRegion: "cn-north-1", schemaVersion: "5", targetRtoSeconds: 900, targetRpoSeconds: 300 },
    supplyChain: { bundleArtifact: supplyChainArtifact.reference, trustedKeyId: supplyChainBundle.attestation.keyId },
  };
  return {
    sbom,
    supplyChainBundle,
    releaseSubject,
    releaseSubjectConfig,
    mediaAuthorityArtifact,
    supplyChainTrustedKey: {
      issuer: "production-supply-chain",
      provider: "supply-chain:production-build",
      keyId: supplyChainBundle.attestation.keyId,
      publicKeyPem: supplyChainPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      scope: "ltm-supply-chain:production",
      authorityRoles: [SUPPLY_CHAIN_AUTHORITY_ROLE],
    },
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
