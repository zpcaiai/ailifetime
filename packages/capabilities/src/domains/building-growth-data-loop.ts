import { DomainError } from "@ltm/core";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertISODate,
  assertKnownState,
  defineCapability,
  participantConsent,
  registerDefinitions,
  requireInteger,
  requireNonEmptyObject,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-growth-data-loop";

function recordReferral(input: JsonObject): JsonObject {
  const referralId = requiredString(input, "referralId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const rewardType = assertKnownState(requiredString(input, "rewardType"), ["credit", "cash", "partner_share"] as const, "rewardType");
  const attributionState = assertKnownState(requiredString(input, "attributionState"), ["verified", "reversed", "pending", "unknown"] as const, "attributionState");
  const fraudState = assertKnownState(requiredString(input, "fraudState"), ["clear", "review", "blocked", "unknown"] as const, "fraudState");
  const publicUgc = requiredBoolean(input, "publicUgc");
  const publicDisplayConsent = requiredBoolean(input, "publicDisplayConsent");
  if (attributionState !== "verified" || fraudState !== "clear") throw new DomainError("DEPENDENCY_UNAVAILABLE", "unverified or suspicious referral cannot earn a reward");
  if (publicUgc && !publicDisplayConsent) throw new DomainError("CONSENT_REQUIRED", "public UGC needs separate display and commercial-use consent");
  return { referralId, participantIds, rewardType, attributionState, fraudState, publicUgc, publicDisplayConsent, purpose: publicUgc ? "public_display" : "referral" };
}

function scheduleLifecycleMessage(input: JsonObject): JsonObject {
  const messageId = requiredString(input, "messageId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const messageClass = assertKnownState(requiredString(input, "messageClass"), ["transactional", "service", "security", "family_invite", "marketing"] as const, "messageClass");
  const channel = assertKnownState(requiredString(input, "channel"), ["email", "sms", "push", "wechat", "in_app"] as const, "channel");
  const scheduledAt = assertISODate(requiredString(input, "scheduledAt"), "scheduledAt");
  const dateSource = assertKnownState(requiredString(input, "dateSource"), ["user_selected", "system_transaction"] as const, "dateSource");
  const subscriptionState = assertKnownState(requiredString(input, "subscriptionState"), ["subscribed", "unsubscribed", "complained", "unknown"] as const, "subscriptionState");
  const containsMinor = requiredBoolean(input, "containsMinor");
  if (["marketing", "family_invite"].includes(messageClass) && subscriptionState !== "subscribed") {
    throw new DomainError("CONSENT_REQUIRED", "optional lifecycle messages require an active channel subscription");
  }
  if (containsMinor && messageClass === "marketing") throw new DomainError("AUTH_FORBIDDEN", "marketing messages are disabled for minors");
  if (messageClass === "marketing" && dateSource !== "user_selected") throw new DomainError("VALIDATION_FAILED", "marketing reminders cannot infer sensitive dates");
  return { messageId, participantIds, messageClass, channel, scheduledAt, dateSource, subscriptionState, containsMinor, purpose: `message_${messageClass}` };
}

const PROHIBITED_ANALYTICS_FIELDS = new Set(["rawPhoto", "faceEmbedding", "paymentToken", "conversationText", "exactBirthDate"]);

function ingestAnalyticsEvent(input: JsonObject): JsonObject {
  const eventId = requiredString(input, "eventId");
  const eventType = requiredString(input, "eventType");
  const schemaVersion = requiredString(input, "schemaVersion");
  const occurredAt = assertISODate(requiredString(input, "occurredAt"), "occurredAt");
  const receivedAt = assertISODate(requiredString(input, "receivedAt"), "receivedAt");
  const actorPseudonym = requiredString(input, "actorPseudonym");
  const dimensions = requireNonEmptyObject(input, "dimensions");
  const metricNames = stringList(input, "metricNames", { min: 1, unique: true });
  if (Object.keys(dimensions).some((field) => PROHIBITED_ANALYTICS_FIELDS.has(field))) {
    throw new DomainError("VALIDATION_FAILED", "analytics dimensions contain prohibited sensitive data");
  }
  if (Date.parse(receivedAt) < Date.parse(occurredAt)) throw new DomainError("VALIDATION_FAILED", "receivedAt cannot precede occurredAt");
  return { eventId, eventType, schemaVersion, occurredAt, receivedAt, actorPseudonym, dimensions, metricNames };
}

const IMMUTABLE_GUARDRAILS = new Set(["consent", "child_safety", "ai_label", "price_transparency", "crisis_policy"]);
const SENSITIVE_FEATURES = new Set(["face", "health", "emotion", "wealth", "minor", "conversation"]);

function assignExperiment(input: JsonObject): JsonObject {
  const experimentId = requiredString(input, "experimentId");
  const subjectKey = requiredString(input, "subjectKey");
  const variant = requiredString(input, "variant");
  const state = assertKnownState(requiredString(input, "state"), ["draft", "running", "paused", "stopped"] as const, "state");
  const variables = stringList(input, "variables", { min: 1, unique: true });
  const features = stringList(input, "features", { min: 0, unique: true });
  const guardrails = stringList(input, "guardrails", { min: 1, unique: true });
  const preregistered = requiredBoolean(input, "preregistered");
  const exposureRecorded = requiredBoolean(input, "exposureRecorded");
  if (state === "running" && (!preregistered || !exposureRecorded)) throw new DomainError("VALIDATION_FAILED", "running experiments require preregistration and server-side exposure");
  if (variables.some((value) => IMMUTABLE_GUARDRAILS.has(value)) || features.some((value) => SENSITIVE_FEATURES.has(value))) {
    throw new DomainError("AUTH_FORBIDDEN", "safety controls and sensitive traits cannot be experiment variables or features");
  }
  if (![...IMMUTABLE_GUARDRAILS].every((guardrail) => guardrails.includes(guardrail))) {
    throw new DomainError("VALIDATION_FAILED", "all immutable product guardrails must remain enabled");
  }
  return { experimentId, subjectKey, variant, state, variables, features, guardrails, preregistered, exposureRecorded };
}

const SENSITIVE_ADMIN_ACTIONS = new Set(["export", "override", "refund", "ban", "unban", "configure"]);

function executeAdminAction(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  const actionId = requiredString(input, "actionId");
  const action = assertKnownState(requiredString(input, "action"), ["view", "search", "export", "override", "refund", "ban", "unban", "configure"] as const, "action");
  const targetId = requiredString(input, "targetId");
  const reason = requiredString(input, "reason");
  const ticketId = requiredString(input, "ticketId");
  const policyVersion = requiredString(input, "policyVersion");
  const fraudState = assertKnownState(requiredString(input, "fraudState"), ["clear", "suspected", "confirmed", "unknown"] as const, "fraudState");
  const secondApproverId = typeof input.secondApproverId === "string" ? input.secondApproverId : undefined;
  const allowedRole = invocation.actor.roles.some((role) => ["support_agent", "moderator", "privacy_officer", "finance_operator", "platform_admin", "auditor", "service_account"].includes(role));
  if (!allowedRole) throw new DomainError("AUTH_FORBIDDEN", "actor role is not authorized for the administration surface");
  if (fraudState === "unknown") throw new DomainError("VALIDATION_FAILED", "unknown risk state must fail closed");
  if (SENSITIVE_ADMIN_ACTIONS.has(action) && !invocation.actor.stepUp) throw new DomainError("AUTH_FORBIDDEN", "sensitive administration actions require step-up authentication");
  if (action === "configure" && (!secondApproverId || secondApproverId === invocation.actor.actorId)) {
    throw new DomainError("AUTH_FORBIDDEN", "configuration changes require an independent second approver");
  }
  return { actionId, action, targetId, reason, ticketId, policyVersion, fraudState, ...(secondApproverId ? { secondApproverId } : {}) };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B39", SKILL, "recordReferral", recordReferral, {
    consent: participantConsent(), mode: "resource", collection: "growth.referrals", recordIdField: "referralId",
  }),
  defineCapability("B40", SKILL, "scheduleLifecycleMessage", scheduleLifecycleMessage, {
    consent: participantConsent(), mode: "external-command", collection: "notifications.lifecycle-commands", recordIdField: "messageId",
  }),
  defineCapability("B41", SKILL, "ingestAnalyticsEvent", ingestAnalyticsEvent, {
    permission: "event:receive", mode: "inbox-event",
  }),
  defineCapability("B42", SKILL, "assignExperiment", assignExperiment, {
    mode: "resource",
    collection: "experiments.assignments",
    recordId: (data) => `${String(data.experimentId)}:${String(data.subjectKey)}`,
  }),
  defineCapability("B43", SKILL, "executeAdminAction", executeAdminAction, {
    permission: "admin.action.execute", mode: "resource", collection: "admin.actions", recordIdField: "actionId",
  }),
];

export function registerBuildingGrowthDataLoopCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingGrowthDataLoopCoverage = definitions.length;
