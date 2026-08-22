import { ProductionIntegrationError, parseJsonObject, requiredString } from "./production-common.js";
import type { EvidenceAttestor } from "./production-common.js";
import type {
  OperationalReportEvidenceBinding,
  SignedCapabilityEvidence,
} from "./evidence.js";

export type OperationalReportV1 =
  | ExperienceGateReportV1
  | ModelEvaluationReportV1
  | ConfigurationChangeReportV1
  | CapacityTestReportV1
  | ResilienceExerciseReportV1;

export interface ExperienceGateReportV1 {
  readonly version: "ltm.experience-gate-report.v1";
  readonly releaseCandidate: string;
  readonly baselineId: string;
  readonly taskSuccessRate: number;
  readonly unresolvedCriticalIssues: number;
  readonly controlledCopyApproved: true;
  readonly aiDisclosurePresent: true;
  readonly humanVisualApproval: true;
  readonly violations: readonly string[];
  readonly passed: true;
}

export interface ModelEvaluationReportV1 {
  readonly version: "ltm.model-evaluation-report.v1";
  readonly evaluationId: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly datasetId: string;
  readonly cohorts: readonly string[];
  readonly metrics: readonly string[];
  readonly criticalFailures: 0;
  readonly rollbackReady: true;
  readonly rawMediaRetained: false;
  readonly violations: readonly string[];
  readonly passed: true;
}

export interface ConfigurationChangeReportV1 {
  readonly version: "ltm.configuration-change-report.v1";
  readonly changeId: string;
  readonly targetEnvironment: "local" | "ci" | "staging" | "production";
  readonly schemaVersion: string;
  readonly changedFields: readonly string[];
  readonly driftFindingsCount: 0;
  readonly disabledNonWaivableControls: readonly string[];
  readonly rollbackVerified: true;
  readonly violations: readonly string[];
  readonly passed: true;
}

export interface CapacityTestReportV1 {
  readonly version: "ltm.capacity-test-report.v1";
  readonly testRunId: string;
  readonly scenarios: readonly string[];
  readonly observedP95Ms: number;
  readonly maxP95Ms: number;
  readonly observedErrorRate: number;
  readonly maxErrorRate: number;
  readonly syntheticDataOnly: true;
  readonly paidTasksProtected: true;
  readonly tenantFairnessVerified: true;
  readonly violations: readonly string[];
  readonly passed: true;
}

export interface ResilienceExerciseReportV1 {
  readonly version: "ltm.resilience-exercise-report.v1";
  readonly exerciseId: string;
  readonly targetRtoSeconds: number;
  readonly observedRtoSeconds: number;
  readonly targetRpoSeconds: number;
  readonly observedRpoSeconds: number;
  readonly failoverRegion: string;
  readonly cancellationPriorityVerified: true;
  readonly deletionResurrectionPrevented: true;
  readonly duplicateSideEffectsPrevented: true;
  readonly violations: readonly string[];
  readonly passed: true;
}

export function parseOperationalReport(
  binding: OperationalReportEvidenceBinding,
  bytes: Uint8Array,
): OperationalReportV1 {
  let reportValue: OperationalReportV1;
  let reportSubject: string;
  switch (binding.batchId) {
    case "B56":
      reportValue = parseExperienceGateReport(bytes);
      reportSubject = reportValue.releaseCandidate;
      break;
    case "B118":
      reportValue = parseModelEvaluationReport(bytes);
      reportSubject = reportValue.evaluationId;
      break;
    case "B119":
      reportValue = parseConfigurationChangeReport(bytes);
      reportSubject = reportValue.changeId;
      break;
    case "B121":
      reportValue = parseCapacityTestReport(bytes);
      reportSubject = reportValue.testRunId;
      break;
    case "B122":
      reportValue = parseResilienceExerciseReport(bytes);
      reportSubject = reportValue.exerciseId;
      break;
  }
  if (reportSubject !== binding.subjectId) {
    invalid("signed operational report subject does not match its evidence scope");
  }
  return reportValue;
}

/** Validates a closed report schema before any LTM evidence envelope is signed. */
export async function attestOperationalReport<Binding extends OperationalReportEvidenceBinding>(
  attestor: EvidenceAttestor,
  binding: Binding,
  artifact: Uint8Array,
): Promise<SignedCapabilityEvidence<Binding>> {
  parseOperationalReport(binding, artifact);
  return attestor.attest(binding, artifact);
}

export function parseExperienceGateReport(bytes: Uint8Array): ExperienceGateReportV1 {
  const value = report(bytes, "experience gate report", [
    "version", "releaseCandidate", "baselineId", "taskSuccessRate", "unresolvedCriticalIssues",
    "controlledCopyApproved", "aiDisclosurePresent", "humanVisualApproval", "violations", "passed",
  ]);
  exactVersion(value, "ltm.experience-gate-report.v1");
  const taskSuccessRate = number(value.taskSuccessRate, "taskSuccessRate", 0, 1);
  const unresolvedCriticalIssues = integer(value.unresolvedCriticalIssues, "unresolvedCriticalIssues", 0);
  const violations = stringArray(value.violations, "violations");
  trueField(value.controlledCopyApproved, "controlledCopyApproved");
  trueField(value.aiDisclosurePresent, "aiDisclosurePresent");
  trueField(value.humanVisualApproval, "humanVisualApproval");
  passed(value.passed, violations, unresolvedCriticalIssues === 0);
  return {
    version: "ltm.experience-gate-report.v1",
    releaseCandidate: requiredString(value.releaseCandidate, "releaseCandidate", 128),
    baselineId: requiredString(value.baselineId, "baselineId", 128),
    taskSuccessRate,
    unresolvedCriticalIssues,
    controlledCopyApproved: true,
    aiDisclosurePresent: true,
    humanVisualApproval: true,
    violations,
    passed: true,
  };
}

export function parseModelEvaluationReport(bytes: Uint8Array): ModelEvaluationReportV1 {
  const value = report(bytes, "model evaluation report", [
    "version", "evaluationId", "modelVersion", "promptVersion", "datasetId", "cohorts", "metrics",
    "criticalFailures", "rollbackReady", "rawMediaRetained", "violations", "passed",
  ]);
  exactVersion(value, "ltm.model-evaluation-report.v1");
  const cohorts = stringArray(value.cohorts, "cohorts", 4);
  const metrics = stringArray(value.metrics, "metrics", 6);
  if (!cohorts.includes("minor") || !metrics.includes("safety") || !metrics.includes("fairness")) invalid("model evaluation coverage is incomplete");
  if (integer(value.criticalFailures, "criticalFailures", 0) !== 0 || value.rawMediaRetained !== false) invalid("model evaluation has a release blocker");
  trueField(value.rollbackReady, "rollbackReady");
  const violations = stringArray(value.violations, "violations");
  passed(value.passed, violations, true);
  return {
    version: "ltm.model-evaluation-report.v1",
    evaluationId: requiredString(value.evaluationId, "evaluationId", 128),
    modelVersion: requiredString(value.modelVersion, "modelVersion", 128),
    promptVersion: requiredString(value.promptVersion, "promptVersion", 128),
    datasetId: requiredString(value.datasetId, "datasetId", 128),
    cohorts,
    metrics,
    criticalFailures: 0,
    rollbackReady: true,
    rawMediaRetained: false,
    violations,
    passed: true,
  };
}

export function parseConfigurationChangeReport(bytes: Uint8Array): ConfigurationChangeReportV1 {
  const value = report(bytes, "configuration change report", [
    "version", "changeId", "targetEnvironment", "schemaVersion", "changedFields", "driftFindingsCount",
    "disabledNonWaivableControls", "rollbackVerified", "violations", "passed",
  ]);
  exactVersion(value, "ltm.configuration-change-report.v1");
  const targetEnvironment = enumField(value.targetEnvironment, "targetEnvironment", ["local", "ci", "staging", "production"] as const);
  const changedFields = stringArray(value.changedFields, "changedFields", 1);
  const disabledNonWaivableControls = stringArray(value.disabledNonWaivableControls, "disabledNonWaivableControls");
  if (integer(value.driftFindingsCount, "driftFindingsCount", 0) !== 0 || disabledNonWaivableControls.length !== 0) {
    invalid("configuration change report has unresolved drift or disables a non-waivable control");
  }
  trueField(value.rollbackVerified, "rollbackVerified");
  const violations = stringArray(value.violations, "violations");
  passed(value.passed, violations, true);
  return {
    version: "ltm.configuration-change-report.v1",
    changeId: requiredString(value.changeId, "changeId", 128),
    targetEnvironment,
    schemaVersion: requiredString(value.schemaVersion, "schemaVersion", 128),
    changedFields,
    driftFindingsCount: 0,
    disabledNonWaivableControls,
    rollbackVerified: true,
    violations,
    passed: true,
  };
}

export function parseCapacityTestReport(bytes: Uint8Array): CapacityTestReportV1 {
  const value = report(bytes, "capacity test report", [
    "version", "testRunId", "scenarios", "observedP95Ms", "maxP95Ms", "observedErrorRate", "maxErrorRate",
    "syntheticDataOnly", "paidTasksProtected", "tenantFairnessVerified", "violations", "passed",
  ]);
  exactVersion(value, "ltm.capacity-test-report.v1");
  const scenarios = stringArray(value.scenarios, "scenarios", 5);
  for (const required of ["baseline", "peak", "burst", "soak", "dependency_degraded"]) {
    if (!scenarios.includes(required)) invalid(`capacity report is missing ${required}`);
  }
  const observedP95Ms = number(value.observedP95Ms, "observedP95Ms", 0);
  const maxP95Ms = number(value.maxP95Ms, "maxP95Ms", 1);
  const observedErrorRate = number(value.observedErrorRate, "observedErrorRate", 0, 1);
  const maxErrorRate = number(value.maxErrorRate, "maxErrorRate", 0, 1);
  trueField(value.syntheticDataOnly, "syntheticDataOnly");
  trueField(value.paidTasksProtected, "paidTasksProtected");
  trueField(value.tenantFairnessVerified, "tenantFairnessVerified");
  const violations = stringArray(value.violations, "violations");
  passed(value.passed, violations, observedP95Ms <= maxP95Ms && observedErrorRate <= maxErrorRate);
  return {
    version: "ltm.capacity-test-report.v1",
    testRunId: requiredString(value.testRunId, "testRunId", 128),
    scenarios,
    observedP95Ms,
    maxP95Ms,
    observedErrorRate,
    maxErrorRate,
    syntheticDataOnly: true,
    paidTasksProtected: true,
    tenantFairnessVerified: true,
    violations,
    passed: true,
  };
}

export function parseResilienceExerciseReport(bytes: Uint8Array): ResilienceExerciseReportV1 {
  const value = report(bytes, "resilience exercise report", [
    "version", "exerciseId", "targetRtoSeconds", "observedRtoSeconds", "targetRpoSeconds", "observedRpoSeconds",
    "failoverRegion", "cancellationPriorityVerified", "deletionResurrectionPrevented", "duplicateSideEffectsPrevented",
    "violations", "passed",
  ]);
  exactVersion(value, "ltm.resilience-exercise-report.v1");
  const targetRtoSeconds = number(value.targetRtoSeconds, "targetRtoSeconds", 0);
  const observedRtoSeconds = number(value.observedRtoSeconds, "observedRtoSeconds", 0);
  const targetRpoSeconds = number(value.targetRpoSeconds, "targetRpoSeconds", 0);
  const observedRpoSeconds = number(value.observedRpoSeconds, "observedRpoSeconds", 0);
  trueField(value.cancellationPriorityVerified, "cancellationPriorityVerified");
  trueField(value.deletionResurrectionPrevented, "deletionResurrectionPrevented");
  trueField(value.duplicateSideEffectsPrevented, "duplicateSideEffectsPrevented");
  const violations = stringArray(value.violations, "violations");
  passed(value.passed, violations, observedRtoSeconds <= targetRtoSeconds && observedRpoSeconds <= targetRpoSeconds);
  return {
    version: "ltm.resilience-exercise-report.v1",
    exerciseId: requiredString(value.exerciseId, "exerciseId", 128),
    targetRtoSeconds,
    observedRtoSeconds,
    targetRpoSeconds,
    observedRpoSeconds,
    failoverRegion: requiredString(value.failoverRegion, "failoverRegion", 128),
    cancellationPriorityVerified: true,
    deletionResurrectionPrevented: true,
    duplicateSideEffectsPrevented: true,
    violations,
    passed: true,
  };
}

function report(bytes: Uint8Array, label: string, fields: readonly string[]): Record<string, unknown> {
  const value = parseJsonObject(bytes, label);
  const extra = Object.keys(value).filter((key) => !fields.includes(key));
  const missing = fields.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (extra.length > 0 || missing.length > 0) invalid(`${label} does not match the closed schema`);
  return value;
}

function exactVersion(value: Record<string, unknown>, expected: string): void {
  if (value.version !== expected) invalid("operational report version is unsupported");
}

function stringArray(value: unknown, field: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 256 ||
      value.some((entry) => typeof entry !== "string" || entry.trim() === "" || entry.length > 256) ||
      new Set(value).size !== value.length) invalid(`${field} must be a bounded unique string array`);
  return [...value] as string[];
}

function number(value: unknown, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) invalid(`${field} is invalid`);
  return value;
}

function integer(value: unknown, field: string, minimum: number): number {
  const result = number(value, field, minimum);
  if (!Number.isSafeInteger(result)) invalid(`${field} must be an integer`);
  return result;
}

function trueField(value: unknown, field: string): asserts value is true {
  if (value !== true) invalid(`${field} must be true in a passing signed report`);
}

function passed(value: unknown, violations: readonly string[], computedPass: boolean): asserts value is true {
  if (value !== true || violations.length !== 0 || !computedPass) invalid("signed operational report does not pass its server-side policy");
}

function enumField<const Values extends readonly string[]>(value: unknown, field: string, values: Values): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) invalid(`${field} is invalid`);
  return value as Values[number];
}

function invalid(message: string): never {
  throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", message);
}
