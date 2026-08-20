import { DomainError } from "@ltm/core";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertActorTenant,
  assertISODate,
  assertKnownState,
  defineCapability,
  registerDefinitions,
  requireInteger,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-commerce-fulfillment";

function publishPrice(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const sku = requiredString(input, "sku");
  const priceMinor = requireInteger(requiredNumber(input, "priceMinor", 1), "priceMinor", 1);
  const currency = requiredString(input, "currency").toUpperCase();
  const region = requiredString(input, "region");
  const quoteVersion = requiredString(input, "quoteVersion");
  const effectiveAt = assertISODate(requiredString(input, "effectiveAt"), "effectiveAt");
  const taxMode = assertKnownState(requiredString(input, "taxMode"), ["inclusive", "exclusive"] as const, "taxMode");
  if (!/^[A-Z]{3}$/.test(currency)) throw new DomainError("VALIDATION_FAILED", "currency must be an ISO-4217 code");
  return { sku, priceMinor, currency, region, quoteVersion, effectiveAt, taxMode };
}

function authorizeCheckout(input: JsonObject): JsonObject {
  const checkoutId = requiredString(input, "checkoutId");
  const quoteId = requiredString(input, "quoteId");
  const quoteState = assertKnownState(requiredString(input, "quoteState"), ["active", "expired", "unknown"] as const, "quoteState");
  const paymentAuthorizationId = requiredString(input, "paymentAuthorizationId");
  const paymentState = assertKnownState(requiredString(input, "paymentState"), ["authorized", "declined", "pending", "unknown"] as const, "paymentState");
  const quotedMinor = requireInteger(requiredNumber(input, "quotedMinor", 1), "quotedMinor", 1);
  const authorizedMinor = requireInteger(requiredNumber(input, "authorizedMinor", 0), "authorizedMinor", 0);
  const currency = requiredString(input, "currency").toUpperCase();
  if ("paymentToken" in input || "cardNumber" in input) throw new DomainError("VALIDATION_FAILED", "raw payment credentials must not enter capability records");
  if (quoteState !== "active") throw new DomainError("VERSION_CONFLICT", "checkout quote is expired or unknown");
  if (paymentState !== "authorized" || authorizedMinor !== quotedMinor) {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "payment must be authoritatively authorized for the exact quote amount");
  }
  return { checkoutId, quoteId, quoteState, paymentAuthorizationId, paymentState, quotedMinor, authorizedMinor, currency };
}

function issueEntitlement(input: JsonObject): JsonObject {
  const entitlementId = requiredString(input, "entitlementId");
  const customerId = requiredString(input, "customerId");
  const kind = assertKnownState(requiredString(input, "kind"), ["subscription", "credit", "gift"] as const, "kind");
  const units = requireInteger(requiredNumber(input, "units", 1), "units", 1);
  const paymentState = assertKnownState(requiredString(input, "paymentState"), ["authorized", "captured", "settled", "refunded", "unknown"] as const, "paymentState");
  const giftBound = requiredBoolean(input, "giftBound");
  if (!["captured", "settled"].includes(paymentState)) throw new DomainError("DEPENDENCY_UNAVAILABLE", "unpaid or unknown purchases cannot create entitlements");
  if (kind === "gift" && giftBound) throw new DomainError("VALIDATION_FAILED", "new gifts must remain unbound until recipient claim");
  return { entitlementId, customerId, kind, units, paymentState, giftBound };
}

const ORDER_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  created: ["paid", "cancelled"],
  paid: ["generating", "refunded", "cancelled"],
  generating: ["ready", "partial", "failed"],
  partial: ["generating", "ready", "refunded"],
  ready: ["delivered", "refunded"],
  delivered: ["refunded"],
  failed: ["generating", "refunded"],
  cancelled: [],
  refunded: [],
};

function transitionOrder(input: JsonObject): JsonObject {
  const orderId = requiredString(input, "orderId");
  const fromState = assertKnownState(requiredString(input, "fromState"), Object.keys(ORDER_TRANSITIONS), "fromState");
  const toState = assertKnownState(requiredString(input, "toState"), Object.keys(ORDER_TRANSITIONS), "toState");
  const paymentState = assertKnownState(requiredString(input, "paymentState"), ["authorized", "captured", "settled", "refunded", "unknown"] as const, "paymentState");
  const deliverableIds = stringList(input, "deliverableIds", { min: 0, unique: true });
  if (!ORDER_TRANSITIONS[fromState]?.includes(toState)) throw new DomainError("VERSION_CONFLICT", `illegal order transition ${fromState} -> ${toState}`);
  if (["paid", "generating", "ready", "delivered"].includes(toState) && !["captured", "settled"].includes(paymentState)) {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "commercial order cannot advance without captured payment");
  }
  if (toState === "delivered" && deliverableIds.length === 0) throw new DomainError("VALIDATION_FAILED", "delivery requires at least one verified deliverable");
  return { orderId, fromState, toState, paymentState, deliverableIds };
}

function submitPhysicalFulfillment(input: JsonObject): JsonObject {
  const orderId = requiredString(input, "orderId");
  const purchaseOrderId = requiredString(input, "purchaseOrderId");
  const printAssetId = requiredString(input, "printAssetId");
  const specificationVersion = requiredString(input, "specificationVersion");
  const quantity = requireInteger(requiredNumber(input, "quantity", 1), "quantity", 1, 1000);
  const proofState = assertKnownState(requiredString(input, "proofState"), ["approved", "rejected", "pending", "unknown"] as const, "proofState");
  const paymentState = assertKnownState(requiredString(input, "paymentState"), ["captured", "settled", "refunded", "unknown"] as const, "paymentState");
  const addressToken = requiredString(input, "addressToken");
  if (proofState !== "approved" || !["captured", "settled"].includes(paymentState)) {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "fulfillment requires approved proof and captured payment");
  }
  if (!addressToken.startsWith("addr_")) throw new DomainError("VALIDATION_FAILED", "fulfillment accepts only a vaulted address token");
  return { orderId, purchaseOrderId, printAssetId, specificationVersion, quantity, proofState, paymentState, addressToken };
}

function resolveCommerceCase(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  const caseId = requiredString(input, "caseId");
  const orderId = requiredString(input, "orderId");
  const action = assertKnownState(requiredString(input, "action"), ["refund", "replacement", "dispute_hold", "release_hold"] as const, "action");
  const reason = requiredString(input, "reason");
  const ticketId = requiredString(input, "ticketId");
  const paidMinor = requireInteger(requiredNumber(input, "paidMinor", 0), "paidMinor", 0);
  const actionMinor = requireInteger(requiredNumber(input, "actionMinor", 0), "actionMinor", 0);
  const paymentState = assertKnownState(requiredString(input, "paymentState"), ["captured", "settled", "refunded", "disputed", "unknown"] as const, "paymentState");
  const secondApproverId = typeof input.secondApproverId === "string" ? input.secondApproverId : undefined;
  if (paymentState === "unknown" || actionMinor > paidMinor) throw new DomainError("VALIDATION_FAILED", "case action exceeds verified payment or has unknown payment state");
  if (action === "refund" && !["captured", "settled", "disputed"].includes(paymentState)) {
    throw new DomainError("VERSION_CONFLICT", "refund is illegal for the current payment state");
  }
  if (actionMinor >= 10_000 && (!invocation.actor.stepUp || !secondApproverId || secondApproverId === invocation.actor.actorId)) {
    throw new DomainError("AUTH_FORBIDDEN", "high-value actions require step-up and an independent second approver");
  }
  return { caseId, orderId, action, reason, ticketId, paidMinor, actionMinor, paymentState, ...(secondApproverId ? { secondApproverId } : {}) };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B25", SKILL, "publishPrice", publishPrice, { permission: "commerce.catalog.manage" }),
  defineCapability("B26", SKILL, "authorizeCheckout", authorizeCheckout, { permission: "commerce.checkout.authorize" }),
  defineCapability("B27", SKILL, "issueEntitlement", issueEntitlement, { permission: "commerce.entitlement.issue" }),
  defineCapability("B28", SKILL, "transitionOrder", transitionOrder, { permission: "commerce.order.transition" }),
  defineCapability("B29", SKILL, "submitPhysicalFulfillment", submitPhysicalFulfillment, { permission: "commerce.fulfillment.submit" }),
  defineCapability("B30", SKILL, "resolveCommerceCase", resolveCommerceCase, { permission: "commerce.support.resolve" }),
];

export function registerBuildingCommerceFulfillmentCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingCommerceFulfillmentCoverage = definitions.length;
