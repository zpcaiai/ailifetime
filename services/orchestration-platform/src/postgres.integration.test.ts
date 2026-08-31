import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  OutboxInboxRuntime,
  PostgresDurableScheduler,
  PostgresLateProviderResultJournal,
  PostgresMessageJournalStore,
  PostgresProviderExecutionStore,
  PostgresTransactionExecutor,
  PostgresWorkflowRepository,
  ScopedRateLimiter,
  type DurableEnvelope,
} from "./index.js";
import type { ProviderRoute } from "./provider-control-plane.js";

const connectionString = process.env.LTM_TEST_POSTGRES_URL;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

test("orchestration PostgreSQL stores provide fenced outbox, provider CAS, late quarantine, scheduler, and history durability", {
  skip: connectionString === undefined ? "set LTM_TEST_POSTGRES_URL to a migrated disposable database" : false,
}, async () => {
  assert.ok(connectionString);
  const pool = new Pool({ connectionString, max: 4, application_name: "ltm-orchestration-integration" });
  const sql = new PostgresTransactionExecutor(pool);
  const tenantId = `tenant-orch-${randomUUID()}`;
  try {
    await new PostgresWorkflowRepository(sql, tenantId).initialize();
    const store = new PostgresMessageJournalStore(sql, tenantId);
    const envelope: Omit<DurableEnvelope, "id" | "requestSha256" | "createdAt"> & { request: unknown } = {
      tenantId, kind: "integration.test", idempotencyKey: "orchestration-idem-0001", payloadSha256: digest("payload"), consentArtifactSha256: digest("consent"), resourceRevision: 1, request: { value: 1 },
    };
    const runtime = new OutboxInboxRuntime(store, new ScopedRateLimiter({ tenant: 20, partner: 20, provider: 20 }), () => new Date("2026-08-28T05:00:00.000Z"));
    const created = await runtime.enqueue(envelope);
    const claimed = await store.claimDue!(created.nextAttemptAt, 10, "2026-08-28T05:01:00.000Z");
    assert.equal(claimed.length, 1); assert.equal(claimed[0]?.state, "delivering");
    const settled = { ...claimed[0]!, state: "delivered" as const, receiptSha256: digest("receipt") };
    await store.settleClaim!(claimed[0]!, settled);
    assert.equal((await store.findOutboxByIdempotency(tenantId, envelope.idempotencyKey))?.state, "delivered");
    const second = await store.findOutboxByIdempotency(tenantId, envelope.idempotencyKey); assert.ok(second);
    assert.equal(await runtime.consume(second!.envelope, { authorize: async () => ({ allowed: true }) }, async () => ({ succeeded: true, retryable: false })), "PROCESSED");
    assert.equal(await runtime.consume(second!.envelope, { authorize: async () => ({ allowed: true }) }, async () => ({ succeeded: true, retryable: false })), "DUPLICATE");

    const provider = new PostgresProviderExecutionStore(sql, tenantId);
    const route: ProviderRoute = { providerId: "provider-a", providerVersion: "v1", estimatedCostMinor: 1, reason: "test", healthArtifactSha256: digest("health") };
    const record = { id: `provider-${randomUUID()}`, version: 1, idempotencyKey: `provider-idem-${randomUUID()}`, requestSha256: digest("request"), tenantId, actorId: "actor-1", operation: "generate_text" as const, route, modelId: "model", state: "intent_persisted" as const, attempt: 0, providerIdempotencyKey: digest("provider-key"), updatedAt: "2026-08-28T05:00:00.000Z" };
    await provider.create(record); assert.equal((await provider.find(record.idempotencyKey))?.version, 1);
    await provider.compareAndSwap(1, { ...record, version: 2, state: "failed", errorCategory: "internal", errorCode: "test", updatedAt: "2026-08-28T05:00:01.000Z" });
    await assert.rejects(() => provider.compareAndSwap(1, { ...record, version: 2, state: "failed", updatedAt: "2026-08-28T05:00:01.000Z" }), /compare-and-swap/);
    const late = new PostgresLateProviderResultJournal(sql, tenantId);
    await late.record({ providerId: "provider-a", providerOperationId: "operation-late", providerIdempotencyKey: "provider-late", outputArtifactSha256: digest("artifact"), observedAt: "2026-08-28T05:00:02.000Z", state: "QUARANTINED" });
    assert.equal((await late.list()).length, 1);
    const scheduler = new PostgresDurableScheduler(sql, tenantId);
    await scheduler.register({ id: `job-${randomUUID()}`, tenantId, kind: "integration.test", payloadSha256: digest("job"), dueAt: "2026-08-28T04:59:00.000Z" });
    assert.equal((await scheduler.due(new Date("2026-08-28T05:00:00.000Z"))).length, 1);
  } finally {
    await pool.query("DELETE FROM orchestration.workflow_history WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM orchestration.scheduler_jobs WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM orchestration.late_provider_results WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM orchestration.provider_executions WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM orchestration.dead_letters WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM orchestration.inbox WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM orchestration.outbox WHERE tenant_id=$1", [tenantId]);
    await pool.end();
  }
});
