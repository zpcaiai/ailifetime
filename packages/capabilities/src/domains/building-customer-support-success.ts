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
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-customer-support-success";

function helpArticle(input: JsonObject): JsonObject {
  const articleId = requiredString(input, "articleId");
  const locale = requiredString(input, "locale");
  const region = requiredString(input, "region");
  const policyVersion = requiredString(input, "policyVersion");
  const state = assertKnownState(requiredString(input, "state"), ["draft", "review", "published", "withdrawn"] as const, "state");
  const searchVisible = requiredBoolean(input, "searchVisible");
  const authorizationBypassAdvice = requiredBoolean(input, "authorizationBypassAdvice");
  const sourceVersionCurrent = requireTrue(requiredBoolean(input, "sourceVersionCurrent"), "sourceVersionCurrent");
  if (state !== "published" && searchVisible) throw new DomainError("VALIDATION_FAILED", "unpublished help content cannot be indexed");
  if (authorizationBypassAdvice) throw new DomainError("VALIDATION_FAILED", "help content cannot advise bypassing authorization");
  return { articleId, locale, region, policyVersion, state, searchVisible, authorizationBypassAdvice, sourceVersionCurrent };
}

function supportTicket(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const ticketId = requiredString(input, "ticketId");
  const channel = assertKnownState(requiredString(input, "channel"), ["email", "chat", "phone", "in_app", "partner"] as const, "channel");
  const severity = assertKnownState(requiredString(input, "severity"), ["P0", "P1", "P2", "P3"] as const, "severity");
  const queue = requiredString(input, "queue");
  const dueAt = assertISODate(requiredString(input, "dueAt"), "dueAt");
  const privacySensitive = requiredBoolean(input, "privacySensitive");
  const dedupeKey = requiredString(input, "dedupeKey");
  const assignedRole = requiredString(input, "assignedRole");
  if (Date.parse(dueAt) <= Date.now()) throw new DomainError("VALIDATION_FAILED", "ticket SLA dueAt must be in the future");
  if (privacySensitive && assignedRole !== "privacy_officer") {
    throw new DomainError("AUTH_FORBIDDEN", "privacy-sensitive tickets require the privacy queue");
  }
  return { ticketId, channel, severity, queue, dueAt, privacySensitive, dedupeKey, assignedRole };
}

function supportAssistant(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const conversationId = requiredString(input, "conversationId");
  const sourceArticleIds = stringList(input, "sourceArticleIds", { min: 1, unique: true });
  const toolMode = assertKnownState(requiredString(input, "toolMode"), ["read_only", "preapproved_actions"] as const, "toolMode");
  const confidence = requiredNumber(input, "confidence", 0);
  const promisedOutcome = requiredBoolean(input, "promisedOutcome");
  const handoffAvailable = requireTrue(requiredBoolean(input, "handoffAvailable"), "handoffAvailable");
  const toolTenantBound = requireTrue(requiredBoolean(input, "toolTenantBound"), "toolTenantBound");
  if (confidence > 1 || promisedOutcome) {
    throw new DomainError("VALIDATION_FAILED", "assistant confidence must be 0..1 and cannot promise commercial outcomes");
  }
  const handoffRequired = confidence < 0.65;
  return { conversationId, sourceArticleIds, toolMode, confidence, promisedOutcome, handoffAvailable, toolTenantBound, handoffRequired };
}

function supportSession(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const sessionId = requiredString(input, "sessionId");
  const caseId = requiredString(input, "caseId");
  const reason = requiredString(input, "reason");
  const expiresAt = assertISODate(requiredString(input, "expiresAt"), "expiresAt");
  const visibleFields = stringList(input, "visibleFields", { min: 1, unique: true });
  const maskedFields = stringList(input, "maskedFields", { min: 2, unique: true });
  const sensitive = requiredBoolean(input, "sensitive");
  const customerNotice = requireTrue(requiredBoolean(input, "customerNotice"), "customerNotice");
  const lifetimeMs = Date.parse(expiresAt) - Date.now();
  if (lifetimeMs <= 0 || lifetimeMs > 60 * 60 * 1000) throw new DomainError("VALIDATION_FAILED", "support session must expire within one hour");
  if (sensitive && invocation.actor.stepUp !== true) throw new DomainError("AUTH_FORBIDDEN", "sensitive support sessions require step-up authentication");
  for (const field of ["payment_credential", "raw_media"]) {
    if (!maskedFields.includes(field)) throw new DomainError("VALIDATION_FAILED", `maskedFields must include ${field}`);
  }
  return { sessionId, caseId, reason, expiresAt, visibleFields, maskedFields, sensitive, customerNotice };
}

function supportAction(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const actionId = requiredString(input, "actionId");
  const ticketId = requiredString(input, "ticketId");
  const actionType = assertKnownState(
    requiredString(input, "actionType"),
    ["refund", "credit", "regenerate", "reprint", "address_change", "data_rights"] as const,
    "actionType",
  );
  const previewHash = requiredString(input, "previewHash");
  const approvalIds = stringList(input, "approvalIds", { min: 1, unique: true });
  const mutuallyExclusiveChecked = requireTrue(requiredBoolean(input, "mutuallyExclusiveChecked"), "mutuallyExclusiveChecked");
  const duplicateRemedyChecked = requireTrue(requiredBoolean(input, "duplicateRemedyChecked"), "duplicateRemedyChecked");
  const dataRightsPropagation = requiredBoolean(input, "dataRightsPropagation");
  let amountMinor = 0;
  let currency = "XXX";
  if (actionType === "refund" || actionType === "credit") {
    amountMinor = requireInteger(requiredNumber(input, "amountMinor", 1), "amountMinor", 1);
    currency = requiredString(input, "currency").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new DomainError("VALIDATION_FAILED", "currency must be ISO-4217");
    if (invocation.actor.stepUp !== true) throw new DomainError("AUTH_FORBIDDEN", "financial remedies require step-up authentication");
  }
  if (actionType === "data_rights" && !dataRightsPropagation) {
    throw new DomainError("VALIDATION_FAILED", "data-rights actions require downstream propagation");
  }
  return {
    actionId,
    ticketId,
    actionType,
    previewHash,
    approvalIds,
    mutuallyExclusiveChecked,
    duplicateRemedyChecked,
    dataRightsPropagation,
    amountMinor,
    currency,
  };
}

function salesOpportunity(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const opportunityId = requiredString(input, "opportunityId");
  const partnerId = requiredString(input, "partnerId");
  const stage = assertKnownState(requiredString(input, "stage"), ["qualified", "proposal", "contracting", "won", "lost"] as const, "stage");
  const contactConsent = requireTrue(requiredBoolean(input, "contactConsent"), "contactConsent");
  const quoteVersion = requiredString(input, "quoteVersion");
  const quoteExpiresAt = assertISODate(requiredString(input, "quoteExpiresAt"), "quoteExpiresAt");
  const amountMinor = requireInteger(requiredNumber(input, "amountMinor", 1), "amountMinor", 1);
  const currency = requiredString(input, "currency").toUpperCase();
  const duplicateOwnershipChecked = requireTrue(requiredBoolean(input, "duplicateOwnershipChecked"), "duplicateOwnershipChecked");
  if (!/^[A-Z]{3}$/.test(currency) || Date.parse(quoteExpiresAt) <= Date.now()) {
    throw new DomainError("VALIDATION_FAILED", "quote currency or expiry is invalid");
  }
  return {
    opportunityId,
    partnerId,
    stage,
    contactConsent,
    quoteVersion,
    quoteExpiresAt,
    amountMinor,
    currency,
    duplicateOwnershipChecked,
  };
}

function successPlan(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  assertActorTenant(input, invocation);
  const partnerId = requiredString(input, "partnerId");
  const lifecycleState = assertKnownState(requiredString(input, "lifecycleState"), ["onboarding", "active", "renewal", "offboarded"] as const, "lifecycleState");
  const milestones = stringList(input, "milestones", { min: 1, unique: true });
  const healthInputs = stringList(input, "healthInputs", { min: 2, unique: true });
  const platformIncidentAdjusted = requireTrue(requiredBoolean(input, "platformIncidentAdjusted"), "platformIncidentAdjusted");
  const credentialsRevoked = requiredBoolean(input, "credentialsRevoked");
  const collectionDisabled = requiredBoolean(input, "collectionDisabled");
  if (lifecycleState === "offboarded" && (!credentialsRevoked || !collectionDisabled)) {
    throw new DomainError("VALIDATION_FAILED", "offboarding must revoke credentials and disable collection");
  }
  return { partnerId, lifecycleState, milestones, healthInputs, platformIncidentAdjusted, credentialsRevoked, collectionDisabled };
}

function feedback(input: JsonObject): JsonObject {
  const feedbackId = requiredString(input, "feedbackId");
  const source = assertKnownState(requiredString(input, "source"), ["csat", "nps", "ticket", "partner", "appeal"] as const, "source");
  const dedupeKey = requiredString(input, "dedupeKey");
  const rootCause = requiredString(input, "rootCause");
  const sensitiveContentRedacted = requireTrue(requiredBoolean(input, "sensitiveContentRedacted"), "sensitiveContentRedacted");
  const eligibleForSurvey = requiredBoolean(input, "eligibleForSurvey");
  const unresolvedRefundFailure = requiredBoolean(input, "unresolvedRefundFailure");
  const qualityReviewerCount = requireInteger(requiredNumber(input, "qualityReviewerCount", 1), "qualityReviewerCount", 1);
  if (unresolvedRefundFailure && eligibleForSurvey) {
    throw new DomainError("VALIDATION_FAILED", "survey must be suppressed while a refund failure is unresolved");
  }
  return {
    feedbackId,
    source,
    dedupeKey,
    rootCause,
    sensitiveContentRedacted,
    eligibleForSurvey,
    unresolvedRefundFailure,
    qualityReviewerCount,
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B79", SKILL, "publishHelpArticle", helpArticle, {
    permission: "support.content.publish",
    mode: "resource",
  }),
  defineCapability("B80", SKILL, "createSupportTicket", supportTicket, {
    permission: "support.ticket.create",
    mode: "resource",
  }),
  defineCapability("B81", SKILL, "recordSupportAssistantSession", supportAssistant, {
    permission: "support.assistant.use",
    mode: "resource",
  }),
  defineCapability("B82", SKILL, "startControlledSupportSession", supportSession, {
    permission: "support.session.start",
    mode: "resource",
  }),
  defineCapability("B83", SKILL, "requestControlledSupportAction", supportAction, {
    permission: "support.remedy.request",
    mode: "external-command",
  }),
  defineCapability("B84", SKILL, "recordPartnerOpportunity", salesOpportunity, {
    permission: "sales.opportunity.manage",
    mode: "resource",
  }),
  defineCapability("B85", SKILL, "updatePartnerSuccessPlan", successPlan, {
    permission: "customer-success.plan.manage",
    mode: "resource",
  }),
  defineCapability("B86", SKILL, "recordGovernedFeedback", feedback, {
    permission: "support.feedback.manage",
    mode: "resource",
  }),
];

export function registerBuildingCustomerSupportSuccessCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingCustomerSupportSuccessCoverage = definitions.length;
