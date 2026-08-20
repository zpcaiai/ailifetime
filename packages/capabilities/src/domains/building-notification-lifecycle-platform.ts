import { DomainError } from "@ltm/core";
import type { CapabilityRegistry, JsonObject } from "../registry.js";
import { objectValue, requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertKnownState,
  defineCapability,
  participantConsent,
  registerDefinitions,
  requireInteger,
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-notification-lifecycle-platform";

function preference(input: JsonObject): JsonObject {
  const preferenceId = requiredString(input, "preferenceId");
  const subjectId = requiredString(input, "subjectId");
  const channel = assertKnownState(requiredString(input, "channel"), ["email", "sms", "push", "wechat", "in_app"] as const, "channel");
  const purpose = assertKnownState(requiredString(input, "purpose"), ["transactional", "support", "marketing", "family"] as const, "purpose");
  const status = assertKnownState(requiredString(input, "status"), ["subscribed", "unsubscribed"] as const, "status");
  const timezone = requiredString(input, "timezone");
  const quietHoursStart = requiredString(input, "quietHoursStart");
  const quietHoursEnd = requiredString(input, "quietHoursEnd");
  const dailyLimit = requireInteger(requiredNumber(input, "dailyLimit", 0), "dailyLimit", 0, 100);
  const policyVersion = requiredString(input, "policyVersion");
  const mergePreservesOptOut = requireTrue(requiredBoolean(input, "mergePreservesOptOut"), "mergePreservesOptOut");
  if (!/^\d{2}:\d{2}$/.test(quietHoursStart) || !/^\d{2}:\d{2}$/.test(quietHoursEnd)) {
    throw new DomainError("VALIDATION_FAILED", "quiet hours must use HH:mm");
  }
  if (purpose === "marketing" && status === "subscribed" && typeof input.consentEvidenceId !== "string") {
    throw new DomainError("CONSENT_REQUIRED", "marketing subscription requires consent evidence");
  }
  return {
    preferenceId,
    subjectId,
    channel,
    purpose,
    status,
    timezone,
    quietHoursStart,
    quietHoursEnd,
    dailyLimit,
    policyVersion,
    mergePreservesOptOut,
    ...(typeof input.consentEvidenceId === "string" ? { consentEvidenceId: input.consentEvidenceId } : {}),
  };
}

function sendCommand(input: JsonObject): JsonObject {
  const notificationId = requiredString(input, "notificationId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const purpose = requiredString(input, "purpose");
  const channel = assertKnownState(requiredString(input, "channel"), ["email", "sms", "push", "wechat", "in_app"] as const, "channel");
  const recipientRef = requiredString(input, "recipientRef");
  const templateVersion = requiredString(input, "templateVersion");
  const providerRoute = stringList(input, "providerRoute", { min: 1, unique: true });
  const eligible = requireTrue(requiredBoolean(input, "eligible"), "eligible");
  const callbackSignaturesRequired = requireTrue(requiredBoolean(input, "callbackSignaturesRequired"), "callbackSignaturesRequired");
  const boundedRetries = requireInteger(requiredNumber(input, "boundedRetries", 0), "boundedRetries", 0, 5);
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (recipientRef.includes("@") || /^\+?\d{7,}$/.test(recipientRef)) {
    throw new DomainError("VALIDATION_FAILED", "recipientRef must be an opaque contact reference");
  }
  return {
    notificationId,
    participantIds,
    purpose,
    channel,
    recipientRef,
    templateVersion,
    providerRoute,
    eligible,
    callbackSignaturesRequired,
    boundedRetries,
    externalEvidenceIds,
  };
}

function template(input: JsonObject): JsonObject {
  const templateId = requiredString(input, "templateId");
  const version = requiredString(input, "version");
  const channel = assertKnownState(requiredString(input, "channel"), ["email", "sms", "push", "wechat", "in_app"] as const, "channel");
  const locale = requiredString(input, "locale");
  const purpose = requiredString(input, "purpose");
  const variables = objectValue(input, "variables");
  const approvals = stringList(input, "approvals", { min: 2, unique: true });
  const linksExpire = requireTrue(requiredBoolean(input, "linksExpire"), "linksExpire");
  const htmlSanitized = requireTrue(requiredBoolean(input, "htmlSanitized"), "htmlSanitized");
  const serialized = JSON.stringify(variables).toLowerCase();
  if (["raw_media", "face_embedding", "payment_credential", "private_dialogue"].some((key) => serialized.includes(key))) {
    throw new DomainError("VALIDATION_FAILED", "template variables contain a prohibited sensitive type");
  }
  return { templateId, version, channel, locale, purpose, variables, approvals, linksExpire, htmlSanitized };
}

function journey(input: JsonObject): JsonObject {
  const journeyId = requiredString(input, "journeyId");
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const purpose = requiredString(input, "purpose");
  const version = requiredString(input, "version");
  const state = assertKnownState(requiredString(input, "state"), ["draft", "active", "paused", "retired"] as const, "state");
  const triggerEvents = stringList(input, "triggerEvents", { min: 1, unique: true });
  const exitCriteria = stringList(input, "exitCriteria", { min: 3, unique: true });
  const maxMessages = requireInteger(requiredNumber(input, "maxMessages", 1), "maxMessages", 1, 50);
  const experimentGuardrailsApproved = requireTrue(
    requiredBoolean(input, "experimentGuardrailsApproved"),
    "experimentGuardrailsApproved",
  );
  for (const exit of ["consent_withdrawn", "unsubscribed", "refunded"]) {
    if (!exitCriteria.includes(exit)) throw new DomainError("VALIDATION_FAILED", `exitCriteria must include ${exit}`);
  }
  return {
    journeyId,
    participantIds,
    purpose,
    version,
    state,
    triggerEvents,
    exitCriteria,
    maxMessages,
    experimentGuardrailsApproved,
  };
}

function deliverability(input: JsonObject): JsonObject {
  const providerId = requiredString(input, "providerId");
  const sendingIdentity = requiredString(input, "sendingIdentity");
  const health = assertKnownState(requiredString(input, "health"), ["healthy", "degraded", "disabled"] as const, "health");
  const authentication = stringList(input, "authentication", { min: 2, unique: true });
  const suppressionSources = stringList(input, "suppressionSources", { min: 2, unique: true });
  const softBounceRetryLimit = requireInteger(requiredNumber(input, "softBounceRetryLimit", 0), "softBounceRetryLimit", 0, 5);
  const complaintsStopImmediately = requireTrue(requiredBoolean(input, "complaintsStopImmediately"), "complaintsStopImmediately");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (!authentication.includes("dkim") || !authentication.includes("spf")) {
    throw new DomainError("VALIDATION_FAILED", "sending identity requires DKIM and SPF evidence");
  }
  return {
    providerId,
    sendingIdentity,
    health,
    authentication,
    suppressionSources,
    softBounceRetryLimit,
    complaintsStopImmediately,
    externalEvidenceIds,
  };
}

function notificationExperiment(input: JsonObject): JsonObject {
  const experimentId = requiredString(input, "experimentId");
  const hypothesis = requiredString(input, "hypothesis");
  const assignmentUnit = assertKnownState(requiredString(input, "assignmentUnit"), ["account", "household", "tenant"] as const, "assignmentUnit");
  const holdoutPercent = requiredNumber(input, "holdoutPercent", 0);
  const frequencyLimit = requireInteger(requiredNumber(input, "frequencyLimit", 1), "frequencyLimit", 1, 100);
  const guardrailMetrics = stringList(input, "guardrailMetrics", { min: 3, unique: true });
  const recordsActualExposure = requireTrue(requiredBoolean(input, "recordsActualExposure"), "recordsActualExposure");
  const consentProtected = requireTrue(requiredBoolean(input, "consentProtected"), "consentProtected");
  if (holdoutPercent <= 0 || holdoutPercent >= 100) throw new DomainError("VALIDATION_FAILED", "holdoutPercent must be between 0 and 100");
  for (const metric of ["unsubscribe", "complaint", "cost"]) {
    if (!guardrailMetrics.includes(metric)) throw new DomainError("VALIDATION_FAILED", `guardrailMetrics must include ${metric}`);
  }
  return {
    experimentId,
    hypothesis,
    assignmentUnit,
    holdoutPercent,
    frequencyLimit,
    guardrailMetrics,
    recordsActualExposure,
    consentProtected,
  };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B73", SKILL, "updateNotificationPreference", preference, { permission: "notification.preference.manage" }),
  defineCapability("B74", SKILL, "scheduleMultiChannelNotification", sendCommand, {
    permission: "notification.send",
    consent: participantConsent(),
    requiresExternalEvidence: true,
  }),
  defineCapability("B75", SKILL, "publishNotificationTemplate", template, { permission: "notification.template.publish" }),
  defineCapability("B76", SKILL, "publishLifecycleJourney", journey, {
    permission: "notification.journey.publish",
    consent: participantConsent(),
  }),
  defineCapability("B77", SKILL, "recordDeliverabilityControl", deliverability, {
    permission: "notification.deliverability.manage",
    requiresExternalEvidence: true,
  }),
  defineCapability("B78", SKILL, "registerNotificationExperiment", notificationExperiment, {
    permission: "experiment.notification.manage",
  }),
];

export function registerBuildingNotificationLifecyclePlatformCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingNotificationLifecyclePlatformCoverage = definitions.length;
