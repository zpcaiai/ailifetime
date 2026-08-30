import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DomainError,
  EXTERNAL_COMMAND_CALLBACK_ROUTES,
  LifeTimeMachineRuntime,
  signConsentPolicyCatalog,
  type ActorContext,
  type OutboxEvent,
} from "@ltm/core";
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
      collection: "supply.vendor-production-commands",
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

test("the B10 batch adapter dispatches the distinct fixed revokeExport route with its server binding", async (testContext) => {
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:" });
  testContext.after(() => runtime.close());
  const commandId = "B10-revoke:worker-test-1";
  runtime.createExternalCommand(actor, {
    record: {
      collection: "sharing.export-revoke-commands",
      id: commandId,
      data: {
        batchId: "B10",
        operation: "revokeExport",
        operationMode: "external-command",
        exportCommandId: "B10:export-worker-test-1",
        exportRecordId: "B10:export-worker-test-1",
        targetProviderOperationId: "provider-share-grant-worker-1",
        workId: "work-worker-1",
        requestedByActorId: actor.actorId,
      },
    },
    commandId,
    batchId: "B10",
    operation: "revokeExport",
    idempotencyKey: "create-share-revoke-worker-1",
  });
  const request = runtime.listOutbox(actor).find((event) => event.eventType === "external_command.requested");
  assert.ok(request);
  let sends = 0;
  const publisher = new ProductionExternalCommandPublisher(runtime, actor, {
    B10: {
      async send(input) {
        sends += 1;
        assert.equal(input.operation, "revokeExport");
        assert.equal(input.payload.exportCommandId, "B10:export-worker-test-1");
        assert.equal(input.payload.targetProviderOperationId, "provider-share-grant-worker-1");
        return {
          providerRequestId: "provider-share-revoke-request-1",
          state: "accepted",
          artifact: Buffer.from("accepted revoke request"),
          artifactSha256: "c".repeat(64),
        };
      },
    },
  });
  await publisher.publish(request);
  assert.equal(sends, 1);
  assert.equal(runtime.getExternalCommand(actor, commandId).state, "acknowledged");
  assert.equal(runtime.getExternalCommand(actor, commandId).providerOperationId, "provider-share-revoke-request-1");
});

test("ten failed command deliveries atomically dead-letter and freeze the command for reconciliation", async (testContext) => {
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:" });
  testContext.after(() => runtime.close());
  const created = runtime.createExternalCommand(actor, {
    record: {
      collection: "supply.vendor-production-commands",
      id: "vendor-job-dead-letter-1",
      data: {
        batchId: "B98",
        operation: "createVendorProductionJob",
        operationMode: "external-command",
      },
    },
    commandId: "vendor-job-dead-letter-1",
    batchId: "B98",
    operation: "createVendorProductionJob",
    idempotencyKey: "create-vendor-job-dead-letter-1",
  }).value;
  runtime.transitionExternalCommand(actor, {
    commandId: created.command.commandId,
    batchId: created.command.batchId,
    operation: created.command.operation,
    aggregateCollection: created.command.aggregateCollection,
    aggregateId: created.command.aggregateId,
    toState: "dispatched",
    idempotencyKey: "dispatch-vendor-job-dead-letter-1",
  });
  const requestId = runtime.listOutbox(actor)
    .find((event) => event.eventType === "external_command.requested")?.id;
  assert.notEqual(requestId, undefined);

  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const leased = runtime.claimOutbox(actor, "dead-letter-preload", 200, 30_000);
    const request = leased.find((event) => event.id === requestId);
    assert.notEqual(request, undefined);
    if (attempt === 1) {
      assert.throws(
        () => runtime.markOutboxFailed(
          actor,
          requestId as string,
          "dead-letter-preload",
          "unsafe generic dead letter",
          { dead: true },
        ),
        (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_FAILED",
      );
      assert.throws(
        () => runtime.deadLetterExternalCommand(actor, {
          eventId: requestId as string,
          workerId: "dead-letter-preload",
          error: "too early",
        }),
        (error: unknown) => error instanceof DomainError && error.code === "VERSION_CONFLICT",
      );
    }
    for (const event of leased) {
      if (event.id === requestId) {
        runtime.markOutboxFailed(actor, event.id, "dead-letter-preload", "provider response unavailable", {
          retryAt: "2020-01-01T00:00:00.000Z",
        });
      } else {
        runtime.markOutboxPublished(actor, event.id, "dead-letter-preload");
      }
    }
  }

  let sends = 0;
  const publisher = new ProductionExternalCommandPublisher(runtime, actor, {
    B98: {
      async send() {
        sends += 1;
        throw new Error("provider acceptance is unknown");
      },
    },
  });
  const worker = new DurableOutboxWorker(runtime, actor, { fulfillment: publisher }, {
    workerId: "dead-letter-worker",
    batchSize: 1,
  });
  assert.deepEqual(await worker.runOnce(), { published: 0, failed: 1 });
  assert.equal(sends, 1);

  const command = runtime.getExternalCommand(actor, created.command.commandId);
  assert.equal(command.state, "dispatched");
  assert.equal(command.decisionState, "frozen");
  assert.equal(command.reconciliationState, "reconciliation_required");
  assert.equal(command.details.deliveryAttempts, 10);
  const aggregate = runtime.getRecord(actor, created.record.collection, created.record.id);
  assert.equal(aggregate.data.executionState, "reconciliation_required");
  assert.equal(aggregate.data._externalDecisionState, "frozen");
  assert.equal(aggregate.data._externalReconciliationState, "reconciliation_required");
  assert.equal(runtime.listOutbox(actor, { status: "dead" }).some((event) => event.id === requestId), true);
  const reconciliationEvent = runtime.listOutbox(actor, { status: "pending" })
    .find((event) => event.eventType === "external_command.reconciliation_required");
  assert.notEqual(reconciliationEvent, undefined);
  assert.equal(
    runtime.listAudit(actor).some((entry) => entry.action === "external_command.reconciliation_required"),
    true,
  );
  let alerts = 0;
  const alertPublisher = new ProductionRoutePublisher(runtime, actor, {}, {
    async send(input) {
      alerts += 1;
      assert.equal(input.batchId, "B98");
      assert.equal(input.operation, "external_command.reconciliation_required");
      return {
        providerRequestId: "reconciliation-alert-1",
        state: "accepted",
        artifact: Buffer.from("accepted"),
        artifactSha256: "e".repeat(64),
      };
    },
  });
  await alertPublisher.publish(reconciliationEvent as OutboxEvent);
  assert.equal(alerts, 1);
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

test("ordinary route delivery re-authorizes current state, skips stale snapshots, and rejects snapshot corruption", async (testContext) => {
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:" });
  testContext.after(() => runtime.close());
  const created = runtime.createRecord(actor, {
    collection: "projects",
    id: "route-revalidation-1",
    data: { batchId: "B01", operationMode: "resource", state: "created", privateValue: "version-one" },
    idempotencyKey: "route-revalidation-create-1",
  }).value;
  const createdEvent = runtime.listOutbox(actor)
    .find((event) => event.eventType === "projects.created");
  assert.ok(createdEvent);
  const updated = runtime.updateRecord(actor, {
    collection: created.collection,
    id: created.id,
    expectedVersion: created.version,
    data: { batchId: "B01", operationMode: "resource", state: "updated", privateValue: "version-two" },
    idempotencyKey: "route-revalidation-update-1",
  }).value;
  const updatedEvent = runtime.listOutbox(actor)
    .find((event) => event.eventType === "projects.updated");
  assert.ok(updatedEvent);
  let deliveries = 0;
  const publisher = new ProductionRoutePublisher(runtime, actor, {}, {
    async send() {
      deliveries += 1;
      return {
        providerRequestId: "revalidated-route-receipt-1",
        state: "accepted",
        artifact: Buffer.from("accepted"),
        artifactSha256: "f".repeat(64),
      };
    },
  });

  await publisher.publish(createdEvent);
  assert.equal(deliveries, 0);
  assert.equal(runtime.listAudit(actor).some((entry) =>
    entry.action === "outbox.stale_projection_skipped" &&
    entry.details.eventVersion === 1 && entry.details.currentVersion === 2), true);

  const persistedSnapshot = updatedEvent.payload.record as Record<string, unknown>;
  const forgedEvent: OutboxEvent = {
    ...updatedEvent,
    payload: {
      ...updatedEvent.payload,
      record: {
        ...persistedSnapshot,
        data: { ...updated.data, privateValue: "forged-value" },
      },
    },
  };
  await assert.rejects(
    publisher.publish(forgedEvent),
    (error: unknown) => error instanceof DomainError && error.code === "EVENT_FINGERPRINT_CONFLICT",
  );
  assert.equal(deliveries, 0);

  await publisher.publish(updatedEvent);
  assert.equal(deliveries, 1);
});

test("ordinary route delivery never reaches the network when point-of-egress consent authorization fails", async () => {
  const record = {
    id: "consent-egress-1",
    tenantId: actor.tenantId,
    collection: "projects",
    processingPurpose: actor.purpose,
    ownerActorId: actor.actorId,
    participantIds: ["participant-egress-1"],
    containsMinor: false,
    data: { batchId: "B01", operationMode: "resource", state: "ready" },
    version: 1,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    deletedAt: null,
  };
  const event: OutboxEvent = {
    id: "outbox-consent-egress-1",
    tenantId: actor.tenantId,
    aggregateType: record.collection,
    aggregateId: record.id,
    eventType: "projects.created",
    payload: { record },
    status: "leased",
    attempts: 1,
    availableAt: "2026-08-20T00:00:00.000Z",
    leaseOwner: "worker-consent-egress",
    leaseUntil: "2026-08-20T00:01:00.000Z",
    createdAt: "2026-08-20T00:00:00.000Z",
    publishedAt: null,
    lastError: null,
  };
  let deliveries = 0;
  const consentDeniedRuntime = {
    getRecord() {
      throw new DomainError("CONSENT_REQUIRED", "participant consent was withdrawn");
    },
  } as unknown as LifeTimeMachineRuntime;
  const publisher = new ProductionRoutePublisher(consentDeniedRuntime, actor, {}, {
    async send() {
      deliveries += 1;
      throw new Error("network delivery must not run");
    },
  });
  await assert.rejects(
    publisher.publish(event),
    (error: unknown) => error instanceof DomainError && error.code === "CONSENT_REQUIRED",
  );
  assert.equal(deliveries, 0);
});

test("production worker configuration requires all routes, batches, managed secrets, and signed consent authority", (testContext) => {
  assert.equal(EXTERNAL_COMMAND_CALLBACK_ROUTES.length, 19);
  assert.equal(new Set(EXTERNAL_COMMAND_CALLBACK_ROUTES.map((route) => route.batchId)).size, 18);
  assert.deepEqual(
    EXTERNAL_COMMAND_CALLBACK_ROUTES.filter((route) => route.batchId === "B10").map((route) => route.operation),
    ["publishExport", "revokeExport"],
  );
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
    ...productionConsentPolicyEnvironment(testContext),
    LTM_EXTERNAL_COMMAND_ADAPTERS_JSON: JSON.stringify(Object.fromEntries(batches.map((batch) => [batch, adapter]))),
    LTM_OUTBOX_ROUTE_ADAPTERS_JSON: JSON.stringify(Object.fromEntries(
      ["media", "notification", "fulfillment", "integration", "data"].map((route) => [route, adapter]),
    )),
  }, "/tmp/ltm-product");
  assert.equal(Object.keys(configuration.externalCommandAdapters).length, 18);
  assert.equal(Object.keys(configuration.routeAdapters).length, 5);
  assert.deepEqual(configuration.actor.roles, ["service_account"]);
  assert.equal(configuration.actor.permissions?.includes("outbox:publish"), true);
  assert.equal(configuration.actor.permissions?.includes("record:purpose:cross"), true);
  assert.equal(configuration.deploymentProfile, "distributed");
  assert.equal(configuration.postgresRuntimeOptions?.applicationName, "ltm-worker");
  assert.equal(configuration.postgresRuntimeOptions?.consentPolicyJurisdiction, "CN");
  assert.equal(configuration.postgresRuntimeOptions?.consentPolicyLocale, "zh-CN");
  assert.equal(configuration.postgresRuntimeOptions?.allowLegacyConsentPolicy, undefined);

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

  assert.throws(() => loadWorkerConfiguration({
    APP_ENV: "development",
    LTM_WORKER_TENANT_ID: "tenant-development",
    LTM_EXTERNAL_COMMAND_ADAPTERS_JSON: JSON.stringify({ B999: adapter }),
  }, "/tmp/ltm-product"), /unknown external command batches: B999/);

  assert.throws(() => loadWorkerConfiguration({
    APP_ENV: "development",
    LTM_WORKER_TENANT_ID: "tenant-development",
    LTM_OUTBOX_ROUTE_ADAPTERS_JSON: JSON.stringify({
      media: { ...adapter, endpoint: "https://integrations.example.test/ltm?route=v1" },
    }),
  }, "/tmp/ltm-product"), /must not contain a query string/);
});

test("development worker opens a ready runtime in explicit legacy-only consent mode", async (testContext) => {
  const configuration = loadWorkerConfiguration({
    APP_ENV: "development",
    LTM_DEPLOYMENT_PROFILE: "single-node",
    LTM_DATABASE_PATH: ":memory:",
    LTM_WORKER_TENANT_ID: "tenant-development-ready",
  }, "/tmp/ltm-product");
  assert.equal(configuration.runtimeOptions.allowLegacyConsentPolicy, true);
  const runtime = new LifeTimeMachineRuntime(configuration.runtimeOptions);
  testContext.after(() => runtime.close());
  assert.deepEqual(await runtime.readiness(), {
    ready: true,
    database: "ok",
    auditChain: "ok",
    evidenceTrust: "disabled",
    consentPolicy: "legacy_test_only",
  });
});

test("worker health is public while metrics require a hashed bearer token", async (testContext) => {
  const token = "synthetic-worker-metrics-token";
  const digest = (await import("node:crypto")).createHash("sha256").update(token).digest("hex");
  const metrics = new WorkerMetrics(new Date("2026-08-20T00:00:00.000Z"));
  metrics.record({ published: 3, failed: 1 }, new Date("2026-08-20T00:01:00.000Z"));
  const server = createWorkerHealthServer({
    readiness: async () => ({
      ready: true,
      database: "ok",
      auditChain: "ok",
      evidenceTrust: "disabled",
      consentPolicy: "legacy_test_only",
    }),
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

function productionConsentPolicyEnvironment(testContext: { after(callback: () => void): void }): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), "ltm-worker-consent-"));
  testContext.after(() => rmSync(directory, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const catalog = signConsentPolicyCatalog({
    schemaVersion: "ltm.consent-policy-catalog.v1",
    catalogId: "worker-production-policy-1",
    issuer: "privacy-policy-authority",
    environment: "production",
    issuedAt,
    expiresAt,
    algorithm: "Ed25519",
    keyId: "worker-consent-key-1",
    policies: [{
      policyVersion: "worker-policy-v1",
      purpose: "external_provider_delivery",
      locale: "zh-CN",
      jurisdictions: ["CN"],
      resourceKinds: ["record"],
      allowedActions: ["read"],
      grantorCapacities: ["self"],
      minorApplicability: "all",
      disclosureSha256: "d".repeat(64),
      effectiveFrom: issuedAt,
      effectiveUntil: expiresAt,
      maxConsentLifetimeSeconds: 3_600,
    }],
  }, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const path = join(directory, "consent-policy.json");
  writeFileSync(path, JSON.stringify(catalog), { mode: 0o600 });
  return {
    LTM_CONSENT_POLICY_CATALOG_FILE: path,
    LTM_CONSENT_POLICY_TRUST_KEYS_JSON: JSON.stringify([{
      keyId: "worker-consent-key-1",
      issuer: "privacy-policy-authority",
      algorithm: "Ed25519",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedEnvironments: ["production"],
      notBefore: issuedAt,
      notAfter: expiresAt,
    }]),
    LTM_CONSENT_POLICY_JURISDICTION: "CN",
    LTM_CONSENT_POLICY_LOCALE: "zh-CN",
  };
}
