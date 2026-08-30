import {
  EnterpriseControlError, assertActor, bps, exactKeys, hexDigest, identifier, integer,
  text, unique, type EnterpriseActor, type JsonObject, type JsonValue,
} from "./common.js";
import { EnterpriseAttestationVerifier, type SignedEnterpriseAttestation, type VerifiedEnterpriseAttestation } from "./attestation.js";
import type { EnterpriseRepository, EnterpriseSnapshot } from "./store.js";

const OPERATORS = ["platform_admin", "reliability_engineer", "capacity_operator"] as const;
const LOAD_SURFACES = ["web", "api", "upload", "generation_status", "media_download", "payment", "partner_api", "webhook", "background"] as const;
const SCENARIOS = ["baseline", "peak", "spike", "soak", "batch", "weak_dependency", "multi_tenant_noise"] as const;
const METRICS = ["p50Ms", "p95Ms", "p99Ms", "throughputRps", "queueAgeMs", "errorBps", "saturationBps", "costMicrosPerRequest", "uxCompletionMs"] as const;
const FAULTS = ["model_timeout", "model_error", "object_unavailable", "database_read_only", "database_latency", "queue_duplicate", "payment_reorder", "messaging_failure", "vendor_unreachable"] as const;
const PROTECTED_WORK = new Set(["cancellation", "refund", "consent_withdrawal", "delete", "safety", "paid_transaction"]);

type Surface = typeof LOAD_SURFACES[number];
type Scenario = typeof SCENARIOS[number];
type Metric = typeof METRICS[number];
type Fault = typeof FAULTS[number];

export class EnterpriseAssuranceEngine {
  readonly #repository: EnterpriseRepository; readonly #facts: EnterpriseAttestationVerifier;
  constructor(input: { repository: EnterpriseRepository; attestationVerifier: EnterpriseAttestationVerifier; clock?: () => Date }) {
    this.#repository = input.repository; this.#facts = input.attestationVerifier;
  }

  // B121-R01 — all nine externally visible and asynchronous load surfaces are mandatory.
  registerLoadModel(actor: EnterpriseActor, input: { modelId: string; version: string; resourceVersionSha256: string; surfaces: readonly { surface: Surface; peakRps: number; concurrency: number; payloadBytes: number; tenantShareBps: number }[]; idempotencyKey: string }): JsonObject {
    assertActor(actor, OPERATORS);
    const supplied = [...input.surfaces].map((surface) => ({ surface: surface.surface, peakRps: integer(surface.peakRps, "peakRps", 1), concurrency: integer(surface.concurrency, "concurrency", 1), payloadBytes: integer(surface.payloadBytes, "payloadBytes", 1), tenantShareBps: bps(surface.tenantShareBps, "tenantShareBps") }));
    requireExactInventory(supplied.map((entry) => entry.surface), LOAD_SURFACES, "load surfaces");
    const state: JsonObject = { modelId: identifier(input.modelId, "modelId"), version: identifier(input.version, "version"), resourceVersionSha256: hexDigest(input.resourceVersionSha256, "resourceVersionSha256"), surfaces: supplied.sort((a, b) => a.surface.localeCompare(b.surface)), syntheticOnly: true, state: "active" };
    return this.#write(actor, input.idempotencyKey, "B121.registerLoadModel", state, "capacity.loadModel", input.modelId, "capacity.loadModelRegistered", state);
  }

  // B121-R02 — latency/throughput/queue/error/saturation/cost/UX budgets are hard gates.
  registerPerformanceBudget(actor: EnterpriseActor, input: { budgetId: string; loadModelId: string; thresholds: Readonly<Record<Metric, number>>; idempotencyKey: string }): JsonObject {
    assertActor(actor, OPERATORS); this.#required(actor.tenantId, "capacity.loadModel", input.loadModelId); exactKeys(input.thresholds, METRICS, "performance thresholds");
    const thresholds: Record<string, JsonValue> = {};
    for (const metric of METRICS) thresholds[metric] = metric.endsWith("Bps") ? bps(input.thresholds[metric], metric) : integer(input.thresholds[metric], metric, 1);
    const state: JsonObject = { budgetId: identifier(input.budgetId, "budgetId"), loadModelId: input.loadModelId, thresholds, hardReleaseGate: true, state: "active" };
    return this.#write(actor, input.idempotencyKey, "B121.registerBudget", state, "capacity.budget", input.budgetId, "capacity.budgetRegistered", state);
  }

  // B121-R03 — a resource-version-bound synthetic suite must contain every required scenario.
  evaluateScenarioSuite(actor: EnterpriseActor, input: { runId: string; budgetId: string; resourceVersionSha256: string; syntheticDatasetSha256: string; scenarios: readonly { scenario: Scenario; observations: Readonly<Record<Metric, number>> }[]; idempotencyKey: string }): JsonObject {
    assertActor(actor, OPERATORS); const budget = this.#required(actor.tenantId, "capacity.budget", input.budgetId); const load = this.#required(actor.tenantId, "capacity.loadModel", String(budget.state.loadModelId));
    if (hexDigest(input.resourceVersionSha256, "resourceVersionSha256") !== load.state.resourceVersionSha256) throw new EnterpriseControlError("POLICY_BLOCKED", "performance run resource version differs from the load model");
    requireExactInventory(input.scenarios.map((scenario) => scenario.scenario), SCENARIOS, "performance scenarios");
    const failures: JsonObject[] = []; const normalized = input.scenarios.map((scenario) => {
      exactKeys(scenario.observations, METRICS, "scenario observations"); const observations: Record<string, JsonValue> = {};
      for (const metric of METRICS) {
        const value = integer(scenario.observations[metric], metric, 0); observations[metric] = value;
        const threshold = Number((budget.state.thresholds as JsonObject)[metric]); const breached = metric === "throughputRps" ? value < threshold : value > threshold;
        if (breached) failures.push({ scenario: scenario.scenario, metric, observed: value, threshold });
      }
      return { scenario: scenario.scenario, observations };
    });
    const state: JsonObject = { runId: identifier(input.runId, "runId"), budgetId: input.budgetId, resourceVersionSha256: input.resourceVersionSha256, syntheticDatasetSha256: hexDigest(input.syntheticDatasetSha256, "syntheticDatasetSha256"), scenarios: normalized, failures, releaseDecision: failures.length === 0 ? "passed" : "blocked", state: "evaluated" };
    return this.#write(actor, input.idempotencyKey, "B121.evaluateScenarios", state, "capacity.run", input.runId, failures.length === 0 ? "capacity.releasePassed" : "capacity.releaseBlocked", state);
  }

  // B121-R04 — quota/backpressure preserves safety, paid transactions, and reversals ahead of ordinary work.
  admitWork(actor: EnterpriseActor, input: { admissionId: string; workKind: string; priority: number; tenantInflight: number; tenantQuota: number; globalInflight: number; globalCapacity: number; queueAgeMs: number; idempotencyKey: string }): JsonObject {
    assertActor(actor, OPERATORS); const kind = identifier(input.workKind, "workKind"); const protectedWork = PROTECTED_WORK.has(kind);
    const tenantInflight = integer(input.tenantInflight, "tenantInflight"); const tenantQuota = integer(input.tenantQuota, "tenantQuota", 1); const globalInflight = integer(input.globalInflight, "globalInflight"); const globalCapacity = integer(input.globalCapacity, "globalCapacity", 1); const priority = integer(input.priority, "priority", 0, 100);
    const exhausted = tenantInflight >= tenantQuota || globalInflight >= globalCapacity; const pressured = tenantInflight * 10 >= tenantQuota * 8 || globalInflight * 10 >= globalCapacity * 8;
    const decision = protectedWork ? (exhausted ? "priority_queue" : "admit") : exhausted ? "reject" : pressured || input.queueAgeMs > 30_000 ? "degrade" : "admit";
    const state: JsonObject = { admissionId: identifier(input.admissionId, "admissionId"), workKind: kind, priority, protectedWork, tenantInflight, tenantQuota, globalInflight, globalCapacity, queueAgeMs: integer(input.queueAgeMs, "queueAgeMs"), decision, ordinaryWorkPreemptible: true, state: "decided" };
    return this.#write(actor, input.idempotencyKey, "B121.admitWork", state, "capacity.admission", input.admissionId, `capacity.${decision}`, state);
  }

  // B121-R05 — explicit end-to-end capacity model identifies the limiting subsystem.
  buildCapacityModel(actor: EnterpriseActor, input: { capacityId: string; campaignDemand: number; modelProvider: number; storage: number; cdn: number; database: number; workflow: number; supplyChain: number; safetyMarginBps: number; idempotencyKey: string }): JsonObject {
    assertActor(actor, OPERATORS); const components = { modelProvider: integer(input.modelProvider, "modelProvider", 1), storage: integer(input.storage, "storage", 1), cdn: integer(input.cdn, "cdn", 1), database: integer(input.database, "database", 1), workflow: integer(input.workflow, "workflow", 1), supplyChain: integer(input.supplyChain, "supplyChain", 1) };
    const demand = integer(input.campaignDemand, "campaignDemand", 1); const margin = bps(input.safetyMarginBps, "safetyMarginBps"); const entries = Object.entries(components); const limiting = entries.reduce((lowest, entry) => entry[1] < lowest[1] ? entry : lowest);
    const safeCapacity = Math.floor(limiting[1] * (10_000 - margin) / 10_000); const state: JsonObject = { capacityId: identifier(input.capacityId, "capacityId"), campaignDemand: demand, components, safetyMarginBps: margin, limitingFactor: limiting[0], safeCapacity, releaseDecision: safeCapacity >= demand ? "passed" : "blocked", state: "modeled" };
    return this.#write(actor, input.idempotencyKey, "B121.buildCapacity", state, "capacity.model", input.capacityId, "capacity.modelBuilt", state);
  }

  // B122-R01 — dependency-specific timeout/retry/circuit/bulkhead/fallback/consistency/manual policy.
  registerDependencyPolicy(actor: EnterpriseActor, input: { dependencyId: string; failureModes: readonly string[]; timeoutMs: number; maxRetries: number; circuitFailureThreshold: number; bulkheadConcurrency: number; fallback: "fail_closed" | "cached_read_only" | "manual_review"; consistency: "strong" | "eventual_with_reconciliation"; manualProcedureId: string; idempotencyKey: string }): JsonObject {
    assertActor(actor, OPERATORS); if (input.maxRetries > 5 || input.timeoutMs > 120_000) throw new EnterpriseControlError("POLICY_BLOCKED", "dependency retry/timeout amplification is unsafe");
    const state: JsonObject = { dependencyId: identifier(input.dependencyId, "dependencyId"), failureModes: unique(input.failureModes, "failureModes"), timeoutMs: integer(input.timeoutMs, "timeoutMs", 1), maxRetries: integer(input.maxRetries, "maxRetries", 0), circuitFailureThreshold: integer(input.circuitFailureThreshold, "circuitFailureThreshold", 1), bulkheadConcurrency: integer(input.bulkheadConcurrency, "bulkheadConcurrency", 1), fallback: input.fallback, consistency: input.consistency, manualProcedureId: identifier(input.manualProcedureId, "manualProcedureId"), state: "active" };
    return this.#write(actor, input.idempotencyKey, "B122.registerDependency", state, "resilience.dependency", input.dependencyId, "resilience.dependencyRegistered", state);
  }

  // B122-R02 — bounded, synthetic fault injection covers every named dependency failure.
  planFaultExperiment(actor: EnterpriseActor, input: { experimentId: string; faults: readonly Fault[]; environment: "test" | "staging" | "production"; syntheticData: boolean; blastRadiusBps: number; stopConditions: readonly string[]; approverIds: readonly string[]; idempotencyKey: string }): JsonObject {
    assertActor(actor, OPERATORS, input.approverIds); requireExactInventory(input.faults, FAULTS, "fault injection inventory");
    if (!input.syntheticData || (input.environment === "production" && bps(input.blastRadiusBps, "blastRadiusBps") > 100)) throw new EnterpriseControlError("POLICY_BLOCKED", "fault experiments require synthetic data and a bounded production blast radius");
    const state: JsonObject = { experimentId: identifier(input.experimentId, "experimentId"), faults: [...input.faults].sort(), environment: input.environment, syntheticData: true, blastRadiusBps: bps(input.blastRadiusBps, "blastRadiusBps"), stopConditions: unique(input.stopConditions, "stopConditions"), approvals: unique(input.approverIds, "approverIds", 2), executionCertification: "NOT_CERTIFIED", state: "approved_not_executed" };
    return this.#write(actor, input.idempotencyKey, "B122.planFaultExperiment", state, "resilience.experiment", input.experimentId, "resilience.experimentPlanned", state);
  }

  // B122-R03 — irreversible protected intent is tombstoned and late dependency success cannot resurrect it.
  recordProtectedIntent(actor: EnterpriseActor, input: { subjectId: string; intent: "cancellation" | "refund" | "consent_withdrawal" | "delete"; causalSequence: number; idempotencyKey: string }): JsonObject {
    assertActor(actor, OPERATORS); const state: JsonObject = { subjectId: identifier(input.subjectId, "subjectId"), intent: input.intent, causalSequence: integer(input.causalSequence, "causalSequence", 1), tombstoned: true, priorityLane: true, state: "protected_terminal" };
    return this.#write(actor, input.idempotencyKey, "B122.recordProtectedIntent", state, "resilience.protectedIntent", input.subjectId, "resilience.protectedIntentRecorded", state);
  }
  applyLateDependencyResult(actor: EnterpriseActor, input: { subjectId: string; providerSequence: number; providerState: string; idempotencyKey: string }): JsonObject {
    assertActor(actor, OPERATORS); const intent = this.#required(actor.tenantId, "resilience.protectedIntent", input.subjectId);
    if (intent.state.tombstoned === true) throw new EnterpriseControlError("POLICY_BLOCKED", "late dependency result cannot resurrect a protected terminal intent", { subjectId: input.subjectId, providerSequence: input.providerSequence });
    return this.#write(actor, input.idempotencyKey, "B122.applyLateResult", input, "resilience.protectedIntent", input.subjectId, "resilience.lateResultApplied", { providerState: text(input.providerState, "providerState") }, intent.version, { ...intent.state, providerState: input.providerState });
  }

  // B122-R04 — failover is residence/contract/idempotency/quality/safety constrained and reversible.
  authorizeFailover(actor: EnterpriseActor, input: { failoverId: string; source: string; destination: string; residenceRegions: readonly string[]; contractRegions: readonly string[]; destinationRegion: string; idempotencyNamespace: string; qualityGateSha256: string; safetyGateSha256: string; rollbackPlanId: string; approverIds: readonly string[]; idempotencyKey: string }): JsonObject {
    assertActor(actor, OPERATORS, input.approverIds); const residence = unique(input.residenceRegions, "residenceRegions"); const contract = unique(input.contractRegions, "contractRegions");
    if (!residence.includes(input.destinationRegion) || !contract.includes(input.destinationRegion) || input.source === input.destination) throw new EnterpriseControlError("POLICY_BLOCKED", "failover destination violates residence/contract or is unchanged");
    const state: JsonObject = { failoverId: identifier(input.failoverId, "failoverId"), source: identifier(input.source, "source"), destination: identifier(input.destination, "destination"), destinationRegion: identifier(input.destinationRegion, "destinationRegion"), residenceRegions: residence, contractRegions: contract, idempotencyNamespace: identifier(input.idempotencyNamespace, "idempotencyNamespace"), qualityGateSha256: hexDigest(input.qualityGateSha256, "qualityGateSha256"), safetyGateSha256: hexDigest(input.safetyGateSha256, "safetyGateSha256"), rollbackPlanId: identifier(input.rollbackPlanId, "rollbackPlanId"), approvals: unique(input.approverIds, "approverIds", 2), runtimeCertification: "NOT_CERTIFIED", state: "authorized" };
    return this.#write(actor, input.idempotencyKey, "B122.authorizeFailover", state, "resilience.failover", input.failoverId, "resilience.failoverAuthorized", state);
  }

  // B122-R05 — game-day certification requires independent, signed, exact execution evidence.
  registerGameDay(actor: EnterpriseActor, input: { gameDayId: string; experimentId: string; plannedRtoMinutes: number; plannedRpoMinutes: number; idempotencyKey: string }): JsonObject {
    assertActor(actor, OPERATORS); this.#required(actor.tenantId, "resilience.experiment", input.experimentId);
    const state: JsonObject = { gameDayId: identifier(input.gameDayId, "gameDayId"), experimentId: input.experimentId, plannedRtoMinutes: integer(input.plannedRtoMinutes, "plannedRtoMinutes", 1), plannedRpoMinutes: integer(input.plannedRpoMinutes, "plannedRpoMinutes", 0), certification: "NOT_CERTIFIED", state: "planned" };
    return this.#write(actor, input.idempotencyKey, "B122.registerGameDay", state, "resilience.gameDay", input.gameDayId, "resilience.gameDayRegistered", state);
  }
  applyGameDayAttestation(actor: EnterpriseActor, attestation: SignedEnterpriseAttestation, idempotencyKey: string): JsonObject {
    assertActor(actor, OPERATORS); const fact = this.#facts.verify(attestation, { tenantId: actor.tenantId, factKind: "resilience.game-day", independent: true, issuerRole: "independent-resilience-authority" }); const gameDay = this.#required(actor.tenantId, "resilience.gameDay", fact.subjectId);
    exactKeys(fact.payload, ["gameDayId", "experimentId", "observationsSha256", "actualRtoMinutes", "actualRpoMinutes", "userImpact", "manualSteps", "defects", "retestRequired", "executed"], "game-day attestation");
    if (fact.payload.gameDayId !== gameDay.aggregateId || fact.payload.experimentId !== gameDay.state.experimentId || fact.payload.executed !== true) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "game-day evidence is not exact");
    const actualRto = integer(Number(fact.payload.actualRtoMinutes), "actualRtoMinutes"); const actualRpo = integer(Number(fact.payload.actualRpoMinutes), "actualRpoMinutes");
    const passed = actualRto <= Number(gameDay.state.plannedRtoMinutes) && actualRpo <= Number(gameDay.state.plannedRpoMinutes) && fact.payload.retestRequired === false;
    const state: JsonObject = { ...gameDay.state, observationsSha256: hexDigest(String(fact.payload.observationsSha256), "observationsSha256"), actualRtoMinutes: actualRto, actualRpoMinutes: actualRpo, userImpact: text(String(fact.payload.userImpact), "userImpact"), manualSteps: unique(fact.payload.manualSteps as readonly string[], "manualSteps"), defects: unique(fact.payload.defects as readonly string[], "defects", 0), retestRequired: fact.payload.retestRequired, factId: fact.factId, certification: passed ? (fact.environment === "production" ? "CERTIFIED" : "TEST_VERIFIED") : "NOT_CERTIFIED", state: passed ? "verified" : "retest_required" };
    return this.#factWrite(actor, fact, idempotencyKey, "B122.applyGameDay", { gameDayId: gameDay.aggregateId }, "resilience.gameDay", gameDay.aggregateId, "resilience.gameDayEvidenceApplied", { factId: fact.factId, certification: state.certification }, gameDay.version, state);
  }

  #write(actor: EnterpriseActor, key: string, operation: string, request: JsonObject, aggregateType: string, aggregateId: string, eventType: string, event: JsonObject, expectedVersion: number | null = null, state: JsonObject = request): JsonObject {
    return this.#repository.execute(actor.tenantId, key, operation, request, () => this.#repository.put({ tenantId: actor.tenantId, aggregateType, aggregateId, expectedVersion, state, eventType, event }).state).value as JsonObject;
  }
  #factWrite(actor: EnterpriseActor, fact: VerifiedEnterpriseAttestation, key: string, operation: string, request: JsonObject, aggregateType: string, aggregateId: string, eventType: string, event: JsonObject, expectedVersion: number | null, state: JsonObject): JsonObject {
    return this.#repository.execute(actor.tenantId, key, operation, { ...request, factSha256: fact.factSha256 }, () => { this.#repository.claimFact({ tenantId: actor.tenantId, factId: fact.factId, factSha256: fact.factSha256, issuer: fact.issuer, factKind: fact.factKind, subjectId: fact.subjectId, sequence: fact.sequence, occurredAt: fact.occurredAt }); return this.#repository.put({ tenantId: actor.tenantId, aggregateType, aggregateId, expectedVersion, state, eventType, event }).state; }).value as JsonObject;
  }
  #required<T extends JsonObject = JsonObject>(tenantId: string, type: string, id: string): EnterpriseSnapshot<T> { const value = this.#repository.get<T>(tenantId, type, id); if (value === undefined) throw new EnterpriseControlError("NOT_FOUND", `${type}/${id} not found`); return value; }
}

function requireExactInventory<T extends string>(actual: readonly T[], required: readonly T[], field: string): void {
  if (actual.length !== required.length || new Set(actual).size !== required.length || required.some((value) => !actual.includes(value))) throw new EnterpriseControlError("VALIDATION_FAILED", `${field} must contain the exact mandatory inventory`);
}
