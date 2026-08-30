import assert from "node:assert/strict";
import test from "node:test";
import { approveAndPublishTemplate, assignExperiment, enforceNotificationGuardrails, experimentReport, NOTIFICATION_FACT_EVENTS, recordNotificationEvent, reserveFrequency, saveTemplateVersion, validateExperiment } from "../src/index.mjs";
import { approvals, AT, auth, D, NOW, store, template } from "./fixtures.mjs";

function throws(code, operation) { assert.throws(operation, (error) => error?.code === code); }
function event(eventId, eventName, overrides = {}) { return { eventId, tenantId: "tenant-1", accountId: "account-1", contactId: "contact-1", familyId: "family-1", messageId: `message-${eventId}`, campaignId: "campaign-1", journeyId: "journey-1", templateId: "generation-ready", providerId: "provider-email-1", channel: "email", purpose: "marketing", event: eventName, costMicros: 20, observable: true, isMinor: false, localHour: 12, occurredAt: AT, ...overrides }; }
function experiment(overrides = {}) { return { experimentId: "experiment-1", tenantId: "tenant-1", campaignId: "campaign-1", purpose: "marketing", design: "fixed-sample", variants: [{ variantId: "a", weightBasisPoints: 2500 }, { variantId: "b", weightBasisPoints: 2500 }], holdoutBasisPoints: 5000, primaryMetric: "goal-completed", guardrails: ["unsubscribed", "complained"], stoppingRule: "Stop after preregistered sample or guardrail breach.", minimumDetectableEffectBasisPoints: 200, sampleSize: 1000, preregisteredAt: "2026-08-20T00:00:00.000Z", startsAt: "2026-08-21T00:00:00.000Z", endsAt: "2026-09-30T00:00:00.000Z", ...overrides }; }

test("B78-R01 unifies sent/delivery/failure/bounce/complaint/unsubscribe/engagement/goal/cost facts", () => {
  assert.deepEqual(NOTIFICATION_FACT_EVENTS, ["sent", "accepted", "delivered", "failed", "bounced", "complained", "unsubscribed", "opened", "clicked", "goal-completed"]);
  const state = store(); const result = recordNotificationEvent(state, { event: event("fact-1", "sent"), authorization: auth("notification-analytics-worker", "notification-analytics") }); assert.equal(result.recorded, true); assert.equal(state.read().records.analytics[0].costMicros, 20);
});

test("B78-R02 atomically reserves rolling account/contact/family/tenant/purpose cross-channel frequency", () => {
  const state = store(); const reservation = { reservationId: "reservation-1", tenantId: "tenant-1", accountId: "account-1", contactId: "contact-1", familyId: "family-1", purpose: "marketing", channel: "email", windowSeconds: 3600, limits: { account: 1, contact: 1, family: 1, tenant: 10, purpose: 1 }, amount: 1, expiresAt: "2026-08-28T13:00:00.000Z" };
  const first = reserveFrequency(state, { reservation, authorization: auth("notification-worker", "frequency-reservation"), at: AT }); assert.deepEqual(reserveFrequency(state, { reservation, authorization: auth("notification-worker", "frequency-reservation"), at: AT }), first);
  throws("FREQUENCY_RESERVATION_DENIED", () => reserveFrequency(state, { reservation: { ...reservation, reservationId: "reservation-2", channel: "sms" }, authorization: auth("notification-worker", "frequency-reservation"), at: AT }));
});

test("B78-R03 preregisters deterministic holdout/A-B-n designs and never experiments on security content", () => {
  const state = store(); assert.equal(validateExperiment(experiment()).holdoutBasisPoints, 5000);
  const first = assignExperiment(state, { experiment: experiment(), subjectId: "contact-1", authorization: auth("experiment-worker", "notification-experiment"), idempotencyKey: "assignment-1", at: AT }); const second = assignExperiment(state, { experiment: experiment(), subjectId: "contact-1", authorization: auth("experiment-worker", "notification-experiment"), idempotencyKey: "assignment-2", at: AT }); assert.equal(first.assignment, second.assignment); assert.equal(first.crossChannel, true);
  throws("SECURITY_EXPERIMENT_FORBIDDEN", () => validateExperiment(experiment({ purpose: "security" })));
});

test("B78-R04 separates correlation and holdout incrementality with CI/contamination/observability/bias", () => {
  const state = store(); for (let index = 0; index < 30; index += 1) { const subjectId = `contact-${index}`; assignExperiment(state, { experiment: experiment(), subjectId, authorization: auth("experiment-worker", "notification-experiment"), idempotencyKey: `assign-${index}`, at: AT }); recordNotificationEvent(state, { event: event(`goal-${index}`, index % 3 === 0 ? "goal-completed" : "delivered", { accountId: subjectId, contactId: subjectId, messageId: `message-${index}`, observable: index % 5 !== 0 }), authorization: auth("notification-analytics-worker", "notification-analytics") }); }
  const report = experimentReport(state, { tenantId: "tenant-1", experimentId: "experiment-1", campaignId: "campaign-1", contaminationCount: 2, authorization: auth("notification-analyst", "notification-experiment") }); assert.equal(report.contamination, 2); assert.match(report.causalBoundary, /Correlation/u); assert.match(report.survivorBiasWarning, /deleted/u); assert.equal(Object.keys(report.results).length >= 2, true);
});

test("B78-R05 guardrails automatically withdraw templates on complaint/unsubscribe/night/minor/security breaches", () => {
  const state = store(); saveTemplateVersion(state, { template: template(), authorization: auth("template-editor", "template-management"), idempotencyKey: "b78-template-save", at: AT }); approveAndPublishTemplate(state, { tenantId: "tenant-1", templateId: "generation-ready", version: "v1", approvals: approvals(), authorization: auth("template-publisher", "template-management", { stepUp: true }), idempotencyKey: "b78-template-publish", at: AT }, NOW);
  recordNotificationEvent(state, { event: event("sent-guard", "sent", { journeyId: null }), authorization: auth("notification-analytics-worker", "notification-analytics") }); recordNotificationEvent(state, { event: event("complaint-guard", "complained", { journeyId: null }), authorization: auth("notification-analytics-worker", "notification-analytics") });
  const result = enforceNotificationGuardrails(state, { tenantId: "tenant-1", templateId: "generation-ready", journeyId: null, thresholds: { unsubscribeBasisPoints: 100, complaintBasisPoints: 100, nightSendCount: 10, minorMarketingCount: 0, securityIncidentCount: 0 }, securityIncidentCount: 0, authorization: auth("notification-safety-worker", "notification-guardrail"), idempotencyKey: "guardrail-1", at: "2026-08-28T12:01:00.000Z" }); assert.equal(result.paused, true); assert.equal(state.read().records.templates["tenant-1:generation-ready"].versions.v1.state, "withdrawn");
});
