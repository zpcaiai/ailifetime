import assert from "node:assert/strict";
import test from "node:test";
import { LifeTimeMachineRuntime, type ActorContext, type OutboxEvent } from "@ltm/core";
import { loadWorkerConfiguration } from "./config.js";
import { createWorkerHealthServer, WorkerMetrics } from "./health.js";
import { DurableOutboxWorker, ProductionExternalCommandPublisher, ProductionRoutePublisher, routeOutboxEvent } from "./index.js";

const actor: ActorContext = {
  actorId: "worker-test-admin",
  tenantId: "tenant-worker-test",
  roles: ["service_account"],
  permissions: [
    "record:create", "record:read", "record:update",
    "outbox:read", "outbox:publish",
    "external-command:read", "external-command:transition",
    "audit:read", "audit:append",
  ],
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

test("production external-command publisher durably dispatches and survives a lost provider response", async (testContext) => {
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:" });
  testContext.after(() => runtime.close());
  const created = runtime.createExternalCommand(actor, {
    record: {
      collection: "capability.building-physical-supply-network",
      id: "vendor-job-1",
      data: {
        batchId: "B98",
        operation: "createVendorProductionJob",
        operationMode: "external-command",
        quantity: 1,
      },
    },
    commandId: "vendor-job-1",
    batchId: "B98",
    operation: "createVendorProductionJob",
    idempotencyKey: "create-vendor-job-1",
  }).value;
  const requestedEvent = runtime.listOutbox(actor).find((event) => event.eventType === "external_command.requested");
  assert.notEqual(requestedEvent, undefined);
  let deliveries = 0;
  const providerIdempotencyKeys: string[] = [];
  const publisher = new ProductionExternalCommandPublisher(runtime, actor, {
    B98: {
      async send(input) {
        deliveries += 1;
        providerIdempotencyKeys.push(input.idempotencyKey);
        assert.equal(input.batchId, "B98");
        assert.equal(input.payload.externalCommandId, "vendor-job-1");
        if (deliveries === 1) throw new Error("provider response was lost after acceptance");
        return {
          providerRequestId: "provider-vendor-job-1",
          state: "accepted",
          artifact: Buffer.from("synthetic provider response"),
          artifactSha256: "a".repeat(64),
        };
      },
    },
  }, () => new Date("2026-08-20T00:00:00.000Z"));
  await assert.rejects(
    publisher.publish(requestedEvent as OutboxEvent),
    /provider response was lost after acceptance/,
  );
  assert.equal(runtime.getExternalCommand(actor, created.command.commandId).state, "dispatched");
  assert.equal(runtime.getRecord(actor, created.record.collection, created.record.id).data.commandState, "dispatched");

  await publisher.publish(requestedEvent as OutboxEvent);
  const command = runtime.getExternalCommand(actor, created.command.commandId);
  assert.equal(command.state, "acknowledged");
  assert.equal(command.providerOperationId, "provider-vendor-job-1");
  assert.equal(command.evidenceId, null);
  assert.deepEqual(command.details, {
    sourceEventId: requestedEvent?.id,
    workerDispatchedAt: "2026-08-20T00:00:00.000Z",
    providerResponseSha256: "a".repeat(64),
    acknowledgedAt: "2026-08-20T00:00:00.000Z",
  });
  const updated = runtime.getRecord(actor, created.record.collection, created.record.id);
  assert.equal(updated.data.executionState, "acknowledged");
  assert.equal(updated.data.commandState, "acknowledged");
  const aggregateReceipt = updated.data.externalReceipt as Record<string, unknown>;
  assert.deepEqual({ ...aggregateReceipt, updatedAt: "<verified>" }, {
    providerOperationId: "provider-vendor-job-1",
    evidenceId: null,
    state: "acknowledged",
    updatedAt: "<verified>",
  });
  assert.equal(typeof aggregateReceipt.updatedAt, "string");
  assert.equal(Number.isFinite(Date.parse(aggregateReceipt.updatedAt as string)), true);
  assert.equal(deliveries, 2);
  assert.deepEqual(providerIdempotencyKeys, [requestedEvent?.id, requestedEvent?.id]);

  await publisher.publish(requestedEvent as OutboxEvent);
  assert.equal(deliveries, 2);
});

test("external command projection events cannot trigger a second provider delivery", async (testContext) => {
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:" });
  testContext.after(() => runtime.close());
  runtime.createExternalCommand(actor, {
    record: {
      collection: "finance.tax-document-commands",
      id: "tax-document-1",
      data: {
        batchId: "B89",
        operation: "requestTaxDocument",
        operationMode: "external-command",
      },
    },
    commandId: "tax-document-1",
    batchId: "B89",
    operation: "requestTaxDocument",
    idempotencyKey: "create-tax-document-1",
  });
  let commandDeliveries = 0;
  let genericDeliveries = 0;
  const publisher = new ProductionRoutePublisher(runtime, actor, {
    B89: {
      async send() {
        commandDeliveries += 1;
        return {
          providerRequestId: "tax-provider-request-1",
          state: "accepted",
          artifact: Buffer.from("accepted"),
          artifactSha256: "c".repeat(64),
        };
      },
    },
  }, {
    async send() {
      genericDeliveries += 1;
      return {
        providerRequestId: "generic-request-1",
        state: "accepted",
        artifact: Buffer.from("accepted"),
        artifactSha256: "d".repeat(64),
      };
    },
  });
  const initial = runtime.listOutbox(actor);
  const requested = initial.find((event) => event.eventType === "external_command.requested");
  assert.notEqual(requested, undefined);
  await publisher.publish(requested as OutboxEvent);
  for (const event of runtime.listOutbox(actor)) {
    if (event.id !== requested?.id) await publisher.publish(event);
  }
  assert.equal(commandDeliveries, 1);
  assert.equal(genericDeliveries, 0);
});

test("production route publisher signs and delivers ordinary capability events", async (testContext) => {
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:" });
  testContext.after(() => runtime.close());
  runtime.createRecord(actor, {
    collection: "capability.building-consumer-time-machine",
    id: "project-route-1",
    data: { batchId: "B01", operationMode: "resource", state: "created" },
    idempotencyKey: "create-project-route-1",
  });
  const delivered: string[] = [];
  const routePublisher = new ProductionRoutePublisher(runtime, actor, {}, {
    async send(input) {
      delivered.push(`${input.batchId}:${input.operation}:${input.idempotencyKey}`);
      return {
        providerRequestId: "route-receipt-1",
        state: "accepted",
        artifact: Buffer.from("accepted"),
        artifactSha256: "b".repeat(64),
      };
    },
  });
  const worker = new DurableOutboxWorker(runtime, actor, { integration: routePublisher }, {
    workerId: "route-worker-production-test",
    batchSize: 1,
  });
  assert.deepEqual(await worker.runOnce(), { published: 1, failed: 0 });
  assert.equal(delivered.length, 1);
  assert.match(delivered[0] ?? "", /^B01:capability\.building-consumer-time-machine\.created:/);
  assert.equal(runtime.listAudit(actor).some((entry) => entry.action === "outbox.provider_accepted"), true);
});

test("production worker configuration requires all routes, batches, and managed secret references", () => {
  assert.throws(() => loadWorkerConfiguration({
    APP_ENV: "production",
    LTM_WORKER_TENANT_ID: "tenant-production",
    LTM_METRICS_TOKEN_SHA256: "a".repeat(64),
  }, "/tmp/ltm-product"), /missing external command batches/);

  const batches = [
    "B05", "B10", "B13", "B14", "B16", "B23", "B26", "B29", "B36",
    "B38", "B40", "B65", "B67", "B74", "B83", "B89", "B98", "B101",
  ];
  const adapter = {
    endpoint: "https://integrations.example.test/ltm",
    signingSecretReference: "secret-manager:ltm/production/integration-hmac",
    responseVerificationKeyReference: "secret-manager:ltm/production/integration-response-hmac",
    responseSignatureScheme: "hmac-sha256",
  };
  const configuration = loadWorkerConfiguration({
    APP_ENV: "production",
    DATABASE_URL: "postgresql://ltm_worker@example.test/ltm?sslmode=verify-full",
    LTM_WORKER_TENANT_ID: "tenant-production",
    LTM_METRICS_TOKEN_SHA256: "a".repeat(64),
    LTM_EXTERNAL_COMMAND_ADAPTERS_JSON: JSON.stringify(Object.fromEntries(batches.map((batch) => [batch, adapter]))),
    LTM_OUTBOX_ROUTE_ADAPTERS_JSON: JSON.stringify(Object.fromEntries(
      ["media", "notification", "fulfillment", "integration", "data"].map((route) => [route, adapter]),
    )),
  }, "/tmp/ltm-product");
  assert.equal(Object.keys(configuration.externalCommandAdapters).length, 18);
  assert.equal(Object.keys(configuration.routeAdapters).length, 5);
  assert.deepEqual(configuration.actor.roles, ["service_account"]);
  assert.equal(configuration.actor.permissions?.includes("outbox:publish"), true);
  assert.equal(configuration.deploymentProfile, "distributed");
  assert.equal(configuration.postgresRuntimeOptions?.applicationName, "ltm-worker");

  assert.throws(() => loadWorkerConfiguration({
    APP_ENV: "development",
    LTM_WORKER_TENANT_ID: "tenant-development",
    LTM_EXTERNAL_COMMAND_ADAPTERS_JSON: JSON.stringify({
      B05: {
        endpoint: "https://example.test/command",
        signingSecretReference: "inline:not-allowed",
        responseVerificationKeyReference: "secret-manager:ltm/development/response",
        responseSignatureScheme: "hmac-sha256",
      },
    }),
  }, "/tmp/ltm-product"), /AWS Secrets Manager reference/);
});

test("worker health is public while metrics require a hashed bearer token", async (testContext) => {
  const token = "synthetic-worker-metrics-token";
  const digest = (await import("node:crypto")).createHash("sha256").update(token).digest("hex");
  const metrics = new WorkerMetrics(new Date("2026-08-20T00:00:00.000Z"));
  metrics.record({ published: 3, failed: 1 }, new Date("2026-08-20T00:01:00.000Z"));
  const server = createWorkerHealthServer({
    readiness: async () => ({ ready: true, database: "ok", auditChain: "ok", evidenceTrust: "disabled" }),
    metricsTokenSha256: digest,
  }, metrics);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  testContext.after(() => server.close());
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
  assert.equal((await fetch(`${base}/health/ready`)).status, 200);
  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  const response = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /ltm_worker_events_published_total 3/);
});
