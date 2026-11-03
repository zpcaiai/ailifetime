import assert from "node:assert/strict";
import test from "node:test";
import {
  DomainError,
  EXTERNAL_COMMAND_CALLBACK_ROUTES,
  EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES,
} from "@ltm/core";
import type { ExternalCommandCallbackRoute, JsonObject, JsonValue, RecordEnvelope, VerifiedBusinessEvent } from "@ltm/core";
import {
  EXTERNAL_EVENT_REDUCER_TARGET_COLLECTIONS,
  externalBusinessEventReducerRegistry,
  listExternalBusinessEventReducerRoutes,
  reduceVerifiedBusinessEvent,
} from "./external-business-event-reducers.js";

const digest = "a".repeat(64);

function event(overrides: Partial<VerifiedBusinessEvent> & Pick<VerifiedBusinessEvent, "batchId" | "operation" | "provider" | "subjectType" | "subjectId" | "eventType">): VerifiedBusinessEvent {
  return {
    version: "ltm.external-business-event.v1",
    eventId: "provider-event-1",
    tenantId: "tenant-1",
    providerOccurredAt: "2026-08-20T01:02:03.000Z",
    sequence: 1,
    correlationId: overrides.correlationId ?? overrides.subjectId,
    artifactSha256: digest,
    evidenceId: "evidence-1",
    evidenceScope: `ltm-evidence:v1:${digest}`,
    canonicalClaims: { placeholder: true },
    canonicalClaimsSha256: digest,
    businessEventSha256: digest,
    ...overrides,
  };
}

function callbackProvider(route: ExternalCommandCallbackRoute): { readonly provider: string; readonly recordData: JsonObject } {
  const binding = route.providerBinding;
  if (binding.kind === "exact") return { provider: binding.provider, recordData: {} };
  if (binding.kind === "record-field") {
    return { provider: `${binding.prefix}provider-1`, recordData: { [binding.field]: "provider-1" } };
  }
  return {
    provider: `${binding.allowedTypes[0]}:provider-1`,
    recordData: { [binding.typeField]: binding.allowedTypes[0] as string, [binding.idField]: "provider-1" },
  };
}

function commandRecord(route: ExternalCommandCallbackRoute, id: string, data: JsonObject = {}): RecordEnvelope {
  return record(route.collection, id, {
    batchId: route.batchId,
    operation: route.operation,
    operationMode: "external-command",
    externalCommandId: id,
    ...data,
  });
}

function callbackRoute(batchId: string): ExternalCommandCallbackRoute {
  const route = EXTERNAL_COMMAND_CALLBACK_ROUTES.find((candidate) => candidate.batchId === batchId);
  assert.ok(route);
  return route;
}

function record(collection: string, id: string, data: JsonObject): RecordEnvelope {
  return {
    id,
    tenantId: "tenant-1",
    collection,
    processingPurpose: "external_provider_delivery",
    ownerActorId: null,
    participantIds: [],
    containsMinor: false,
    data,
    version: 1,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    deletedAt: null,
  };
}

test("external business registry covers every first-wave authoritative reducer exactly once", () => {
  assert.deepEqual([...EXTERNAL_EVENT_REDUCER_TARGET_COLLECTIONS].sort(), [
    "commerce.store-entitlements",
    "commerce.wechat-payments",
    "supply.inventory-balances",
    "supply.shipments",
    "supply.vendor-scorecards",
  ]);
  const expected = [
    ...EXTERNAL_COMMAND_CALLBACK_ROUTES.map((route) => `${route.batchId}:${route.operation}`),
    "B66:verifyStoreTransaction",
    "B71:recordWechatCommercialAction",
    "B99:recordShipment",
    "B100:recordInventoryAdjustment",
    "B102:publishVendorScorecard",
  ].sort();
  assert.deepEqual(listExternalBusinessEventReducerRoutes(), expected);
});

test("B14 publishes only exact-plan images with separate stored source/output-bound quality and safety", () => {
  const route = callbackRoute("B14"), id = "timeline-1";
  const current = commandRecord(route, id, { sourceAssetId: "source", targetAges: [5], generationPlan: { schemaVersion: "age-portrait-plan.v1" } });
  const binding = { sourceAssetId: "source", assetId: "image", targetAge: 5, outputSha256: digest };
  const scores = Object.fromEntries(["identity", "ageRange", "facialDrift", "pose", "artifacts", "clarity", "background", "handsTeethEyes", "photorealism"].map(d => [d, .9]));
  const quality = record("media.quality-decisions", "q", { batchId: "B15", executionState: "persisted", artifactBinding: binding, decision: "pass", scores, thresholds: scores });
  const safety = record("media.safety-certificates", "s", { batchId: "B17", executionState: "persisted", artifactBinding: binding, inputSafety: "allowed", outputSafety: "allowed", aiLabel: true });
  const resultManifest = { schemaVersion: "ltm.timeline-results.v1", sourceAssetId: "source", planVersion: "age-portrait-plan.v1", aiLabel: true,
    nodes: [{ nodeId: "age-5", targetAge: 5, status: "ready", qualityResultId: "q", safetyResultId: "s", asset: { id: "image", sha256: digest, mimeType: "image/png", width: 1024, height: 1024, byteLength: 1000 } }] };
  const ev = event({ batchId: "B14", operation: route.operation, provider: "generation-engine", subjectType: route.subjectType, subjectId: id, eventType: "external-command.succeeded", canonicalClaims: { providerOperationId: "op", resultManifest } });
  const context = { current, relatedRecords: { "quality-5": quality, "safety-5": safety } };
  const good = reduceVerifiedBusinessEvent(ev, context);
  assert.equal(good.reduction.patch.deliveryState, "ready");
  assert.equal(good.target.relatedRecords?.length, 2);
  for(const imageQuality of ['standard','hd']){
    const size=imageQuality==='standard'?1536:2048;
    const qualified={...current,data:{...current.data,generationPlan:{schemaVersion:'age-portrait-plan.v1',imageQuality,imageWidth:size,imageHeight:size}}};
    assert.throws(()=>reduceVerifiedBusinessEvent(ev,{...context,current:qualified}),/dimensions/);
    const matching=event({...ev,canonicalClaims:{providerOperationId:'op',resultManifest:{...resultManifest,nodes:resultManifest.nodes.map(n=>({...n,asset:{...n.asset,width:size,height:size}}))}}});
    assert.equal(reduceVerifiedBusinessEvent(matching,{...context,current:qualified}).reduction.patch.deliveryState,'ready');
  }
  assert.throws(() => reduceVerifiedBusinessEvent(ev, { current, relatedRecords: {} }), /evidence is missing/);
  assert.throws(() => reduceVerifiedBusinessEvent(ev, { ...context, relatedRecords: { ...context.relatedRecords, "quality-5": { ...quality, data: { ...quality.data, decision: "reject" } } } }), /quality and safety/);
  assert.throws(() => reduceVerifiedBusinessEvent({ ...ev, canonicalClaims: { ...ev.canonicalClaims, resultManifest: { ...resultManifest, sourceAssetId: "wrong" } } }, context), /original plan/);
});

test("B14 couple publication requires both stored participant assessments", () => {
  const route = callbackRoute("B14"), id = "pair-timeline", participantIds = ["left", "right"];
  const current = { ...commandRecord(route, id, { sourceAssetId: "source", targetAges: [37], generationPlan: { schemaVersion: "age-portrait-plan.v1" } }), participantIds };
  const binding = { sourceAssetId: "source", assetId: "image", targetAge: 37, outputSha256: digest };
  const scores = Object.fromEntries(["identity", "ageRange", "facialDrift", "pose", "artifacts", "clarity", "background", "handsTeethEyes", "photorealism"].map(d => [d, .9]));
  const assessments = participantIds.map(participantId => ({ participantId, scores: { identity: .9, ageRange: .9, facialDrift: .9 }, thresholds: { identity: .8, ageRange: .8, facialDrift: .8 } }));
  const quality = { ...record("media.quality-decisions", "q", { batchId: "B15", executionState: "persisted", artifactBinding: binding, decision: "pass", scores, thresholds: scores, participantAssessments: assessments }), participantIds };
  const safety = { ...record("media.safety-certificates", "s", { batchId: "B17", executionState: "persisted", artifactBinding: binding, inputSafety: "allowed", outputSafety: "allowed", aiLabel: true }), participantIds };
  const resultManifest = { schemaVersion: "ltm.timeline-results.v1", sourceAssetId: "source", planVersion: "age-portrait-plan.v1", aiLabel: true,
    nodes: [{ nodeId: "age-37", targetAge: 37, status: "ready", qualityResultId: "q", safetyResultId: "s", asset: { id: "image", sha256: digest, mimeType: "image/png", width: 1024, height: 1024, byteLength: 1000 } }] };
  const ev = event({ batchId: "B14", operation: route.operation, provider: "generation-engine", subjectType: route.subjectType, subjectId: id, eventType: "external-command.succeeded", canonicalClaims: { providerOperationId: "pair-op", resultManifest } });
  const context = { current, relatedRecords: { "quality-37": quality, "safety-37": safety } };
  assert.equal(reduceVerifiedBusinessEvent(ev, context).reduction.patch.deliveryState, "ready");
  for (const participantAssessments of [[], assessments.slice(0, 1), [assessments[0]!, { ...assessments[1]!, scores: { ...assessments[1]!.scores, identity: .2 } }]]) {
    assert.throws(() => reduceVerifiedBusinessEvent(ev, { ...context, relatedRecords: { ...context.relatedRecords, "quality-37": { ...quality, data: { ...quality.data, participantAssessments } } } }), /participant/);
  }
});

test("all 19 external command operations expose fixed signed terminal reducers and reject callback-authored authority", () => {
  assert.equal(EXTERNAL_COMMAND_CALLBACK_ROUTES.length, 19);
  const terminalCases = Object.entries(EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES) as readonly [
    "succeeded" | "failed" | "cancelled" | "compensated",
    string,
  ][];
  for (const route of EXTERNAL_COMMAND_CALLBACK_ROUTES) {
    const commandId = `${route.batchId.toLowerCase()}-command-1`;
    const authority = callbackProvider(route);
    const requiredData: Record<string, JsonValue> = { ...authority.recordData };
    const requiredClaims: Record<string, JsonValue> = { providerOperationId: `${route.batchId.toLowerCase()}-provider-operation-1` };
    for (const field of route.requiredClaimIdentifiers ?? []) {
      const value = requiredData[field] ?? `${field}-1`;
      requiredData[field] = value;
      requiredClaims[field] = value;
    }
    for (const [terminalState, eventType] of terminalCases) {
      const callback = event({
        batchId: route.batchId,
        operation: route.operation,
        provider: authority.provider,
        subjectType: route.subjectType,
        subjectId: commandId,
        eventType,
        canonicalClaims: requiredClaims,
      });
      const current = commandRecord(route, commandId, {
        ...requiredData,
        ...(terminalState === "compensated" ? { providerState: "succeeded" } : {}),
      });
      const result = reduceVerifiedBusinessEvent(callback, { current, relatedRecords: {} });
      assert.equal(result.target.collection, route.collection, route.batchId);
      assert.equal(result.target.aggregateId, commandId, route.batchId);
      assert.equal(result.reduction.stateField, "providerState", route.batchId);
      assert.equal(result.reduction.commandTransition?.commandId, commandId, route.batchId);
      assert.equal(result.reduction.commandTransition?.toState, terminalState, route.batchId);
      assert.equal(result.reduction.patch.providerResultSha256, digest, route.batchId);
    }

    const valid = event({
      batchId: route.batchId,
      operation: route.operation,
      provider: authority.provider,
      subjectType: route.subjectType,
      subjectId: commandId,
      eventType: EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES.succeeded,
      canonicalClaims: requiredClaims,
    });
    const current = commandRecord(route, commandId, requiredData);
    const wrongProvider = route.providerBinding.kind === "exact"
      ? `${authority.provider}-other`
      : `${authority.provider.slice(0, authority.provider.lastIndexOf(":") + 1)}other`;
    assert.throws(
      () => reduceVerifiedBusinessEvent({ ...valid, provider: wrongProvider }, { current, relatedRecords: {} }),
      (error: unknown) => error instanceof DomainError &&
        (error.code === "VALIDATION_FAILED" || error.code === "TENANT_SCOPE_MISMATCH"),
      `${route.batchId} must reject a different provider`,
    );
    assertDomainCode(() => reduceVerifiedBusinessEvent({ ...valid, correlationId: "different-command" }, {
      current,
      relatedRecords: {},
    }), "EVENT_FINGERPRINT_CONFLICT");
    for (const forbiddenClaims of [
      { collection: "attacker.records" },
      { tenantId: "tenant-other" },
      { patch: { commandState: "succeeded" } },
      { terminal: true, succeeded: true },
    ]) {
      assertDomainCode(() => reduceVerifiedBusinessEvent({
        ...valid,
        canonicalClaims: { ...valid.canonicalClaims, ...forbiddenClaims },
      }, { current, relatedRecords: {} }), "VALIDATION_FAILED");
    }
    assertDomainCode(() => reduceVerifiedBusinessEvent({
      ...valid,
      canonicalClaims: Object.fromEntries(
        Object.entries(valid.canonicalClaims).filter(([field]) => field !== "providerOperationId"),
      ),
    }, { current, relatedRecords: {} }), "VALIDATION_FAILED");
    for (const field of route.requiredClaimIdentifiers ?? []) {
      assertDomainCode(() => reduceVerifiedBusinessEvent({
        ...valid,
        canonicalClaims: { ...valid.canonicalClaims, [field]: `${String(valid.canonicalClaims[field])}-other` },
      }, { current, relatedRecords: {} }), "TENANT_SCOPE_MISMATCH");
    }
    assertDomainCode(() => reduceVerifiedBusinessEvent(valid, {
      current: commandRecord(route, `${commandId}-other`, requiredData),
      relatedRecords: {},
    }), "EVENT_FINGERPRINT_CONFLICT");
  }
});

test("shipment reducer exposes a fail-closed out-of-order state graph", () => {
  const delivered = event({
    batchId: "B99",
    operation: "recordShipment",
    provider: "carrier:ups",
    subjectType: "shipment",
    subjectId: "shipment-1",
    eventType: "shipment.delivered",
    canonicalClaims: {
      carrierTrackingRef: "tracking-1",
      vendorId: "vendor-1",
      vendorJobId: "vendor-job-1",
    },
  });
  const vendorJob = record("supply.vendor-production-commands", "vendor-job-1", {
    state: "shipped",
    vendorId: "vendor-1",
  });
  const result = reduceVerifiedBusinessEvent(delivered, { current: null, relatedRecords: { vendorJob } });
  assert.equal(result.target.collection, "supply.shipments");
  assert.equal(result.reduction.nextState, "delivered");
  assert.deepEqual(result.reduction.allowedPriorStates, ["in_transit", "out_for_delivery"]);
  assert.equal(result.reduction.allowedPriorStates.includes("label_created"), false);

  const wrongProvider = { ...delivered, provider: "vendor:ups" };
  assertDomainCode(() => result.reducer.locate(wrongProvider), "VALIDATION_FAILED");
  assertDomainCode(() => reduceVerifiedBusinessEvent(delivered, {
    current: null,
    relatedRecords: {
      vendorJob: record("supply.vendor-production-commands", "vendor-job-1", {
        state: "shipped",
        vendorId: "vendor-2",
      }),
    },
  }), "TENANT_SCOPE_MISMATCH");
});

test("inventory reducer computes locked balances and rejects callback-authored totals", () => {
  const adjustment = event({
    batchId: "B100",
    operation: "recordInventoryAdjustment",
    provider: "vendor:fulfiller",
    subjectType: "inventory-item",
    subjectId: "warehouse-1:sku-1",
    eventType: "inventory.adjusted",
    canonicalClaims: {
      vendorId: "fulfiller",
      sku: "sku-1",
      warehouseId: "warehouse-1",
      quantityDelta: 5,
      reservationDelta: 2,
      adjustmentReason: "receipt",
    },
  });
  const current = record("supply.inventory-balances", adjustment.subjectId, {
    state: "available",
    vendorId: "fulfiller",
    onHandQuantity: 10,
    reservedQuantity: 3,
  });
  const result = reduceVerifiedBusinessEvent(adjustment, { current, relatedRecords: {} });
  assert.equal(result.reduction.patch.onHandQuantity, 15);
  assert.equal(result.reduction.patch.reservedQuantity, 5);
  assert.equal(result.reduction.patch.availableQuantity, 10);

  assertDomainCode(() => reduceVerifiedBusinessEvent({
    ...adjustment,
    canonicalClaims: { ...adjustment.canonicalClaims, availableAfter: 999 },
  }, { current, relatedRecords: {} }), "VALIDATION_FAILED");

  assertDomainCode(() => reduceVerifiedBusinessEvent({
    ...adjustment,
    canonicalClaims: { ...adjustment.canonicalClaims, quantityDelta: -11, reservationDelta: 0 },
  }, { current, relatedRecords: {} }), "VERSION_CONFLICT");

  assertDomainCode(() => reduceVerifiedBusinessEvent({
    ...adjustment,
    provider: "vendor:other",
  }, { current, relatedRecords: {} }), "TENANT_SCOPE_MISMATCH");

  assertDomainCode(() => reduceVerifiedBusinessEvent(adjustment, {
    current: record("supply.inventory-balances", adjustment.subjectId, {
      state: "available",
      vendorId: "other",
      onHandQuantity: 10,
      reservedQuantity: 3,
    }),
    relatedRecords: {},
  }), "TENANT_SCOPE_MISMATCH");
});

test("vendor scorecard derives counters only from a locked projected fact", () => {
  const scorecardEvent = event({
    batchId: "B102",
    operation: "publishVendorScorecard",
    provider: "vendor:vendor-1",
    subjectType: "vendor",
    subjectId: "vendor-1",
    eventType: "scorecard.shipment",
    canonicalClaims: { projectedFactId: "shipment-1" },
  });
  const projectedShipment = record("supply.shipments", "shipment-1", {
    vendorId: "vendor-1",
    state: "delivered",
    onTime: true,
  });
  const result = reduceVerifiedBusinessEvent(scorecardEvent, {
    current: record("supply.vendor-scorecards", "vendor-1", {
      state: "current",
      totalShipments: 4,
      onTimeShipments: 3,
      completedJobs: 2,
      claimsOpened: 1,
      claimsResolved: 1,
      settlementsCompleted: 1,
      processedFactIds: [],
    }),
    relatedRecords: { fact: projectedShipment },
  });
  assert.equal(result.reduction.patch.totalShipments, 5);
  assert.equal(result.reduction.patch.onTimeShipments, 4);
  assert.equal(result.reduction.patch.onTimeRateBasisPoints, 8_000);

  assertDomainCode(() => reduceVerifiedBusinessEvent({
    ...scorecardEvent,
    canonicalClaims: { projectedFactId: "shipment-1", score: 100 },
  }, { current: null, relatedRecords: { fact: projectedShipment } }), "VALIDATION_FAILED");
  assertDomainCode(() => reduceVerifiedBusinessEvent(scorecardEvent, {
    current: null,
    relatedRecords: {},
  }), "RESOURCE_NOT_FOUND");
});

test("command callback reducers select fixed command IDs and terminal transitions", () => {
  const callback = event({
    batchId: "B74",
    operation: "scheduleMultiChannelNotification",
    provider: "notification:ses",
    subjectType: "notification",
    subjectId: "notification-1",
    eventType: "notification.delivered",
    canonicalClaims: { providerOperationId: "ses-message-1" },
  });
  const reducer = externalBusinessEventReducerRegistry.resolve(callback);
  assert.ok(reducer);
  const current = commandRecord(callbackRoute("B74"), "notification-1", {
    providerId: "ses",
    providerState: "acknowledged",
  });
  const result = reducer.reduce(callback, { current, relatedRecords: {} });
  assert.equal(result.nextState, "delivered");
  assert.equal(result.commandTransition?.commandId, "notification-1");
  assert.equal(result.commandTransition?.toState, "succeeded");

  assertDomainCode(() => reducer.reduce({ ...callback, provider: "notification:other" }, {
    current,
    relatedRecords: {},
  }), "TENANT_SCOPE_MISMATCH");
});

test("store entitlement and WeChat payment reducers produce provider-bound state and balanced money effects", () => {
  const entitlement = event({
    batchId: "B66",
    operation: "verifyStoreTransaction",
    provider: "apple-app-store",
    subjectType: "account",
    subjectId: "account-1",
    eventType: "entitlement.granted",
    canonicalClaims: {
      accountId: "account-1",
      productId: "life.yearly",
      transactionId: "apple-transaction-1",
      originalTransactionId: "apple-original-1",
    },
  });
  const entitlementResult = reduceVerifiedBusinessEvent(entitlement, { current: null, relatedRecords: {} });
  assert.equal(entitlementResult.target.aggregateId, "account-1:life.yearly");
  assert.equal(entitlementResult.reduction.nextState, "active");
  assertDomainCode(() => reduceVerifiedBusinessEvent({ ...entitlement, provider: "wechat-pay" }, {
    current: null,
    relatedRecords: {},
    }), "VALIDATION_FAILED");

  const payment = event({
    batchId: "B71",
    operation: "recordWechatCommercialAction",
    provider: "wechat-pay",
    subjectType: "payment",
    subjectId: "payment-1",
    eventType: "payment.captured",
    canonicalClaims: {
      accountId: "account-1",
      outTradeNo: "order-1",
      providerTransactionId: "wechat-transaction-1",
      amountMinor: 8_800,
      currency: "CNY",
    },
  });
  const paymentResult = reduceVerifiedBusinessEvent(payment, { current: null, relatedRecords: {} });
  assert.equal(paymentResult.reduction.nextState, "captured");
  assert.equal(paymentResult.reduction.ledger?.lines.length, 2);
  assert.equal(paymentResult.reduction.ledger?.lines[0]?.amountMinor, 8_800);
  assert.equal(paymentResult.reduction.ledger?.lines[1]?.amountMinor, 8_800);
  assertDomainCode(() => reduceVerifiedBusinessEvent({
    ...payment,
    canonicalClaims: { ...payment.canonicalClaims, currency: "cny" },
  }, { current: null, relatedRecords: {} }), "VALIDATION_FAILED");
});

test("vendor production and return callbacks cannot cross command-provider ownership", () => {
  const vendorCallback = event({
    batchId: "B98",
    operation: "createVendorProductionJob",
    provider: "vendor:vendor-1",
    subjectType: "vendor-job",
    subjectId: "job-1",
    eventType: "vendor-job.accepted",
    canonicalClaims: { providerOperationId: "provider-job-1", vendorId: "vendor-1" },
  });
  const vendorCommand = commandRecord(callbackRoute("B98"), "job-1", {
    providerState: "requested",
    vendorId: "vendor-1",
  });
  assert.equal(reduceVerifiedBusinessEvent(vendorCallback, {
    current: vendorCommand,
    relatedRecords: {},
  }).reduction.nextState, "accepted");
  assertDomainCode(() => reduceVerifiedBusinessEvent({ ...vendorCallback, provider: "vendor:vendor-2" }, {
    current: vendorCommand,
    relatedRecords: {},
  }), "TENANT_SCOPE_MISMATCH");
  assertDomainCode(() => reduceVerifiedBusinessEvent({
    ...vendorCallback,
    canonicalClaims: { ...vendorCallback.canonicalClaims, vendorId: "vendor-2" },
  }, { current: vendorCommand, relatedRecords: {} }), "TENANT_SCOPE_MISMATCH");

  const claimCallback = event({
    batchId: "B101",
    operation: "createReturnOrClaim",
    provider: "carrier:ups",
    subjectType: "return-claim",
    subjectId: "claim-1",
    eventType: "return-claim.accepted",
    canonicalClaims: { providerOperationId: "ups-claim-1", vendorId: "vendor-1" },
  });
  const claimCommand = commandRecord(callbackRoute("B101"), "claim-1", {
    providerState: "requested",
    providerType: "carrier",
    providerId: "ups",
    vendorId: "vendor-1",
  });
  assert.equal(reduceVerifiedBusinessEvent(claimCallback, {
    current: claimCommand,
    relatedRecords: {},
  }).reduction.nextState, "accepted");
  assertDomainCode(() => reduceVerifiedBusinessEvent({ ...claimCallback, provider: "carrier:fedex" }, {
    current: claimCommand,
    relatedRecords: {},
  }), "TENANT_SCOPE_MISMATCH");
  assertDomainCode(() => reduceVerifiedBusinessEvent({
    ...claimCallback,
    canonicalClaims: { ...claimCallback.canonicalClaims, vendorId: "vendor-2" },
  }, { current: claimCommand, relatedRecords: {} }), "TENANT_SCOPE_MISMATCH");
});

test("notification and tax callbacks bind the provider selected by the requested command", () => {
  const routes = [
    {
      batchId: "B74" as const,
      operation: "scheduleMultiChannelNotification",
      provider: "notification:ses",
      wrongProvider: "notification:twilio",
      subjectType: "notification",
      eventType: "notification.acknowledged",
      collection: "notification.delivery-commands",
    },
    {
      batchId: "B89" as const,
      operation: "requestTaxDocument",
      provider: "tax-authority:avalara",
      wrongProvider: "tax-authority:other",
      subjectType: "tax-document",
      eventType: "tax-document.acknowledged",
      collection: "finance.tax-document-commands",
    },
  ];
  for (const routeCase of routes) {
    const callback = event({
      batchId: routeCase.batchId,
      operation: routeCase.operation,
      provider: routeCase.provider,
      subjectType: routeCase.subjectType,
      subjectId: `${routeCase.batchId.toLowerCase()}-command-1`,
      eventType: routeCase.eventType,
      canonicalClaims: { providerOperationId: `${routeCase.batchId.toLowerCase()}-provider-1` },
    });
    const current = commandRecord(callbackRoute(routeCase.batchId), callback.subjectId, {
      providerState: "requested",
      providerId: routeCase.provider.split(":")[1] as string,
    });
    assert.equal(reduceVerifiedBusinessEvent(callback, { current, relatedRecords: {} }).reduction.nextState, "acknowledged");
    assertDomainCode(() => reduceVerifiedBusinessEvent({ ...callback, provider: routeCase.wrongProvider }, {
      current,
      relatedRecords: {},
    }), "TENANT_SCOPE_MISMATCH");
  }
});

test("tax reissue compensates only an issued command; rejected documents require a new B89 request", () => {
  const callback = event({
    batchId: "B89",
    operation: "requestTaxDocument",
    provider: "tax-authority:avalara",
    subjectType: "tax-document",
    subjectId: "invoice-1",
    eventType: "tax-document.reissue",
    canonicalClaims: { providerOperationId: "reissue-1" },
  });
  const issued = commandRecord(callbackRoute("B89"), "invoice-1", {
    providerState: "issued",
    providerId: "avalara",
  });
  const reduction = reduceVerifiedBusinessEvent(callback, { current: issued, relatedRecords: {} }).reduction;
  assert.deepEqual(reduction.allowedPriorStates, ["issued"]);
  assert.equal(reduction.commandTransition?.toState, "compensated");
  assert.equal(reduction.allowedPriorStates.includes("rejected"), false);
});

test("vendor scorecard rejects a projected fact owned by another vendor", () => {
  const scorecardEvent = event({
    batchId: "B102",
    operation: "publishVendorScorecard",
    provider: "vendor:vendor-1",
    subjectType: "vendor",
    subjectId: "vendor-1",
    eventType: "scorecard.shipment",
    canonicalClaims: { projectedFactId: "shipment-other" },
  });
  assertDomainCode(() => reduceVerifiedBusinessEvent(scorecardEvent, {
    current: null,
    relatedRecords: {
      fact: record("supply.shipments", "shipment-other", {
        state: "delivered",
        vendorId: "vendor-2",
        onTime: true,
      }),
    },
  }), "TENANT_SCOPE_MISMATCH");
});

function assertDomainCode(action: () => unknown, code: DomainError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof DomainError && error.code === code);
}
