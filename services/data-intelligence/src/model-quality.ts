import { clone, DataIntelligenceError, fingerprint, required, strictUtc, unique } from "./common.js";

export interface EvaluationDataset {
  readonly id: string;
  readonly version: number;
  readonly source: "synthetic" | "authorized";
  readonly licenseId: string;
  readonly consentPurpose: string;
  readonly dataCardSha256: string;
  readonly dimensions: Readonly<Record<"age_range" | "skin_tone" | "gender_expression" | "device" | "multi_person" | "hard_case", readonly string[]>>;
  readonly rawMediaRetentionDays: number;
}

export interface EvaluationMetricResult {
  readonly metric: "identity_consistency" | "age_perceptibility" | "temporal_continuity" | "artifact_rate" | "text_quality" | "audio_quality" | "ai_label_integrity" | "safety" | "fairness";
  readonly score: number;
  readonly threshold: number;
  readonly groupScores: Readonly<Record<string, number>>;
  readonly humanRubricScore: number;
}

export interface OfflineEvaluation {
  readonly evaluationId: string;
  readonly datasetId: string;
  readonly modelVersionId: string;
  readonly completedAt: string;
  readonly metrics: readonly EvaluationMetricResult[];
  readonly highRiskFailures: number;
  readonly evaluatorIds: readonly string[];
}

export interface ModelVersion {
  readonly id: string;
  readonly predecessorId?: string;
  readonly modelArtifactSha256: string;
  readonly promptSha256: string;
  readonly parametersSha256: string;
  readonly postprocessorSha256: string;
  readonly evaluationId: string;
  readonly rollout: "shadow" | "canary" | "production";
  readonly rollbackReady: boolean;
  readonly registeredAt: string;
}

export interface ProductionQualityObservation {
  readonly observationId: string;
  readonly modelVersionId: string;
  readonly observedAt: string;
  readonly sampleCount: number;
  readonly rejectRate: number;
  readonly retryRate: number;
  readonly appealRate: number;
  readonly costPerSuccessMinor: number;
  readonly p95LatencyMs: number;
  readonly distributionDrift: number;
  readonly safetyRegression: boolean;
  readonly highRiskFailure: boolean;
  readonly groupScores: Readonly<Record<string, number>>;
  readonly rawMediaIncluded: boolean;
}

export interface ModelControlDecision {
  readonly modelVersionId: string;
  readonly action: "KEEP" | "DISABLE" | "ROLLBACK";
  readonly reasonCodes: readonly string[];
  readonly replacementModelVersionId?: string;
  readonly recertificationRequired: boolean;
}

interface RegisteredModel {
  readonly version: ModelVersion;
  enabled: boolean;
  readonly decisions: ModelControlDecision[];
}

export class ModelQualityService {
  readonly #datasets = new Map<string, EvaluationDataset>();
  readonly #evaluations = new Map<string, OfflineEvaluation>();
  readonly #models = new Map<string, RegisteredModel>();

  registerDataset(dataset: EvaluationDataset): void {
    required(dataset.id, "dataset id"); required(dataset.licenseId, "dataset license"); required(dataset.consentPurpose, "dataset consent purpose");
    if (!Number.isSafeInteger(dataset.version) || dataset.version < 1 || !/^[a-f0-9]{64}$/u.test(dataset.dataCardSha256)) throw new DataIntelligenceError("VALIDATION_FAILED", "dataset version or data card is invalid");
    if (!Number.isSafeInteger(dataset.rawMediaRetentionDays) || dataset.rawMediaRetentionDays < 0 || dataset.rawMediaRetentionDays > 365) throw new DataIntelligenceError("POLICY_BLOCKED", "evaluation raw-media retention is invalid");
    for (const [dimension, values] of Object.entries(dataset.dimensions)) unique(values, `dataset ${dimension}`);
    if (Object.values(dataset.dimensions).some((values) => values.length < 2)) throw new DataIntelligenceError("VALIDATION_FAILED", "evaluation dataset must cover every required diversity dimension");
    const key = `${dataset.id}@${dataset.version}`;
    if (this.#datasets.has(key)) throw new DataIntelligenceError("CONFLICT", "evaluation dataset already exists");
    this.#datasets.set(key, Object.freeze(clone(dataset)));
  }

  recordOfflineEvaluation(evaluation: OfflineEvaluation): { readonly passed: boolean; readonly failures: readonly string[] } {
    required(evaluation.evaluationId, "evaluation id"); strictUtc(evaluation.completedAt, "evaluation completedAt"); unique(evaluation.evaluatorIds, "evaluators");
    if (![...this.#datasets.keys()].some((key) => key.startsWith(`${evaluation.datasetId}@`))) throw new DataIntelligenceError("NOT_FOUND", "evaluation dataset is not registered");
    if (evaluation.metrics.length !== 9 || new Set(evaluation.metrics.map((result) => result.metric)).size !== 9) throw new DataIntelligenceError("VALIDATION_FAILED", "offline evaluation must cover the complete metric contract");
    const failures: string[] = [];
    for (const result of evaluation.metrics) {
      if (![result.score, result.threshold, result.humanRubricScore, ...Object.values(result.groupScores)].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
        throw new DataIntelligenceError("VALIDATION_FAILED", `evaluation metric ${result.metric} is invalid`);
      }
      if (result.score < result.threshold || result.humanRubricScore < result.threshold) failures.push(`${result.metric}:below_threshold`);
      const groupValues = Object.values(result.groupScores);
      if (groupValues.length < 2 || Math.max(...groupValues) - Math.min(...groupValues) > 0.1) failures.push(`${result.metric}:group_disparity`);
    }
    if (evaluation.highRiskFailures > 0) failures.push("high_risk_failure");
    if (this.#evaluations.has(evaluation.evaluationId)) throw new DataIntelligenceError("CONFLICT", "evaluation id already exists");
    this.#evaluations.set(evaluation.evaluationId, Object.freeze(clone(evaluation)));
    return Object.freeze({ passed: failures.length === 0, failures: Object.freeze(failures) });
  }

  registerModel(version: ModelVersion): void {
    for (const [field, digest] of Object.entries(version).filter(([key]) => key.endsWith("Sha256"))) {
      if (!/^[a-f0-9]{64}$/u.test(String(digest))) throw new DataIntelligenceError("VALIDATION_FAILED", `${field} is invalid`);
    }
    strictUtc(version.registeredAt, "registeredAt");
    const evaluation = this.#evaluations.get(version.evaluationId);
    if (evaluation === undefined || evaluation.modelVersionId !== version.id) throw new DataIntelligenceError("NOT_FOUND", "model has no bound offline evaluation");
    const result = this.#evaluationFailures(evaluation);
    if (result.length > 0) throw new DataIntelligenceError("POLICY_BLOCKED", `model evaluation failed: ${result.join(",")}`);
    if (!version.rollbackReady) throw new DataIntelligenceError("POLICY_BLOCKED", "model registration requires a tested rollback path");
    if (version.rollout !== "shadow" && version.predecessorId === undefined) throw new DataIntelligenceError("POLICY_BLOCKED", "non-shadow rollout requires a predecessor");
    if (version.predecessorId !== undefined && !this.#models.has(version.predecessorId)) throw new DataIntelligenceError("NOT_FOUND", "model predecessor is not registered");
    if (this.#models.has(version.id)) throw new DataIntelligenceError("CONFLICT", "model version already exists");
    this.#models.set(version.id, { version: Object.freeze(clone(version)), enabled: true, decisions: [] });
  }

  observe(observation: ProductionQualityObservation): ModelControlDecision {
    const registered = this.#models.get(observation.modelVersionId);
    if (registered === undefined) throw new DataIntelligenceError("NOT_FOUND", "model version is not registered");
    required(observation.observationId, "observation id"); strictUtc(observation.observedAt, "observedAt");
    if (observation.rawMediaIncluded) throw new DataIntelligenceError("POLICY_BLOCKED", "production quality telemetry cannot retain unauthorized raw media");
    if (!Number.isSafeInteger(observation.sampleCount) || observation.sampleCount < 1 || !Number.isSafeInteger(observation.costPerSuccessMinor) || observation.costPerSuccessMinor < 0 || !Number.isSafeInteger(observation.p95LatencyMs) || observation.p95LatencyMs < 0) {
      throw new DataIntelligenceError("VALIDATION_FAILED", "production quality observation counts are invalid");
    }
    for (const [field, value] of [["rejectRate", observation.rejectRate], ["retryRate", observation.retryRate], ["appealRate", observation.appealRate], ["distributionDrift", observation.distributionDrift]] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new DataIntelligenceError("VALIDATION_FAILED", `${field} is invalid`);
    }
    const groupValues = Object.values(observation.groupScores);
    if (groupValues.length < 2 || groupValues.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new DataIntelligenceError("VALIDATION_FAILED", "production group scores are invalid");
    const reasons = [
      ...(observation.highRiskFailure ? ["high_risk_failure"] : []),
      ...(observation.safetyRegression ? ["safety_regression"] : []),
      ...(Math.max(...groupValues) - Math.min(...groupValues) > 0.1 ? ["group_disparity"] : []),
      ...(observation.distributionDrift > 0.2 ? ["distribution_drift"] : []),
      ...(observation.rejectRate > 0.25 ? ["quality_reject_rate"] : []),
    ];
    const severe = observation.highRiskFailure || observation.safetyRegression || reasons.includes("group_disparity");
    const replacement = registered.version.predecessorId;
    const action: ModelControlDecision["action"] = reasons.length === 0 ? "KEEP" : severe && replacement !== undefined ? "ROLLBACK" : "DISABLE";
    if (action !== "KEEP") registered.enabled = false;
    const decision: ModelControlDecision = Object.freeze({
      modelVersionId: observation.modelVersionId, action, reasonCodes: Object.freeze(reasons),
      ...(action === "ROLLBACK" && replacement !== undefined ? { replacementModelVersionId: replacement } : {}),
      recertificationRequired: action !== "KEEP",
    });
    registered.decisions.push(decision);
    return decision;
  }

  status(modelVersionId: string): { readonly enabled: boolean; readonly versionFingerprint: string; readonly decisions: readonly ModelControlDecision[] } {
    const registered = this.#models.get(modelVersionId);
    if (registered === undefined) throw new DataIntelligenceError("NOT_FOUND", "model version is not registered");
    return Object.freeze({ enabled: registered.enabled, versionFingerprint: fingerprint(registered.version), decisions: Object.freeze(registered.decisions.map(clone)) });
  }

  #evaluationFailures(evaluation: OfflineEvaluation): string[] {
    const failures = evaluation.metrics.flatMap((metric) => {
      const scores = Object.values(metric.groupScores);
      return [
        ...(metric.score < metric.threshold ? [`${metric.metric}:metric`] : []),
        ...(metric.humanRubricScore < metric.threshold ? [`${metric.metric}:human_rubric`] : []),
        ...(Math.max(...scores) - Math.min(...scores) > 0.1 ? [`${metric.metric}:fairness`] : []),
      ];
    });
    if (evaluation.highRiskFailures > 0) failures.push("high_risk_failure");
    return failures;
  }
}
