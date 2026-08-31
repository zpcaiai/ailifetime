import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  COMMERCIAL_SAGA_DEFINITIONS,
  DurableScheduler,
  InMemoryMessageJournalStore,
  InMemoryLateProviderResultJournal,
  InMemoryProviderExecutionStore,
  OutboxInboxRuntime,
  PostgresWorkflowRepository,
  ProviderControlPlane,
  ProviderExecutionService,
  ProviderModelRegistry,
  ScopedRateLimiter,
  VirtualClock,
  WorkflowHistoryLedger,
  providerHealthPayload,
  type ProviderAdapter,
  type ProviderDefinition,
  type ProviderExecutionRequest,
  type ProviderHealth,
  type WorkflowInstance,
} from "./index.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const NOW = "2026-08-28T00:00:00.000Z";

function definition(id: string, version = "v1", costPerUnitMinor = 1): ProviderDefinition {
  return { id, version, capabilities: ["image"], regions: ["CN"], allowedForMinors: true, dataCategories: ["derived-media"], allowedPurposes: ["generation"], retentionDays: 7, trainingUseAllowed: false, supportsDeletion: true, costPerUnitMinor, maximumConcurrency: 5, canaryBasisPoints: 10_000, healthAuthority: "synthetic-authority", healthKeyId: "key-1", healthPublicKeyPem: publicKey };
}

function health(providerId: string, overrides: Partial<Omit<ProviderHealth, "artifactSha256" | "signature">> = {}): ProviderHealth {
  const unsigned = { providerId, observedAt: NOW, state: "healthy" as const, p95LatencyMs: 10, errorRate: 0, capacityAvailable: 5, authority: "synthetic-authority", keyId: "key-1", ...overrides };
  const payload = providerHealthPayload(unsigned);
  return { ...unsigned, artifactSha256: sha(payload), signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64url") };
}

function registryFor(providerIds: readonly string[]): ProviderModelRegistry {
  const registry = new ProviderModelRegistry();
  for (const providerId of providerIds) {
    registry.register({ providerId, modelId: "illustrative-age", modelVersion: "v1", operations: ["generate_image"], regions: ["CN"], purposes: ["generation"], retentionDays: 7, trainingUseAllowed: false, registrationReferences: ["synthetic-sandbox-registration"], limitations: ["illustrative-not-predictive"], priceMinorPerUnit: 1, slo: { p95LatencyMs: 1_000, availabilityBasisPoints: 9_900 }, allowedScenarios: ["age-progression"] });
    registry.activate(providerId, "illustrative-age", "v1");
  }
  return registry;
}

function request(overrides: Partial<ProviderExecutionRequest> = {}): ProviderExecutionRequest {
  return { tenantId: "tenant-1", subjectId: "participant-1", capability: "image", region: "CN", participantMinor: false, dataCategories: ["derived-media"], consentPurposes: ["generation"], requiredPurposes: ["generation"], units: 1, maxCostMinor: 100, maximumRetentionDays: 7, requestId: "request-1", idempotencyKey: "provider-idem-1", actorId: "actor-1", operation: "generate_image", modelId: "illustrative-age", scenario: "age-progression", authorizationArtifactSha256: sha("authorization"), inputAssetSha256: sha("input"), parameters: { targetAge: 40, qualityTier: "standard" }, timeoutMs: 500, ...overrides };
}

function successfulAdapter(providerOperationId: string): ProviderAdapter & { executeCount: number; deleteCount: number } {
  return {
    executeCount: 0,
    deleteCount: 0,
    async execute() { this.executeCount += 1; return { status: "succeeded", providerOperationId, outputArtifactSha256: sha(`${providerOperationId}:output`), safetyArtifactSha256: sha(`${providerOperationId}:safety`), billedMinor: 1 }; },
    async cancel() { return { cancelled: true, receiptSha256: sha("cancel") }; },
    async delete() { this.deleteCount += 1; return { deleted: true, receiptSha256: sha("delete") }; },
  };
}

test("B12 rejects forged health and requires cross-functional model-version review", async () => {
  const control = new ProviderControlPlane({ probe: async () => ({ ...health("provider-a"), signature: "forged" }) }, () => new Date(NOW));
  control.register(definition("provider-a"), 100);
  await assert.rejects(() => control.refresh(), /invalid signed observation/);
  const registry = registryFor(["provider-a"]);
  assert.throws(() => registry.register({ ...registry.get("provider-a", "illustrative-age", "v1"), modelVersion: "v2" }), /lacks independent/);
  registry.register({ ...registry.get("provider-a", "illustrative-age", "v1"), modelVersion: "v2", review: { previousVersion: "v1", qualityPassed: true, safetyPassed: true, costApproved: true, contractApproved: true, reviewedAt: NOW, reviewerIds: ["quality-reviewer", "commercial-reviewer"], evidenceSha256: sha("review") } });
  registry.activate("provider-a", "illustrative-age", "v2");
  assert.equal(registry.get("provider-a", "illustrative-age").modelVersion, "v2");
});

test("B12 persists intent before provider side effects and guarantees request/publish idempotency", async () => {
  const control = new ProviderControlPlane({ probe: async (value) => health(value.id) }, () => new Date(NOW));
  control.register(definition("provider-a"), 100);
  await control.refresh();
  const adapter = successfulAdapter("operation-1");
  const store = new InMemoryProviderExecutionStore();
  const service = new ProviderExecutionService(control, registryFor(["provider-a"]), new Map([["provider-a", adapter]]), store, () => new Date(NOW));
  const completed = await service.execute(request());
  assert.equal(completed.state, "succeeded");
  assert.equal(adapter.executeCount, 1);
  assert.equal((await service.execute(request())).id, completed.id);
  assert.equal(adapter.executeCount, 1);
  await assert.rejects(() => service.execute(request({ parameters: { targetAge: 41 } })), /idempotency key was reused/);
  let publishes = 0;
  assert.equal((await service.publish("provider-idem-1", async ({ publicationId }) => { publishes += 1; return { receiptSha256: sha(publicationId) }; })).state, "published");
  assert.equal((await service.publish("provider-idem-1", async () => { publishes += 1; return { receiptSha256: sha("unexpected") }; })).state, "published");
  assert.equal(publishes, 1);
  assert.equal((await service.delete("provider-idem-1")).state, "deleted");
  assert.equal(adapter.deleteCount, 1);
});

test("B12 performs bounded failover without cross-provider duplicate publication", async () => {
  const control = new ProviderControlPlane({ probe: async (value) => health(value.id) }, () => new Date(NOW));
  control.register(definition("provider-primary", "v1", 1), 100);
  control.register(definition("provider-secondary", "v1", 2), 100);
  await control.refresh();
  const primary: ProviderAdapter = { execute: async () => ({ status: "rejected", providerOperationId: "primary-attempt", billedMinor: 0, errorCategory: "transient_dependency", errorCode: "UPSTREAM_TIMEOUT" }), cancel: async () => ({ cancelled: false, receiptSha256: sha("none") }), delete: async () => ({ deleted: false, receiptSha256: sha("none") }) };
  const secondary = successfulAdapter("secondary-operation");
  const service = new ProviderExecutionService(control, registryFor(["provider-primary", "provider-secondary"]), new Map([["provider-primary", primary], ["provider-secondary", secondary]]), new InMemoryProviderExecutionStore(), () => new Date(NOW));
  const result = await service.execute(request({ idempotencyKey: "provider-idem-failover" }));
  assert.equal(result.route.providerId, "provider-secondary");
  assert.equal(result.attempt, 2);
  assert.equal(secondary.executeCount, 1);
});

test("B12 quarantines and deletes a primary provider success that arrives after timeout and failover", async () => {
  const control = new ProviderControlPlane({ probe: async (value) => health(value.id) }, () => new Date(NOW));
  control.register(definition("provider-primary", "v1", 1), 100);
  control.register(definition("provider-secondary", "v1", 2), 100);
  await control.refresh();
  let lateDeletes = 0;
  const primary: ProviderAdapter = {
    execute: async () => new Promise((resolve) => setTimeout(() => resolve({ status: "succeeded", providerOperationId: "late-primary-operation", outputArtifactSha256: sha("late-output"), safetyArtifactSha256: sha("late-safety"), billedMinor: 1 }), 80)),
    cancel: async () => ({ cancelled: true, receiptSha256: sha("cancel") }),
    delete: async () => { lateDeletes += 1; return { deleted: true, receiptSha256: sha("late-delete") }; },
  };
  const secondary = successfulAdapter("secondary-after-timeout");
  const lateResults = new InMemoryLateProviderResultJournal();
  const service = new ProviderExecutionService(control, registryFor(["provider-primary", "provider-secondary"]), new Map([["provider-primary", primary], ["provider-secondary", secondary]]), new InMemoryProviderExecutionStore(), () => new Date(NOW), lateResults, async () => {});
  const result = await service.execute(request({ idempotencyKey: "provider-idem-late", timeoutMs: 50 }));
  assert.equal(result.route.providerId, "provider-secondary");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(lateDeletes, 1);
  assert.equal((await lateResults.list())[0]?.state, "DELETED");
});

test("B13 PostgreSQL repository pins tenant scope and uses digest compare-and-swap", async () => {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  const client = { query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => { calls.push({ text, ...(values === undefined ? {} : { values }) }); const rows = text.includes("WITH required(name)") ? [{ table_count: 8, forced_rls_count: 8, policy_count: 8, exact_policy_count: 8 }] : []; return { rows: rows as unknown as Row[], rowCount: text.startsWith("UPDATE") ? 0 : 1 }; } };
  const sql = { transaction: async <T>(operation: (value: typeof client) => Promise<T>) => operation(client) };
  const repository = new PostgresWorkflowRepository(sql, "tenant-1");
  await repository.initialize();
  assert.match(calls[0]?.text ?? "", /pg_policies/);
  assert.doesNotMatch(calls[0]?.text ?? "", /CREATE|ALTER|DROP/);
  await repository.load("workflow-1");
  assert.equal(calls.at(-2)?.text, "SELECT set_config('app.tenant_id', $1, true)");
  const instance = workflowInstance();
  await repository.save(undefined, instance);
  await assert.rejects(() => repository.save(sha("old-state"), { ...instance, updatedAt: "2026-08-28T00:00:01.000Z" }), /compare-and-swap/);
  await assert.rejects(() => repository.save(undefined, { ...instance, tenantId: "tenant-2" }), /cross-tenant/);
});

test("B13 outbox persists intent, relays with signed receipt, deduplicates inbox, and fails closed on payload reuse", async () => {
  const clock = new VirtualClock(NOW);
  const store = new InMemoryMessageJournalStore();
  const runtime = new OutboxInboxRuntime(store, new ScopedRateLimiter({ tenant: 10, partner: 10, provider: 10 }), clock.now);
  const queued = await runtime.enqueue({ tenantId: "tenant-1", kind: "generation.requested", idempotencyKey: "outbox-idem-1", payloadSha256: sha("payload"), consentArtifactSha256: sha("consent"), resourceRevision: 1, providerId: "provider-a", request: { assetId: "asset-1" } });
  assert.equal((await runtime.enqueue({ tenantId: "tenant-1", kind: "generation.requested", idempotencyKey: "outbox-idem-1", payloadSha256: sha("payload"), consentArtifactSha256: sha("consent"), resourceRevision: 1, providerId: "provider-a", request: { assetId: "asset-1" } })).envelope.id, queued.envelope.id);
  await assert.rejects(() => runtime.enqueue({ tenantId: "tenant-1", kind: "generation.requested", idempotencyKey: "outbox-idem-1", payloadSha256: sha("payload"), consentArtifactSha256: sha("consent"), resourceRevision: 1, request: { assetId: "different" } }), /idempotency key was reused/);
  assert.equal((await runtime.relay(async (envelope) => ({ delivered: true, retryable: false, receiptSha256: sha(envelope.id) })))[0]?.state, "delivered");
  const guard = { authorize: async () => ({ allowed: true }) };
  assert.equal(await runtime.consume(queued.envelope, guard, async () => ({ succeeded: true, retryable: false })), "PROCESSED");
  assert.equal(await runtime.consume(queued.envelope, guard, async () => ({ succeeded: false, retryable: false })), "DUPLICATE");
  await assert.rejects(() => runtime.consume({ ...queued.envelope, payloadSha256: sha("changed") }, guard, async () => ({ succeeded: true, retryable: false })), /different payload/);
});

test("B13 dead-letter replay requires step-up and rechecks current consent/resource state", async () => {
  const store = new InMemoryMessageJournalStore();
  const runtime = new OutboxInboxRuntime(store, new ScopedRateLimiter({ tenant: 1, partner: 1, provider: 1 }), () => new Date(NOW));
  const envelope = await runtime.enqueue({ tenantId: "tenant-1", kind: "print.requested", idempotencyKey: "outbox-idem-2", payloadSha256: sha("print"), consentArtifactSha256: sha("consent"), resourceRevision: 2, request: { order: "order-1" } });
  assert.equal(await runtime.consume(envelope.envelope, { authorize: async () => ({ allowed: false, reasonCode: "CONSENT_REVOKED" }) }, async () => ({ succeeded: true, retryable: false })), "DEAD_LETTER");
  await assert.rejects(() => runtime.replay({ deadLetterId: envelope.envelope.id, actorId: "operator", actorRoles: [], ticketId: "ticket-1", stepUpArtifactSha256: sha("step-up") }, { authorize: async () => ({ allowed: true }) }), /requires operator role/);
  await assert.rejects(() => runtime.replay({ deadLetterId: envelope.envelope.id, actorId: "operator", actorRoles: ["workflow_replay_operator"], ticketId: "ticket-1", stepUpArtifactSha256: sha("step-up") }, { authorize: async () => ({ allowed: false, reasonCode: "ASSET_DELETED" }) }), /current state/);
  assert.equal((await runtime.replay({ deadLetterId: envelope.envelope.id, actorId: "operator", actorRoles: ["workflow_replay_operator"], ticketId: "ticket-1", stepUpArtifactSha256: sha("step-up") }, { authorize: async () => ({ allowed: true }) })).state, "pending");
});

test("B13 supplies seven versioned commercial sagas, scheduler, trace graph, history compaction, and virtual time", () => {
  assert.deepEqual(COMMERCIAL_SAGA_DEFINITIONS.map((value) => value.id).sort(), ["credit-saga", "deletion-saga", "generation-saga", "order-saga", "payment-saga", "print-saga", "settlement-saga"]);
  for (const saga of COMMERCIAL_SAGA_DEFINITIONS) for (const item of saga.activities) assert.ok(item.compensationId.length > 0);
  const clock = new VirtualClock(NOW);
  const scheduler = new DurableScheduler();
  scheduler.register({ id: "annual-reminder", tenantId: "tenant-1", kind: "ritual.reminder", payloadSha256: sha("reminder"), dueAt: "2026-08-28T00:00:01.000Z", intervalMs: 1_000 });
  assert.equal(scheduler.due(clock.now()).length, 0);
  clock.advance(1_000);
  assert.equal(scheduler.due(clock.now()).length, 1);
  assert.equal(scheduler.due(clock.now()).length, 0);
  const instance = workflowInstance();
  const history = new WorkflowHistoryLedger();
  history.support("generation-saga", [1]);
  history.append(instance, "started");
  history.append({ ...instance, updatedAt: "2026-08-28T00:00:01.000Z" }, "activity-completed");
  history.append({ ...instance, updatedAt: "2026-08-28T00:00:02.000Z" }, "completed");
  assert.match(history.compact(instance.id, 1).checkpointSha256, /^[a-f0-9]{64}$/u);
  assert.equal(history.visualize(instance).traceId, "trace-1");
  assert.throws(() => history.assertCompatible({ ...instance, definitionVersion: 2 }), /not supported/);
});

function workflowInstance(): WorkflowInstance {
  return { id: "workflow-1", tenantId: "tenant-1", traceId: "trace-1", definitionId: "generation-saga", definitionVersion: 1, codeVersion: "git:synthetic", inputSha256: sha("input"), idempotencyKey: "workflow-idem-1", state: "running", currentIndex: 0, activities: [{ id: "persist-generation-intent", state: "pending", attempts: 0 }], startedAt: NOW, updatedAt: NOW, cancelRequested: false };
}
