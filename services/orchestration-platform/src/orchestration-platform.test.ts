import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  DurableWorkflowEngine,
  InMemoryWorkflowRepository,
  OrchestrationError,
  ProviderControlPlane,
  providerHealthPayload,
  type ProviderDefinition,
  type WorkflowActivityRunner,
} from "./index.js";

const digest = (character: string) => character.repeat(64);
const healthKeys = generateKeyPairSync("ed25519");
const healthPublicKeyPem = healthKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
const provider = (overrides: Partial<ProviderDefinition> = {}): ProviderDefinition => ({
  id: "provider-a",
  version: "2026-08-28",
  capabilities: ["image"],
  regions: ["CN"],
  allowedForMinors: false,
  dataCategories: ["derived-media"],
  allowedPurposes: ["generation"],
  retentionDays: 7,
  trainingUseAllowed: false,
  supportsDeletion: true,
  costPerUnitMinor: 10,
  maximumConcurrency: 1,
  canaryBasisPoints: 10_000,
  healthAuthority: "synthetic-health-authority",
  healthKeyId: "health-key-1",
  healthPublicKeyPem,
  ...overrides,
});

function signedHealth(providerId: string, observedAt: string, p95LatencyMs = 10) {
  const unsigned = {
    providerId,
    observedAt,
    state: "healthy" as const,
    p95LatencyMs,
    errorRate: 0,
    capacityAvailable: 2,
    authority: "synthetic-health-authority",
    keyId: "health-key-1",
  };
  const payload = providerHealthPayload(unsigned);
  return {
    ...unsigned,
    artifactSha256: createHash("sha256").update(payload).digest("hex"),
    signature: sign(null, Buffer.from(payload), healthKeys.privateKey).toString("base64url"),
  };
}

test("B12 routes only from fresh authoritative health and all policy constraints", async () => {
  let now = new Date("2026-08-28T00:00:00.000Z");
  const control = new ProviderControlPlane({
    probe: async (definition) => signedHealth(definition.id, now.toISOString(), definition.id === "provider-cheap" ? 100 : 10),
  }, () => new Date(now));
  control.register(provider({ id: "provider-cheap", costPerUnitMinor: 1, maximumConcurrency: 2 }), 100);
  control.register(provider({ id: "provider-fast", costPerUnitMinor: 20, maximumConcurrency: 2 }), 100);
  assert.throws(() => control.route({ tenantId: "t", subjectId: "s", capability: "image", region: "CN", participantMinor: false, dataCategories: ["derived-media"], consentPurposes: ["generation"], requiredPurposes: ["generation"], units: 1, maxCostMinor: 100, maximumRetentionDays: 7, requestId: "before-health" }), (error: unknown) => error instanceof OrchestrationError && error.code === "NO_ELIGIBLE_PROVIDER");
  await control.refresh();
  const route = control.route({ tenantId: "t", subjectId: "s", capability: "image", region: "CN", participantMinor: false, dataCategories: ["derived-media"], consentPurposes: ["generation"], requiredPurposes: ["generation"], units: 1, maxCostMinor: 100, maximumRetentionDays: 7, requestId: "request-1" });
  assert.equal(route.providerId, "provider-cheap");
  assert.match(route.healthArtifactSha256, /^[a-f0-9]{64}$/u);
  assert.throws(() => control.route({ tenantId: "t", subjectId: "s", capability: "image", region: "US", participantMinor: false, dataCategories: ["derived-media"], consentPurposes: ["generation"], requiredPurposes: ["generation"], units: 1, maxCostMinor: 100, maximumRetentionDays: 7, requestId: "wrong-region" }), /no healthy provider/);
  control.complete(route.providerId, false);
  now = new Date("2026-08-28T00:03:00.001Z");
  assert.throws(() => control.route({ tenantId: "t", subjectId: "s", capability: "image", region: "CN", participantMinor: false, dataCategories: ["derived-media"], consentPurposes: ["generation"], requiredPurposes: ["generation"], units: 1, maxCostMinor: 100, maximumRetentionDays: 7, requestId: "stale-health" }), /no healthy provider/);
});

test("B12 opens the circuit after bounded failures and enforces minor, budget, canary, and capacity", async () => {
  const now = () => new Date("2026-08-28T00:00:00.000Z");
  const control = new ProviderControlPlane({ probe: async (definition) => ({ ...signedHealth(definition.id, now().toISOString()), capacityAvailable: 1, ...(() => {
    const unsigned = { providerId: definition.id, observedAt: now().toISOString(), state: "healthy" as const, p95LatencyMs: 10, errorRate: 0, capacityAvailable: 1, authority: "synthetic-health-authority", keyId: "health-key-1" };
    const payload = providerHealthPayload(unsigned);
    return { artifactSha256: createHash("sha256").update(payload).digest("hex"), signature: sign(null, Buffer.from(payload), healthKeys.privateKey).toString("base64url") };
  })() }) }, now);
  control.register(provider(), 50);
  await control.refresh();
  const input = { tenantId: "t", subjectId: "s", capability: "image", region: "CN", participantMinor: false, dataCategories: ["derived-media"] as const, consentPurposes: ["generation"] as const, requiredPurposes: ["generation"] as const, units: 1, maxCostMinor: 50, maximumRetentionDays: 7, requestId: "request" };
  assert.throws(() => control.route({ ...input, participantMinor: true }), /no healthy provider/);
  for (let count = 0; count < 3; count += 1) {
    const reservation = control.route({ ...input, requestId: `failure-${count}` });
    assert.throws(() => control.route({ ...input, requestId: `concurrent-${count}` }), /no healthy provider/);
    control.complete(reservation.providerId, false);
  }
  assert.throws(() => control.route({ ...input, requestId: "circuit-open" }), /no healthy provider/);
});

function workflowRunner(results: Array<{ succeeded: boolean; retryable: boolean; resultSha256: string; errorCode?: string }>): WorkflowActivityRunner & { compensations: string[] } {
  const compensations: string[] = [];
  return {
    compensations,
    run: async ({ heartbeat }) => {
      await heartbeat();
      const result = results.shift();
      if (result === undefined) throw new Error("runner fixture exhausted");
      return result;
    },
    compensate: async ({ compensationId }) => {
      compensations.push(compensationId);
      return { succeeded: true, receiptSha256: digest("f") };
    },
  };
}

test("B13 persists deterministic progress, retries transient failure, and deduplicates starts", async () => {
  let clock = new Date("2026-08-28T00:00:00.000Z");
  const repository = new InMemoryWorkflowRepository();
  const runner = workflowRunner([
    { succeeded: false, retryable: true, resultSha256: digest("1"), errorCode: "TRANSIENT" },
    { succeeded: true, retryable: false, resultSha256: digest("2") },
    { succeeded: true, retryable: false, resultSha256: digest("3") },
  ]);
  const engine = new DurableWorkflowEngine(repository, runner, () => new Date(clock));
  engine.register({ id: "generate-saga", version: 1, activities: [
    { id: "persist-intent", timeoutMs: 5_000, heartbeatMs: 1_000, maxAttempts: 3, initialBackoffMs: 0, compensationId: "void-intent", nonRetryableErrorCodes: ["CONSENT_REVOKED"] },
    { id: "invoke-provider", timeoutMs: 5_000, heartbeatMs: 1_000, maxAttempts: 2, initialBackoffMs: 0, compensationId: "delete-provider-asset", nonRetryableErrorCodes: ["POLICY_DENIED"] },
  ] });
  const started = await engine.start({ id: "wf-1", tenantId: "t", traceId: "trace-1", definitionId: "generate-saga", definitionVersion: 1, codeVersion: "git:abc", payload: { tenantId: "t", assetId: "a" }, idempotencyKey: "idem-key-1" });
  assert.equal((await engine.start({ id: "ignored", tenantId: "t", traceId: "trace-1", definitionId: "generate-saga", definitionVersion: 1, codeVersion: "git:abc", payload: { tenantId: "t", assetId: "a" }, idempotencyKey: "idem-key-1" })).id, "wf-1");
  await assert.rejects(() => engine.start({ id: "ignored-2", tenantId: "t", traceId: "trace-1", definitionId: "generate-saga", definitionVersion: 1, codeVersion: "git:abc", payload: { tenantId: "t", assetId: "different" }, idempotencyKey: "idem-key-1" }), /idempotency key was reused/);
  assert.equal(started.state, "running");
  clock = new Date("2026-08-28T00:00:00.100Z");
  assert.equal((await engine.step("wf-1")).activities[0]?.state, "pending");
  clock = new Date("2026-08-28T00:00:00.200Z");
  assert.equal((await engine.step("wf-1")).activities[0]?.state, "completed");
  clock = new Date("2026-08-28T00:00:00.300Z");
  assert.equal((await engine.step("wf-1")).activities[1]?.state, "completed");
  clock = new Date("2026-08-28T00:00:00.400Z");
  assert.equal((await engine.step("wf-1")).state, "completed");
});

test("B13 cancellation compensates completed side effects in reverse and CAS rejects stale writes", async () => {
  let clock = new Date("2026-08-28T00:00:00.000Z");
  const repository = new InMemoryWorkflowRepository();
  const runner = workflowRunner([{ succeeded: true, retryable: false, resultSha256: digest("a") }]);
  const engine = new DurableWorkflowEngine(repository, runner, () => new Date(clock));
  engine.register({ id: "delete-saga", version: 1, activities: [
    { id: "revoke-share", timeoutMs: 5_000, heartbeatMs: 1_000, maxAttempts: 1, initialBackoffMs: 0, compensationId: "restore-share-if-consent-current", nonRetryableErrorCodes: ["CONSENT_REVOKED"] },
    { id: "delete-asset", timeoutMs: 5_000, heartbeatMs: 1_000, maxAttempts: 1, initialBackoffMs: 0, compensationId: "none", nonRetryableErrorCodes: ["ASSET_DELETED"] },
  ] });
  await engine.start({ id: "wf-2", tenantId: "t", traceId: "trace-2", definitionId: "delete-saga", definitionVersion: 1, codeVersion: "git:abc", payload: { asset: "a" }, idempotencyKey: "idem-key-2" });
  clock = new Date("2026-08-28T00:00:00.100Z");
  const completed = await engine.step("wf-2");
  const stale = structuredClone(completed);
  await engine.cancel("wf-2");
  await assert.rejects(() => repository.save(digest("0"), stale), /compare-and-swap/);
  clock = new Date("2026-08-28T00:00:00.200Z");
  assert.equal((await engine.step("wf-2")).state, "compensating");
  clock = new Date("2026-08-28T00:00:00.300Z");
  assert.equal((await engine.step("wf-2")).activities[0]?.state, "compensated");
  clock = new Date("2026-08-28T00:00:00.400Z");
  assert.equal((await engine.step("wf-2")).state, "compensated");
  assert.deepEqual(runner.compensations, ["restore-share-if-consent-current"]);
});
