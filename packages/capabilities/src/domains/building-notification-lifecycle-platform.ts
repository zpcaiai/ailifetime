import { DomainError } from "@ltm/core";
import { capabilityEvidenceScope } from "@ltm/providers";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { objectValue, requiredBoolean, requiredNumber, requiredString, stringList } from "../validation.js";
import {
  assertKnownState,
  defineCapability,
  participantConsent,
  registerDefinitions,
  rejectClientAssertions,
  requireInteger,
  requireTrue,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "building-notification-lifecycle-platform";

function sha256(input: JsonObject, field: string): string {
  const value = requiredString(input, field);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DomainError("VALIDATION_FAILED", `${field} must be a lowercase SHA-256 digest`);
  return value;
}

function providerEnvironment(input: JsonObject): "sandbox" | "production" {
  return assertKnownState(requiredString(input, "providerEnvironment"), ["sandbox", "production"] as const, "providerEnvironment");
}

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
  rejectClientAssertions(input, [
    "eligible",
    "callbackSignaturesRequired",
    "notificationArtifactSha256",
    "externalEvidenceIds",
    "providerRequestId",
  ]);
  const notificationId = requiredString(input, "notificationId");
  const providerId = requiredString(input, "providerId");
  const environment = providerEnvironment(input);
  const participantIds = stringList(input, "participantIds", { min: 1, unique: true });
  const purpose = requiredString(input, "purpose");
  const channel = assertKnownState(requiredString(input, "channel"), ["email", "sms", "push", "wechat", "in_app"] as const, "channel");
  const recipientRef = requiredString(input, "recipientRef");
  const templateVersion = requiredString(input, "templateVersion");
  const providerRoute = stringList(input, "providerRoute", { min: 1, unique: true });
  const eligibilityDecisionId = requiredString(input, "eligibilityDecisionId");
  const callbackVerificationPolicyVersion = requiredString(input, "callbackVerificationPolicyVersion");
  const boundedRetries = requireInteger(requiredNumber(input, "boundedRetries", 0), "boundedRetries", 0, 5);
  if (recipientRef.includes("@") || /^\+?\d{7,}$/.test(recipientRef)) {
    throw new DomainError("VALIDATION_FAILED", "recipientRef must be an opaque contact reference");
  }
  return {
    notificationId,
    providerId,
    providerEnvironment: environment,
    participantIds,
    purpose,
    channel,
    recipientRef,
    templateVersion,
    providerRoute,
    eligibilityDecisionId,
    callbackVerificationPolicyVersion,
    boundedRetries,
    commandState: "requested",
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

function deliverability(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  rejectClientAssertions(input, ["complaintsStopImmediately"]);
  const providerId = requiredString(input, "providerId");
  const environment = providerEnvironment(input);
  const deliverabilityArtifactSha256 = sha256(input, "deliverabilityArtifactSha256");
  const sendingIdentity = requiredString(input, "sendingIdentity");
  const health = assertKnownState(requiredString(input, "health"), ["healthy", "degraded", "disabled"] as const, "health");
  const authentication = stringList(input, "authentication", { min: 2, unique: true });
  const suppressionSources = stringList(input, "suppressionSources", { min: 2, unique: true });
  const softBounceRetryLimit = requireInteger(requiredNumber(input, "softBounceRetryLimit", 0), "softBounceRetryLimit", 0, 5);
  const complaintSuppressionPolicyVersion = requiredString(input, "complaintSuppressionPolicyVersion");
  const externalEvidenceIds = stringList(input, "externalEvidenceIds", { min: 1, unique: true });
  if (!authentication.includes("dkim") || !authentication.includes("spf")) {
    throw new DomainError("VALIDATION_FAILED", "sending identity requires DKIM and SPF evidence");
  }
  const evidenceScope = capabilityEvidenceScope({
    tenantId: invocation.actor.tenantId,
    batchId: "B77",
    operation: "recordDeliverabilityControl",
    kind: "deliverability-control",
    provider: `notification:${providerId}`,
    artifactSha256: deliverabilityArtifactSha256,
    environment,
    subjectId: providerId,
  });
  return {
    providerId,
    providerEnvironment: environment,
    deliverabilityArtifactSha256,
    sendingIdentity,
    health,
    authentication,
    suppressionSources,
    softBounceRetryLimit,
    complaintSuppressionPolicyVersion,
    externalEvidenceIds,
    evidenceScope,
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
  defineCapability("B73", SKILL, "updateNotificationPreference", preference, {
    permission: "notification.preference.manage",
    mode: "resource",
  }),
  defineCapability("B74", SKILL, "scheduleMultiChannelNotification", sendCommand, {
    permission: "notification.send",
    consent: participantConsent(),
    mode: "external-command",
    collection: "notification.delivery-commands",
    recordIdField: "notificationId",
  }),
  defineCapability("B75", SKILL, "publishNotificationTemplate", template, {
    permission: "notification.template.publish",
    mode: "resource",
  }),
  defineCapability("B76", SKILL, "publishLifecycleJourney", journey, {
    permission: "notification.journey.publish",
    consent: participantConsent(),
    mode: "resource",
  }),
  defineCapability("B77", SKILL, "recordDeliverabilityControl", deliverability, {
    permission: "notification.deliverability.manage",
    requiresExternalEvidence: true,
    externalEvidenceScope: (data) => requiredString(data, "evidenceScope"),
    evidenceRequestArtifactField: "deliverabilityArtifactSha256",
    mode: "attestation",
  }),
  defineCapability("B78", SKILL, "registerNotificationExperiment", notificationExperiment, {
    permission: "experiment.notification.manage",
    mode: "resource",
  }),
];

export function registerBuildingNotificationLifecyclePlatformCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const buildingNotificationLifecyclePlatformCoverage = definitions.length;
