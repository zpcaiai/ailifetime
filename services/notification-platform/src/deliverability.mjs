import { authorization, bool, digest, exact, fail, id, integer, iso, list, object, oneOf, sha256, text } from "./contracts.mjs";
import { NOTIFICATION_CHANNELS, NOTIFICATION_PURPOSES } from "./preferences.mjs";
import { selectProvider, validateMessageCommand } from "./providers.mjs";

export function registerSenderAsset(store, input) {
  const asset = object(input.asset, "sender asset");
  exact(asset, ["assetId", "tenantId", "type", "providerId", "region", "verification", "secretOrCertificateReference", "rotationState", "verifiedAt", "expiresAt"], "sender asset");
  const tenantId = id(asset.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["deliverability-admin"], purpose: "sender-governance" });
  const type = oneOf(asset.type, ["email-domain", "sms-sender", "push-certificate", "wechat-template"], "type");
  const verification = object(asset.verification, "verification");
  const required = type === "email-domain" ? ["spf", "dkim", "dmarc"] : type === "sms-sender" ? ["signature", "template"] : type === "push-certificate" ? ["certificate", "topic"] : ["account", "template"];
  exact(verification, required, "verification"); for (const key of required) if (verification[key] !== "verified") fail("SENDER_ASSET_UNVERIFIED", `${key} must be verified`);
  const normalized = { schemaVersion: "ltm.sender-asset.v1", assetId: id(asset.assetId, "assetId"), tenantId, type, providerId: id(asset.providerId, "providerId"), region: id(asset.region, "region"), verification, secretOrCertificateReference: text(asset.secretOrCertificateReference, "secretOrCertificateReference", 512), rotationState: oneOf(asset.rotationState, ["current", "rotating", "retiring", "revoked"], "rotationState"), verifiedAt: iso(asset.verifiedAt, "verifiedAt"), expiresAt: iso(asset.expiresAt, "expiresAt") };
  if (!normalized.secretOrCertificateReference.startsWith("secret-manager:")) fail("SENDER_SECRET_REFERENCE_INVALID", "sender credentials must use a secret-manager reference");
  if (new Date(normalized.expiresAt) <= new Date(normalized.verifiedAt)) fail("SENDER_ASSET_WINDOW_INVALID", "sender expiry must follow verification");
  return store.transact({ authorization: input.authorization, tenantId, purpose: "sender-governance", action: "sender-asset.register", subject: normalized.assetId, idempotencyKey: input.idempotencyKey, at: input.at, input: normalized }, (records) => { records.deliverability.senderAssets ??= {}; records.deliverability.senderAssets[`${tenantId}:${normalized.assetId}`] = normalized; return { assetId: normalized.assetId, rotationState: normalized.rotationState, productionVerificationRequired: true }; });
}

export function applySuppressionFromDelivery(store, input) {
  const event = object(input.event, "delivery suppression event"); exact(event, ["eventId", "tenantId", "contactId", "channel", "purpose", "state", "occurredAt", "providerReceiptSha256"], "delivery suppression event");
  const tenantId = id(event.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["deliverability-worker"], purpose: "delivery-governance" });
  const state = oneOf(event.state, ["hard-bounce", "soft-bounce", "complained", "invalid-number", "uninstalled-token"], "state");
  return store.transact({ authorization: input.authorization, tenantId, purpose: "delivery-governance", action: "suppression.apply", subject: id(event.contactId, "contactId"), idempotencyKey: id(event.eventId, "eventId"), at: event.occurredAt, input: event }, (records) => {
    const channel = oneOf(event.channel, NOTIFICATION_CHANNELS, "channel"); const purpose = oneOf(event.purpose, NOTIFICATION_PURPOSES, "purpose");
    if (state === "soft-bounce") return { suppressed: false, retryable: true, maximumRetries: 2 };
    const scope = state === "complained" ? { channel, purpose: "marketing" } : { channel, purpose };
    const key = `${tenantId}:${event.contactId}:${scope.channel}:${scope.purpose}`;
    records.suppressions[key] = { tenantId, contactId: id(event.contactId, "contactId"), ...scope, reason: state, occurredAt: iso(event.occurredAt, "occurredAt"), providerReceiptSha256: digest(event.providerReceiptSha256, "providerReceiptSha256"), state: "active" };
    return { suppressed: true, key, retryable: false };
  });
}

export function recordDeliverabilityFact(store, input) {
  const fact = object(input.fact, "deliverability fact"); exact(fact, ["factId", "tenantId", "region", "providerId", "templateId", "channel", "event", "latencyMs", "costMicros", "trackingConsent", "occurredAt"], "deliverability fact");
  const tenantId = id(fact.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["deliverability-worker"], purpose: "delivery-analytics" });
  const event = oneOf(fact.event, ["accepted", "delivered", "opened", "clicked", "failed", "bounced", "complained", "expired"], "event");
  if (["opened", "clicked"].includes(event) && !bool(fact.trackingConsent, "trackingConsent")) fail("TRACKING_CONSENT_REQUIRED", "open/click tracking requires regional consent");
  const normalized = { factId: id(fact.factId, "factId"), tenantId, region: id(fact.region, "region"), providerId: id(fact.providerId, "providerId"), templateId: id(fact.templateId, "templateId"), channel: oneOf(fact.channel, NOTIFICATION_CHANNELS, "channel"), event, latencyMs: integer(fact.latencyMs, "latencyMs", 0, 86_400_000), costMicros: integer(fact.costMicros, "costMicros", 0, 1_000_000_000), trackingConsent: fact.trackingConsent, occurredAt: iso(fact.occurredAt, "occurredAt") };
  return store.transact({ authorization: input.authorization, tenantId, purpose: "delivery-analytics", action: "deliverability.record", subject: normalized.factId, idempotencyKey: normalized.factId, at: normalized.occurredAt, input: normalized }, (records) => { records.analytics.push({ schemaVersion: "ltm.deliverability-fact.v1", ...normalized }); return { factId: normalized.factId, recorded: true }; });
}

export function deliverabilityReport(store, input) {
  const tenantId = id(input.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["deliverability-analyst", "notification-admin"], purpose: "delivery-analytics" });
  const facts = store.read().records.analytics.filter((fact) => fact.tenantId === tenantId && (!input.region || fact.region === input.region) && (!input.providerId || fact.providerId === input.providerId) && (!input.templateId || fact.templateId === input.templateId));
  const counts = Object.fromEntries(["accepted", "delivered", "opened", "clicked", "failed", "bounced", "complained", "expired"].map((event) => [event, facts.filter((fact) => fact.event === event).length]));
  const accepted = Math.max(counts.accepted, 1); const latency = facts.map((fact) => fact.latencyMs).sort((a, b) => a - b);
  const alerts = [];
  if (counts.bounced / accepted > 0.05) alerts.push("bounce-rate"); if (counts.complained / accepted > 0.001) alerts.push("complaint-rate"); if ((latency[Math.floor(latency.length * 0.95)] ?? 0) > 300_000) alerts.push("p95-latency");
  return { schemaVersion: "ltm.deliverability-report.v1", tenantId, counts, ratesBasisPoints: { delivered: Math.round(counts.delivered / accepted * 10_000), bounced: Math.round(counts.bounced / accepted * 10_000), complained: Math.round(counts.complained / accepted * 10_000) }, p95LatencyMs: latency[Math.floor(latency.length * 0.95)] ?? null, costMicros: facts.reduce((sum, fact) => sum + fact.costMicros, 0), alerts, readSemantics: "Provider delivery/open metrics do not prove a human read the message." };
}

export function planProviderFailover(store, input, now = new Date()) {
  const command = validateMessageCommand(input.command); authorization(input.authorization, { tenantId: command.tenantId, roles: ["deliverability-worker"], purpose: "provider-failover" });
  const prior = store.read().records.messages[command.commandId]; if (prior === undefined || !["failed", "expired", "dispatching"].includes(prior.state)) fail("FAILOVER_STATE_INVALID", "message is not eligible for failover");
  const disabledProviderId = id(input.disabledProviderId, "disabledProviderId");
  const state = store.read(); const configKey = `${command.tenantId}:${disabledProviderId}`; const disabled = state.records.providerConfigs[configKey]; if (disabled !== undefined) disabled.health = "down";
  let alternative;
  try {
    const clone = { read: () => state };
    alternative = selectProvider(clone, input.command, now);
  } catch (error) {
    if (error?.code !== "NO_CONSENTED_PROVIDER_ROUTE") throw error;
    return { commandId: command.commandId, state: command.priority === "high" || command.priority === "emergency" ? "manual-intervention" : "dead-letter", reason: "no-consented-alternative", crossChannelFallback: false };
  }
  if (alternative.providerId === disabledProviderId) fail("FAILOVER_PROVIDER_INVALID", "failover selected the disabled provider");
  return { commandId: command.commandId, providerId: alternative.providerId, channel: alternative.channel, idempotencyKey: command.idempotencyKey, crossChannelFallback: alternative.channel !== prior.channel, consentReevaluated: true };
}

export function registerDeliverabilityOperations(store, input) {
  const plan = object(input.plan, "deliverability operations plan"); exact(plan, ["planId", "tenantId", "purchasedLists", "warmupDailyCaps", "capacityPerMinute", "blacklistRunbookSha256", "incidentRunbookSha256", "postmortemTemplateSha256", "reviewedAt", "expiresAt"], "deliverability operations plan");
  const tenantId = id(plan.tenantId, "tenantId"); const auth = authorization(input.authorization, { tenantId, roles: ["deliverability-admin"], purpose: "sender-governance" }); if (!auth.stepUp) fail("STEP_UP_REQUIRED", "operations plan requires step-up");
  if (bool(plan.purchasedLists, "purchasedLists")) fail("PURCHASED_LISTS_FORBIDDEN", "purchased recipient lists are forbidden");
  const normalized = { planId: id(plan.planId, "planId"), tenantId, purchasedLists: false, warmupDailyCaps: list(plan.warmupDailyCaps, "warmupDailyCaps", { minimum: 3, maximum: 90, item: (value, label) => integer(value, label, 1, 10_000_000) }), capacityPerMinute: integer(plan.capacityPerMinute, "capacityPerMinute", 1, 10_000_000), blacklistRunbookSha256: digest(plan.blacklistRunbookSha256, "blacklistRunbookSha256"), incidentRunbookSha256: digest(plan.incidentRunbookSha256, "incidentRunbookSha256"), postmortemTemplateSha256: digest(plan.postmortemTemplateSha256, "postmortemTemplateSha256"), reviewedAt: iso(plan.reviewedAt, "reviewedAt"), expiresAt: iso(plan.expiresAt, "expiresAt") };
  if (new Date(normalized.expiresAt) <= new Date(normalized.reviewedAt)) fail("OPERATIONS_PLAN_EXPIRED", "operations plan validity is invalid");
  return store.transact({ authorization: input.authorization, tenantId, purpose: "sender-governance", action: "deliverability.operations", subject: normalized.planId, idempotencyKey: input.idempotencyKey, at: input.at, input: normalized }, (records) => { records.deliverability.operations ??= {}; records.deliverability.operations[normalized.planId] = normalized; return { planId: normalized.planId, capacityPerMinute: normalized.capacityPerMinute, reviewRequired: true }; });
}
