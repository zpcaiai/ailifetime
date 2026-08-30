import assert from "node:assert/strict";
import test from "node:test";
import { dispatchMessage, EmailProviderAdapter, hmac, InAppProviderAdapter, ingestProviderCallback, PushProviderAdapter, registerProviderConfiguration, SandboxNotificationAdapter, savePreferences, selectProvider, SmsProviderAdapter, validateMessageCommand, WechatProviderAdapter } from "../src/index.mjs";
import { AT, auth, command, D, NOW, preferences, providerConfiguration, SECRET, store } from "./fixtures.mjs";

function throws(code, operation) { assert.throws(operation, (error) => error?.code === code); }
async function rejects(code, operation) { await assert.rejects(operation, (error) => error?.code === code); }
function setup() { const state = store(); savePreferences(state, { preferences: preferences(), authorization: auth("account-owner", "notification-preferences"), idempotencyKey: "b74-pref", at: AT }); registerProviderConfiguration(state, { tenantId: "tenant-1", configuration: providerConfiguration(), authorization: auth("notification-admin", "provider-configuration"), idempotencyKey: "provider-email", at: AT }); return state; }

test("B74-R01 validates channel-neutral replay-safe message command contract", () => {
  const value = validateMessageCommand(command()); assert.equal(value.traceId, "trace-1"); assert.equal(value.channels.length, 2);
  throws("CONTRACT_FIELDS_INVALID", () => validateMessageCommand({ ...command(), mediaUrl: "https://private.example/media" }));
  throws("MESSAGE_DEADLINE_INVALID", () => validateMessageCommand(command({ deadline: AT })));
});

test("B74-R02 provides email/SMS/push/WeChat/in-app HTTP adapters and deterministic sandbox adapters", async () => {
  const transport = { request: async (request) => ({ status: 202, externalMessageId: `external-${request.body.commandId}`, receiptSha256: D.a }) };
  const configuration = { providerId: "real-provider", endpoint: "https://notify.example.com/v1/send", credentialReference: "secret-manager:notifications/provider" };
  const adapters = [new EmailProviderAdapter(configuration, transport), new SmsProviderAdapter(configuration, transport), new PushProviderAdapter(configuration, transport), new WechatProviderAdapter(configuration, transport), new InAppProviderAdapter(configuration, transport)];
  assert.deepEqual(adapters.map((adapter) => adapter.channel), ["email", "sms", "push", "wechat", "inapp"]);
  const receipt = await new SandboxNotificationAdapter("email").send({ idempotencyKey: "same-send", traceId: "trace", payload: { commandId: "c" }, timeoutMs: 1000 }); assert.equal(receipt.productionEvidence, false);
  const second = await new SandboxNotificationAdapter("sms").send({ idempotencyKey: "same-send", traceId: "trace", payload: { commandId: "c" }, timeoutMs: 1000 }); assert.equal(second.channel, "sms");
});

test("B74-R03 verifies, deduplicates and state-maps provider callbacks", async () => {
  const state = setup(); const adapter = new SandboxNotificationAdapter("email", "provider-email-1"); const sent = await dispatchMessage(state, { command: command(), authorization: auth("notification-worker", "notification-send"), at: AT }, new Map([["provider-email-1", adapter]]), NOW);
  const timestamp = "2026-08-28T12:01:00.000Z"; const callback = { callbackId: "callback-1", tenantId: "tenant-1", providerId: "provider-email-1", externalMessageId: sent.externalMessageId, state: "delivered", occurredAt: timestamp, receiptSha256: D.b }; const rawBody = JSON.stringify(callback); const signature = hmac(`${timestamp}.${rawBody}`, SECRET);
  const input = { timestamp, rawBody, signature, authorization: auth("provider-callback", "provider-callback") };
  assert.equal(ingestProviderCallback(state, input, SECRET, new Date(timestamp)).state, "delivered"); assert.equal(ingestProviderCallback(state, input, SECRET, new Date(timestamp)).state, "delivered");
  throws("CALLBACK_SIGNATURE_INVALID", () => ingestProviderCallback(state, { ...input, signature: D.c }, SECRET, new Date(timestamp)));
});

test("B74-R04 routing uses region/template/health/cost and never falls back across denied channels", () => {
  const state = store(); savePreferences(state, { preferences: preferences({ channelEnabled: { email: true, sms: false, push: false, wechat: false, inapp: false } }), authorization: auth("account-owner", "notification-preferences"), idempotencyKey: "b74-route-pref", at: AT });
  registerProviderConfiguration(state, { tenantId: "tenant-1", configuration: providerConfiguration({ providerId: "email-degraded", health: "degraded", costMicros: 1 }), authorization: auth("notification-admin", "provider-configuration"), idempotencyKey: "route-email-1", at: AT });
  registerProviderConfiguration(state, { tenantId: "tenant-1", configuration: providerConfiguration({ providerId: "email-healthy", costMicros: 500 }), authorization: auth("notification-admin", "provider-configuration"), idempotencyKey: "route-email-2", at: AT });
  registerProviderConfiguration(state, { tenantId: "tenant-1", configuration: providerConfiguration({ providerId: "sms-healthy", channel: "sms" }), authorization: auth("notification-admin", "provider-configuration"), idempotencyKey: "route-sms", at: AT });
  assert.equal(selectProvider(state, command(), NOW).providerId, "email-healthy");
  const disabled = store(); savePreferences(disabled, { preferences: preferences({ channelEnabled: { email: false, sms: false, push: false, wechat: false, inapp: false } }), authorization: auth("account-owner", "notification-preferences"), idempotencyKey: "b74-disabled-pref", at: AT }); registerProviderConfiguration(disabled, { tenantId: "tenant-1", configuration: providerConfiguration(), authorization: auth("notification-admin", "provider-configuration"), idempotencyKey: "disabled-provider", at: AT }); throws("NO_CONSENTED_PROVIDER_ROUTE", () => selectProvider(disabled, command(), NOW));
});

test("B74-R05 provider configuration stores only governed secret/sender/certificate references with rotation audit", () => {
  const state = store(); const result = registerProviderConfiguration(state, { tenantId: "tenant-1", configuration: providerConfiguration({ health: "rotating", version: "v2" }), authorization: auth("notification-admin", "provider-configuration"), idempotencyKey: "provider-config-good", at: AT }); assert.equal(result.rotationAuditRequired, true);
  assert.equal(JSON.stringify(state.read()).includes("actual-api-key"), false);
  throws("PROVIDER_CONFIGURATION_REFERENCE_INVALID", () => registerProviderConfiguration(state, { tenantId: "tenant-1", configuration: providerConfiguration({ providerId: "bad-provider", credentialReference: "actual-api-key" }), authorization: auth("notification-admin", "provider-configuration"), idempotencyKey: "provider-config-bad", at: AT }));
});
