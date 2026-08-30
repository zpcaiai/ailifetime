import assert from "node:assert/strict";
import { test } from "node:test";
import { EnterpriseAssuranceEngine } from "./assurance-engine.js";
import { ACTOR, APPROVERS, HASH, fact, makeHarness } from "./test-fixtures.js";

const surfaces = ["web", "api", "upload", "generation_status", "media_download", "payment", "partner_api", "webhook", "background"] as const;
const scenarios = ["baseline", "peak", "spike", "soak", "batch", "weak_dependency", "multi_tenant_noise"] as const;
const faults = ["model_timeout", "model_error", "object_unavailable", "database_read_only", "database_latency", "queue_duplicate", "payment_reorder", "messaging_failure", "vendor_unreachable"] as const;
const thresholds = { p50Ms: 100, p95Ms: 300, p99Ms: 500, throughputRps: 100, queueAgeMs: 1_000, errorBps: 100, saturationBps: 8_000, costMicrosPerRequest: 5_000, uxCompletionMs: 2_000 } as const;
const good = { p50Ms: 80, p95Ms: 250, p99Ms: 450, throughputRps: 120, queueAgeMs: 500, errorBps: 50, saturationBps: 7_000, costMicrosPerRequest: 4_000, uxCompletionMs: 1_800 } as const;

function load(engine: EnterpriseAssuranceEngine): void {
  engine.registerLoadModel(ACTOR, { modelId: "load-v1", version: "v1", resourceVersionSha256: HASH, idempotencyKey: "load", surfaces: surfaces.map((surface) => ({ surface, peakRps: 200, concurrency: 50, payloadBytes: 1_024, tenantShareBps: 2_000 })) });
}
function budget(engine: EnterpriseAssuranceEngine): void { load(engine); engine.registerPerformanceBudget(ACTOR, { budgetId: "budget-v1", loadModelId: "load-v1", thresholds, idempotencyKey: "budget" }); }
function experiment(engine: EnterpriseAssuranceEngine): void { engine.planFaultExperiment(ACTOR, { experimentId: "experiment-1", faults, environment: "staging", syntheticData: true, blastRadiusBps: 500, stopConditions: ["error budget exceeded"], approverIds: APPROVERS, idempotencyKey: "experiment" }); }

test("B121-R01 requires the exact nine load surfaces", () => {
  const h = makeHarness(); const engine = new EnterpriseAssuranceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock });
  assert.throws(() => engine.registerLoadModel(ACTOR, { modelId: "bad", version: "v1", resourceVersionSha256: HASH, idempotencyKey: "bad-load", surfaces: surfaces.slice(1).map((surface) => ({ surface, peakRps: 1, concurrency: 1, payloadBytes: 1, tenantShareBps: 1 })) }), /exact mandatory inventory/); load(engine); h.repository.close();
});

test("B121-R02 hard-blocks release when any latency throughput queue error saturation cost or UX budget breaches", () => {
  const h = makeHarness(); const engine = new EnterpriseAssuranceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); budget(engine);
  const failed = engine.evaluateScenarioSuite(ACTOR, { runId: "run-breach", budgetId: "budget-v1", resourceVersionSha256: HASH, syntheticDatasetSha256: HASH, idempotencyKey: "run-breach", scenarios: scenarios.map((scenario, index) => ({ scenario, observations: { ...good, p99Ms: index === 0 ? 501 : good.p99Ms } })) }); assert.equal(failed.releaseDecision, "blocked"); assert.equal((failed.failures as unknown[]).length, 1); h.repository.close();
});

test("B121-R03 requires all seven synthetic scenarios and exact resource version", () => {
  const h = makeHarness(); const engine = new EnterpriseAssuranceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); budget(engine);
  assert.throws(() => engine.evaluateScenarioSuite(ACTOR, { runId: "missing", budgetId: "budget-v1", resourceVersionSha256: HASH, syntheticDatasetSha256: HASH, idempotencyKey: "missing", scenarios: scenarios.slice(0, 6).map((scenario) => ({ scenario, observations: good })) }), /exact mandatory inventory/);
  assert.throws(() => engine.evaluateScenarioSuite(ACTOR, { runId: "drift", budgetId: "budget-v1", resourceVersionSha256: "a".repeat(64), syntheticDatasetSha256: HASH, idempotencyKey: "drift", scenarios: scenarios.map((scenario) => ({ scenario, observations: good })) }), /resource version differs/); h.repository.close();
});

test("B121-R04 quota backpressure rejects ordinary work but prioritizes reversals", () => {
  const h = makeHarness(); const engine = new EnterpriseAssuranceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock });
  const ordinary = engine.admitWork(ACTOR, { admissionId: "ordinary", workKind: "generation", priority: 10, tenantInflight: 10, tenantQuota: 10, globalInflight: 100, globalCapacity: 100, queueAgeMs: 40_000, idempotencyKey: "ordinary" }); const reversal = engine.admitWork(ACTOR, { admissionId: "refund", workKind: "refund", priority: 100, tenantInflight: 10, tenantQuota: 10, globalInflight: 100, globalCapacity: 100, queueAgeMs: 40_000, idempotencyKey: "refund" });
  assert.equal(ordinary.decision, "reject"); assert.equal(reversal.decision, "priority_queue"); h.repository.close();
});

test("B121-R05 computes cross-system limiting capacity with safety margin", () => {
  const h = makeHarness(); const engine = new EnterpriseAssuranceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock });
  const model = engine.buildCapacityModel(ACTOR, { capacityId: "capacity-1", campaignDemand: 90, modelProvider: 120, storage: 140, cdn: 150, database: 110, workflow: 100, supplyChain: 80, safetyMarginBps: 1_000, idempotencyKey: "capacity" }); assert.equal(model.limitingFactor, "supplyChain"); assert.equal(model.safeCapacity, 72); assert.equal(model.releaseDecision, "blocked"); h.repository.close();
});

test("B122-R01 records bounded dependency resilience and rejects retry amplification", () => {
  const h = makeHarness(); const engine = new EnterpriseAssuranceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock });
  assert.throws(() => engine.registerDependencyPolicy(ACTOR, { dependencyId: "bad", failureModes: ["timeout"], timeoutMs: 10_000, maxRetries: 10, circuitFailureThreshold: 5, bulkheadConcurrency: 10, fallback: "fail_closed", consistency: "strong", manualProcedureId: "manual-1", idempotencyKey: "bad" }), /amplification/);
  const policy = engine.registerDependencyPolicy(ACTOR, { dependencyId: "payment", failureModes: ["timeout", "unknown_result"], timeoutMs: 5_000, maxRetries: 2, circuitFailureThreshold: 5, bulkheadConcurrency: 10, fallback: "manual_review", consistency: "eventual_with_reconciliation", manualProcedureId: "manual-payments", idempotencyKey: "policy" }); assert.equal(policy.maxRetries, 2); h.repository.close();
});

test("B122-R02 fault plan covers every failure and remains NOT_CERTIFIED until execution evidence", () => {
  const h = makeHarness(); const engine = new EnterpriseAssuranceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); experiment(engine);
  const saved = h.repository.get(ACTOR.tenantId, "resilience.experiment", "experiment-1"); assert.equal(saved?.state.executionCertification, "NOT_CERTIFIED"); assert.throws(() => engine.planFaultExperiment(ACTOR, { experimentId: "unsafe", faults, environment: "production", syntheticData: true, blastRadiusBps: 101, stopConditions: ["stop"], approverIds: APPROVERS, idempotencyKey: "unsafe" }), /bounded production blast radius/); h.repository.close();
});

test("B122-R03 protected cancellation refund withdrawal and delete cannot be resurrected", () => {
  const h = makeHarness(); const engine = new EnterpriseAssuranceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); engine.recordProtectedIntent(ACTOR, { subjectId: "order-1", intent: "refund", causalSequence: 7, idempotencyKey: "intent" });
  assert.throws(() => engine.applyLateDependencyResult(ACTOR, { subjectId: "order-1", providerSequence: 8, providerState: "paid", idempotencyKey: "late" }), /cannot resurrect/); h.repository.close();
});

test("B122-R04 failover must satisfy residence contract idempotency quality safety and rollback", () => {
  const h = makeHarness(); const engine = new EnterpriseAssuranceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock });
  assert.throws(() => engine.authorizeFailover(ACTOR, { failoverId: "blocked", source: "vendor-a", destination: "vendor-b", residenceRegions: ["cn-east"], contractRegions: ["cn-east"], destinationRegion: "sg", idempotencyNamespace: "failover-v1", qualityGateSha256: HASH, safetyGateSha256: HASH, rollbackPlanId: "rollback-1", approverIds: APPROVERS, idempotencyKey: "blocked" }), /violates residence/);
  const authorized = engine.authorizeFailover(ACTOR, { failoverId: "allowed", source: "vendor-a", destination: "vendor-b", residenceRegions: ["sg"], contractRegions: ["sg"], destinationRegion: "sg", idempotencyNamespace: "failover-v1", qualityGateSha256: HASH, safetyGateSha256: HASH, rollbackPlanId: "rollback-1", approverIds: APPROVERS, idempotencyKey: "allowed" }); assert.equal(authorized.runtimeCertification, "NOT_CERTIFIED"); h.repository.close();
});

test("B122-R05 independent game-day evidence measures RTO RPO impact manual steps defects and retest", () => {
  const h = makeHarness(); const engine = new EnterpriseAssuranceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); experiment(engine); engine.registerGameDay(ACTOR, { gameDayId: "game-1", experimentId: "experiment-1", plannedRtoMinutes: 30, plannedRpoMinutes: 5, idempotencyKey: "game" });
  const payload = { gameDayId: "game-1", experimentId: "experiment-1", observationsSha256: HASH, actualRtoMinutes: 20, actualRpoMinutes: 3, userImpact: "synthetic users only", manualSteps: ["promote standby"], defects: [], retestRequired: false, executed: true };
  assert.throws(() => engine.applyGameDayAttestation(ACTOR, fact("resilience.game-day", "game-1", payload), "general-game"), /scope mismatch/); const result = engine.applyGameDayAttestation(ACTOR, fact("resilience.game-day", "game-1", payload, true), "independent-game"); assert.equal(result.certification, "TEST_VERIFIED"); h.repository.close();
});
