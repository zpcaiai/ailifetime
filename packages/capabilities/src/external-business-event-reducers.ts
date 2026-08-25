import {
  DomainError,
  EXTERNAL_COMMAND_CALLBACK_ROUTES,
  EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES,
  externalCommandCallbackProviderAllowed,
} from "@ltm/core";
import type {
  ExternalBusinessAggregateTarget,
  ExternalBusinessEventReducer,
  ExternalBusinessEventReducerRegistry,
  ExternalBusinessReducerContext,
  ExternalBusinessReduction,
  JsonObject,
  JsonValue,
  ExternalCommandCallbackRoute,
  VerifiedBusinessEvent,
} from "@ltm/core";

type BatchOperation = `${VerifiedBusinessEvent["batchId"]}:${string}`;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;
const SPECIALIZED_COMMAND_BATCHES = new Set(["B74", "B89", "B98", "B101"]);

export const EXTERNAL_EVENT_REDUCER_TARGET_COLLECTION = Object.freeze({
  storeEntitlements: "commerce.store-entitlements",
  wechatPayments: "commerce.wechat-payments",
  shipments: "supply.shipments",
  inventoryBalances: "supply.inventory-balances",
  vendorScorecards: "supply.vendor-scorecards",
} as const);

/** Collections whose writes are owned exclusively by signed external-event reducers. */
export const EXTERNAL_EVENT_REDUCER_TARGET_COLLECTIONS = Object.freeze(
  Object.values(EXTERNAL_EVENT_REDUCER_TARGET_COLLECTION),
);

interface RoutedReducer extends ExternalBusinessEventReducer {
  readonly batchId: VerifiedBusinessEvent["batchId"];
  readonly operation: string;
}

/**
 * Compile-time business reducers. Provider callbacks never supply a collection,
 * patch, state transition, command transition, or ledger posting.
 */
const reducers: readonly RoutedReducer[] = [
  entitlementReducer(),
  wechatPaymentReducer(),
  ...EXTERNAL_COMMAND_CALLBACK_ROUTES
    .filter((definition) => !SPECIALIZED_COMMAND_BATCHES.has(definition.batchId))
    .map(genericTerminalCommandReducer),
  notificationReducer(),
  taxDocumentReducer(),
  vendorJobReducer(),
  shipmentReducer(),
  inventoryReducer(),
  returnClaimReducer(),
  vendorScorecardReducer(),
];

const reducerByRoute = new Map<BatchOperation, RoutedReducer>(
  reducers.map((reducer) => [`${reducer.batchId}:${reducer.operation}` as BatchOperation, reducer]),
);

export const externalBusinessEventReducerRegistry: ExternalBusinessEventReducerRegistry = Object.freeze({
  resolve(event: VerifiedBusinessEvent): ExternalBusinessEventReducer | undefined {
    return reducerByRoute.get(`${event.batchId}:${event.operation}` as BatchOperation);
  },
});

export interface ReducedVerifiedBusinessEvent {
  readonly reducer: ExternalBusinessEventReducer;
  readonly target: ExternalBusinessAggregateTarget;
  readonly reduction: ExternalBusinessReduction;
}

/** Useful for application wiring and tests; runtime execution uses the same registry object. */
export function reduceVerifiedBusinessEvent(
  event: VerifiedBusinessEvent,
  context: ExternalBusinessReducerContext,
): ReducedVerifiedBusinessEvent {
  const reducer = externalBusinessEventReducerRegistry.resolve(event);
  if (reducer === undefined) {
    throw invalid("No trusted reducer is registered for the external business event", {
      batchId: event.batchId,
      operation: event.operation,
    });
  }
  return {
    reducer,
    target: reducer.locate(event),
    reduction: reducer.reduce(event, context),
  };
}

export function listExternalBusinessEventReducerRoutes(): readonly BatchOperation[] {
  return [...reducerByRoute.keys()].sort();
}

function entitlementReducer(): RoutedReducer {
  const batchId = "B66" as const;
  const operation = "verifyStoreTransaction";
  return {
    name: "store-entitlement-v1",
    batchId,
    operation,
    locate(event) {
      route(event, batchId, operation, ["apple-app-store", "google-play"], "account");
      const productId = claimIdentifier(event, "productId");
      return target(EXTERNAL_EVENT_REDUCER_TARGET_COLLECTION.storeEntitlements, `${event.subjectId}:${productId}`, event.subjectId);
    },
    reduce(event) {
      route(event, batchId, operation, ["apple-app-store", "google-play"], "account");
      const productId = claimIdentifier(event, "productId");
      const transactionId = claimIdentifier(event, "transactionId");
      const originalTransactionId = optionalClaimIdentifier(event, "originalTransactionId");
      const expiresAt = optionalClaimTimestamp(event, "expiresAt");
      const mapping: Readonly<Record<string, { readonly allowed: readonly (string | null)[]; readonly next: string }>> = {
        "entitlement.granted": { allowed: [null, "expired", "revoked", "refunded", "cancelled"], next: "active" },
        "entitlement.renewed": { allowed: ["active", "grace", "on_hold", "cancelled"], next: "active" },
        "entitlement.billing_retry": { allowed: ["active", "grace"], next: "grace" },
        "entitlement.grace": { allowed: ["active", "grace"], next: "grace" },
        "entitlement.on_hold": { allowed: ["active", "grace", "on_hold"], next: "on_hold" },
        "entitlement.cancelled": { allowed: ["active", "grace", "on_hold", "cancelled"], next: "cancelled" },
        "entitlement.expired": { allowed: ["active", "grace", "on_hold", "cancelled", "expired"], next: "expired" },
        "entitlement.refunded": { allowed: ["active", "grace", "on_hold", "cancelled", "expired"], next: "refunded" },
        "entitlement.revoked": { allowed: ["active", "grace", "on_hold", "cancelled", "expired", "refunded"], next: "revoked" },
        "entitlement.restored": { allowed: ["refunded", "revoked", "expired"], next: "active" },
      };
      const transition = knownEvent(event, mapping);
      return reduction(event, transition.allowed, transition.next, "entitlement-provider-decision", {
        accountId: event.subjectId,
        productId,
        transactionId,
        ...(originalTransactionId === undefined ? {} : { originalTransactionId }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        entitlementProvider: event.provider,
      });
    },
  };
}

function wechatPaymentReducer(): RoutedReducer {
  const batchId = "B71" as const;
  const operation = "recordWechatCommercialAction";
  return {
    name: "wechat-payment-v1",
    batchId,
    operation,
    locate(event) {
      route(event, batchId, operation, ["wechat-pay"], "payment");
      return target(EXTERNAL_EVENT_REDUCER_TARGET_COLLECTION.wechatPayments, event.subjectId, claimIdentifier(event, "accountId"));
    },
    reduce(event) {
      route(event, batchId, operation, ["wechat-pay"], "payment");
      const amountMinor = claimInteger(event, "amountMinor", 1);
      const currency = claimString(event, "currency", CURRENCY);
      const outTradeNo = claimIdentifier(event, "outTradeNo");
      const providerTransactionId = optionalClaimIdentifier(event, "providerTransactionId");
      const mapping: Readonly<Record<string, { readonly allowed: readonly (string | null)[]; readonly next: string }>> = {
        "payment.captured": { allowed: [null, "pending"], next: "captured" },
        "payment.refunded": { allowed: ["captured", "refunded"], next: "refunded" },
        "payment.cancelled": { allowed: [null, "pending", "captured"], next: "cancelled" },
        "payment.revoked": { allowed: ["captured", "refunded", "cancelled"], next: "revoked" },
      };
      const transition = knownEvent(event, mapping);
      const base = reduction(event, transition.allowed, transition.next, "wechat-payment-provider-decision", {
        accountId: claimIdentifier(event, "accountId"),
        outTradeNo,
        amountMinor,
        currency,
        ...(providerTransactionId === undefined ? {} : { providerTransactionId }),
      });
      if (event.eventType === "payment.captured") {
        return {
          ...base,
          ledger: balancedLedger(
            `wechat-capture:${event.eventId}`,
            "wechat-payment-capture",
            event.eventId,
            event.providerOccurredAt,
            amountMinor,
            currency,
            "payment-clearing",
            "deferred-revenue",
          ),
        };
      }
      if (event.eventType === "payment.refunded") {
        return {
          ...base,
          ledger: balancedLedger(
            `wechat-refund:${event.eventId}`,
            "wechat-payment-refund",
            event.eventId,
            event.providerOccurredAt,
            amountMinor,
            currency,
            "customer-refunds",
            "payment-clearing",
          ),
        };
      }
      return base;
    },
  };
}

function genericTerminalCommandReducer(routeDefinition: ExternalCommandCallbackRoute): RoutedReducer {
  return commandReducer({
    name: `external-command-terminal-${routeDefinition.batchId.toLowerCase()}-v1`,
    route: routeDefinition,
    decisionType: "external-command-provider-decision",
    mapping: {},
  });
}

function commandCallbackRoute(batchId: string): ExternalCommandCallbackRoute {
  const routeDefinition = EXTERNAL_COMMAND_CALLBACK_ROUTES.find((candidate) => candidate.batchId === batchId);
  if (routeDefinition === undefined) {
    throw new DomainError("INTERNAL_ERROR", `Missing external-command callback route for ${batchId}`);
  }
  return routeDefinition;
}

function notificationReducer(): RoutedReducer {
  return commandReducer({
    name: "notification-delivery-v1",
    route: commandCallbackRoute("B74"),
    decisionType: "notification-provider-decision",
    mapping: {
      // Worker dispatch owns requested -> dispatched -> acknowledged. The signed
      // provider callback projects delivery state without replaying that edge.
      "notification.acknowledged": { allowed: [null, "requested"], next: "acknowledged" },
      "notification.delivered": { allowed: ["acknowledged"], next: "delivered", command: "succeeded" },
      "notification.failed": { allowed: [null, "requested", "acknowledged"], next: "failed", command: "failed" },
      "notification.suppressed": { allowed: [null, "requested", "acknowledged"], next: "suppressed", command: "cancelled" },
    },
  });
}

function taxDocumentReducer(): RoutedReducer {
  return commandReducer({
    name: "tax-document-v1",
    route: commandCallbackRoute("B89"),
    decisionType: "tax-document-provider-decision",
    mapping: {
      "tax-document.acknowledged": { allowed: [null, "requested"], next: "acknowledged" },
      "tax-document.issued": { allowed: ["acknowledged", "reissue"], next: "issued", command: "succeeded" },
      "tax-document.rejected": { allowed: [null, "requested", "acknowledged"], next: "rejected", command: "failed" },
      // Only an issued document can compensate the succeeded command. A rejected
      // document must be retried as a new B89 request with a new command ID.
      "tax-document.reissue": { allowed: ["issued"], next: "reissue", command: "compensated" },
      "tax-document.red_letter": { allowed: [null, "requested", "acknowledged", "reissue"], next: "red_letter", command: "failed" },
    },
  });
}

function vendorJobReducer(): RoutedReducer {
  return commandReducer({
    name: "vendor-production-job-v1",
    route: commandCallbackRoute("B98"),
    decisionType: "vendor-job-provider-decision",
    mapping: {
      "vendor-job.accepted": { allowed: [null, "requested"], next: "accepted" },
      "vendor-job.rejected": { allowed: [null, "requested"], next: "rejected", command: "failed" },
      "vendor-job.scheduled": { allowed: ["accepted"], next: "scheduled" },
      "vendor-job.production": { allowed: ["scheduled"], next: "production" },
      "vendor-job.qc": { allowed: ["production"], next: "qc" },
      "vendor-job.shipped": { allowed: ["qc"], next: "shipped", command: "succeeded" },
      "vendor-job.failed": { allowed: ["accepted", "scheduled", "production", "qc"], next: "failed", command: "failed" },
    },
  });
}

function shipmentReducer(): RoutedReducer {
  const batchId = "B99" as const;
  const operation = "recordShipment";
  const mapping: Readonly<Record<string, { readonly allowed: readonly (string | null)[]; readonly next: string }>> = {
    "shipment.label_created": { allowed: [null], next: "label_created" },
    "shipment.picked_up": { allowed: ["label_created"], next: "picked_up" },
    "shipment.in_transit": { allowed: ["picked_up", "delayed"], next: "in_transit" },
    "shipment.delayed": { allowed: ["picked_up", "in_transit", "out_for_delivery", "delayed"], next: "delayed" },
    "shipment.out_for_delivery": { allowed: ["in_transit", "delayed"], next: "out_for_delivery" },
    "shipment.delivered": { allowed: ["in_transit", "out_for_delivery"], next: "delivered" },
    "shipment.exception": { allowed: ["picked_up", "in_transit", "delayed", "out_for_delivery"], next: "exception" },
    "shipment.returned": { allowed: ["delivered", "exception"], next: "returned" },
    "shipment.cancelled": { allowed: [null, "label_created"], next: "cancelled" },
  };
  return {
    name: "shipment-state-graph-v1",
    batchId,
    operation,
    locate(event) {
      routePrefix(event, batchId, operation, "carrier:", "shipment");
      return {
        ...target(EXTERNAL_EVENT_REDUCER_TARGET_COLLECTION.shipments, event.subjectId),
        relatedRecords: [{
          key: "vendorJob",
          collection: "supply.vendor-production-commands",
          id: claimIdentifier(event, "vendorJobId"),
          required: true,
          lock: "share",
        }],
      };
    },
    reduce(event, context) {
      routePrefix(event, batchId, operation, "carrier:", "shipment");
      const transition = knownEvent(event, mapping);
      const vendorId = claimIdentifier(event, "vendorId");
      const vendorJob = context.relatedRecords.vendorJob;
      if (vendorJob === undefined || vendorJob === null || vendorJob.id !== claimIdentifier(event, "vendorJobId") ||
          vendorJob.data.vendorId !== vendorId) {
        throw new DomainError("TENANT_SCOPE_MISMATCH", "Shipment callback vendor does not match its projected vendor job");
      }
      return reduction(event, transition.allowed, transition.next, "carrier-shipment-decision", {
        vendorId,
        vendorJobId: vendorJob.id,
        carrierTrackingRef: claimIdentifier(event, "carrierTrackingRef"),
        ...(optionalClaimString(event, "locationCode") === undefined
          ? {}
          : { locationCode: optionalClaimString(event, "locationCode") as string }),
      });
    },
  };
}

function inventoryReducer(): RoutedReducer {
  const batchId = "B100" as const;
  const operation = "recordInventoryAdjustment";
  return {
    name: "inventory-balance-v1",
    batchId,
    operation,
    locate(event) {
      routePrefix(event, batchId, operation, "vendor:", "inventory-item");
      rejectClaims(event, ["availableAfter", "onHandAfter", "reservedAfter"]);
      assertVendorAuthority(event, claimIdentifier(event, "vendorId"));
      return target(EXTERNAL_EVENT_REDUCER_TARGET_COLLECTION.inventoryBalances, event.subjectId);
    },
    reduce(event, context) {
      routePrefix(event, batchId, operation, "vendor:", "inventory-item");
      rejectClaims(event, ["availableAfter", "onHandAfter", "reservedAfter"]);
      const vendorId = claimIdentifier(event, "vendorId");
      assertVendorAuthority(event, vendorId);
      const persistedVendorId = context.current?.data.vendorId;
      if (persistedVendorId !== undefined && persistedVendorId !== vendorId) {
        throw new DomainError("TENANT_SCOPE_MISMATCH", "Inventory aggregate belongs to a different vendor");
      }
      const quantityDelta = claimInteger(event, "quantityDelta", -1_000_000_000, 1_000_000_000);
      const reservationDelta = optionalClaimInteger(event, "reservationDelta", -1_000_000_000, 1_000_000_000) ?? 0;
      if (quantityDelta === 0 && reservationDelta === 0) {
        throw invalid("Inventory event must change on-hand or reserved quantity");
      }
      const currentOnHand = currentInteger(context, "onHandQuantity", 0);
      const currentReserved = currentInteger(context, "reservedQuantity", 0);
      const onHandQuantity = safeSum(currentOnHand, quantityDelta, "onHandQuantity");
      const reservedQuantity = safeSum(currentReserved, reservationDelta, "reservedQuantity");
      const availableQuantity = safeSum(onHandQuantity, -reservedQuantity, "availableQuantity");
      if (onHandQuantity < 0 || reservedQuantity < 0 || availableQuantity < 0) {
        throw new DomainError("VERSION_CONFLICT", "Inventory adjustment would create a negative locked balance", {
          details: { currentOnHand, currentReserved, quantityDelta, reservationDelta },
        });
      }
      return reduction(event, [null, "available", "depleted"], availableQuantity === 0 ? "depleted" : "available", "inventory-balance-decision", {
        vendorId,
        sku: claimIdentifier(event, "sku"),
        warehouseId: claimIdentifier(event, "warehouseId"),
        quantityDelta,
        reservationDelta,
        onHandQuantity,
        reservedQuantity,
        availableQuantity,
        adjustmentReason: claimIdentifier(event, "adjustmentReason"),
      });
    },
  };
}

function returnClaimReducer(): RoutedReducer {
  return commandReducer({
    name: "return-claim-v1",
    route: commandCallbackRoute("B101"),
    decisionType: "return-claim-provider-decision",
    mapping: {
      "return-claim.eligible": { allowed: [null, "requested"], next: "eligible" },
      "return-claim.accepted": { allowed: [null, "requested", "eligible"], next: "accepted" },
      "return-claim.in_transit": { allowed: ["accepted"], next: "return_in_transit" },
      "return-claim.refunded": { allowed: ["accepted", "return_in_transit"], next: "refunded", command: "succeeded" },
      "return-claim.replaced": { allowed: ["accepted", "return_in_transit"], next: "replaced", command: "succeeded" },
      "return-claim.recovered": { allowed: ["accepted", "return_in_transit", "refunded", "replaced"], next: "claim_recovered", command: "compensated" },
      "return-claim.denied": { allowed: [null, "requested", "eligible", "accepted"], next: "denied", command: "failed" },
    },
  });
}

function vendorScorecardReducer(): RoutedReducer {
  const batchId = "B102" as const;
  const operation = "publishVendorScorecard";
  const factRoutes = {
    "scorecard.vendor_job": { key: "fact", collection: "supply.vendor-production-commands", kind: "job" },
    "scorecard.shipment": { key: "fact", collection: EXTERNAL_EVENT_REDUCER_TARGET_COLLECTION.shipments, kind: "shipment" },
    "scorecard.claim": { key: "fact", collection: "supply.return-claim-commands", kind: "claim" },
    "scorecard.settlement": { key: "fact", collection: "supply.vendor-settlements", kind: "settlement" },
  } as const;
  return {
    name: "vendor-scorecard-from-projected-facts-v1",
    batchId,
    operation,
    locate(event) {
      routePrefix(event, batchId, operation, "vendor:", "vendor");
      assertVendorAuthority(event, event.subjectId);
      rejectClaims(event, [
        "onTimeRate", "defectRate", "refundRate", "averageLeadTimeDays", "score",
        "completedJobs", "totalShipments", "onTimeShipments", "claimsOpened", "claimsResolved",
      ]);
      const factRoute = knownEvent(event, factRoutes);
      return {
        ...target(EXTERNAL_EVENT_REDUCER_TARGET_COLLECTION.vendorScorecards, event.subjectId),
        relatedRecords: [{
          key: factRoute.key,
          collection: factRoute.collection,
          id: claimIdentifier(event, "projectedFactId"),
          required: true,
          lock: "share",
        }],
      };
    },
    reduce(event, context) {
      routePrefix(event, batchId, operation, "vendor:", "vendor");
      assertVendorAuthority(event, event.subjectId);
      rejectClaims(event, [
        "onTimeRate", "defectRate", "refundRate", "averageLeadTimeDays", "score",
        "completedJobs", "totalShipments", "onTimeShipments", "claimsOpened", "claimsResolved",
      ]);
      const factRoute = knownEvent(event, factRoutes);
      const fact = context.relatedRecords.fact;
      if (fact === undefined || fact === null || fact.id !== claimIdentifier(event, "projectedFactId")) {
        throw new DomainError("RESOURCE_NOT_FOUND", "Vendor scorecard requires the referenced projected fact");
      }
      const factVendorId = fact.data.vendorId;
      if (typeof factVendorId !== "string" || factVendorId !== event.subjectId) {
        throw new DomainError("TENANT_SCOPE_MISMATCH", "Projected fact belongs to a different vendor");
      }
      const processedFactIds = currentStringList(context, "processedFactIds");
      if (processedFactIds.includes(fact.id)) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Projected fact has already contributed to this scorecard");
      }
      if (processedFactIds.length >= 1_000) {
        throw invalid("Vendor scorecard fact window is full and must be rolled over");
      }
      const completedJobs = currentInteger(context, "completedJobs", 0) +
        (factRoute.kind === "job" && factState(fact) === "shipped" ? 1 : 0);
      const totalShipments = currentInteger(context, "totalShipments", 0) + (factRoute.kind === "shipment" ? 1 : 0);
      const onTimeShipments = currentInteger(context, "onTimeShipments", 0) +
        (factRoute.kind === "shipment" && fact.data.onTime === true ? 1 : 0);
      const claimsOpened = currentInteger(context, "claimsOpened", 0) + (factRoute.kind === "claim" ? 1 : 0);
      const claimsResolved = currentInteger(context, "claimsResolved", 0) +
        (factRoute.kind === "claim" && ["refunded", "replaced", "claim_recovered", "denied"].includes(factState(fact)) ? 1 : 0);
      const settlementsCompleted = currentInteger(context, "settlementsCompleted", 0) +
        (factRoute.kind === "settlement" && factState(fact) === "completed" ? 1 : 0);
      return reduction(event, [null, "current"], "current", "vendor-scorecard-fact-aggregation", {
        vendorId: event.subjectId,
        completedJobs,
        totalShipments,
        onTimeShipments,
        claimsOpened,
        claimsResolved,
        settlementsCompleted,
        onTimeRateBasisPoints: ratioBasisPoints(onTimeShipments, totalShipments),
        claimResolutionRateBasisPoints: ratioBasisPoints(claimsResolved, claimsOpened),
        processedFactIds: [...processedFactIds, fact.id],
      });
    },
  };
}

interface CommandReducerOptions {
  readonly name: string;
  readonly route: ExternalCommandCallbackRoute;
  readonly decisionType: string;
  readonly mapping: Readonly<Record<string, {
    readonly allowed: readonly (string | null)[];
    readonly next: string;
    readonly command?: "acknowledged" | "succeeded" | "failed" | "cancelled" | "compensated";
  }>>;
}

function commandReducer(options: CommandReducerOptions): RoutedReducer {
  const successfulProviderStates = Object.values(options.mapping)
    .filter((candidate) => candidate.command === "succeeded")
    .map((candidate) => candidate.next);
  const nonTerminalProviderStates = Object.values(options.mapping)
    .filter((candidate) => candidate.command === undefined)
    .map((candidate) => candidate.next);
  const mapping: CommandReducerOptions["mapping"] = {
    [EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES.succeeded]: {
      allowed: [null, ...nonTerminalProviderStates], next: "succeeded", command: "succeeded",
    },
    [EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES.failed]: {
      allowed: [null, ...nonTerminalProviderStates], next: "failed", command: "failed",
    },
    [EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES.cancelled]: {
      allowed: [null, ...nonTerminalProviderStates], next: "cancelled", command: "cancelled",
    },
    [EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES.compensated]: {
      allowed: ["succeeded", ...successfulProviderStates], next: "compensated", command: "compensated",
    },
    ...options.mapping,
  };
  return {
    name: options.name,
    batchId: options.route.batchId,
    operation: options.route.operation,
    locate(event) {
      commandRoute(event, options);
      return target(options.route.collection, event.subjectId);
    },
    reduce(event, context) {
      commandRoute(event, options);
      assertCommandProviderBinding(event, context, options);
      const transition = knownEvent(event, mapping);
      const providerOperationId = claimIdentifier(event, "providerOperationId");
      const claimPatch = Object.fromEntries(
        (options.route.requiredClaimIdentifiers ?? []).map((field) => [field, claimIdentifier(event, field)]),
      );
      const base = reduction(event, transition.allowed, transition.next, options.decisionType, {
        ...claimPatch,
        providerOperationId,
        providerStatus: transition.next,
        providerResultSha256: event.artifactSha256,
      }, "providerState");
      if (transition.command === undefined) return base;
      return {
        ...base,
        commandTransition: {
          commandId: event.subjectId,
          toState: transition.command,
          providerOperationId,
          evidenceId: event.evidenceId,
          details: {
            providerEventId: event.eventId,
            providerStatus: transition.next,
            providerResultSha256: event.artifactSha256,
          },
        },
      };
    },
  };
}

function assertCommandProviderBinding(
  event: VerifiedBusinessEvent,
  context: ExternalBusinessReducerContext,
  options: CommandReducerOptions,
): void {
  const current = context.current;
  if (current === null) {
    throw new DomainError("RESOURCE_NOT_FOUND", "Provider callback cannot create an unsolicited external command aggregate");
  }
  if (current.collection !== options.route.collection || current.id !== event.subjectId ||
      current.data.batchId !== options.route.batchId || current.data.operation !== options.route.operation ||
      current.data.operationMode !== "external-command" || current.data.externalCommandId !== event.subjectId) {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Provider callback does not match the persisted external command aggregate");
  }
  const providerBinding = options.route.providerBinding;
  let expectedProvider: string;
  if (providerBinding.kind === "exact") {
    expectedProvider = providerBinding.provider;
  } else if (providerBinding.kind === "record-field") {
    expectedProvider = `${providerBinding.prefix}${persistedIdentifier(current.data[providerBinding.field], providerBinding.field)}`;
  } else {
    const providerType = persistedIdentifier(current.data[providerBinding.typeField], providerBinding.typeField);
    if (!providerBinding.allowedTypes.includes(providerType)) {
      throw new DomainError("INTERNAL_ERROR", "External command has an unsupported persisted provider type");
    }
    expectedProvider = `${providerType}:${persistedIdentifier(current.data[providerBinding.idField], providerBinding.idField)}`;
  }
  if (event.provider !== expectedProvider) {
    throw new DomainError("TENANT_SCOPE_MISMATCH", "Provider callback does not match the requested command authority", {
      details: { expectedProvider, actualProvider: event.provider },
    });
  }
  for (const field of options.route.requiredClaimIdentifiers ?? []) {
    const callbackValue = claimIdentifier(event, field);
    if (persistedIdentifier(current.data[field], field) !== callbackValue) {
      throw new DomainError("TENANT_SCOPE_MISMATCH", "Provider callback claim does not match the requested command", {
        details: { field },
      });
    }
  }
}

function assertVendorAuthority(event: VerifiedBusinessEvent, vendorId: string): void {
  const expectedProvider = `vendor:${identifier(vendorId, "vendorId")}`;
  if (event.provider !== expectedProvider) {
    throw new DomainError("TENANT_SCOPE_MISMATCH", "Provider callback does not match the vendor authority", {
      details: { expectedProvider, actualProvider: event.provider },
    });
  }
}

function persistedIdentifier(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new DomainError("INTERNAL_ERROR", `External command is missing persisted ${field}`);
  }
  return value;
}

function commandRoute(event: VerifiedBusinessEvent, options: CommandReducerOptions): void {
  const routeDefinition = options.route;
  if (event.batchId !== routeDefinition.batchId || event.operation !== routeDefinition.operation ||
      event.subjectType !== routeDefinition.subjectType ||
      !externalCommandCallbackProviderAllowed(routeDefinition, event.provider)) {
    throw invalid("External business event route is not allowed by this reducer", {
      batchId: event.batchId,
      operation: event.operation,
      provider: event.provider,
      subjectType: event.subjectType,
    });
  }
  identifier(event.subjectId, "subjectId");
  if (event.correlationId !== event.subjectId) {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "External-command callback correlation must equal the exact command ID");
  }
  rejectClaims(event, [
    "tenantId", "batchId", "operation", "collection", "aggregateCollection", "aggregateId",
    "patch", "state", "providerState", "nextState", "toState", "commandState", "executionState",
    "terminal", "succeeded", "failed", "cancelled", "compensated", "commandId", "subjectId",
    "provider", "artifactSha256", "resultSha256", "resultDigest",
  ]);
}

function target(collection: string, aggregateId: string, ownerActorId?: string): ExternalBusinessAggregateTarget {
  return {
    collection,
    aggregateId: identifier(aggregateId, "aggregateId"),
    ...(ownerActorId === undefined ? {} : { ownerActorId: identifier(ownerActorId, "ownerActorId") }),
  };
}

function reduction(
  event: VerifiedBusinessEvent,
  allowedPriorStates: readonly (string | null)[],
  nextState: string,
  decisionType: string,
  patch: JsonObject,
  stateField = "state",
): ExternalBusinessReduction {
  return {
    stateField,
    allowedPriorStates,
    nextState,
    patch: {
      ...patch,
      lastProvider: event.provider,
      lastProviderEventId: event.eventId,
      lastProviderOccurredAt: event.providerOccurredAt,
      lastProviderSequence: event.sequence,
      lastCorrelationId: event.correlationId,
      lastEvidenceId: event.evidenceId,
      lastArtifactSha256: event.artifactSha256,
    },
    decisionType,
    decisionId: event.eventId,
  };
}

function balancedLedger(
  transactionId: string,
  sourceType: string,
  sourceId: string,
  occurredAt: string,
  amountMinor: number,
  currency: string,
  debitAccount: string,
  creditAccount: string,
): NonNullable<ExternalBusinessReduction["ledger"]> {
  return {
    transactionId,
    sourceType,
    sourceId,
    description: `${sourceType}:${sourceId}`,
    occurredAt,
    lines: [
      { accountCode: debitAccount, direction: "debit", amountMinor, currency },
      { accountCode: creditAccount, direction: "credit", amountMinor, currency },
    ],
  };
}

function route(
  event: VerifiedBusinessEvent,
  batchId: VerifiedBusinessEvent["batchId"],
  operation: string,
  providers: readonly string[],
  subjectType: string,
  providerPrefixes = false,
): void {
  const providerAllowed = providerPrefixes
    ? providers.some((prefix) => event.provider.startsWith(prefix) && event.provider.length > prefix.length)
    : providers.includes(event.provider);
  if (event.batchId !== batchId || event.operation !== operation || !providerAllowed || event.subjectType !== subjectType) {
    throw invalid("External business event route is not allowed by this reducer", {
      batchId: event.batchId,
      operation: event.operation,
      provider: event.provider,
      subjectType: event.subjectType,
    });
  }
  identifier(event.subjectId, "subjectId");
}

function routePrefix(
  event: VerifiedBusinessEvent,
  batchId: VerifiedBusinessEvent["batchId"],
  operation: string,
  providerPrefix: string,
  subjectType: string,
): void {
  route(event, batchId, operation, [providerPrefix], subjectType, true);
}

function knownEvent<T>(event: VerifiedBusinessEvent, mapping: Readonly<Record<string, T>>): T {
  const value = mapping[event.eventType];
  if (value === undefined) {
    throw invalid("External business event type is not allowed for this reducer", {
      batchId: event.batchId,
      operation: event.operation,
      eventType: event.eventType,
    });
  }
  return value;
}

function claim(event: VerifiedBusinessEvent, field: string): JsonValue | undefined {
  return event.canonicalClaims[field];
}

function claimString(event: VerifiedBusinessEvent, field: string, pattern = IDENTIFIER): string {
  const value = claim(event, field);
  if (typeof value !== "string" || !pattern.test(value)) {
    throw invalid(`${field} is missing or invalid in canonical provider claims`, { field });
  }
  return value;
}

function claimIdentifier(event: VerifiedBusinessEvent, field: string): string {
  return claimString(event, field);
}

function optionalClaimString(event: VerifiedBusinessEvent, field: string): string | undefined {
  const value = claim(event, field);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(`${field} is invalid in canonical provider claims`, { field });
  }
  return value;
}

function optionalClaimIdentifier(event: VerifiedBusinessEvent, field: string): string | undefined {
  const value = optionalClaimString(event, field);
  if (value === undefined) return undefined;
  return identifier(value, field);
}

function optionalClaimTimestamp(event: VerifiedBusinessEvent, field: string): string | undefined {
  const value = optionalClaimString(event, field);
  if (value === undefined) return undefined;
  if (new Date(value).toISOString() !== value) throw invalid(`${field} must be a canonical UTC timestamp`, { field });
  return value;
}

function claimInteger(
  event: VerifiedBusinessEvent,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = claim(event, field);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(`${field} is missing or invalid in canonical provider claims`, { field, minimum, maximum });
  }
  return value;
}

function optionalClaimInteger(
  event: VerifiedBusinessEvent,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = claim(event, field);
  if (value === undefined || value === null) return undefined;
  return claimInteger(event, field, minimum, maximum);
}

function rejectClaims(event: VerifiedBusinessEvent, fields: readonly string[]): void {
  const present = fields.filter((field) => Object.prototype.hasOwnProperty.call(event.canonicalClaims, field));
  if (present.length > 0) {
    throw invalid("Provider claims cannot supply server-computed reducer results", { fields: present });
  }
}

function currentInteger(context: ExternalBusinessReducerContext, field: string, fallback: number): number {
  const value = context.current?.data[field];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DomainError("INTERNAL_ERROR", `Persisted ${field} is not an integer`);
  }
  return value;
}

function currentStringList(context: ExternalBusinessReducerContext, field: string): string[] {
  const value = context.current?.data[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !IDENTIFIER.test(entry))) {
    throw new DomainError("INTERNAL_ERROR", `Persisted ${field} is not a valid identifier list`);
  }
  return [...value] as string[];
}

function factState(fact: NonNullable<ExternalBusinessReducerContext["relatedRecords"][string]>): string {
  const value = fact.data.state;
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new DomainError("INTERNAL_ERROR", "Projected fact is missing its trusted state");
  }
  return value;
}

function ratioBasisPoints(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator * 10_000) / denominator);
}

function safeSum(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw invalid(`${field} exceeds the safe integer range`, { field });
  return result;
}

function identifier(value: string, field: string): string {
  if (!IDENTIFIER.test(value)) throw invalid(`${field} has an invalid identifier format`, { field });
  return value;
}

function invalid(message: string, details: JsonObject = {}): DomainError {
  return new DomainError("VALIDATION_FAILED", message, { details });
}
