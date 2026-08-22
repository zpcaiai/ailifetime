import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@ltm/core";
import type { JsonObject, RecordEnvelope, VerifiedBusinessEvent } from "@ltm/core";
import {
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
    correlationId: "correlation-1",
    artifactSha256: digest,
    evidenceId: "evidence-1",
    evidenceScope: `ltm-evidence:v1:${digest}`,
    canonicalClaims: { placeholder: true },
    canonicalClaimsSha256: digest,
    businessEventSha256: digest,
    ...overrides,
  };
}

function record(collection: string, id: string, data: JsonObject): RecordEnvelope {
  return {
    id,
    tenantId: "tenant-1",
    collection,
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
  assert.deepEqual(listExternalBusinessEventReducerRoutes(), [
    "B100:recordInventoryAdjustment",
    "B101:createReturnOrClaim",
    "B102:publishVendorScorecard",
    "B66:verifyStoreTransaction",
    "B71:recordWechatCommercialAction",
    "B74:scheduleMultiChannelNotification",
    "B89:requestTaxDocument",
    "B98:createVendorProductionJob",
    "B99:recordShipment",
  ]);
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
  const current = record("notification.delivery-commands", "notification-1", {
    providerId: "ses",
    state: "acknowledged",
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
  const vendorCommand = record("supply.vendor-production-commands", "job-1", {
    state: "requested",
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
  const claimCommand = record("supply.return-claim-commands", "claim-1", {
    state: "requested",
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
    const current = record(routeCase.collection, callback.subjectId, {
      state: "requested",
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
  const issued = record("finance.tax-document-commands", "invoice-1", {
    state: "issued",
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
