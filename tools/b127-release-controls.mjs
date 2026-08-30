import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const REQUIRED_B127_MONITORING_SIGNALS = Object.freeze({
  quality: Object.freeze({ signalId: "generation_failure_rate", unit: "ratio" }),
  payment: Object.freeze({ signalId: "payment_failure_rate", unit: "ratio" }),
  refund: Object.freeze({ signalId: "refund_failure_rate", unit: "ratio" }),
  message: Object.freeze({ signalId: "message_delivery_failure_rate", unit: "ratio" }),
  support: Object.freeze({ signalId: "support_sla_breach_rate", unit: "ratio" }),
  ledger: Object.freeze({ signalId: "ledger_unbalanced_count", unit: "count" }),
  supply: Object.freeze({ signalId: "vendor_sla_breach_rate", unit: "ratio" }),
  privacy: Object.freeze({ signalId: "privacy_control_violation_count", unit: "count" }),
  security: Object.freeze({ signalId: "unresolved_high_or_critical_count", unit: "count" }),
  cost: Object.freeze({ signalId: "cost_per_successful_order_minor", unit: "minor_currency" }),
  slo: Object.freeze({ signalId: "availability_error_budget_burn_rate", unit: "ratio" }),
});

const MAXIMUM_VALUE_BY_UNIT = Object.freeze({
  ratio: 1,
  count: 1_000_000_000,
  minor_currency: 1_000_000_000_000,
});

export const REQUIRED_B127_MONITORING_DOMAINS = Object.freeze(
  Object.keys(REQUIRED_B127_MONITORING_SIGNALS),
);

export const CONTROL_ARTIFACT_ATTESTATION_SCHEMA_VERSION = "ltm.control-artifact-attestation.v1";

export function controlArtifactAttestationScope(claims) {
  return `ltm-control-artifact:v1:${sha256(Buffer.from(canonicalJson(claims), "utf8"))}`;
}

export function controlArtifactAttestationSigningBytes(unsignedAttestation) {
  return Buffer.from(canonicalJson(unsignedAttestation), "utf8");
}

export const REQUIRED_B127_ROLLBACK_VERIFICATIONS = Object.freeze({
  application: Object.freeze(["health", "api_contract", "idempotency"]),
  configuration: Object.freeze(["config_digest", "policy_enforcement", "feature_flag_state"]),
  model: Object.freeze(["model_version", "model_provenance", "ai_output_label"]),
  workflow: Object.freeze(["inflight_resume", "workflow_idempotency", "dead_letter_recovery"]),
  database: Object.freeze(["expand_contract_compatibility", "paid_order_integrity", "ledger_balance", "tenant_rls"]),
  mobile: Object.freeze(["minimum_supported_version", "api_backward_compatibility", "forced_upgrade_policy"]),
  wechat_mini_program: Object.freeze(["minimum_supported_version", "api_backward_compatibility", "platform_release_route"]),
  vendor_routing: Object.freeze(["primary_route", "fallback_route", "callback_reconciliation", "duplicate_side_effect_prevention"]),
});

export const REQUIRED_B127_ROLLBACK_SCOPES = Object.freeze(
  Object.keys(REQUIRED_B127_ROLLBACK_VERIFICATIONS),
);

export class B127ReleaseControlError extends Error {
  constructor(code, message, status = "FAIL") {
    super(message);
    this.name = "B127ReleaseControlError";
    this.code = code;
    this.status = status;
  }
}

export function validateRolloutGuardrailPolicy(bytes, expected) {
  const policy = parseJson(bytes, "rollout guardrail policy", "GUARDRAIL_POLICY_JSON_INVALID");
  exactObject(policy, "rollout guardrail policy", [
    "schemaVersion", "policyId", "policyVersion", "releaseId", "tenantId", "launchId",
    "deploymentId", "repositoryCommit", "componentSetSha256", "controls", "controlSetSha256",
    "producer",
  ], "GUARDRAIL_POLICY_FIELDS_INVALID");
  if (policy.schemaVersion !== "ltm.rollout-guardrail-policy.v1") {
    invalid("GUARDRAIL_POLICY_SCHEMA_INVALID", "Rollout guardrail policy schemaVersion is unsupported");
  }
  identifier(policy.policyId, "guardrail policy.policyId");
  releaseVersion(policy.policyVersion, "guardrail policy.policyVersion");
  for (const [field, expectedValue] of Object.entries({
    releaseId: expected.launchId,
    tenantId: expected.tenantId,
    launchId: expected.launchId,
    deploymentId: expected.deploymentId,
    repositoryCommit: expected.repositoryCommit,
    componentSetSha256: expected.componentSetSha256,
    policyVersion: expected.policyVersion,
  })) {
    if (policy[field] !== expectedValue) {
      invalid("GUARDRAIL_POLICY_BINDING_MISMATCH", `Rollout guardrail policy ${field} is not bound to this release`);
    }
  }
  identifier(policy.releaseId, "guardrail policy.releaseId");
  identifier(policy.tenantId, "guardrail policy.tenantId");
  identifier(policy.launchId, "guardrail policy.launchId");
  identifier(policy.deploymentId, "guardrail policy.deploymentId");
  commit(policy.repositoryCommit, "guardrail policy.repositoryCommit");
  digest(policy.componentSetSha256, "guardrail policy.componentSetSha256");
  const controls = array(policy.controls, "guardrail policy.controls", REQUIRED_B127_MONITORING_DOMAINS.length, REQUIRED_B127_MONITORING_DOMAINS.length)
    .map((entry, index) => validateGuardrailControl(entry, index));
  const domains = controls.map((entry) => entry.domain);
  if (!sameArray(domains, REQUIRED_B127_MONITORING_DOMAINS) || new Set(domains).size !== domains.length) {
    invalid("GUARDRAIL_POLICY_SCOPE_INCOMPLETE", `Guardrail policy must exactly cover ${REQUIRED_B127_MONITORING_DOMAINS.join(", ")}`, "BLOCKED_EXTERNAL");
  }
  const calculated = sha256(Buffer.from(canonicalJson(controls), "utf8"));
  if (digest(policy.controlSetSha256, "guardrail policy.controlSetSha256") !== calculated) {
    invalid("GUARDRAIL_POLICY_SET_DIGEST_MISMATCH", "Guardrail policy controlSetSha256 does not match its typed controls");
  }
  return {
    schemaVersion: policy.schemaVersion,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    controlSetSha256: calculated,
    controls,
    controlsByDomain: Object.fromEntries(controls.map((control) => [control.domain, control])),
    producer: validateProducer(policy.producer, "rollout guardrail policy"),
  };
}

export function validateRolloutWaveObservation(bytes, expected) {
  const report = parseJson(bytes, "rollout-wave observation", "WAVE_OBSERVATION_JSON_INVALID");
  exactObject(report, "rollout-wave observation", [
    "schemaVersion", "reportId", "releaseId", "tenantId", "launchId", "deploymentId",
    "repositoryCommit", "componentSetSha256", "wave", "rolloutPercent", "monitoringWindow",
    "guardrailPolicySha256", "automaticPausePolicy", "measurements", "measurementSetSha256",
    "conclusion", "producer",
  ], "WAVE_OBSERVATION_FIELDS_INVALID");
  if (report.schemaVersion !== "ltm.rollout-wave-observation.v1") {
    invalid("WAVE_OBSERVATION_SCHEMA_INVALID", "Rollout-wave observation schemaVersion is unsupported");
  }
  identifier(report.reportId, "reportId");
  for (const [field, expectedValue] of Object.entries({
    releaseId: expected.launchId,
    tenantId: expected.tenantId,
    launchId: expected.launchId,
    deploymentId: expected.deploymentId,
    repositoryCommit: expected.repositoryCommit,
    componentSetSha256: expected.componentSetSha256,
    wave: expected.wave,
    rolloutPercent: expected.rolloutPercent,
  })) {
    if (report[field] !== expectedValue) {
      invalid("WAVE_OBSERVATION_BINDING_MISMATCH", `Rollout-wave observation ${field} is not bound to this release wave`);
    }
  }
  identifier(report.releaseId, "releaseId");
  identifier(report.tenantId, "tenantId");
  identifier(report.launchId, "launchId");
  identifier(report.deploymentId, "deploymentId");
  commit(report.repositoryCommit, "repositoryCommit");
  digest(report.componentSetSha256, "componentSetSha256");
  if (digest(report.guardrailPolicySha256, "guardrailPolicySha256") !== expected.guardrailPolicySha256) {
    invalid("WAVE_GUARDRAIL_POLICY_MISMATCH", "Rollout-wave observation is not bound to the canonical guardrail policy");
  }

  const window = exactObject(report.monitoringWindow, "monitoringWindow", [
    "startedAt", "endedAt", "minimumObservationSeconds", "observedSeconds", "collectionIntervalSeconds",
  ], "WAVE_OBSERVATION_FIELDS_INVALID");
  const startedAt = timestamp(window.startedAt, "monitoringWindow.startedAt");
  const endedAt = timestamp(window.endedAt, "monitoringWindow.endedAt");
  const minimumObservationSeconds = integer(window.minimumObservationSeconds, "minimumObservationSeconds", 3_600, 30 * 24 * 60 * 60);
  const observedSeconds = integer(window.observedSeconds, "observedSeconds", minimumObservationSeconds, 60 * 24 * 60 * 60);
  integer(window.collectionIntervalSeconds, "collectionIntervalSeconds", 1, 300);
  if (
    startedAt !== expected.startedAt ||
    endedAt !== expected.completedAt ||
    minimumObservationSeconds !== expected.minimumObservationSeconds ||
    observedSeconds !== expected.observedSeconds ||
    Date.parse(endedAt) - Date.parse(startedAt) < observedSeconds * 1_000
  ) {
    invalid("WAVE_OBSERVATION_WINDOW_MISMATCH", "Rollout-wave monitoring window does not match the immutable wave summary");
  }

  const measurements = array(report.measurements, "measurements", REQUIRED_B127_MONITORING_DOMAINS.length, REQUIRED_B127_MONITORING_DOMAINS.length)
    .map((entry, index) => validateMeasurement(entry, index, {
      ...expected,
      startedAt,
      endedAt,
      guardrailPolicySha256: report.guardrailPolicySha256,
    }));
  const domains = measurements.map((entry) => entry.domain);
  if (!sameArray(domains, REQUIRED_B127_MONITORING_DOMAINS) || new Set(domains).size !== domains.length) {
    invalid(
      "WAVE_OBSERVATION_SCOPE_INCOMPLETE",
      `Rollout-wave measurements must exactly cover ${REQUIRED_B127_MONITORING_DOMAINS.join(", ")}`,
      "BLOCKED_EXTERNAL",
    );
  }
  for (const field of ["queryArtifact", "resultArtifact"]) {
    if (new Set(measurements.map((entry) => entry[field].sha256)).size !== measurements.length) {
      invalid("WAVE_OBSERVATION_EVIDENCE_REUSED", `Every monitoring domain requires a distinct ${field} digest`);
    }
  }
  const calculatedMeasurementSetSha256 = sha256(Buffer.from(canonicalJson(report.measurements), "utf8"));
  if (digest(report.measurementSetSha256, "measurementSetSha256") !== calculatedMeasurementSetSha256) {
    invalid("WAVE_OBSERVATION_SET_DIGEST_MISMATCH", "Monitoring measurementSetSha256 does not match the typed measurements");
  }

  const pause = exactObject(report.automaticPausePolicy, "automaticPausePolicy", [
    "policyVersion", "action", "evaluationMode", "evaluatedAt", "drill",
  ], "WAVE_OBSERVATION_FIELDS_INVALID");
  if (releaseVersion(pause.policyVersion, "automaticPausePolicy.policyVersion") !== expected.automaticPausePolicyVersion) {
    invalid("WAVE_AUTOMATIC_PAUSE_POLICY_MISMATCH", "Automatic-pause policy version does not match the release wave");
  }
  if (pause.action !== "pause_wave" || pause.evaluationMode !== "server_side") {
    invalid("WAVE_AUTOMATIC_PAUSE_POLICY_INVALID", "Automatic-pause policy must be a server-side pause_wave action");
  }
  const evaluatedAt = timestamp(pause.evaluatedAt, "automaticPausePolicy.evaluatedAt");
  if (Date.parse(evaluatedAt) < Date.parse(startedAt) || Date.parse(evaluatedAt) > Date.parse(endedAt)) {
    invalid("WAVE_AUTOMATIC_PAUSE_POLICY_INVALID", "Automatic-pause policy evaluation is outside the observation window");
  }
  const pauseDrill = validatePauseDrill(pause.drill, {
    ...expected,
    startedAt,
    endedAt,
    guardrailPolicySha256: report.guardrailPolicySha256,
  });

  const conclusion = exactObject(report.conclusion, "conclusion", [
    "status", "decision", "breachCount",
  ], "WAVE_OBSERVATION_FIELDS_INVALID");
  if (conclusion.status !== "passed" || conclusion.decision !== "continue" || conclusion.breachCount !== 0) {
    invalid("WAVE_OBSERVATION_NOT_PASSED", "Rollout-wave observation has not reached a zero-breach continue conclusion", "BLOCKED_EXTERNAL");
  }
  const producer = validateProducer(report.producer, "rollout-wave observation");
  return {
    schemaVersion: report.schemaVersion,
    reportId: report.reportId,
    wave: report.wave,
    monitoringWindow: { ...window },
    measurementSetSha256: calculatedMeasurementSetSha256,
    domains: [...domains],
    automaticPauseDrill: pauseDrill,
    evidenceBindings: [
      ...measurements.flatMap((measurement) => [
        {
          kind: "query",
          id: measurement.query.queryId,
          sha256: measurement.queryArtifact.sha256,
          ...measurement.queryAttestation,
        },
        {
          kind: "result",
          id: measurement.result.resultId,
          sha256: measurement.resultArtifact.sha256,
          ...measurement.resultAttestation,
        },
      ]),
      {
        kind: "pause_command",
        id: pauseDrill.pauseCommandId,
        sha256: pauseDrill.commandArtifact.sha256,
        ...pauseDrill.commandAttestation,
      },
      {
        kind: "pause_receipt",
        id: pauseDrill.receipt.receiptId,
        sha256: pauseDrill.receiptArtifact.sha256,
        ...pauseDrill.receiptAttestation,
      },
      { kind: "pause_drill", id: pauseDrill.drillId, sha256: sha256(Buffer.from(canonicalJson(pauseDrill), "utf8")) },
    ],
    conclusion: { ...conclusion },
    producer,
  };
}

export function validateRollbackForwardDrill(bytes, expected) {
  const report = parseJson(bytes, "rollback-forward drill", "ROLLBACK_DRILL_JSON_INVALID");
  exactObject(report, "rollback-forward drill", [
    "schemaVersion", "reportId", "exerciseId", "releaseId", "tenantId", "launchId",
    "deploymentId", "repositoryCommit", "componentSetSha256", "startedAt", "completedAt",
    "scopes", "scopeSetSha256", "conclusion", "producer",
  ], "ROLLBACK_DRILL_FIELDS_INVALID");
  if (report.schemaVersion !== "ltm.rollback-forward-drill.v2") {
    invalid("ROLLBACK_DRILL_SCHEMA_INVALID", "Rollback-forward drill schemaVersion is unsupported");
  }
  identifier(report.reportId, "reportId");
  identifier(report.exerciseId, "exerciseId");
  for (const [field, expectedValue] of Object.entries({
    exerciseId: expected.exerciseId,
    releaseId: expected.launchId,
    tenantId: expected.tenantId,
    launchId: expected.launchId,
    deploymentId: expected.deploymentId,
    repositoryCommit: expected.repositoryCommit,
    componentSetSha256: expected.componentSetSha256,
  })) {
    if (report[field] !== expectedValue) {
      invalid("ROLLBACK_DRILL_BINDING_MISMATCH", `Rollback-forward drill ${field} is not bound to this release`);
    }
  }
  identifier(report.releaseId, "releaseId");
  identifier(report.tenantId, "tenantId");
  identifier(report.launchId, "launchId");
  identifier(report.deploymentId, "deploymentId");
  commit(report.repositoryCommit, "repositoryCommit");
  digest(report.componentSetSha256, "componentSetSha256");
  const startedAt = timestamp(report.startedAt, "startedAt");
  const completedAt = timestamp(report.completedAt, "completedAt");
  if (
    Date.parse(completedAt) <= Date.parse(startedAt) ||
    Date.parse(completedAt) - Date.parse(startedAt) > 24 * 60 * 60_000 ||
    Date.parse(completedAt) > Date.parse(expected.maximumCompletedAt)
  ) {
    invalid("ROLLBACK_DRILL_WINDOW_INVALID", "Rollback-forward drill has an invalid or post-release completion window", "BLOCKED_EXTERNAL");
  }

  const scopes = array(report.scopes, "scopes", REQUIRED_B127_ROLLBACK_SCOPES.length, REQUIRED_B127_ROLLBACK_SCOPES.length)
    .map((entry, index) => validateRollbackScope(entry, index, { ...expected, startedAt, completedAt }));
  const scopeNames = scopes.map((entry) => entry.scope);
  if (!sameArray(scopeNames, REQUIRED_B127_ROLLBACK_SCOPES) || new Set(scopeNames).size !== scopeNames.length) {
    invalid(
      "ROLLBACK_DRILL_SCOPE_INCOMPLETE",
      `Rollback-forward drill must exactly cover ${REQUIRED_B127_ROLLBACK_SCOPES.join(", ")}`,
      "BLOCKED_EXTERNAL",
    );
  }
  const evidenceDigests = scopes.flatMap((entry) => [
    entry.rollback.evidenceArtifact.sha256,
    entry.forward.evidenceArtifact.sha256,
    ...entry.verifications.map((verification) => verification.evidenceArtifact.sha256),
  ]);
  if (new Set(evidenceDigests).size !== evidenceDigests.length) {
    invalid("ROLLBACK_DRILL_EVIDENCE_REUSED", "Every rollback, forward, and verification result requires a distinct raw evidence digest");
  }
  const calculatedScopeSetSha256 = sha256(Buffer.from(canonicalJson(scopes), "utf8"));
  if (digest(report.scopeSetSha256, "scopeSetSha256") !== calculatedScopeSetSha256) {
    invalid("ROLLBACK_DRILL_SET_DIGEST_MISMATCH", "Rollback-forward scopeSetSha256 does not match the typed scope results");
  }
  const conclusion = exactObject(report.conclusion, "conclusion", [
    "status", "decision", "failedScopes", "dataLossEvents",
  ], "ROLLBACK_DRILL_FIELDS_INVALID");
  if (
    conclusion.status !== "passed" ||
    conclusion.decision !== "release_compatible" ||
    array(conclusion.failedScopes, "failedScopes", 0, 0).length !== 0 ||
    conclusion.dataLossEvents !== 0
  ) {
    invalid("ROLLBACK_DRILL_NOT_PASSED", "Rollback-forward drill has not reached a zero-data-loss release-compatible conclusion", "BLOCKED_EXTERNAL");
  }
  return {
    schemaVersion: report.schemaVersion,
    reportId: report.reportId,
    exerciseId: report.exerciseId,
    startedAt,
    completedAt,
    scopeSetSha256: calculatedScopeSetSha256,
    scopes,
    conclusion: { ...conclusion, failedScopes: [] },
    producer: validateProducer(report.producer, "rollback-forward drill"),
  };
}

export function waveObservationArtifactSetSha256(waves) {
  if (!Array.isArray(waves) || waves.length === 0) {
    invalid("WAVE_OBSERVATION_SCOPE_INCOMPLETE", "At least one typed wave observation artifact is required", "BLOCKED_EXTERNAL");
  }
  const bindings = waves.map((entry, index) => {
    const item = exactObject(entry, `wave artifact binding ${index}`, ["wave", "sha256"], "WAVE_OBSERVATION_FIELDS_INVALID");
    identifier(item.wave, `wave artifact binding ${index}.wave`);
    digest(item.sha256, `wave artifact binding ${index}.sha256`);
    return { wave: item.wave, sha256: item.sha256 };
  });
  if (new Set(bindings.map((entry) => entry.wave)).size !== bindings.length || new Set(bindings.map((entry) => entry.sha256)).size !== bindings.length) {
    invalid("WAVE_OBSERVATION_EVIDENCE_REUSED", "Wave observation artifact bindings must be unique");
  }
  return sha256(Buffer.from(canonicalJson(bindings), "utf8"));
}

function validateGuardrailControl(value, index) {
  const control = exactObject(value, `guardrail policy.controls[${index}]`, [
    "domain", "signalId", "unit", "comparator", "threshold",
  ], "GUARDRAIL_POLICY_FIELDS_INVALID");
  const domain = identifier(control.domain, `guardrail policy.controls[${index}].domain`);
  const expectedSignal = REQUIRED_B127_MONITORING_SIGNALS[domain];
  if (
    expectedSignal === undefined ||
    control.signalId !== expectedSignal.signalId ||
    control.unit !== expectedSignal.unit ||
    control.comparator !== "lte"
  ) {
    invalid("GUARDRAIL_POLICY_SIGNAL_INVALID", `Guardrail domain ${domain} uses an unsupported signal, unit, or comparator`);
  }
  const threshold = boundedMetricValue(control.threshold, control.unit, `guardrail policy.controls[${index}].threshold`);
  return { ...control, threshold };
}

function validateMeasurement(value, index, context) {
  const measurement = exactObject(value, `measurements[${index}]`, [
    "domain", "signalId", "unit", "comparator", "threshold", "observedValue",
    "sampleCount", "queryArtifact", "resultArtifact", "conclusion",
  ], "WAVE_OBSERVATION_FIELDS_INVALID");
  const domain = identifier(measurement.domain, `measurements[${index}].domain`);
  const expectedSignal = REQUIRED_B127_MONITORING_SIGNALS[domain];
  if (
    expectedSignal === undefined ||
    measurement.signalId !== expectedSignal.signalId ||
    measurement.unit !== expectedSignal.unit ||
    measurement.comparator !== "lte"
  ) {
    invalid("WAVE_OBSERVATION_SIGNAL_INVALID", `Monitoring domain ${domain} uses an unsupported signal, unit, or comparator`);
  }
  const threshold = boundedMetricValue(measurement.threshold, measurement.unit, `measurements[${index}].threshold`);
  const rawObservedValue = finiteNumber(measurement.observedValue, `measurements[${index}].observedValue`, 0);
  const sampleCount = integer(measurement.sampleCount, `measurements[${index}].sampleCount`, 1, Number.MAX_SAFE_INTEGER);
  const policyControl = context.guardrailPolicy?.controlsByDomain?.[domain];
  if (
    policyControl === undefined ||
    policyControl.signalId !== measurement.signalId ||
    policyControl.unit !== measurement.unit ||
    policyControl.comparator !== measurement.comparator ||
    policyControl.threshold !== threshold
  ) {
    invalid("WAVE_GUARDRAIL_POLICY_MISMATCH", `Monitoring domain ${domain} does not exactly match the canonical guardrail policy`);
  }
  if (rawObservedValue > threshold || measurement.conclusion !== "within_threshold") {
    invalid("WAVE_OBSERVATION_THRESHOLD_BREACHED", `Monitoring domain ${domain} exceeded its release threshold`, "BLOCKED_EXTERNAL");
  }
  const observedValue = boundedMetricValue(rawObservedValue, measurement.unit, `measurements[${index}].observedValue`);
  const queryArtifact = artifactReference(measurement.queryArtifact, `measurements[${index}].queryArtifact`);
  const resultArtifact = artifactReference(measurement.resultArtifact, `measurements[${index}].resultArtifact`);
  const queryBytes = readRawArtifact(context, queryArtifact, `${domain} monitoring query`);
  const resultBytes = readRawArtifact(context, resultArtifact, `${domain} monitoring result`);
  const binding = {
    releaseId: context.launchId,
    tenantId: context.tenantId,
    launchId: context.launchId,
    deploymentId: context.deploymentId,
    repositoryCommit: context.repositoryCommit,
    componentSetSha256: context.componentSetSha256,
    guardrailPolicySha256: context.guardrailPolicySha256,
    wave: context.wave,
    domain,
    signalId: measurement.signalId,
    unit: measurement.unit,
    startedAt: context.startedAt,
    endedAt: context.endedAt,
  };
  const query = validateMonitoringQuery(queryBytes, binding);
  const result = validateMonitoringResult(resultBytes, {
    ...binding,
    queryId: query.queryId,
    queryArtifactSha256: queryArtifact.sha256,
    threshold,
    observedValue,
    sampleCount,
  });
  const queryAttestation = verifyControlArtifactAttestation(context, queryArtifact, `${domain} monitoring query`, {
    artifactType: "monitoring_query",
    artifactId: query.queryId,
    artifactSha256: queryArtifact.sha256,
    relatedArtifactSha256: null,
    releaseId: context.launchId,
    tenantId: context.tenantId,
    launchId: context.launchId,
    deploymentId: context.deploymentId,
    repositoryCommit: context.repositoryCommit,
    componentSetSha256: context.componentSetSha256,
    guardrailPolicySha256: context.guardrailPolicySha256,
    wave: context.wave,
    domain,
    signalId: measurement.signalId,
    unit: measurement.unit,
    windowStart: context.startedAt,
    windowEnd: context.endedAt,
    eventAt: context.startedAt,
    threshold,
    observedValue: null,
    state: "query_defined",
  });
  const resultAttestation = verifyControlArtifactAttestation(context, resultArtifact, `${domain} monitoring result`, {
    artifactType: "monitoring_result",
    artifactId: result.resultId,
    artifactSha256: resultArtifact.sha256,
    relatedArtifactSha256: queryArtifact.sha256,
    releaseId: context.launchId,
    tenantId: context.tenantId,
    launchId: context.launchId,
    deploymentId: context.deploymentId,
    repositoryCommit: context.repositoryCommit,
    componentSetSha256: context.componentSetSha256,
    guardrailPolicySha256: context.guardrailPolicySha256,
    wave: context.wave,
    domain,
    signalId: measurement.signalId,
    unit: measurement.unit,
    windowStart: context.startedAt,
    windowEnd: context.endedAt,
    eventAt: result.producedAt,
    threshold,
    observedValue,
    state: "result_complete",
  });
  if (queryAttestation.publicKeySha256 === resultAttestation.publicKeySha256) {
    invalid("CONTROL_ARTIFACT_SIGNER_NOT_INDEPENDENT", `Monitoring query and result for ${domain} must use distinct enrolled Ed25519 producer keys`);
  }
  return {
    ...measurement,
    threshold,
    observedValue,
    sampleCount,
    queryArtifact,
    resultArtifact,
    query,
    result,
    queryAttestation,
    resultAttestation,
  };
}

function validatePauseDrill(value, window) {
  const drill = exactObject(value, "automaticPausePolicy.drill", [
    "drillId", "injectedDomain", "signalId", "threshold", "observedValue", "pauseCommandId",
    "commandIssuedAt", "commandAcknowledgedAt", "commandArtifact", "receiptArtifact", "conclusion",
  ], "WAVE_OBSERVATION_FIELDS_INVALID");
  identifier(drill.drillId, "automaticPausePolicy.drill.drillId");
  const expectedSignal = REQUIRED_B127_MONITORING_SIGNALS[drill.injectedDomain];
  if (expectedSignal === undefined || drill.signalId !== expectedSignal.signalId) {
    invalid("WAVE_AUTOMATIC_PAUSE_DRILL_INVALID", "Automatic-pause drill uses an unsupported domain signal");
  }
  const threshold = boundedMetricValue(drill.threshold, expectedSignal.unit, "automaticPausePolicy.drill.threshold");
  const observedValue = boundedMetricValue(drill.observedValue, expectedSignal.unit, "automaticPausePolicy.drill.observedValue");
  const policyControl = window.guardrailPolicy?.controlsByDomain?.[drill.injectedDomain];
  if (policyControl === undefined || policyControl.threshold !== threshold || policyControl.signalId !== drill.signalId) {
    invalid("WAVE_GUARDRAIL_POLICY_MISMATCH", "Automatic-pause drill does not use the canonical guardrail threshold");
  }
  identifier(drill.pauseCommandId, "automaticPausePolicy.drill.pauseCommandId");
  const issuedAt = timestamp(drill.commandIssuedAt, "automaticPausePolicy.drill.commandIssuedAt");
  const acknowledgedAt = timestamp(drill.commandAcknowledgedAt, "automaticPausePolicy.drill.commandAcknowledgedAt");
  if (
    observedValue <= threshold ||
    Date.parse(issuedAt) < Date.parse(window.startedAt) ||
    Date.parse(acknowledgedAt) < Date.parse(issuedAt) ||
    Date.parse(acknowledgedAt) > Date.parse(window.endedAt) ||
    drill.conclusion !== "paused"
  ) {
    invalid("WAVE_AUTOMATIC_PAUSE_DRILL_INVALID", "Automatic-pause drill lacks a threshold breach and acknowledged pause receipt", "BLOCKED_EXTERNAL");
  }
  const commandArtifact = artifactReference(drill.commandArtifact, "automaticPausePolicy.drill.commandArtifact");
  const receiptArtifact = artifactReference(drill.receiptArtifact, "automaticPausePolicy.drill.receiptArtifact");
  const common = {
    releaseId: window.launchId,
    tenantId: window.tenantId,
    launchId: window.launchId,
    deploymentId: window.deploymentId,
    repositoryCommit: window.repositoryCommit,
    componentSetSha256: window.componentSetSha256,
    guardrailPolicySha256: window.guardrailPolicySha256,
    wave: window.wave,
    drillId: drill.drillId,
    domain: drill.injectedDomain,
    signalId: drill.signalId,
    threshold,
    observedValue,
  };
  const command = validatePauseCommand(readRawArtifact(window, commandArtifact, "automatic-pause command"), {
    ...common,
    pauseCommandId: drill.pauseCommandId,
    issuedAt,
    startedAt: window.startedAt,
    endedAt: window.endedAt,
  });
  const receipt = validatePauseReceipt(readRawArtifact(window, receiptArtifact, "automatic-pause receipt"), {
    ...common,
    pauseCommandId: command.commandId,
    commandArtifactSha256: commandArtifact.sha256,
    acknowledgedAt,
    startedAt: window.startedAt,
    endedAt: window.endedAt,
  });
  const unit = REQUIRED_B127_MONITORING_SIGNALS[drill.injectedDomain].unit;
  const commandAttestation = verifyControlArtifactAttestation(window, commandArtifact, "automatic-pause command", {
    artifactType: "pause_command",
    artifactId: command.commandId,
    artifactSha256: commandArtifact.sha256,
    relatedArtifactSha256: null,
    releaseId: window.launchId,
    tenantId: window.tenantId,
    launchId: window.launchId,
    deploymentId: window.deploymentId,
    repositoryCommit: window.repositoryCommit,
    componentSetSha256: window.componentSetSha256,
    guardrailPolicySha256: window.guardrailPolicySha256,
    wave: window.wave,
    domain: drill.injectedDomain,
    signalId: drill.signalId,
    unit,
    windowStart: window.startedAt,
    windowEnd: window.endedAt,
    eventAt: command.issuedAt,
    threshold,
    observedValue,
    state: "pause_issued",
  });
  const receiptAttestation = verifyControlArtifactAttestation(window, receiptArtifact, "automatic-pause receipt", {
    artifactType: "pause_receipt",
    artifactId: receipt.receiptId,
    artifactSha256: receiptArtifact.sha256,
    relatedArtifactSha256: commandArtifact.sha256,
    releaseId: window.launchId,
    tenantId: window.tenantId,
    launchId: window.launchId,
    deploymentId: window.deploymentId,
    repositoryCommit: window.repositoryCommit,
    componentSetSha256: window.componentSetSha256,
    guardrailPolicySha256: window.guardrailPolicySha256,
    wave: window.wave,
    domain: drill.injectedDomain,
    signalId: drill.signalId,
    unit,
    windowStart: window.startedAt,
    windowEnd: window.endedAt,
    eventAt: receipt.acknowledgedAt,
    threshold,
    observedValue,
    state: "pause_acknowledged",
  });
  if (commandAttestation.publicKeySha256 === receiptAttestation.publicKeySha256) {
    invalid("CONTROL_ARTIFACT_SIGNER_NOT_INDEPENDENT", "Automatic-pause command and receipt must use distinct enrolled Ed25519 producer keys");
  }
  return {
    ...drill,
    threshold,
    observedValue,
    commandArtifact,
    receiptArtifact,
    command,
    receipt,
    commandAttestation,
    receiptAttestation,
  };
}

function validateMonitoringQuery(bytes, expected) {
  const value = parseJson(bytes, "monitoring query", "WAVE_RAW_EVIDENCE_JSON_INVALID");
  exactObject(value, "monitoring query", [
    "schemaVersion", "queryId", "releaseId", "tenantId", "launchId", "deploymentId",
    "repositoryCommit", "componentSetSha256", "guardrailPolicySha256", "wave", "domain",
    "signalId", "unit", "windowStart", "windowEnd", "queryLanguage", "queryText",
  ], "WAVE_RAW_EVIDENCE_FIELDS_INVALID");
  if (value.schemaVersion !== "ltm.rollout-monitoring-query.v1") invalid("WAVE_RAW_EVIDENCE_SCHEMA_INVALID", "Monitoring query schemaVersion is unsupported");
  identifier(value.queryId, "monitoring query.queryId");
  validateRawCommon(value, expected, "monitoring query");
  if (value.windowStart !== expected.startedAt || value.windowEnd !== expected.endedAt) invalid("WAVE_RAW_EVIDENCE_WINDOW_MISMATCH", "Monitoring query is outside its immutable wave window");
  if (!new Set(["promql", "sql", "vendor_api"]).has(value.queryLanguage)) invalid("WAVE_RAW_EVIDENCE_CONTENT_INVALID", "Monitoring query language is unsupported");
  visible(value.queryText, "monitoring query.queryText", 8_192);
  return { ...value };
}

function validateMonitoringResult(bytes, expected) {
  const value = parseJson(bytes, "monitoring result", "WAVE_RAW_EVIDENCE_JSON_INVALID");
  exactObject(value, "monitoring result", [
    "schemaVersion", "resultId", "queryId", "queryArtifactSha256", "releaseId", "tenantId",
    "launchId", "deploymentId", "repositoryCommit", "componentSetSha256", "guardrailPolicySha256",
    "wave", "domain", "signalId", "unit", "windowStart", "windowEnd", "observedValue",
    "sampleCount", "threshold", "status", "producedAt",
  ], "WAVE_RAW_EVIDENCE_FIELDS_INVALID");
  if (value.schemaVersion !== "ltm.rollout-monitoring-result.v1") invalid("WAVE_RAW_EVIDENCE_SCHEMA_INVALID", "Monitoring result schemaVersion is unsupported");
  identifier(value.resultId, "monitoring result.resultId");
  identifier(value.queryId, "monitoring result.queryId");
  digest(value.queryArtifactSha256, "monitoring result.queryArtifactSha256");
  validateRawCommon(value, expected, "monitoring result");
  const observedValue = boundedMetricValue(value.observedValue, value.unit, "monitoring result.observedValue");
  const threshold = boundedMetricValue(value.threshold, value.unit, "monitoring result.threshold");
  const sampleCount = integer(value.sampleCount, "monitoring result.sampleCount", 1, Number.MAX_SAFE_INTEGER);
  const producedAt = timestamp(value.producedAt, "monitoring result.producedAt");
  if (
    value.queryId !== expected.queryId ||
    value.queryArtifactSha256 !== expected.queryArtifactSha256 ||
    value.windowStart !== expected.startedAt ||
    value.windowEnd !== expected.endedAt ||
    observedValue !== expected.observedValue ||
    threshold !== expected.threshold ||
    sampleCount !== expected.sampleCount ||
    Date.parse(producedAt) < Date.parse(expected.startedAt) ||
    Date.parse(producedAt) > Date.parse(expected.endedAt) ||
    value.status !== "complete"
  ) {
    invalid("WAVE_RAW_EVIDENCE_BINDING_MISMATCH", "Monitoring result does not match its query, wave, observed value, threshold, or sample set");
  }
  return { ...value, observedValue, threshold, sampleCount };
}

function validatePauseCommand(bytes, expected) {
  const value = parseJson(bytes, "automatic-pause command", "WAVE_RAW_EVIDENCE_JSON_INVALID");
  exactObject(value, "automatic-pause command", [
    "schemaVersion", "commandId", "releaseId", "tenantId", "launchId", "deploymentId",
    "repositoryCommit", "componentSetSha256", "guardrailPolicySha256", "wave", "drillId",
    "domain", "signalId", "threshold", "observedValue", "action", "issuedAt", "status",
  ], "WAVE_RAW_EVIDENCE_FIELDS_INVALID");
  if (value.schemaVersion !== "ltm.rollout-pause-command.v1") invalid("WAVE_RAW_EVIDENCE_SCHEMA_INVALID", "Automatic-pause command schemaVersion is unsupported");
  identifier(value.commandId, "automatic-pause command.commandId");
  validateRawCommon(value, expected, "automatic-pause command");
  identifier(value.drillId, "automatic-pause command.drillId");
  const threshold = boundedMetricValue(value.threshold, REQUIRED_B127_MONITORING_SIGNALS[value.domain]?.unit, "automatic-pause command.threshold");
  const observedValue = boundedMetricValue(value.observedValue, REQUIRED_B127_MONITORING_SIGNALS[value.domain]?.unit, "automatic-pause command.observedValue");
  const issuedAt = timestamp(value.issuedAt, "automatic-pause command.issuedAt");
  if (
    value.commandId !== expected.pauseCommandId || value.drillId !== expected.drillId ||
    threshold !== expected.threshold || observedValue !== expected.observedValue ||
    issuedAt !== expected.issuedAt || Date.parse(issuedAt) < Date.parse(expected.startedAt) ||
    Date.parse(issuedAt) > Date.parse(expected.endedAt) || value.action !== "pause_wave" || value.status !== "issued"
  ) invalid("WAVE_RAW_EVIDENCE_BINDING_MISMATCH", "Automatic-pause command is not bound to the drill breach and wave window");
  return { ...value, threshold, observedValue };
}

function validatePauseReceipt(bytes, expected) {
  const value = parseJson(bytes, "automatic-pause receipt", "WAVE_RAW_EVIDENCE_JSON_INVALID");
  exactObject(value, "automatic-pause receipt", [
    "schemaVersion", "receiptId", "commandId", "commandArtifactSha256", "releaseId", "tenantId",
    "launchId", "deploymentId", "repositoryCommit", "componentSetSha256", "guardrailPolicySha256",
    "wave", "drillId", "domain", "signalId", "threshold", "observedValue", "acknowledgedAt",
    "resultingState",
  ], "WAVE_RAW_EVIDENCE_FIELDS_INVALID");
  if (value.schemaVersion !== "ltm.rollout-pause-receipt.v1") invalid("WAVE_RAW_EVIDENCE_SCHEMA_INVALID", "Automatic-pause receipt schemaVersion is unsupported");
  identifier(value.receiptId, "automatic-pause receipt.receiptId");
  identifier(value.commandId, "automatic-pause receipt.commandId");
  digest(value.commandArtifactSha256, "automatic-pause receipt.commandArtifactSha256");
  validateRawCommon(value, expected, "automatic-pause receipt");
  identifier(value.drillId, "automatic-pause receipt.drillId");
  const threshold = boundedMetricValue(value.threshold, REQUIRED_B127_MONITORING_SIGNALS[value.domain]?.unit, "automatic-pause receipt.threshold");
  const observedValue = boundedMetricValue(value.observedValue, REQUIRED_B127_MONITORING_SIGNALS[value.domain]?.unit, "automatic-pause receipt.observedValue");
  const acknowledgedAt = timestamp(value.acknowledgedAt, "automatic-pause receipt.acknowledgedAt");
  if (
    value.commandId !== expected.pauseCommandId || value.commandArtifactSha256 !== expected.commandArtifactSha256 ||
    value.drillId !== expected.drillId || threshold !== expected.threshold || observedValue !== expected.observedValue ||
    acknowledgedAt !== expected.acknowledgedAt || Date.parse(acknowledgedAt) < Date.parse(expected.startedAt) ||
    Date.parse(acknowledgedAt) > Date.parse(expected.endedAt) || value.resultingState !== "paused"
  ) invalid("WAVE_RAW_EVIDENCE_BINDING_MISMATCH", "Automatic-pause receipt is not bound to the issued command and wave window");
  return { ...value, threshold, observedValue };
}

function validateRawCommon(value, expected, label) {
  for (const [field, expectedValue] of Object.entries({
    releaseId: expected.releaseId,
    tenantId: expected.tenantId,
    launchId: expected.launchId,
    deploymentId: expected.deploymentId,
    repositoryCommit: expected.repositoryCommit,
    componentSetSha256: expected.componentSetSha256,
    guardrailPolicySha256: expected.guardrailPolicySha256,
    wave: expected.wave,
    domain: expected.domain,
    signalId: expected.signalId,
    ...(expected.unit === undefined ? {} : { unit: expected.unit }),
  })) {
    if (value[field] !== expectedValue) invalid("WAVE_RAW_EVIDENCE_BINDING_MISMATCH", `${label} ${field} is not bound to this release wave`);
  }
  identifier(value.releaseId, `${label}.releaseId`);
  identifier(value.tenantId, `${label}.tenantId`);
  identifier(value.launchId, `${label}.launchId`);
  identifier(value.deploymentId, `${label}.deploymentId`);
  commit(value.repositoryCommit, `${label}.repositoryCommit`);
  digest(value.componentSetSha256, `${label}.componentSetSha256`);
  digest(value.guardrailPolicySha256, `${label}.guardrailPolicySha256`);
}

function artifactReference(value, label) {
  const reference = exactObject(value, label, ["path", "sha256", "attestation"], "WAVE_RAW_EVIDENCE_REFERENCE_INVALID");
  visible(reference.path, `${label}.path`, 1_024);
  digest(reference.sha256, `${label}.sha256`);
  return {
    path: reference.path,
    sha256: reference.sha256,
    attestation: digestArtifactReference(reference.attestation, `${label}.attestation`),
  };
}

function readRawArtifact(context, reference, label) {
  if (typeof context.readArtifact !== "function") invalid("WAVE_RAW_EVIDENCE_READER_MISSING", `No stable artifact reader is configured for ${label}`);
  const result = context.readArtifact({ path: reference.path, sha256: reference.sha256 }, label);
  const bytes = Buffer.isBuffer(result) ? result : result?.bytes;
  if (!Buffer.isBuffer(bytes) || sha256(bytes) !== reference.sha256) invalid("WAVE_RAW_EVIDENCE_DIGEST_MISMATCH", `${label} bytes do not match the declared SHA-256 digest`);
  return bytes;
}

function digestArtifactReference(value, label) {
  const reference = exactObject(value, label, ["path", "sha256"], "CONTROL_ARTIFACT_ATTESTATION_REFERENCE_INVALID");
  visible(reference.path, `${label}.path`, 1_024);
  digest(reference.sha256, `${label}.sha256`);
  return { path: reference.path, sha256: reference.sha256 };
}

function verifyControlArtifactAttestation(context, reference, label, expectedClaims) {
  if (typeof context.verifyAttestation !== "function") {
    invalid("CONTROL_ARTIFACT_ATTESTATION_VERIFIER_MISSING", `No detached producer-attestation verifier is configured for ${label}`);
  }
  const result = context.verifyAttestation(reference.attestation, expectedClaims, label);
  if (
    result === null ||
    typeof result !== "object" ||
    typeof result.attestationId !== "string" ||
    typeof result.nonce !== "string" ||
    typeof result.signature !== "string" ||
    typeof result.attestationSha256 !== "string" ||
    typeof result.publicKeySha256 !== "string"
  ) {
    invalid("CONTROL_ARTIFACT_ATTESTATION_INVALID", `Detached producer attestation for ${label} did not return a verified identity`);
  }
  return { ...result };
}

function validateRollbackScope(value, index, window) {
  const item = exactObject(value, `scopes[${index}]`, [
    "scope", "targetId", "fromVersion", "rollbackVersion", "forwardVersion", "baselineStateSha256",
    "rollback", "forward", "verifications", "conclusion",
  ], "ROLLBACK_DRILL_FIELDS_INVALID");
  const scope = identifier(item.scope, `scopes[${index}].scope`);
  const requiredChecks = REQUIRED_B127_ROLLBACK_VERIFICATIONS[scope];
  if (requiredChecks === undefined) invalid("ROLLBACK_DRILL_SCOPE_INCOMPLETE", `Rollback scope ${scope} is unsupported`);
  const targetId = identifier(item.targetId, `scopes[${index}].targetId`);
  const fromVersion = releaseVersion(item.fromVersion, `scopes[${index}].fromVersion`);
  const rollbackVersion = releaseVersion(item.rollbackVersion, `scopes[${index}].rollbackVersion`);
  const forwardVersion = releaseVersion(item.forwardVersion, `scopes[${index}].forwardVersion`);
  if (fromVersion !== forwardVersion || fromVersion === rollbackVersion) {
    invalid("ROLLBACK_DRILL_VERSION_INVALID", `Rollback scope ${scope} must roll back to a distinct version and forward to the release version`);
  }
  const baselineStateSha256 = digest(item.baselineStateSha256, `scopes[${index}].baselineStateSha256`);
  const rollback = validateDrillStep(item.rollback, `scopes[${index}].rollback`, window, {
    scope,
    targetId,
    phase: "rollback",
    version: rollbackVersion,
  });
  const forward = validateDrillStep(item.forward, `scopes[${index}].forward`, window, {
    scope,
    targetId,
    phase: "forward",
    version: forwardVersion,
  });
  if (
    Date.parse(forward.startedAt) < Date.parse(rollback.completedAt) ||
    rollback.stateSha256 === baselineStateSha256 ||
    forward.stateSha256 !== baselineStateSha256 ||
    rollback.evidenceArtifact.sha256 === forward.evidenceArtifact.sha256
  ) {
    invalid("ROLLBACK_DRILL_STATE_INVALID", `Rollback scope ${scope} does not prove a distinct rollback state and restored forward state`);
  }
  const verifications = array(item.verifications, `scopes[${index}].verifications`, requiredChecks.length, requiredChecks.length)
    .map((entry, verificationIndex) => {
      const verification = exactObject(entry, `scopes[${index}].verifications[${verificationIndex}]`, [
        "checkId", "expectedSha256", "observedSha256", "evidenceArtifact", "conclusion",
      ], "ROLLBACK_DRILL_FIELDS_INVALID");
      const checkId = identifier(verification.checkId, `scopes[${index}].verifications[${verificationIndex}].checkId`);
      digest(verification.expectedSha256, `scopes[${index}].verifications[${verificationIndex}].expectedSha256`);
      digest(verification.observedSha256, `scopes[${index}].verifications[${verificationIndex}].observedSha256`);
      const evidenceArtifact = rollbackEvidenceArtifactReference(
        verification.evidenceArtifact,
        `scopes[${index}].verifications[${verificationIndex}].evidenceArtifact`,
      );
      if (verification.expectedSha256 !== verification.observedSha256 || verification.conclusion !== "passed") {
        invalid("ROLLBACK_DRILL_VERIFICATION_FAILED", `Rollback scope ${scope} verification ${verification.checkId} failed`, "BLOCKED_EXTERNAL");
      }
      const evidenceBytes = readRollbackArtifact(
        window,
        evidenceArtifact,
        `rollback scope ${scope} verification ${checkId}`,
      );
      validateRollbackVerificationEvidence(evidenceBytes, {
        ...window,
        scope,
        targetId,
        checkId,
        expectedSha256: verification.expectedSha256,
        observedSha256: verification.observedSha256,
      });
      return { ...verification, evidenceArtifact };
    });
  if (!sameArray(verifications.map((entry) => entry.checkId), requiredChecks)) {
    invalid("ROLLBACK_DRILL_SCOPE_INCOMPLETE", `Rollback scope ${scope} does not contain its exact verification set`, "BLOCKED_EXTERNAL");
  }
  if (item.conclusion !== "passed") {
    invalid("ROLLBACK_DRILL_VERIFICATION_FAILED", `Rollback scope ${scope} did not pass`, "BLOCKED_EXTERNAL");
  }
  return {
    ...item,
    baselineStateSha256,
    rollback,
    forward,
    verifications,
  };
}

function validateDrillStep(value, label, window, expected) {
  const step = exactObject(value, label, [
    "operationId", "startedAt", "completedAt", "result", "stateSha256", "evidenceArtifact",
  ], "ROLLBACK_DRILL_FIELDS_INVALID");
  const operationId = identifier(step.operationId, `${label}.operationId`);
  const startedAt = timestamp(step.startedAt, `${label}.startedAt`);
  const completedAt = timestamp(step.completedAt, `${label}.completedAt`);
  const stateSha256 = digest(step.stateSha256, `${label}.stateSha256`);
  const evidenceArtifact = rollbackEvidenceArtifactReference(step.evidenceArtifact, `${label}.evidenceArtifact`);
  if (
    Date.parse(startedAt) < Date.parse(window.startedAt) ||
    Date.parse(completedAt) <= Date.parse(startedAt) ||
    Date.parse(completedAt) > Date.parse(window.completedAt) ||
    step.result !== "passed"
  ) {
    invalid("ROLLBACK_DRILL_STEP_FAILED", `${label} has no valid passed operation window`, "BLOCKED_EXTERNAL");
  }
  const evidenceBytes = readRollbackArtifact(window, evidenceArtifact, `${label} raw operation evidence`);
  validateRollbackOperationEvidence(evidenceBytes, {
    ...window,
    ...expected,
    operationId,
    startedAt,
    completedAt,
    stateSha256,
  });
  return { ...step, evidenceArtifact };
}

function rollbackEvidenceArtifactReference(value, label) {
  const reference = exactObject(value, label, ["path", "sha256"], "ROLLBACK_DRILL_EVIDENCE_REFERENCE_INVALID");
  visible(reference.path, `${label}.path`, 1_024);
  digest(reference.sha256, `${label}.sha256`);
  return { path: reference.path, sha256: reference.sha256 };
}

function readRollbackArtifact(context, reference, label) {
  if (typeof context.readArtifact !== "function") {
    invalid("ROLLBACK_DRILL_EVIDENCE_READER_MISSING", `No stable artifact reader is configured for ${label}`);
  }
  const result = context.readArtifact(reference, label);
  const bytes = Buffer.isBuffer(result) ? result : result?.bytes;
  if (!Buffer.isBuffer(bytes) || sha256(bytes) !== reference.sha256) {
    invalid("ROLLBACK_DRILL_EVIDENCE_DIGEST_MISMATCH", `${label} bytes do not match the declared SHA-256 digest`);
  }
  return bytes;
}

function validateRollbackOperationEvidence(bytes, expected) {
  const value = parseJson(bytes, "rollback operation evidence", "ROLLBACK_DRILL_EVIDENCE_JSON_INVALID");
  exactObject(value, "rollback operation evidence", [
    "schemaVersion", "evidenceId", "exerciseId", "releaseId", "tenantId", "launchId", "deploymentId",
    "repositoryCommit", "componentSetSha256", "scope", "targetId", "phase", "operationId", "version",
    "startedAt", "completedAt", "result", "stateSha256",
  ], "ROLLBACK_DRILL_EVIDENCE_FIELDS_INVALID");
  if (value.schemaVersion !== "ltm.rollback-operation-evidence.v1") {
    invalid("ROLLBACK_DRILL_EVIDENCE_SCHEMA_INVALID", "Rollback operation evidence schemaVersion is unsupported");
  }
  identifier(value.evidenceId, "rollback operation evidence.evidenceId");
  validateRollbackEvidenceCommon(value, expected, "rollback operation evidence");
  for (const [field, expectedValue] of Object.entries({
    phase: expected.phase,
    operationId: expected.operationId,
    version: expected.version,
    startedAt: expected.startedAt,
    completedAt: expected.completedAt,
    result: "passed",
    stateSha256: expected.stateSha256,
  })) {
    if (value[field] !== expectedValue) {
      invalid("ROLLBACK_DRILL_EVIDENCE_BINDING_MISMATCH", `Rollback operation evidence ${field} is not bound to the reported operation`);
    }
  }
}

function validateRollbackVerificationEvidence(bytes, expected) {
  const value = parseJson(bytes, "rollback verification evidence", "ROLLBACK_DRILL_EVIDENCE_JSON_INVALID");
  exactObject(value, "rollback verification evidence", [
    "schemaVersion", "evidenceId", "exerciseId", "releaseId", "tenantId", "launchId", "deploymentId",
    "repositoryCommit", "componentSetSha256", "scope", "targetId", "checkId", "expectedSha256",
    "observedSha256", "verifiedAt", "conclusion",
  ], "ROLLBACK_DRILL_EVIDENCE_FIELDS_INVALID");
  if (value.schemaVersion !== "ltm.rollback-verification-evidence.v1") {
    invalid("ROLLBACK_DRILL_EVIDENCE_SCHEMA_INVALID", "Rollback verification evidence schemaVersion is unsupported");
  }
  identifier(value.evidenceId, "rollback verification evidence.evidenceId");
  validateRollbackEvidenceCommon(value, expected, "rollback verification evidence");
  const verifiedAt = timestamp(value.verifiedAt, "rollback verification evidence.verifiedAt");
  if (
    value.checkId !== expected.checkId ||
    value.expectedSha256 !== expected.expectedSha256 ||
    value.observedSha256 !== expected.observedSha256 ||
    value.conclusion !== "passed" ||
    Date.parse(verifiedAt) < Date.parse(expected.startedAt) ||
    Date.parse(verifiedAt) > Date.parse(expected.completedAt)
  ) {
    invalid("ROLLBACK_DRILL_EVIDENCE_BINDING_MISMATCH", "Rollback verification evidence is not bound to the reported check and drill window");
  }
}

function validateRollbackEvidenceCommon(value, expected, label) {
  for (const [field, expectedValue] of Object.entries({
    exerciseId: expected.exerciseId,
    releaseId: expected.launchId,
    tenantId: expected.tenantId,
    launchId: expected.launchId,
    deploymentId: expected.deploymentId,
    repositoryCommit: expected.repositoryCommit,
    componentSetSha256: expected.componentSetSha256,
    scope: expected.scope,
    targetId: expected.targetId,
  })) {
    if (value[field] !== expectedValue) {
      invalid("ROLLBACK_DRILL_EVIDENCE_BINDING_MISMATCH", `${label} ${field} is not bound to this release exercise`);
    }
  }
  identifier(value.exerciseId, `${label}.exerciseId`);
  identifier(value.releaseId, `${label}.releaseId`);
  identifier(value.tenantId, `${label}.tenantId`);
  identifier(value.launchId, `${label}.launchId`);
  identifier(value.deploymentId, `${label}.deploymentId`);
  commit(value.repositoryCommit, `${label}.repositoryCommit`);
  digest(value.componentSetSha256, `${label}.componentSetSha256`);
  identifier(value.scope, `${label}.scope`);
  identifier(value.targetId, `${label}.targetId`);
}

function validateProducer(value, label) {
  const producer = exactObject(value, `${label}.producer`, ["name", "version", "invocationId"], "B127_CONTROL_PRODUCER_INVALID");
  visible(producer.name, `${label}.producer.name`, 128);
  releaseVersion(producer.version, `${label}.producer.version`);
  identifier(producer.invocationId, `${label}.producer.invocationId`);
  return { ...producer };
}

function parseJson(bytes, label, code) {
  try {
    const serialized = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
    return JSON.parse(serialized);
  } catch {
    invalid(code, `${label} is not valid JSON`);
  }
}

function exactObject(value, label, fields, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid(code, `${label} must be a JSON object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (!sameArray(actual, expected)) invalid(code, `${label} fields do not match the closed contract`);
  return value;
}

function array(value, label, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    invalid("B127_CONTROL_ARRAY_INVALID", `${label} must contain between ${minimum} and ${maximum} entries`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid("B127_CONTROL_IDENTIFIER_INVALID", `${label} has an invalid identifier`);
  return value;
}

function commit(value, label) {
  if (typeof value !== "string" || !COMMIT.test(value)) invalid("B127_CONTROL_COMMIT_INVALID", `${label} must be a full lowercase Git object ID`);
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) invalid("B127_CONTROL_DIGEST_INVALID", `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string") invalid("B127_CONTROL_TIMESTAMP_INVALID", `${label} must be canonical UTC ISO-8601`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) invalid("B127_CONTROL_TIMESTAMP_INVALID", `${label} must be canonical UTC ISO-8601`);
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("B127_CONTROL_INTEGER_INVALID", `${label} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function finiteNumber(value, label, minimum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) invalid("B127_CONTROL_NUMBER_INVALID", `${label} must be a finite number at least ${minimum}`);
  return value;
}

function boundedMetricValue(value, unit, label) {
  const maximum = MAXIMUM_VALUE_BY_UNIT[unit];
  if (maximum === undefined) invalid("B127_CONTROL_UNIT_INVALID", `${label} uses an unsupported unit`);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    invalid("B127_CONTROL_NUMBER_INVALID", `${label} must be a finite ${unit} value between 0 and ${maximum}`);
  }
  if ((unit === "count" || unit === "minor_currency") && !Number.isSafeInteger(value)) {
    invalid("B127_CONTROL_INTEGER_INVALID", `${label} must be a non-negative safe integer for ${unit}`);
  }
  return value;
}

function visible(value, label, maximum) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid("B127_CONTROL_TEXT_INVALID", `${label} must contain visible text`);
  }
  return value;
}

function releaseVersion(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(value) ||
    /^(?:pending|unknown|latest|none|not[-_.]?configured|n[._-]?a)$/i.test(value)
  ) {
    invalid("B127_CONTROL_VERSION_INVALID", `${label} must be a concrete immutable version`);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("B127_CONTROL_CANONICAL_JSON_INVALID", "Control evidence contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  invalid("B127_CONTROL_CANONICAL_JSON_INVALID", "Control evidence contains a non-JSON value");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalid(code, message, status = "FAIL") {
  throw new B127ReleaseControlError(code, message, status);
}
