import assert from "node:assert/strict";
import test from "node:test";
import { applyContactLifecycleEvent, consumeAnonymousUnsubscribe, evaluateContactEligibility, exportAuthenticatedPreferences, issueAnonymousUnsubscribeToken, savePreferences } from "../src/index.mjs";
import { AT, auth, D, NOW, preferences, SECRET, store } from "./fixtures.mjs";

function throws(code, operation) { assert.throws(operation, (error) => error?.code === code); }

test("B73-R01 versions purpose/channel/region preferences and forbids minor marketing", () => {
  const state = store(); const result = savePreferences(state, { preferences: preferences(), authorization: auth("account-owner", "notification-preferences"), idempotencyKey: "pref-save-1", at: AT });
  assert.equal(result.policyVersion, "policy-v1"); assert.equal(Object.keys(state.read().records.preferences).length, 1);
  throws("MINOR_MARKETING_FORBIDDEN", () => savePreferences(state, { preferences: preferences({ contactId: "minor-1", isMinor: true }), authorization: auth("account-owner", "notification-preferences"), idempotencyKey: "pref-minor", at: AT }));
});

test("B73-R02 enforces global/purpose/channel unsubscribe, quiet hours, caps, and safety exception", () => {
  const state = store(); savePreferences(state, { preferences: preferences({ globalUnsubscribed: true, frequencyCaps: { hour: 0, day: 0, week: 0 } }), authorization: auth("account-owner", "notification-preferences"), idempotencyKey: "pref-save-2", at: AT });
  assert.equal(evaluateContactEligibility(state, { tenantId: "tenant-1", accountId: "account-1", contactId: "contact-1", purpose: "marketing", priority: "normal", channel: "email", policyVersion: "policy-v1" }, new Date("2026-08-28T23:00:00.000Z")).code, "GLOBAL_UNSUBSCRIBED");
  assert.equal(evaluateContactEligibility(state, { tenantId: "tenant-1", accountId: "account-1", contactId: "contact-1", purpose: "security", priority: "emergency", channel: "email", policyVersion: "policy-v1" }, new Date("2026-08-28T23:00:00.000Z")).code, "EMERGENCY_SECURITY_EXCEPTION");
});

test("B73-R03 recalculates current tenant/contact/policy state on every eligibility check", () => {
  const state = store(); savePreferences(state, { preferences: preferences(), authorization: auth("account-owner", "notification-preferences"), idempotencyKey: "pref-save-3", at: AT });
  assert.equal(evaluateContactEligibility(state, { tenantId: "tenant-1", accountId: "account-1", contactId: "contact-1", purpose: "generation", priority: "normal", channel: "email", policyVersion: "policy-v1" }, NOW).eligible, true);
  assert.equal(evaluateContactEligibility(state, { tenantId: "tenant-1", accountId: "account-1", contactId: "contact-1", purpose: "generation", priority: "normal", channel: "email", policyVersion: "old" }, NOW).code, "POLICY_VERSION_STALE");
  applyContactLifecycleEvent(state, { authorization: auth("privacy-operator", "contact-lifecycle"), event: { eventId: "delete-contact", tenantId: "tenant-1", accountId: "account-1", contactId: "contact-1", type: "data-deleted", replacementContactId: null, endpointReference: null, endpointSha256: null, occurredAt: "2026-08-28T12:01:00.000Z" } });
  assert.equal(evaluateContactEligibility(state, { tenantId: "tenant-1", accountId: "account-1", contactId: "contact-1", purpose: "generation", priority: "normal", channel: "email", policyVersion: "policy-v1" }, NOW).code, "CONTACT_POLICY_UNKNOWN");
});

test("B73-R04 isolates endpoint changes and never restores opt-out during merge/delete", () => {
  const state = store(); savePreferences(state, { preferences: preferences({ globalUnsubscribed: true }), authorization: auth("account-owner", "notification-preferences"), idempotencyKey: "pref-save-4", at: AT });
  const changed = applyContactLifecycleEvent(state, { authorization: auth("identity-service", "contact-lifecycle"), event: { eventId: "contact-change", tenantId: "tenant-1", accountId: "account-1", contactId: "contact-1", type: "endpoint-changed", replacementContactId: "contact-2", endpointReference: "contact-vault:endpoint-2", endpointSha256: D.a, occurredAt: "2026-08-28T12:01:00.000Z" } });
  assert.equal(changed.replacementState, "pending-verification"); assert.equal(state.read().records.contacts["contact-1"].state, "isolated-replaced");
  throws("CONTACT_NOT_FOUND", () => applyContactLifecycleEvent(state, { authorization: auth("identity-service", "contact-lifecycle"), event: { eventId: "bad-change", tenantId: "tenant-1", accountId: "other", contactId: "contact-2", type: "data-deleted", replacementContactId: null, endpointReference: null, endpointSha256: null, occurredAt: "2026-08-28T12:02:00.000Z" } }));
});

test("B73-R05 anonymous unsubscribe is signed/non-enumerating and authenticated export is audited", () => {
  const state = store(); savePreferences(state, { preferences: preferences(), authorization: auth("account-owner", "notification-preferences"), idempotencyKey: "pref-save-5", at: AT });
  const token = issueAnonymousUnsubscribeToken({ tenantId: "tenant-1", accountId: "account-1", contactId: "contact-1", scope: "global", channel: null, expiresInSeconds: 600 }, SECRET, NOW);
  const result = consumeAnonymousUnsubscribe(state, { token, authorization: auth("public-endpoint", "anonymous-unsubscribe"), idempotencyKey: "anon-unsubscribe-1", at: "2026-08-28T12:01:00.000Z" }, SECRET, NOW);
  assert.equal(result.accepted, true); assert.equal(state.read().records.preferences["tenant-1:account-1:contact-1"].globalUnsubscribed, true);
  const purposeToken = issueAnonymousUnsubscribeToken({ tenantId: "tenant-1", accountId: "account-1", contactId: "contact-1", scope: "purpose", purpose: "generation", channel: null, expiresInSeconds: 600 }, SECRET, NOW); consumeAnonymousUnsubscribe(state, { token: purposeToken, authorization: auth("public-endpoint", "anonymous-unsubscribe"), idempotencyKey: "anon-unsubscribe-purpose", at: "2026-08-28T12:01:30.000Z" }, SECRET, NOW); assert.equal(state.read().records.preferences["tenant-1:account-1:contact-1"].purposeEnabled.generation, false);
  throws("UNSUBSCRIBE_SCOPE_INVALID", () => issueAnonymousUnsubscribeToken({ tenantId: "tenant-1", accountId: "account-1", contactId: "contact-1", scope: "purpose", purpose: null, channel: null, expiresInSeconds: 600 }, SECRET, NOW));
  const missingToken = issueAnonymousUnsubscribeToken({ tenantId: "tenant-1", accountId: "missing", contactId: "missing", scope: "global", channel: null, expiresInSeconds: 600 }, SECRET, NOW);
  assert.deepEqual(consumeAnonymousUnsubscribe(state, { token: missingToken, authorization: auth("public-endpoint", "anonymous-unsubscribe"), idempotencyKey: "anon-unsubscribe-2", at: "2026-08-28T12:02:00.000Z" }, SECRET, NOW), result);
  assert.equal(exportAuthenticatedPreferences(state, { tenantId: "tenant-1", accountId: "account-1", authorization: auth("account-owner", "notification-preferences") }).preferences.length, 1);
});
