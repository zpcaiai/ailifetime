import { timingSafeEqual } from "node:crypto";
import { authorization, bool, digest, exact, fail, hmac, id, integer, iso, list, object, oneOf, sha256, text } from "./contracts.mjs";
import { evaluateContactEligibility, NOTIFICATION_CHANNELS, NOTIFICATION_PURPOSES } from "./preferences.mjs";

export const DELIVERY_STATES = Object.freeze(["accepted", "delivered", "failed", "bounced", "complained", "expired"]);
export const MESSAGE_PRIORITIES = Object.freeze(["low", "normal", "high", "emergency"]);

export function validateMessageCommand(value) {
  const command = object(value, "message command");
  exact(command, ["commandId", "tenantId", "accountId", "contactId", "templateId", "templateVersion", "variablesSha256", "purpose", "priority", "deadline", "idempotencyKey", "traceId", "channels", "region", "policyVersion", "createdAt"], "message command");
  const createdAt = iso(command.createdAt, "createdAt"); const deadline = iso(command.deadline, "deadline");
  if (new Date(deadline) <= new Date(createdAt)) fail("MESSAGE_DEADLINE_INVALID", "deadline must follow createdAt");
  return {
    schemaVersion: "ltm.message-command.v1", commandId: id(command.commandId, "commandId"), tenantId: id(command.tenantId, "tenantId"), accountId: id(command.accountId, "accountId"), contactId: id(command.contactId, "contactId"),
    templateId: id(command.templateId, "templateId"), templateVersion: id(command.templateVersion, "templateVersion"), variablesSha256: digest(command.variablesSha256, "variablesSha256"),
    purpose: oneOf(command.purpose, NOTIFICATION_PURPOSES, "purpose"), priority: oneOf(command.priority, MESSAGE_PRIORITIES, "priority"), deadline,
    idempotencyKey: id(command.idempotencyKey, "idempotencyKey"), traceId: id(command.traceId, "traceId"), channels: list(command.channels, "channels", { minimum: 1, maximum: NOTIFICATION_CHANNELS.length, item: (item, label) => oneOf(item, NOTIFICATION_CHANNELS, label) }),
    region: id(command.region, "region"), policyVersion: id(command.policyVersion, "policyVersion"), createdAt,
  };
}

function validateHttpsEndpoint(value) {
  let url;
  try { url = new URL(text(value, "endpoint", 2048)); } catch { fail("PROVIDER_ENDPOINT_INVALID", "provider endpoint must be an HTTPS URL"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") fail("PROVIDER_ENDPOINT_INVALID", "provider endpoint must be credential-free HTTPS without fragment");
  return url.toString();
}

export class NotificationProviderAdapter {
  constructor({ providerId, channel, production }) { this.providerId = id(providerId, "providerId"); this.channel = oneOf(channel, NOTIFICATION_CHANNELS, "channel"); this.production = bool(production, "production"); }
  async send(_request) { fail("PROVIDER_ADAPTER_REQUIRED", "send must be implemented"); }
}

export class HttpNotificationProviderAdapter extends NotificationProviderAdapter {
  constructor(configuration, transport) {
    super({ providerId: configuration.providerId, channel: configuration.channel, production: true });
    this.endpoint = validateHttpsEndpoint(configuration.endpoint);
    this.credentialReference = text(configuration.credentialReference, "credentialReference", 512);
    if (!/^secret-manager:[A-Za-z0-9][A-Za-z0-9._:/-]{2,480}$/u.test(this.credentialReference)) fail("PROVIDER_SECRET_REFERENCE_INVALID", "credential must be a secret-manager reference");
    if (typeof transport?.request !== "function") fail("PROVIDER_TRANSPORT_INVALID", "transport.request is required");
    this.transport = transport;
  }
  async send(request) {
    const response = await this.transport.request({ method: "POST", url: this.endpoint, credentialReference: this.credentialReference, headers: { "content-type": "application/json", "idempotency-key": id(request.idempotencyKey, "idempotencyKey"), "x-ltm-trace-id": id(request.traceId, "traceId") }, body: object(request.payload, "provider payload"), timeoutMs: integer(request.timeoutMs, "timeoutMs", 100, 30_000) });
    if (response?.status !== 202 || typeof response.externalMessageId !== "string" || typeof response.receiptSha256 !== "string") fail("PROVIDER_RESPONSE_UNKNOWN", "provider did not return an accepted receipt");
    return { providerId: this.providerId, channel: this.channel, state: "accepted", externalMessageId: id(response.externalMessageId, "externalMessageId"), receiptSha256: digest(response.receiptSha256, "receiptSha256"), productionEvidence: true };
  }
}

export class EmailProviderAdapter extends HttpNotificationProviderAdapter { constructor(configuration, transport) { super({ ...configuration, channel: "email" }, transport); } }
export class SmsProviderAdapter extends HttpNotificationProviderAdapter { constructor(configuration, transport) { super({ ...configuration, channel: "sms" }, transport); } }
export class PushProviderAdapter extends HttpNotificationProviderAdapter { constructor(configuration, transport) { super({ ...configuration, channel: "push" }, transport); } }
export class WechatProviderAdapter extends HttpNotificationProviderAdapter { constructor(configuration, transport) { super({ ...configuration, channel: "wechat" }, transport); } }
export class InAppProviderAdapter extends HttpNotificationProviderAdapter { constructor(configuration, transport) { super({ ...configuration, channel: "inapp" }, transport); } }

export class SandboxNotificationAdapter extends NotificationProviderAdapter {
  constructor(channel, providerId = `sandbox-${channel}`) { super({ providerId, channel, production: false }); this.receipts = new Map(); }
  async send(request) {
    const key = id(request.idempotencyKey, "idempotencyKey");
    const receipt = this.receipts.get(key) ?? { providerId: this.providerId, channel: this.channel, state: "accepted", externalMessageId: `sandbox:${sha256(key).slice(0, 24)}`, receiptSha256: sha256({ providerId: this.providerId, key, payload: request.payload }), productionEvidence: false };
    this.receipts.set(key, receipt);
    return structuredClone(receipt);
  }
}

export function registerProviderConfiguration(store, input) {
  const config = object(input.configuration, "provider configuration");
  exact(config, ["providerId", "channel", "regions", "supportedTemplates", "credentialReference", "senderReference", "certificateReference", "quotaPerMinute", "costMicros", "deliveryBasisPoints", "health", "version", "validFrom", "validUntil"], "provider configuration");
  const tenantId = id(input.tenantId, "tenantId");
  authorization(input.authorization, { tenantId, roles: ["notification-admin"], purpose: "provider-configuration" });
  const normalized = { tenantId, providerId: id(config.providerId, "providerId"), channel: oneOf(config.channel, NOTIFICATION_CHANNELS, "channel"), regions: list(config.regions, "regions", { minimum: 1, maximum: 100, item: id }), supportedTemplates: list(config.supportedTemplates, "supportedTemplates", { minimum: 1, maximum: 1000, item: id }), credentialReference: text(config.credentialReference, "credentialReference", 512), senderReference: text(config.senderReference, "senderReference", 512), certificateReference: text(config.certificateReference, "certificateReference", 512), quotaPerMinute: integer(config.quotaPerMinute, "quotaPerMinute", 1, 1_000_000), costMicros: integer(config.costMicros, "costMicros", 0, 1_000_000_000), deliveryBasisPoints: integer(config.deliveryBasisPoints, "deliveryBasisPoints", 0, 10_000), health: oneOf(config.health, ["healthy", "degraded", "down", "rotating"], "health"), version: id(config.version, "version"), validFrom: iso(config.validFrom, "validFrom"), validUntil: iso(config.validUntil, "validUntil") };
  for (const [field, prefix] of [["credentialReference", "secret-manager:"], ["senderReference", "provider-config:"], ["certificateReference", "secret-manager:"]]) if (!normalized[field].startsWith(prefix)) fail("PROVIDER_CONFIGURATION_REFERENCE_INVALID", `${field} must use ${prefix}`);
  if (new Date(normalized.validUntil) <= new Date(normalized.validFrom)) fail("PROVIDER_CONFIGURATION_WINDOW_INVALID", "provider validity window is invalid");
  return store.transact({ authorization: input.authorization, tenantId, purpose: "provider-configuration", action: "provider.configure", subject: normalized.providerId, idempotencyKey: input.idempotencyKey, at: input.at, input: normalized }, (records) => {
    const key = `${tenantId}:${normalized.providerId}`; const prior = records.providerConfigs[key];
    if (prior !== undefined && prior.version === normalized.version && sha256(prior) !== sha256(normalized)) fail("PROVIDER_VERSION_IMMUTABLE", "provider configuration version is immutable");
    records.providerConfigs[key] = normalized;
    return { providerId: normalized.providerId, version: normalized.version, health: normalized.health, rotationAuditRequired: true };
  });
}

export function selectProvider(store, commandValue, now = new Date()) {
  const command = validateMessageCommand(commandValue); const state = store.read().records;
  const candidates = Object.values(state.providerConfigs).filter((config) => config.tenantId === command.tenantId && config.regions.includes(command.region) && command.channels.includes(config.channel) && config.supportedTemplates.includes(command.templateId) && config.health !== "down" && new Date(config.validFrom) <= now && new Date(config.validUntil) > now)
    .filter((config) => evaluateContactEligibility(store, { tenantId: command.tenantId, accountId: command.accountId, contactId: command.contactId, purpose: command.purpose, priority: command.priority, channel: config.channel, policyVersion: command.policyVersion }, now).eligible)
    .sort((left, right) => (left.health === right.health ? right.deliveryBasisPoints - left.deliveryBasisPoints || left.costMicros - right.costMicros : left.health === "healthy" ? -1 : 1));
  if (candidates.length === 0) fail("NO_CONSENTED_PROVIDER_ROUTE", "no compliant and consented provider route is available");
  return candidates[0];
}

export async function dispatchMessage(store, input, adapters, now = new Date()) {
  const command = validateMessageCommand(input.command);
  authorization(input.authorization, { tenantId: command.tenantId, roles: ["notification-worker"], purpose: "notification-send" });
  if (new Date(command.deadline) <= now) fail("MESSAGE_EXPIRED", "message deadline has passed");
  // Re-evaluate the original closed command at the routing boundary. Passing the
  // normalized value would add schemaVersion to the public contract and fail its
  // exact-field check; accepting that extra field would weaken fail-closed input
  // validation.
  const provider = selectProvider(store, input.command, now); const adapter = adapters.get(provider.providerId);
  if (!(adapter instanceof NotificationProviderAdapter) || adapter.channel !== provider.channel) fail("PROVIDER_ADAPTER_UNAVAILABLE", "selected provider adapter is unavailable");
  const plan = store.transact({ authorization: input.authorization, tenantId: command.tenantId, purpose: "notification-send", action: "message.plan", subject: command.commandId, idempotencyKey: command.idempotencyKey, at: input.at, input: command }, (records) => {
    if (records.messages[command.commandId] !== undefined) fail("MESSAGE_COMMAND_EXISTS", "message command identifier already exists");
    const message = { ...command, providerId: provider.providerId, channel: provider.channel, state: "dispatching", createdAt: command.createdAt, attempts: 0, externalMessageId: null, receiptSha256: null };
    records.messages[command.commandId] = message;
    return message;
  });
  if (["accepted", "delivered"].includes(plan.state)) return plan;
  const receipt = await adapter.send({ idempotencyKey: command.idempotencyKey, traceId: command.traceId, payload: { commandId: command.commandId, contactReference: command.contactId, templateId: command.templateId, templateVersion: command.templateVersion, variablesSha256: command.variablesSha256, purpose: command.purpose, deadline: command.deadline }, timeoutMs: 5_000 });
  return store.transact({ authorization: input.authorization, tenantId: command.tenantId, purpose: "notification-send", action: "message.accept", subject: command.commandId, idempotencyKey: `${command.idempotencyKey}:receipt`, at: input.at, input: receipt }, (records) => {
    const message = records.messages[command.commandId];
    if (message.providerId !== receipt.providerId) fail("PROVIDER_RECEIPT_MISMATCH", "receipt provider does not match plan");
    Object.assign(message, { state: receipt.state, attempts: message.attempts + 1, externalMessageId: receipt.externalMessageId, receiptSha256: receipt.receiptSha256, productionEvidence: receipt.productionEvidence });
    return message;
  });
}

export function ingestProviderCallback(store, input, secret, now = new Date()) {
  const timestamp = iso(input.timestamp, "timestamp");
  if (Math.abs(now.getTime() - new Date(timestamp).getTime()) > 300_000) fail("CALLBACK_TIMESTAMP_INVALID", "callback timestamp is outside replay window");
  const rawBody = text(input.rawBody, "rawBody", 65_536); const expected = hmac(`${timestamp}.${rawBody}`, secret);
  const actual = Buffer.from(text(input.signature, "signature", 64), "hex"); const wanted = Buffer.from(expected, "hex");
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) fail("CALLBACK_SIGNATURE_INVALID", "provider callback signature is invalid");
  let callback;
  try { callback = JSON.parse(rawBody); } catch { fail("CALLBACK_PAYLOAD_INVALID", "callback payload is invalid JSON"); }
  exact(callback, ["callbackId", "tenantId", "providerId", "externalMessageId", "state", "occurredAt", "receiptSha256"], "provider callback");
  const tenantId = id(callback.tenantId, "tenantId"); const callbackId = id(callback.callbackId, "callbackId");
  authorization(input.authorization, { tenantId, roles: ["provider-callback"], purpose: "provider-callback" });
  const normalized = { callbackId, tenantId, providerId: id(callback.providerId, "providerId"), externalMessageId: id(callback.externalMessageId, "externalMessageId"), state: oneOf(callback.state, DELIVERY_STATES, "state"), occurredAt: iso(callback.occurredAt, "occurredAt"), receiptSha256: digest(callback.receiptSha256, "receiptSha256") };
  return store.transact({ authorization: input.authorization, tenantId, purpose: "provider-callback", action: "callback.ingest", subject: callbackId, idempotencyKey: `${tenantId}:${callbackId}`, at: normalized.occurredAt, input: normalized }, (records) => {
    if (records.callbacks[callbackId] !== undefined) fail("CALLBACK_ID_CONFLICT", "callback identifier already exists in another scope");
    const message = Object.values(records.messages).find((item) => item.externalMessageId === normalized.externalMessageId && item.providerId === normalized.providerId && item.tenantId === tenantId);
    if (message === undefined) fail("CALLBACK_MESSAGE_NOT_FOUND", "callback message is unavailable");
    const allowed = message.state === "accepted" ? ["accepted", "delivered", "failed", "bounced", "complained", "expired"] : message.state === "delivered" ? ["delivered", "complained"] : [message.state];
    if (!allowed.includes(normalized.state)) fail("DELIVERY_STATE_REGRESSION", "provider callback would regress a delivery state");
    records.callbacks[callbackId] = normalized;
    message.state = normalized.state; message.callbackReceiptSha256 = normalized.receiptSha256;
    return { callbackId, commandId: message.commandId, state: message.state };
  });
}
