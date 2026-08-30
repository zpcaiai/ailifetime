import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  attribute, canonicalJson, cohortKey, DashboardCatalog, DASHBOARD_IDS, DataGovernanceService, DELETION_TARGETS, Ed25519DeletionReceiptAuthority,
  EventSchemaRegistry, ExperimentService, fingerprint, InMemoryTrackingQueueRepository, INGESTION_SOURCES, lifetimeValue, ModelQualityService,
  PROTECTED_EXPERIMENT_CONTROLS, reconcileEconomics, retentionCurve, runEconomicsScenario, SEMANTIC_METRICS,
  SlowlyChangingDimension, TrackingClient, unitEconomics, WarehousePipeline,
  type DashboardDefinition, type EvaluationMetricResult, type ExperimentDefinition, type SourceRecord,
  type UnitEconomicsFacts,
} from "./index.js";

const NOW = new Date("2026-08-28T04:00:00.000Z");
const now = () => new Date(NOW);
const schemaDigest = "a".repeat(64);

function eventSchema(version = 1) {
  return {
    name: "ltm.generation.completed",
    domain: "generation" as const,
    version,
    owner: "generation-platform",
    producer: "generation-worker",
    trigger: "generation committed after safety and consent gates",
    dedupeField: "generation_id",
    consentPurpose: "illustrative_generation_analytics",
    retentionDays: 90,
    fields: {
      generation_id: { type: "string" as const, required: true, classification: "confidential" as const, purposes: ["illustrative_generation_analytics"] },
      completed_at: { type: "utc_timestamp" as const, required: true, classification: "internal" as const, purposes: ["illustrative_generation_analytics"] },
      participant_ref: { type: "string" as const, required: false, classification: "restricted" as const, purposes: ["illustrative_generation_analytics"] },
      success: { type: "boolean" as const, required: true, classification: "internal" as const, purposes: ["illustrative_generation_analytics"] },
    },
  };
}

test("B111 registry enforces taxonomy, purposes, unknown fields, and compatible dual-write versions", () => {
  const registry = new EventSchemaRegistry();
  registry.register(eventSchema());
  assert.throws(() => registry.validate("ltm.generation.completed", 1, {
    generation_id: "g-1", completed_at: NOW.toISOString(), success: true, extra: "not contracted",
  }, ["illustrative_generation_analytics"]), /unknown field/);
  assert.throws(() => registry.validate("ltm.generation.completed", 1, {
    generation_id: "g-1", completed_at: NOW.toISOString(), success: true,
  }, []), /requires purpose/);
  const v2 = eventSchema(2);
  const withRequired = { ...v2, fields: { ...v2.fields, model_route: { type: "string" as const, required: true, classification: "internal" as const, purposes: ["illustrative_generation_analytics"] } } };
  assert.throws(() => registry.register(withRequired), /dual-write/);
  assert.equal(registry.register(withRequired, { dualWritePreviousVersion: 1 }).dualWritePreviousVersion, 1);
  assert.equal(registry.catalog().length, 2);
});

test("B111 typed tracking injects trusted context and durably retries without silent loss", async () => {
  const registry = new EventSchemaRegistry();
  registry.register(eventSchema());
  const delivered: unknown[] = [];
  let accept = true;
  let clock = new Date(NOW);
  const trackingNow = () => new Date(clock);
  const queue = new InMemoryTrackingQueueRepository();
  const baseEvent = { eventId: "event-1", name: "ltm.generation.completed", version: 1, occurredAt: "2026-08-28T03:00:00.000Z", payload: { generation_id: "g-1", completed_at: NOW.toISOString(), success: true }, grantedPurposes: ["illustrative_generation_analytics"] } as const;
  const client = new TrackingClient("mobile", {
    environment: "sandbox", applicationVersion: "1.2.3", sessionId: "session-1", tenantId: "tenant-1", requestId: "request-1", traceId: "trace-1",
  }, registry, { deliver: async (envelope) => { delivered.push(envelope); return accept ? { accepted: true } : { accepted: false, retryable: true, reason: "temporary network filter failure" }; } }, trackingNow, queue, "worker-one");
  client.setOnline(false);
  const queued = await client.track(baseEvent);
  assert.equal(queued.state, "QUEUED_OFFLINE");
  assert.equal((await client.track(baseEvent)).state, "DUPLICATE");
  await assert.rejects(() => client.track({ ...baseEvent, payload: { ...baseEvent.payload, success: false } }), /changed tracking payload/);
  client.setOnline(true);
  assert.equal((await client.flush())[0]?.state, "DELIVERED");
  accept = false;
  assert.equal((await client.track({ eventId: "event-2", name: "ltm.generation.completed", version: 1, occurredAt: NOW.toISOString(), payload: { generation_id: "g-2", completed_at: NOW.toISOString(), success: false }, grantedPurposes: ["illustrative_generation_analytics"] })).state, "RETRY_SCHEDULED");
  assert.equal(queue.snapshot().find((event) => event.eventId === "event-2")?.state, "PENDING");
  accept = true; clock = new Date(NOW.getTime() + 1_000);
  const restarted = new TrackingClient("mobile", client.context, registry, client.transport, trackingNow, queue, "worker-after-restart");
  assert.equal((await restarted.flush())[0]?.state, "DELIVERED");
  assert.equal(client.telemetry().lost, 0);
  assert.equal(client.telemetry().retriesScheduled, 1);
  assert.equal(client.telemetry().clockSkew, 1);
  assert.equal((delivered[0] as { context: { tenantId: string } }).context.tenantId, "tenant-1");
});

test("B111 production tracking rejects a process-local queue", () => {
  const registry = new EventSchemaRegistry(); registry.register(eventSchema());
  assert.throws(() => new TrackingClient("server", {
    environment: "production", applicationVersion: "1.0.0", sessionId: "session-1", tenantId: "tenant-1", requestId: "request-1", traceId: "trace-1",
  }, registry, { deliver: async () => ({ accepted: true }) }, now), /durable queue/);
});

function sourceRecord(sequence: number, primaryKey = `record-${sequence}`, overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    tenantId: "tenant-1", sequence, primaryKey, sourceOccurredAt: `2026-08-28T03:5${sequence}:00.000Z`, sourceVersion: 1,
    deleted: false, payload: { synthetic: true }, currency: "CNY", amountMinor: 100, ...overrides,
  };
}

test("B112 pipeline incrementally ingests every required source with four traceable layers and watermarks", () => {
  for (const source of INGESTION_SOURCES) {
    const pipeline = new WarehousePipeline(now);
    const report = pipeline.ingest({ batchId: `batch-${source}`, source, schemaFingerprint: schemaDigest, records: [sourceRecord(1)], expectedRowCount: 1, expectedAmountMinor: 100, maxCostMinor: 50, actualCostMinor: 10, freshnessSloSeconds: 3600 });
    assert.equal(report.status, "COMMITTED");
    assert.equal(report.cursor, 1);
    assert.equal(pipeline.rows("raw")[0]?.traceKey, `tenant-1:${source}:record-1`);
    assert.equal(pipeline.rows("staging").length, 1);
    assert.equal(pipeline.rows("core").length, 1);
    assert.equal(pipeline.rows("mart").length, 1);
  }
  assert.deepEqual(Object.keys(SEMANTIC_METRICS).sort(), ["activation", "arr", "generation_success", "gross_margin", "mrr", "paid_conversion", "retention", "security_incident_rate", "sla_attainment"]);
});

test("B112 pipeline fails closed on cursor gaps, drift, cost, and control totals and resumes from a digestible snapshot", () => {
  const pipeline = new WarehousePipeline(now);
  pipeline.ingest({ batchId: "batch-1", source: "payment", schemaFingerprint: schemaDigest, records: [sourceRecord(1)], expectedRowCount: 1, expectedAmountMinor: 100, maxCostMinor: 50, actualCostMinor: 10, freshnessSloSeconds: 3600 });
  assert.throws(() => pipeline.ingest({ batchId: "gap", source: "payment", schemaFingerprint: schemaDigest, records: [sourceRecord(3)], expectedRowCount: 1, expectedAmountMinor: 100, maxCostMinor: 50, actualCostMinor: 10, freshnessSloSeconds: 3600 }), /cursor has a gap/);
  assert.throws(() => pipeline.ingest({ batchId: "drift", source: "payment", schemaFingerprint: "b".repeat(64), records: [sourceRecord(2)], expectedRowCount: 1, expectedAmountMinor: 100, maxCostMinor: 50, actualCostMinor: 10, freshnessSloSeconds: 3600 }), /schema drift/);
  assert.throws(() => pipeline.ingest({ batchId: "cost", source: "payment", schemaFingerprint: schemaDigest, records: [sourceRecord(2)], expectedRowCount: 1, expectedAmountMinor: 100, maxCostMinor: 5, actualCostMinor: 10, freshnessSloSeconds: 3600 }), /cost budget/);
  assert.throws(() => pipeline.ingest({ batchId: "balance", source: "payment", schemaFingerprint: schemaDigest, records: [sourceRecord(2)], expectedRowCount: 1, expectedAmountMinor: 99, maxCostMinor: 50, actualCostMinor: 10, freshnessSloSeconds: 3600 }), /does not balance/);
  const restored = new WarehousePipeline(now, pipeline.snapshot());
  assert.equal(restored.stateFingerprint(), pipeline.stateFingerprint());
  assert.equal(restored.ingest({ batchId: "batch-1", source: "payment", schemaFingerprint: schemaDigest, records: [sourceRecord(1)], expectedRowCount: 1, expectedAmountMinor: 100, maxCostMinor: 50, actualCostMinor: 10, freshnessSloSeconds: 3600 }).status, "NOOP");
});

test("B112 SCD rebuilds late dimensions instead of hiding history", () => {
  const dimension = new SlowlyChangingDimension();
  dimension.apply({ naturalKey: "plan-1", effectiveAt: "2026-08-02T00:00:00.000Z", attributes: { price: 200 }, deleted: false });
  const versions = dimension.apply({ naturalKey: "plan-1", effectiveAt: "2026-08-01T00:00:00.000Z", attributes: { price: 100 }, deleted: false });
  assert.equal(versions.length, 2);
  assert.equal(versions[0]?.effectiveUntil, "2026-08-02T00:00:00.000Z");
  assert.equal(versions[1]?.current, true);
});

function dashboard(id: (typeof DASHBOARD_IDS)[number]): DashboardDefinition {
  return {
    id, owner: "analytics", roles: ["platform_analyst", "partner_analyst"], allowedDetailColumns: ["order_id", "amount_minor"],
    drilldownAction: `open-${id}`, contractVersion: 1,
    metrics: [{ metric: `${id}_rate`, definition: "numerator / eligible denominator", asOf: NOW.toISOString(), refreshSeconds: 300, grain: "day", filters: ["region"], currency: "CNY", confidence: "observed", owner: "analytics" }],
  };
}

test("B113 catalog covers core dashboards and enforces role, tenant, region, partner and column controls", () => {
  const catalog = new DashboardCatalog();
  for (const id of DASHBOARD_IDS) catalog.publish(dashboard(id));
  const rows = [
    { tenantId: "tenant-1", region: "CN", partnerId: "partner-1", values: { order_id: "o-1", amount_minor: 100, raw_media: "forbidden" } },
    { tenantId: "tenant-1", region: "CN", partnerId: "partner-2", values: { order_id: "o-2", amount_minor: 200 } },
    { tenantId: "tenant-2", region: "CN", partnerId: "partner-1", values: { order_id: "o-3", amount_minor: 300 } },
  ];
  const visible = catalog.query("partner", { tenantId: "tenant-1", role: "partner_analyst", regions: ["CN"], partnerId: "partner-1", permissions: ["dashboard:partner:read"] }, rows);
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0]?.values, { order_id: "o-1", amount_minor: 100 });
  assert.throws(() => catalog.query("partner", { tenantId: "tenant-1", role: "partner_analyst", regions: ["CN"], permissions: ["dashboard:partner:read"] }, rows), /partner id/);
  assert.throws(() => catalog.publish({ ...dashboard("slo"), contractVersion: 2, allowedDetailColumns: ["raw_media"] }), /prohibited/);
});

test("B114 attribution flags fraud, consent and cross-device limits; cohorts, retention and LTV are computed", () => {
  const result = attribute({ model: "linear_multi_touch", conversionAt: NOW.toISOString(), windowDays: 30, observableAcrossDevices: false, touches: [
    { touchId: "t-1", subjectId: "s-1", deviceId: "d-1", channel: "search", occurredAt: "2026-08-20T00:00:00.000Z", contactConsent: true, bot: false, affiliateFraud: false, identityMergeConfidence: 1 },
    { touchId: "t-2", subjectId: "s-1", deviceId: "d-2", channel: "affiliate", occurredAt: "2026-08-21T00:00:00.000Z", contactConsent: true, bot: false, affiliateFraud: true, identityMergeConfidence: 1 },
    { touchId: "t-3", subjectId: "s-1", deviceId: "d-1", channel: "email", occurredAt: "2026-08-22T00:00:00.000Z", contactConsent: false, bot: false, affiliateFraud: false, identityMergeConfidence: 1 },
  ] });
  assert.equal(result.credits.length, 1);
  assert.deepEqual(new Set(result.limitations), new Set(["cross_device_unobservable", "consent_missing", "invalid_traffic_removed"]));
  const member = { subjectId: "s-1", anchor: "first_purchase" as const, anchorAt: "2026-08-01T00:00:00.000Z", channel: "search", partnerId: "partner-1", region: "CN", plan: "annual" };
  assert.equal(cohortKey(member), "first_purchase:2026-08:search:partner-1:CN:annual");
  assert.deepEqual(retentionCurve(member, [{ subjectId: "s-1", occurredAt: "2026-08-08T00:00:00.000Z", kind: "revenue", amountMinor: 500 }, { subjectId: "s-1", occurredAt: "2026-08-09T00:00:00.000Z", kind: "refund", amountMinor: -100 }]), { "refund:w1": -100, "revenue:w1": 500 });
  const ltv = lifetimeValue({ revenueMinor: 10000, refundsMinor: 1000, revenueShareMinor: 500, aiCostMinor: 1000, paymentCostMinor: 100, notificationCostMinor: 100, supportCostMinor: 200, fulfillmentCostMinor: 500, observationMonths: 2, horizonMonths: 6, monthlyRetentionLow: 0.7, monthlyRetentionHigh: 0.9 });
  assert.equal(ltv.observedNetMinor, 6600);
  assert.ok(ltv.highMinor > ltv.lowMinor);
});

const economicsFacts: UnitEconomicsFacts = {
  unit: "physical", grossRevenueMinor: 20000, refundsMinor: 1000, discountsMinor: 500, revenueShareMinor: 500,
  costs: { model: 1000, model_retry: 200, storage_cdn: 100, payment: 300, message: 100, printing: 2000, shipping: 1000, support: 300 },
  customers: 10, acquiredCustomers: 5, acquisitionCostMinor: 2500, successfulGenerations: 8,
};

test("B115 unit economics separates facts/assumptions and opens reconciliation cases", () => {
  const result = unitEconomics(economicsFacts);
  assert.equal(result.netRevenueMinor, 18000);
  assert.equal(result.contributionMarginMinor, 13000);
  const scenario = runEconomicsScenario({ scenarioId: "shipping-shock", facts: economicsFacts, assumptions: { modelPriceMultiplier: 1, conversionMultiplier: 1, refundMultiplier: 1, retryMultiplier: 1, shippingMultiplier: 2 } });
  assert.equal(scenario.assumptions.shippingMultiplier, 2);
  assert.notEqual(scenario.result.contributionMarginMinor, result.contributionMarginMinor);
  assert.equal(reconcileEconomics({ ledgerNetMinor: 18000, vendorBilledMinor: 4000, operationalAllocatedMinor: 10000, toleranceMinor: 100, period: "2026-08" }).caseId, "economics-reconciliation:2026-08");
});

function experimentDefinition(): ExperimentDefinition {
  return {
    id: "experiment-1", hypothesis: "A smaller first step improves activation", population: "eligible adult sandbox accounts", assignmentUnit: "account",
    strata: ["region"], layer: "onboarding", holdoutBasisPoints: 2000,
    variants: [{ id: "control", allocationBasisPoints: 4000, changes: { onboarding_steps: 3 } }, { id: "treatment", allocationBasisPoints: 4000, changes: { onboarding_steps: 2 } }],
    primaryMetric: "activation", guardrailMetrics: ["consent_completion"], minimumSampleSize: 20,
    startsAt: "2026-08-28T00:00:00.000Z", endsAt: "2026-09-28T00:00:00.000Z", stoppingRule: "fixed_sample",
    forbiddenControlChanges: [...PROTECTED_EXPERIMENT_CONTROLS],
  };
}

test("B116 assignments are deterministic, mutually exclusive and exposures are actual audited events", () => {
  const service = new ExperimentService("synthetic-assignment-salt-at-least-32-bytes", now);
  service.create(experimentDefinition());
  service.transition({ experimentId: "experiment-1", target: "APPROVED", actorId: "approver-1", reason: "pre-registered plan reviewed", approved: true });
  service.transition({ experimentId: "experiment-1", target: "RUNNING", actorId: "operator-1", reason: "sample window opened", approved: true });
  const assignment = service.assign("experiment-1", "subject-1");
  assert.equal(service.assign("experiment-1", "subject-1").assignmentFingerprint, assignment.assignmentFingerprint);
  assert.throws(() => service.expose({ exposureId: "exposure-missing", experimentId: "experiment-1", subjectId: "other", occurredAt: NOW.toISOString(), channel: "web" }), /no server-issued assignment/);
  assert.equal(service.expose({ exposureId: "exposure-1", experimentId: "experiment-1", subjectId: "subject-1", occurredAt: NOW.toISOString(), channel: "mobile" }).variantId, assignment.variantId);
  const analysis = service.analyze("experiment-1", [{ subjectId: "subject-1", variantId: assignment.variantId, converted: true, metricValue: 1, stratum: "CN" }]);
  assert.equal(analysis.status, "INSUFFICIENT_SAMPLE");
  assert.equal(service.audit("experiment-1").length, 2);
});

test("B116 rejects experiments that try to purchase away safety or consent", () => {
  const service = new ExperimentService("synthetic-assignment-salt-at-least-32-bytes", now);
  const definition = experimentDefinition();
  assert.throws(() => service.create({ ...definition, variants: [{ id: "unsafe", allocationBasisPoints: 8000, changes: { participant_consent: false } }] }), /cannot alter participant_consent/);
});

test("B117 catalog lineage, quality, dynamic masking, row policies and deletion propagation fail closed", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const authority = new Ed25519DeletionReceiptAuthority([{
    authority: "sandbox-data-eraser", keyId: "eraser-key-1", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    targets: [...DELETION_TARGETS], notBefore: "2026-08-01T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z",
  }]);
  const governance = new DataGovernanceService(now, authority);
  governance.registerAsset({ id: "business.orders", kind: "database", owner: "commerce", tenantScoped: true, classifications: { order_id: "internal", participant_ref: "restricted" }, allowedPurposes: ["operations"], retentionPolicy: "order-lifecycle", deletionSupported: true });
  governance.registerAsset({ id: "mart.orders", kind: "warehouse_model", owner: "analytics", tenantScoped: true, classifications: { order_id: "internal", participant_ref: "restricted" }, allowedPurposes: ["operations"], retentionPolicy: "analytics-window", deletionSupported: true });
  governance.addLineage({ fromAssetId: "business.orders", toAssetId: "mart.orders", fieldMappings: { order_id: "order_id", participant_ref: "participant_ref" }, transformFingerprint: "c".repeat(64) });
  assert.deepEqual(governance.impact("business.orders").downstream, ["mart.orders"]);
  governance.registerQualityRule({ id: "orders-complete", assetId: "mart.orders", type: "complete", severity: "high", threshold: 0.99, owner: "analytics" });
  assert.equal(governance.observeQuality({ ruleId: "orders-complete", measured: 0.95, observedAt: NOW.toISOString() }).incidentId, `data-quality:orders-complete:${NOW.toISOString()}`);
  governance.grant({ policyId: "support-order-read", assetId: "mart.orders", roles: ["support"], tenantIds: ["tenant-1"], regions: ["CN"], purposes: ["operations"], allowedColumns: ["order_id", "participant_ref"], maskedColumns: ["participant_ref"], expiresAt: "2026-08-29T00:00:00.000Z", exportAllowed: false });
  assert.deepEqual(governance.read({ policyId: "support-order-read", actor: { actorId: "support-1", role: "support", tenantId: "tenant-1", region: "CN", purpose: "operations" }, rowTenantId: "tenant-1", rowRegion: "CN", values: { order_id: "order-1", participant_ref: "private-ref" } }), { order_id: "order-1", participant_ref: "***" });
  assert.throws(() => governance.read({ policyId: "support-order-read", actor: { actorId: "support-1", role: "support", tenantId: "tenant-2", region: "CN", purpose: "operations" }, rowTenantId: "tenant-1", rowRegion: "CN", values: {} }), /denied access/);
  const subjectDigest = fingerprint("synthetic-subject-1");
  governance.requestDeletion({ requestId: "delete-1", subjectDigest, requestedAt: NOW.toISOString() });
  let completed = false;
  for (const target of DELETION_TARGETS) {
    const unsigned = { requestId: "delete-1", target, subjectDigest, deletedAt: NOW.toISOString(), authority: "sandbox-data-eraser", artifactSha256: fingerprint(target), algorithm: "Ed25519" as const, keyId: "eraser-key-1" };
    completed = governance.recordDeletionReceipt({ ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned), "utf8"), privateKey).toString("base64") }).complete;
  }
  assert.equal(completed, true);
  const unsigned = { requestId: "delete-1", target: "warehouse" as const, subjectDigest, deletedAt: NOW.toISOString(), authority: "sandbox-data-eraser", artifactSha256: fingerprint("warehouse"), algorithm: "Ed25519" as const, keyId: "eraser-key-1" };
  assert.throws(() => governance.recordDeletionReceipt({ ...unsigned, artifactSha256: fingerprint("tampered"), signature: sign(null, Buffer.from(canonicalJson(unsigned), "utf8"), privateKey).toString("base64") }), /not signed/);
});

const metrics: EvaluationMetricResult[] = [
  "identity_consistency", "age_perceptibility", "temporal_continuity", "artifact_rate", "text_quality", "audio_quality", "ai_label_integrity", "safety", "fairness",
].map((metric) => ({ metric: metric as EvaluationMetricResult["metric"], score: 0.95, threshold: 0.9, groupScores: { group_a: 0.94, group_b: 0.95 }, humanRubricScore: 0.94 }));

test("B118 registry requires licensed diverse datasets, offline/human gates, shadow lineage and rollback readiness", () => {
  const quality = new ModelQualityService();
  quality.registerDataset({ id: "synthetic-diverse-v1", version: 1, source: "synthetic", licenseId: "synthetic-generator-policy-v1", consentPurpose: "model_quality", dataCardSha256: "d".repeat(64), dimensions: { age_range: ["adult-young", "adult-older"], skin_tone: ["group-a", "group-b"], gender_expression: ["feminine", "masculine"], device: ["ios", "android"], multi_person: ["single", "multiple"], hard_case: ["low-light", "occlusion"] }, rawMediaRetentionDays: 7 });
  assert.equal(quality.recordOfflineEvaluation({ evaluationId: "eval-v1", datasetId: "synthetic-diverse-v1", modelVersionId: "model-v1", completedAt: NOW.toISOString(), metrics, highRiskFailures: 0, evaluatorIds: ["human-rater-1", "automated-suite-v1"] }).passed, true);
  quality.registerModel({ id: "model-v1", modelArtifactSha256: "1".repeat(64), promptSha256: "2".repeat(64), parametersSha256: "3".repeat(64), postprocessorSha256: "4".repeat(64), evaluationId: "eval-v1", rollout: "shadow", rollbackReady: true, registeredAt: NOW.toISOString() });
  assert.equal(quality.status("model-v1").enabled, true);
});

test("B118 production drift never stores raw media and automatically disables or rolls back severe regressions", () => {
  const quality = new ModelQualityService();
  quality.registerDataset({ id: "synthetic-diverse-v1", version: 1, source: "synthetic", licenseId: "synthetic-generator-policy-v1", consentPurpose: "model_quality", dataCardSha256: "d".repeat(64), dimensions: { age_range: ["adult-young", "adult-older"], skin_tone: ["group-a", "group-b"], gender_expression: ["feminine", "masculine"], device: ["ios", "android"], multi_person: ["single", "multiple"], hard_case: ["low-light", "occlusion"] }, rawMediaRetentionDays: 7 });
  quality.recordOfflineEvaluation({ evaluationId: "eval-v1", datasetId: "synthetic-diverse-v1", modelVersionId: "model-v1", completedAt: NOW.toISOString(), metrics, highRiskFailures: 0, evaluatorIds: ["human-rater-1"] });
  quality.registerModel({ id: "model-v1", modelArtifactSha256: "1".repeat(64), promptSha256: "2".repeat(64), parametersSha256: "3".repeat(64), postprocessorSha256: "4".repeat(64), evaluationId: "eval-v1", rollout: "shadow", rollbackReady: true, registeredAt: NOW.toISOString() });
  quality.recordOfflineEvaluation({ evaluationId: "eval-v2", datasetId: "synthetic-diverse-v1", modelVersionId: "model-v2", completedAt: NOW.toISOString(), metrics, highRiskFailures: 0, evaluatorIds: ["human-rater-1"] });
  quality.registerModel({ id: "model-v2", predecessorId: "model-v1", modelArtifactSha256: "5".repeat(64), promptSha256: "6".repeat(64), parametersSha256: "7".repeat(64), postprocessorSha256: "8".repeat(64), evaluationId: "eval-v2", rollout: "canary", rollbackReady: true, registeredAt: NOW.toISOString() });
  const base = { observationId: "observation-1", modelVersionId: "model-v2", observedAt: NOW.toISOString(), sampleCount: 100, rejectRate: 0.1, retryRate: 0.1, appealRate: 0.01, costPerSuccessMinor: 20, p95LatencyMs: 800, distributionDrift: 0.1, safetyRegression: false, highRiskFailure: false, groupScores: { group_a: 0.9, group_b: 0.91 }, rawMediaIncluded: false };
  assert.throws(() => quality.observe({ ...base, rawMediaIncluded: true }), /cannot retain/);
  const decision = quality.observe({ ...base, safetyRegression: true });
  assert.equal(decision.action, "ROLLBACK");
  assert.equal(decision.replacementModelVersionId, "model-v1");
  assert.equal(quality.status("model-v2").enabled, false);
});
