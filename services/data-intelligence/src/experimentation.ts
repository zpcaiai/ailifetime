import { clone, DataIntelligenceError, fingerprint, required, strictUtc, unique } from "./common.js";

export const PROTECTED_EXPERIMENT_CONTROLS = [
  "participant_consent", "ai_generation_label", "child_protection", "high_impact_decision_ban", "payment_truth", "data_deletion",
] as const;
export type ProtectedExperimentControl = (typeof PROTECTED_EXPERIMENT_CONTROLS)[number];
export type ExperimentState = "DRAFT" | "APPROVED" | "RUNNING" | "PAUSED" | "CONCLUDED" | "ROLLED_OUT";

export interface ExperimentVariant {
  readonly id: string;
  readonly allocationBasisPoints: number;
  readonly changes: Readonly<Record<string, string | number | boolean>>;
}

export interface ExperimentDefinition {
  readonly id: string;
  readonly hypothesis: string;
  readonly population: string;
  readonly assignmentUnit: "account" | "family" | "session" | "partner";
  readonly strata: readonly string[];
  readonly layer: string;
  readonly holdoutBasisPoints: number;
  readonly variants: readonly ExperimentVariant[];
  readonly primaryMetric: string;
  readonly guardrailMetrics: readonly string[];
  readonly minimumSampleSize: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly stoppingRule: "fixed_sample" | "sequential";
  readonly forbiddenControlChanges: readonly ProtectedExperimentControl[];
}

export interface Assignment {
  readonly experimentId: string;
  readonly subjectId: string;
  readonly variantId: string | "holdout";
  readonly assignedAt: string;
  readonly assignmentFingerprint: string;
}

export interface Exposure {
  readonly exposureId: string;
  readonly experimentId: string;
  readonly subjectId: string;
  readonly variantId: string | "holdout";
  readonly occurredAt: string;
  readonly channel: "web" | "mobile" | "mini_program" | "server";
}

export interface ExperimentObservation {
  readonly subjectId: string;
  readonly variantId: string | "holdout";
  readonly converted: boolean;
  readonly metricValue: number;
  readonly stratum: string;
}

export interface ExperimentAnalysis {
  readonly experimentId: string;
  readonly status: "INSUFFICIENT_SAMPLE" | "VALID" | "INVALID_SRM" | "CONTAMINATED";
  readonly sampleSize: number;
  readonly missingExposureCount: number;
  readonly contaminationCount: number;
  readonly srmChiSquare: number;
  readonly multipleComparisonAlpha: number;
  readonly variants: Readonly<Record<string, { readonly count: number; readonly conversionRate: number; readonly mean: number; readonly confidenceLow: number; readonly confidenceHigh: number }>>;
  readonly heterogeneousStrata: readonly string[];
}

interface ManagedExperiment {
  readonly definition: ExperimentDefinition;
  state: ExperimentState;
  readonly approvals: Array<{ actorId: string; action: string; reason: string; at: string }>;
}

export class ExperimentService {
  readonly #experiments = new Map<string, ManagedExperiment>();
  readonly #assignments = new Map<string, Assignment>();
  readonly #layersBySubject = new Map<string, string>();
  readonly #exposures = new Map<string, Exposure>();

  constructor(readonly salt: string, readonly now: () => Date = () => new Date()) {
    if (salt.length < 32) throw new DataIntelligenceError("VALIDATION_FAILED", "assignment salt must have at least 32 characters");
  }

  create(definition: ExperimentDefinition): void {
    validateDefinition(definition);
    if (this.#experiments.has(definition.id)) throw new DataIntelligenceError("CONFLICT", "experiment already exists");
    this.#experiments.set(definition.id, { definition: Object.freeze(clone(definition)), state: "DRAFT", approvals: [] });
  }

  transition(input: { readonly experimentId: string; readonly target: ExperimentState; readonly actorId: string; readonly reason: string; readonly approved: boolean }): ExperimentState {
    const managed = this.#managed(input.experimentId);
    required(input.actorId, "actorId"); required(input.reason, "reason");
    const allowed: Readonly<Record<ExperimentState, readonly ExperimentState[]>> = {
      DRAFT: ["APPROVED"], APPROVED: ["RUNNING"], RUNNING: ["PAUSED", "CONCLUDED"],
      PAUSED: ["RUNNING", "CONCLUDED"], CONCLUDED: ["ROLLED_OUT"], ROLLED_OUT: [],
    };
    if (!allowed[managed.state].includes(input.target)) throw new DataIntelligenceError("CONFLICT", `invalid experiment transition ${managed.state} -> ${input.target}`);
    if (!input.approved) throw new DataIntelligenceError("AUTHORIZATION_DENIED", "experiment lifecycle action requires an approval decision");
    managed.state = input.target;
    managed.approvals.push({ actorId: input.actorId, action: input.target, reason: input.reason, at: this.now().toISOString() });
    return managed.state;
  }

  assign(experimentId: string, subjectId: string): Assignment {
    const managed = this.#managed(experimentId);
    if (managed.state !== "RUNNING") throw new DataIntelligenceError("POLICY_BLOCKED", "experiment is not running");
    required(subjectId, "subjectId");
    const key = `${experimentId}:${subjectId}`;
    const existing = this.#assignments.get(key);
    if (existing !== undefined) return existing;
    const occupiedLayer = this.#layersBySubject.get(`${managed.definition.layer}:${subjectId}`);
    if (occupiedLayer !== undefined && occupiedLayer !== experimentId) throw new DataIntelligenceError("POLICY_BLOCKED", "subject is already assigned in the mutually exclusive layer");
    const bucket = Number.parseInt(fingerprint(`${this.salt}:${experimentId}:${subjectId}`).slice(0, 8), 16) % 10_000;
    let variantId: string | "holdout" = "holdout";
    let cursor = managed.definition.holdoutBasisPoints;
    if (bucket >= cursor) {
      for (const variant of managed.definition.variants) {
        cursor += variant.allocationBasisPoints;
        if (bucket < cursor) { variantId = variant.id; break; }
      }
    }
    const assignedAt = this.now().toISOString();
    const assignment = Object.freeze({ experimentId, subjectId, variantId, assignedAt, assignmentFingerprint: fingerprint({ experimentId, subjectId, variantId, assignedAt }) });
    this.#assignments.set(key, assignment);
    this.#layersBySubject.set(`${managed.definition.layer}:${subjectId}`, experimentId);
    return assignment;
  }

  expose(input: Omit<Exposure, "variantId">): Exposure {
    const managed = this.#managed(input.experimentId);
    if (managed.state !== "RUNNING") throw new DataIntelligenceError("POLICY_BLOCKED", "cannot record exposure for an experiment that is not running");
    required(input.exposureId, "exposureId"); strictUtc(input.occurredAt, "exposure occurredAt");
    const assignment = this.#assignments.get(`${input.experimentId}:${input.subjectId}`);
    if (assignment === undefined) throw new DataIntelligenceError("NOT_FOUND", "exposure has no server-issued assignment");
    const existing = this.#exposures.get(input.exposureId);
    const exposure: Exposure = Object.freeze({ ...clone(input), variantId: assignment.variantId });
    if (existing !== undefined) {
      if (fingerprint(existing) !== fingerprint(exposure)) throw new DataIntelligenceError("CONFLICT", "exposure id was reused");
      return existing;
    }
    this.#exposures.set(input.exposureId, exposure);
    return exposure;
  }

  analyze(experimentId: string, observations: readonly ExperimentObservation[], alpha = 0.05): ExperimentAnalysis {
    const managed = this.#managed(experimentId);
    if (alpha <= 0 || alpha >= 1) throw new DataIntelligenceError("VALIDATION_FAILED", "analysis alpha is invalid");
    const assignments = [...this.#assignments.values()].filter((assignment) => assignment.experimentId === experimentId);
    const exposureSubjects = new Set([...this.#exposures.values()].filter((exposure) => exposure.experimentId === experimentId).map((exposure) => exposure.subjectId));
    const assignmentBySubject = new Map(assignments.map((assignment) => [assignment.subjectId, assignment]));
    const missingExposureCount = assignments.filter((assignment) => !exposureSubjects.has(assignment.subjectId)).length;
    const contaminationCount = observations.filter((observation) => assignmentBySubject.get(observation.subjectId)?.variantId !== observation.variantId).length;
    const valid = observations.filter((observation) => exposureSubjects.has(observation.subjectId) && assignmentBySubject.get(observation.subjectId)?.variantId === observation.variantId);
    const expectedWeights = new Map<string, number>([["holdout", managed.definition.holdoutBasisPoints / 10_000], ...managed.definition.variants.map((variant) => [variant.id, variant.allocationBasisPoints / 10_000] as const)]);
    const counts = new Map<string, ExperimentObservation[]>();
    for (const observation of valid) counts.set(observation.variantId, [...(counts.get(observation.variantId) ?? []), observation]);
    const srmChiSquare = [...expectedWeights.entries()].reduce((sum, [variant, weight]) => {
      const expected = valid.length * weight;
      const observed = counts.get(variant)?.length ?? 0;
      return expected === 0 ? sum : sum + ((observed - expected) ** 2) / expected;
    }, 0);
    const comparisonAlpha = alpha / Math.max(1, expectedWeights.size - 1);
    const variants: Record<string, { count: number; conversionRate: number; mean: number; confidenceLow: number; confidenceHigh: number }> = {};
    for (const [variant, rows] of counts) {
      const count = rows.length;
      const conversionRate = count === 0 ? 0 : rows.filter((row) => row.converted).length / count;
      const mean = count === 0 ? 0 : rows.reduce((sum, row) => sum + row.metricValue, 0) / count;
      const standardError = count === 0 ? 0 : Math.sqrt(conversionRate * (1 - conversionRate) / count);
      const z = comparisonAlpha < 0.025 ? 2.576 : 1.96;
      variants[variant] = { count, conversionRate, mean, confidenceLow: Math.max(0, conversionRate - z * standardError), confidenceHigh: Math.min(1, conversionRate + z * standardError) };
    }
    const strata = new Map<string, number[]>();
    for (const row of valid) strata.set(row.stratum, [...(strata.get(row.stratum) ?? []), row.metricValue]);
    const overallMean = valid.length === 0 ? 0 : valid.reduce((sum, row) => sum + row.metricValue, 0) / valid.length;
    const heterogeneousStrata = [...strata.entries()].filter(([, values]) => Math.abs(values.reduce((sum, value) => sum + value, 0) / values.length - overallMean) > Math.max(1, Math.abs(overallMean) * 0.5)).map(([stratum]) => stratum);
    const status: ExperimentAnalysis["status"] = valid.length < managed.definition.minimumSampleSize ? "INSUFFICIENT_SAMPLE" : contaminationCount > 0 ? "CONTAMINATED" : srmChiSquare > 9.21 ? "INVALID_SRM" : "VALID";
    return Object.freeze({ experimentId, status, sampleSize: valid.length, missingExposureCount, contaminationCount, srmChiSquare, multipleComparisonAlpha: comparisonAlpha, variants: Object.freeze(variants), heterogeneousStrata: Object.freeze(heterogeneousStrata) });
  }

  audit(experimentId: string): readonly Readonly<{ actorId: string; action: string; reason: string; at: string }>[] {
    return Object.freeze(this.#managed(experimentId).approvals.map((entry) => Object.freeze({ ...entry })));
  }

  #managed(experimentId: string): ManagedExperiment {
    const managed = this.#experiments.get(experimentId);
    if (managed === undefined) throw new DataIntelligenceError("NOT_FOUND", "experiment does not exist");
    return managed;
  }
}

function validateDefinition(definition: ExperimentDefinition): void {
  required(definition.id, "experiment id"); required(definition.hypothesis, "hypothesis"); required(definition.population, "population"); required(definition.layer, "layer"); required(definition.primaryMetric, "primaryMetric");
  unique(definition.strata, "experiment strata"); unique(definition.guardrailMetrics, "guardrail metrics"); unique(definition.forbiddenControlChanges, "protected controls");
  if (new Set(definition.forbiddenControlChanges).size !== PROTECTED_EXPERIMENT_CONTROLS.length || PROTECTED_EXPERIMENT_CONTROLS.some((control) => !definition.forbiddenControlChanges.includes(control))) {
    throw new DataIntelligenceError("POLICY_BLOCKED", "all non-negotiable product controls must be protected from experimentation");
  }
  strictUtc(definition.startsAt, "startsAt"); strictUtc(definition.endsAt, "endsAt");
  if (Date.parse(definition.startsAt) >= Date.parse(definition.endsAt)) throw new DataIntelligenceError("VALIDATION_FAILED", "experiment time range is invalid");
  if (!Number.isSafeInteger(definition.minimumSampleSize) || definition.minimumSampleSize < 20) throw new DataIntelligenceError("VALIDATION_FAILED", "minimum sample size is too small");
  if (!Number.isSafeInteger(definition.holdoutBasisPoints) || definition.holdoutBasisPoints < 0) throw new DataIntelligenceError("VALIDATION_FAILED", "holdout allocation is invalid");
  unique(definition.variants.map((variant) => variant.id), "variant ids");
  const total = definition.holdoutBasisPoints + definition.variants.reduce((sum, variant) => {
    if (!Number.isSafeInteger(variant.allocationBasisPoints) || variant.allocationBasisPoints < 1) throw new DataIntelligenceError("VALIDATION_FAILED", "variant allocation is invalid");
    for (const control of PROTECTED_EXPERIMENT_CONTROLS) {
      if (Object.hasOwn(variant.changes, control)) throw new DataIntelligenceError("POLICY_BLOCKED", `variant cannot alter ${control}`);
    }
    return sum + variant.allocationBasisPoints;
  }, 0);
  if (total !== 10_000) throw new DataIntelligenceError("VALIDATION_FAILED", "experiment allocation must total 10000 basis points");
}
