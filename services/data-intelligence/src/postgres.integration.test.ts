import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  EventSchemaRegistry, PostgresTrackingQueueRepository, PostgresWarehouseStateRepository,
  TrackingClient, WarehousePipeline,
} from "./index.js";

const connectionString = process.env.LTM_TEST_POSTGRES_URL;

test("B111-B112 PostgreSQL queue and warehouse state survive clients, lease safely, CAS, and isolate tenants", {
  skip: connectionString === undefined ? "set LTM_TEST_POSTGRES_URL to a migrated disposable database" : false,
}, async () => {
  assert.ok(connectionString);
  const pool = new Pool({ connectionString, max: 4, application_name: "ltm-data-intelligence-integration" });
  const suffix = randomUUID(); const tenantA = `tenant-data-a-${suffix}`; const tenantB = `tenant-data-b-${suffix}`;
  let clock = new Date("2026-08-28T04:00:00.000Z"); const now = () => new Date(clock);
  try {
    const registry = new EventSchemaRegistry();
    registry.register({
      name: "ltm.generation.completed", domain: "generation", version: 1, owner: "analytics", producer: "worker",
      trigger: "generation committed", dedupeField: "generation_id", consentPurpose: "analytics", retentionDays: 30,
      fields: { generation_id: { type: "string", required: true, classification: "confidential", purposes: ["analytics"] } },
    });
    const queue = new PostgresTrackingQueueRepository(pool); let accepted = false;
    const context = { environment: "production" as const, applicationVersion: "1.0.0", sessionId: "session-1", tenantId: tenantA, requestId: "request-1234", traceId: "trace-1234" };
    const first = new TrackingClient("server", context, registry, { deliver: async () => accepted ? { accepted: true } : { accepted: false, retryable: true, reason: "synthetic outage" } }, now, queue, "worker-a");
    const event = { eventId: `event-${suffix}`, name: "ltm.generation.completed", version: 1, occurredAt: clock.toISOString(), payload: { generation_id: "generation-1" }, grantedPurposes: ["analytics"] };
    assert.equal((await first.track(event)).state, "RETRY_SCHEDULED");
    accepted = true; clock = new Date(clock.getTime() + 1_000);
    const restarted = new TrackingClient("server", context, registry, first.transport, now, queue, "worker-b");
    assert.equal((await restarted.flush())[0]?.state, "DELIVERED");
    assert.equal((await restarted.track(event)).state, "DUPLICATE");

    const stateKey = `warehouse-${suffix}`;
    const repositoryA = new PostgresWarehouseStateRepository(pool, tenantA, stateKey);
    const repositoryB = new PostgresWarehouseStateRepository(pool, tenantB, stateKey);
    assert.equal(await repositoryA.load(), undefined); assert.equal(await repositoryB.load(), undefined);
    const pipeline = new WarehousePipeline(now);
    pipeline.ingest({ batchId: `batch-${suffix}`, source: "payment", schemaFingerprint: "a".repeat(64), records: [{ tenantId: tenantA, sequence: 1, primaryKey: "payment-1", sourceOccurredAt: clock.toISOString(), sourceVersion: 1, deleted: false, payload: { synthetic: true }, amountMinor: 100, currency: "CNY" }], expectedRowCount: 1, expectedAmountMinor: 100, maxCostMinor: 20, actualCostMinor: 10, freshnessSloSeconds: 60 });
    await pipeline.persist(repositoryA);
    const loaded = await repositoryA.load(); assert.ok(loaded); assert.equal(loaded.records.length, 4);
    assert.equal(await repositoryB.load(), undefined);
    const concurrentA = new WarehousePipeline(now, loaded); const concurrentB = new WarehousePipeline(now, loaded);
    concurrentA.approveSchema("payment", "b".repeat(64)); concurrentB.approveSchema("payment", "c".repeat(64));
    await concurrentA.persist(repositoryA, pipeline.stateFingerprint());
    await assert.rejects(() => concurrentB.persist(repositoryA, pipeline.stateFingerprint()), /changed since it was loaded/);
  } finally { await pool.end(); }
});
