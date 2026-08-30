import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import {
  acknowledgeWithdrawal,
  attributionHealth,
  campaignFunnelHealth,
  changeCampaignState,
  configureCampaign,
  eligibleTags,
  enforceTagExecution,
  issueCampaignEntry,
  recordAttributionEvent,
  recordConsent,
  renderRegionalConsentInterface,
  resolveCampaignEntry,
  validateCampaign,
  validateConsentPolicy,
  withdrawConsent,
} from "../src/index.mjs";
import { AT, campaign, campaignPolicy, consentInput, consentPolicy, D, freshStore, NOW, SECRET } from "./fixtures.mjs";

function throwsCode(code, operation) { assert.throws(operation, (error) => error?.code === code); }
async function rejectsCode(code, operation) { await assert.rejects(operation, (error) => error?.code === code); }

test("B59-R01 renders a region/version-bound accessible consent interface", () => {
  const result = renderRegionalConsentInterface(consentPolicy(), {
    locale: "en-US",
    title: "Privacy choices",
    description: "Choose optional processing purposes.",
    purposeLabels: { essential: "Essential", preferences: "Preferences", analytics: "Analytics", advertising: "Advertising" },
    acceptAll: "Accept all", rejectOptional: "Reject optional", save: "Save choices",
  });
  assert.equal(result.region, "us");
  assert.match(result.html, /data-policy-version="v1"/u);
  assert.match(result.html, /name="essential" value="true" checked disabled/u);
});

test("B59-R02 consent gates tags and automatic egress scan blocks undeclared data", () => {
  const { root, store } = freshStore();
  try {
    const receipt = recordConsent(store, consentInput(), consentPolicy());
    assert.equal(eligibleTags(consentPolicy(), receipt).tags.length, 1);
    const pass = enforceTagExecution(consentPolicy(), receipt, [{ tagId: "analytics-v1", networkOrigin: "https://analytics.example.com", dataFields: ["event_id"], loaded: true }]);
    assert.equal(pass.status, "PASS");
    throwsCode("TAG_EXECUTION_BLOCKED", () => enforceTagExecution(consentPolicy(), receipt, [{ tagId: "analytics-v1", networkOrigin: "https://analytics.example.com", dataFields: ["raw_payload"], loaded: true }]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B59-R03 tag manifests reject sensitive attribution fields", () => {
  const policy = consentPolicy();
  policy.tags[0].dataFields.push("raw_photo");
  throwsCode("SENSITIVE_ATTRIBUTION_DATA", () => validateConsentPolicy(policy));
});

test("B59-R04 withdrawal stops collection and produces downstream deletion proof", () => {
  const { root, store } = freshStore();
  try {
    const receipt = recordConsent(store, consentInput(), consentPolicy());
    const withdrawal = withdrawConsent(store, { receiptId: receipt.receiptId, actorId: "visitor-1", idempotencyKey: "withdraw-1", at: "2026-08-28T12:01:00.000Z" }, consentPolicy());
    assert.deepEqual(withdrawal.clearIdentifiers, ["ltm_preferences", "ltm_analytics", "ltm_advertising", "ltm_attribution"]);
    assert.equal(eligibleTags(consentPolicy(), store.read().records.consents[receipt.receiptId]).tags.length, 0);
    const task = acknowledgeWithdrawal(store, { receiptId: receipt.receiptId, processorId: "analytics-processor", state: "deleted", receiptSha256: D.d, actorId: "privacy-worker", idempotencyKey: "withdraw-ack-1", at: "2026-08-28T12:02:00.000Z" });
    assert.equal(task.state, "deleted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B59-R05 server attribution deduplicates conversion and records confidence", () => {
  const { root, store } = freshStore();
  try {
    const receipt = recordConsent(store, consentInput(), consentPolicy());
    const event = {
      eventId: "event-1", eventType: "purchase", occurredAt: AT, anonymousIdSha256: D.e, campaignId: "campaign-1", channel: "social",
      conversionId: "conversion-1", valueBucket: "medium", consentReceiptId: receipt.receiptId, handoffId: "handoff-1", blockedClientSignal: false,
    };
    const stored = recordAttributionEvent(store, { event, actorId: "attribution-worker", idempotencyKey: "attribution-1", at: AT }, consentPolicy(), NOW);
    assert.equal(stored.confidence, "high");
    throwsCode("ATTRIBUTION_DUPLICATE", () => recordAttributionEvent(store, { event: { ...event, eventId: "event-2" }, actorId: "attribution-worker", idempotencyKey: "attribution-2", at: AT }, consentPolicy(), NOW));
    assert.deepEqual(attributionHealth(store).byConfidence, { high: 1, medium: 0, low: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B60-R01/B60-R02 versioned campaign issues real QR and resolves only enrolled destinations", async () => {
  const { root, store } = freshStore();
  try {
    configureCampaign(store, { campaign: campaign(), actorId: "campaign-operator", idempotencyKey: "campaign-v1", at: AT }, campaignPolicy());
    const artifact = await issueCampaignEntry(store, { campaignId: "campaign-1", ttlSeconds: 600, entryId: "entrytoken0123456789abcdxy" }, campaignPolicy(), SECRET, NOW);
    assert.match(artifact.qrSvg, /^<svg/u);
    assert.match(artifact.qrSvg, /<path/u);
    const resolved = resolveCampaignEntry(store, { token: artifact.token, client: "ios", destination: "https://evil.example" }, campaignPolicy(), SECRET, NOW);
    assert.equal(resolved.redirect, "ltmapp://campaign/campaign-1");
    assert.equal(resolved.attributionHandoff.confidence, "high");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B60-R02/B60-R03 rejects open redirects, guessable codes, and sensitive QR bindings", () => {
  throwsCode("DESTINATION_NOT_ALLOWED", () => validateCampaign(campaign({ destinations: { ...campaign().destinations, web: "https://evil.example/redirect" } }), campaignPolicy()));
  throwsCode("SHORT_CODE_ENTROPY_INSUFFICIENT", () => validateCampaign(campaign({ shortCode: "short" }), campaignPolicy()));
  throwsCode("QR_SENSITIVE_DATA_FORBIDDEN", () => validateCampaign(campaign({ qrBinding: { kind: "employee", id: "child-face-id" } }), campaignPolicy()));
});

test("B60-R04 pause or security incident invalidates already-issued entry tokens", async () => {
  const { root, store } = freshStore();
  try {
    configureCampaign(store, { campaign: campaign(), actorId: "campaign-operator", idempotencyKey: "campaign-v1", at: AT }, campaignPolicy());
    const artifact = await issueCampaignEntry(store, { campaignId: "campaign-1", ttlSeconds: 600, entryId: "entrytoken0123456789abcdxy" }, campaignPolicy(), SECRET, NOW);
    changeCampaignState(store, { campaignId: "campaign-1", state: "paused", reason: "security-incident", version: "v2", actorId: "security-operator", idempotencyKey: "campaign-pause", at: "2026-08-28T12:01:00.000Z" });
    const result = resolveCampaignEntry(store, { token: artifact.token, client: "web" }, campaignPolicy(), SECRET, new Date("2026-08-28T12:02:00.000Z"));
    assert.deepEqual(result, { status: "gone", httpStatus: 410, recoveryPath: "/campaign-unavailable", redirect: null });
    await rejectsCode("CAMPAIGN_ENTRY_DISABLED", () => issueCampaignEntry(store, { campaignId: "campaign-1", ttlSeconds: 600 }, campaignPolicy(), SECRET, NOW));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B60-R05 funnel monitoring deduplicates and detects impossible sequences", () => {
  const report = campaignFunnelHealth([
    { eventId: "event-1", eventType: "arrival" },
    { eventId: "event-1", eventType: "arrival" },
    { eventId: "event-2", eventType: "purchase" },
  ]);
  assert.equal(report.status, "degraded");
  assert.deepEqual(report.anomalies, ["duplicate-events", "arrival-without-click", "purchase-without-generation"]);
});
