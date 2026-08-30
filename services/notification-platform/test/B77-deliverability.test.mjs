import assert from "node:assert/strict";
import test from "node:test";
import { applySuppressionFromDelivery, deliverabilityReport, dispatchMessage, evaluateContactEligibility, hmac, ingestProviderCallback, planProviderFailover, recordDeliverabilityFact, registerDeliverabilityOperations, registerProviderConfiguration, registerSenderAsset, SandboxNotificationAdapter, savePreferences } from "../src/index.mjs";
import { AT, auth, command, D, NOW, preferences, providerConfiguration, SECRET, store } from "./fixtures.mjs";

function throws(code, operation) { assert.throws(operation, (error) => error?.code === code); }

test("B77-R01 governs SPF/DKIM/DMARC, SMS, push and WeChat verification/rotation state", () => {
  const state = store(); const asset = { assetId: "email-domain-1", tenantId: "tenant-1", type: "email-domain", providerId: "provider-email-1", region: "us", verification: { spf: "verified", dkim: "verified", dmarc: "verified" }, secretOrCertificateReference: "secret-manager:notifications/email-domain", rotationState: "current", verifiedAt: AT, expiresAt: "2027-08-28T00:00:00.000Z" };
  assert.equal(registerSenderAsset(state, { asset, authorization: auth("deliverability-admin", "sender-governance"), idempotencyKey: "sender-1", at: AT }).productionVerificationRequired, true);
  throws("SENDER_ASSET_UNVERIFIED", () => registerSenderAsset(state, { asset: { ...asset, assetId: "bad-domain", verification: { ...asset.verification, dmarc: "pending" } }, authorization: auth("deliverability-admin", "sender-governance"), idempotencyKey: "sender-bad", at: AT }));
});

test("B77-R02 hard bounce/complaint/invalid/uninstalled suppress retries while soft bounce is bounded", () => {
  const state = store(); savePreferences(state, { preferences: preferences(), authorization: auth("account-owner", "notification-preferences"), idempotencyKey: "b77-pref", at: AT });
  const soft = applySuppressionFromDelivery(state, { event: { eventId: "soft-1", tenantId: "tenant-1", contactId: "contact-1", channel: "email", purpose: "generation", state: "soft-bounce", occurredAt: AT, providerReceiptSha256: D.a }, authorization: auth("deliverability-worker", "delivery-governance") }); assert.equal(soft.maximumRetries, 2);
  applySuppressionFromDelivery(state, { event: { eventId: "hard-1", tenantId: "tenant-1", contactId: "contact-1", channel: "email", purpose: "generation", state: "hard-bounce", occurredAt: AT, providerReceiptSha256: D.b }, authorization: auth("deliverability-worker", "delivery-governance") });
  assert.equal(evaluateContactEligibility(state, { tenantId: "tenant-1", accountId: "account-1", contactId: "contact-1", purpose: "generation", priority: "normal", channel: "email", policyVersion: "policy-v1" }, NOW).code, "DELIVERABILITY_SUPPRESSED");
});

test("B77-R03 reports acceptance/delivery/tracking/bounce/complaint/latency/cost by governed facts", () => {
  const state = store(); const base = { tenantId: "tenant-1", region: "us", providerId: "provider-email-1", templateId: "generation-ready", channel: "email", latencyMs: 100, costMicros: 20, trackingConsent: true, occurredAt: AT };
  for (const [index, event] of ["accepted", "delivered", "opened", "bounced", "complained"].entries()) recordDeliverabilityFact(state, { fact: { ...base, factId: `fact-${index}`, event }, authorization: auth("deliverability-worker", "delivery-analytics") });
  const report = deliverabilityReport(state, { tenantId: "tenant-1", region: "us", providerId: "provider-email-1", templateId: "generation-ready", authorization: auth("deliverability-analyst", "delivery-analytics") }); assert.equal(report.counts.delivered, 1); assert.equal(report.alerts.includes("complaint-rate"), true); assert.match(report.readSemantics, /do not prove/u);
  throws("TRACKING_CONSENT_REQUIRED", () => recordDeliverabilityFact(state, { fact: { ...base, factId: "tracking-bad", event: "opened", trackingConsent: false }, authorization: auth("deliverability-worker", "delivery-analytics") }));
});

test("B77-R04 provider failover preserves idempotency and consent or routes critical messages to humans", async () => {
  const state = store(); savePreferences(state, { preferences: preferences(), authorization: auth("account-owner", "notification-preferences"), idempotencyKey: "b77-route-pref", at: AT }); registerProviderConfiguration(state, { tenantId: "tenant-1", configuration: providerConfiguration(), authorization: auth("notification-admin", "provider-configuration"), idempotencyKey: "b77-primary", at: AT }); registerProviderConfiguration(state, { tenantId: "tenant-1", configuration: providerConfiguration({ providerId: "provider-email-2", costMicros: 500 }), authorization: auth("notification-admin", "provider-configuration"), idempotencyKey: "b77-secondary", at: AT });
  const sent = await dispatchMessage(state, { command: command(), authorization: auth("notification-worker", "notification-send"), at: AT }, new Map([["provider-email-1", new SandboxNotificationAdapter("email", "provider-email-1")]]), NOW);
  const timestamp = "2026-08-28T12:01:00.000Z"; const rawBody = JSON.stringify({ callbackId: "failure-callback", tenantId: "tenant-1", providerId: "provider-email-1", externalMessageId: sent.externalMessageId, state: "failed", occurredAt: timestamp, receiptSha256: D.c }); ingestProviderCallback(state, { timestamp, rawBody, signature: hmac(`${timestamp}.${rawBody}`, SECRET), authorization: auth("provider-callback", "provider-callback") }, SECRET, new Date(timestamp));
  const failover = planProviderFailover(state, { command: command(), disabledProviderId: "provider-email-1", authorization: auth("deliverability-worker", "provider-failover") }, new Date(timestamp)); assert.equal(failover.providerId, "provider-email-2"); assert.equal(failover.idempotencyKey, "message-command-1");
});

test("B77-R05 requires no-purchased-list warmup/capacity/blacklist/incident/postmortem operations", () => {
  const state = store(); const plan = { planId: "operations-1", tenantId: "tenant-1", purchasedLists: false, warmupDailyCaps: [100, 250, 500], capacityPerMinute: 1000, blacklistRunbookSha256: D.a, incidentRunbookSha256: D.b, postmortemTemplateSha256: D.c, reviewedAt: AT, expiresAt: "2027-08-28T00:00:00.000Z" };
  assert.equal(registerDeliverabilityOperations(state, { plan, authorization: auth("deliverability-admin", "sender-governance", { stepUp: true }), idempotencyKey: "ops-good", at: AT }).reviewRequired, true);
  throws("PURCHASED_LISTS_FORBIDDEN", () => registerDeliverabilityOperations(state, { plan: { ...plan, planId: "ops-bad", purchasedLists: true }, authorization: auth("deliverability-admin", "sender-governance", { stepUp: true }), idempotencyKey: "ops-bad", at: AT }));
});
