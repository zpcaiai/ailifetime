import assert from "node:assert/strict";
import test from "node:test";
import { LifeTimeMachineRuntime, type ActorContext, type OutboxEvent } from "@ltm/core";
import { DurableOutboxWorker, routeOutboxEvent } from "./index.js";

const actor: ActorContext = {
  actorId: "worker-test-admin",
  tenantId: "tenant-worker-test",
  roles: ["platform_admin"],
  purpose: "event_delivery",
  requestId: "worker-test-request",
  stepUp: true,
};

test("named routes are deterministic and conservative", () => {
  assert.equal(routeOutboxEvent({ aggregateType: "media_asset", eventType: "media.created" }), "media");
  assert.equal(routeOutboxEvent({ aggregateType: "notification", eventType: "message.queued" }), "notification");
  assert.equal(routeOutboxEvent({ aggregateType: "order", eventType: "shipment.created" }), "fulfillment");
  assert.equal(routeOutboxEvent({ aggregateType: "experiment", eventType: "metric.recorded" }), "data");
  assert.equal(routeOutboxEvent({ aggregateType: "project", eventType: "project.created" }), "integration");
});

test("worker publishes a leased event once and records delivery", async (testContext) => {
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:" });
  testContext.after(() => runtime.close());
  runtime.createRecord(actor, {
    collection: "projects",
    data: { state: "created" },
    idempotencyKey: "worker-project-create",
  });
  const delivered: OutboxEvent[] = [];
  const worker = new DurableOutboxWorker(runtime, actor, {
    integration: { publish: (event) => { delivered.push(event); } },
  }, { workerId: "integration-worker-test" });

  assert.deepEqual(await worker.runOnce(), { published: 1, failed: 0 });
  assert.equal(delivered.length, 1);
  assert.equal(runtime.listOutbox(actor, { status: "published" }).length, 1);
  assert.deepEqual(await worker.runOnce(), { published: 0, failed: 0 });
});

test("missing route adapters fail closed and keep an event retryable", async (testContext) => {
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:" });
  testContext.after(() => runtime.close());
  runtime.createRecord(actor, {
    collection: "media_assets",
    data: { state: "created" },
    idempotencyKey: "worker-media-create",
  });
  const worker = new DurableOutboxWorker(runtime, actor, {}, { workerId: "media-worker-test" });

  assert.deepEqual(await worker.runOnce(), { published: 0, failed: 1 });
  const pending = runtime.listOutbox(actor, { status: "pending" });
  assert.equal(pending.length, 1);
  assert.match(pending[0]?.lastError ?? "", /No media event publisher/);
});
