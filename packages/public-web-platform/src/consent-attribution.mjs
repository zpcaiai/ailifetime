import {
  boolean,
  digest,
  enumValue,
  exactKeys,
  escapeHtml,
  fail,
  httpsUrl,
  identifier,
  integer,
  locale,
  plainObject,
  requiredString,
  sanitizeText,
  sha256,
  stringArray,
  timestamp,
} from "./contracts.mjs";

export const CONSENT_PURPOSES = Object.freeze(["essential", "preferences", "analytics", "advertising"]);
const FORBIDDEN_ATTRIBUTION_FIELDS = Object.freeze([
  "raw_photo", "photo", "face", "face_feature", "biometric", "future_self_dialogue", "private_dialogue",
  "minor_identity", "child_identity", "health", "payment", "email", "phone", "name", "address",
]);

function validateChoices(value) {
  const choices = plainObject(value, "choices");
  exactKeys(choices, CONSENT_PURPOSES, "choices");
  const normalized = Object.fromEntries(CONSENT_PURPOSES.map((purpose) => [purpose, boolean(choices[purpose], `choices.${purpose}`)]));
  if (normalized.essential !== true) fail("ESSENTIAL_PURPOSE_REQUIRED", "essential processing remains enabled independently of marketing consent");
  return normalized;
}

function validateTag(value, index, policy) {
  const tag = plainObject(value, `tags[${index}]`);
  exactKeys(tag, ["tagId", "purpose", "domain", "proxyUrl", "dataFields", "cspSource"], `tags[${index}]`);
  const purpose = enumValue(tag.purpose, CONSENT_PURPOSES, `tags[${index}].purpose`);
  const domain = requiredString(tag.domain, `tags[${index}].domain`, 253).toLowerCase();
  if (!policy.allowedTagDomains.includes(domain)) fail("TAG_DOMAIN_NOT_ALLOWED", `tag domain ${domain} is not enrolled`);
  const proxy = httpsUrl(tag.proxyUrl, `tags[${index}].proxyUrl`, { allowedOrigins: policy.allowedProxyOrigins });
  if (!proxy.pathname.startsWith("/marketing-proxy/")) fail("TAG_PROXY_REQUIRED", "third-party tags must use the controlled proxy path");
  const dataFields = stringArray(tag.dataFields, `tags[${index}].dataFields`, { maximum: 50, itemMaximum: 64 });
  if (dataFields.some((field) => FORBIDDEN_ATTRIBUTION_FIELDS.some((forbidden) => field.toLowerCase().includes(forbidden)))) {
    fail("SENSITIVE_ATTRIBUTION_DATA", "tag manifest requests a forbidden sensitive field");
  }
  const cspSource = requiredString(tag.cspSource, `tags[${index}].cspSource`, 256);
  if (new URL(`https://${domain}`).origin !== cspSource) fail("CSP_SOURCE_MISMATCH", "tag CSP source must exactly bind its enrolled domain");
  return { tagId: identifier(tag.tagId, `tags[${index}].tagId`), purpose, domain, proxyUrl: proxy.toString(), dataFields, cspSource };
}

export function validateConsentPolicy(value) {
  const policy = plainObject(value, "consent policy");
  exactKeys(policy, [
    "schemaVersion", "policyId", "version", "region", "noticeSha256", "allowedTagDomains", "allowedProxyOrigins",
    "tags", "downstreamProcessors", "attributionWindowDays",
  ], "consent policy");
  if (policy.schemaVersion !== "ltm.marketing-consent-policy.v1") fail("CONSENT_POLICY_INVALID", "consent policy schema is unsupported");
  const allowedTagDomains = stringArray(policy.allowedTagDomains, "allowedTagDomains", { maximum: 100, itemMaximum: 253 }).map((item) => item.toLowerCase());
  const allowedProxyOrigins = stringArray(policy.allowedProxyOrigins, "allowedProxyOrigins", { minimum: 1, maximum: 10, itemMaximum: 256 })
    .map((item, index) => httpsUrl(item, `allowedProxyOrigins[${index}]`).origin);
  const normalized = {
    schemaVersion: "ltm.marketing-consent-policy.v1",
    policyId: identifier(policy.policyId, "policyId"),
    version: identifier(policy.version, "version"),
    region: identifier(policy.region, "region"),
    noticeSha256: digest(policy.noticeSha256, "noticeSha256"),
    allowedTagDomains,
    allowedProxyOrigins,
    downstreamProcessors: stringArray(policy.downstreamProcessors, "downstreamProcessors", { maximum: 50, itemMaximum: 128 }).map((item) => identifier(item, "downstreamProcessor")),
    attributionWindowDays: integer(policy.attributionWindowDays, "attributionWindowDays", 1, 180),
  };
  if (!Array.isArray(policy.tags) || policy.tags.length > 100) fail("TAG_MANIFEST_INVALID", "tags must be a bounded array");
  const tags = policy.tags.map((tag, index) => validateTag(tag, index, normalized));
  if (new Set(tags.map((tag) => tag.tagId)).size !== tags.length) fail("TAG_MANIFEST_INVALID", "tag IDs must be unique");
  return { ...normalized, tags };
}

export function recordConsent(store, input, policyValue) {
  const policy = validateConsentPolicy(policyValue);
  const receiptId = identifier(input.receiptId, "receiptId");
  const choices = validateChoices(input.choices);
  const recordedAt = timestamp(input.at, "at");
  const receipt = {
    schemaVersion: "ltm.marketing-consent-receipt.v1",
    receiptId,
    subjectKeySha256: digest(input.subjectKeySha256, "subjectKeySha256"),
    deviceKeySha256: digest(input.deviceKeySha256, "deviceKeySha256"),
    region: policy.region,
    policyId: policy.policyId,
    policyVersion: policy.version,
    noticeSha256: policy.noticeSha256,
    source: enumValue(input.source, ["banner", "privacy-center", "account-settings"], "source"),
    choices,
    recordedAt,
    withdrawnAt: null,
    state: "active",
  };
  return store.transact({
    actorId: input.actorId,
    action: "consent.record",
    subject: receiptId,
    idempotencyKey: input.idempotencyKey,
    input: receipt,
    at: recordedAt,
  }, (records) => {
    if (records.consents[receiptId] !== undefined) fail("CONSENT_RECEIPT_EXISTS", "consent receipt already exists");
    records.consents[receiptId] = receipt;
    return receipt;
  });
}

export function eligibleTags(policyValue, receipt) {
  const policy = validateConsentPolicy(policyValue);
  if (receipt?.state !== "active" || receipt.withdrawnAt !== null || receipt.policyId !== policy.policyId || receipt.policyVersion !== policy.version || receipt.noticeSha256 !== policy.noticeSha256) {
    return { tags: [], csp: ["'self'"], reason: "consent-unavailable-or-stale" };
  }
  const tags = policy.tags.filter((tag) => receipt.choices[tag.purpose] === true);
  return { tags, csp: ["'self'", ...new Set(tags.map((tag) => tag.cspSource))], reason: "consent-matched" };
}

export function renderRegionalConsentInterface(policyValue, copyValue) {
  const policy = validateConsentPolicy(policyValue);
  const copy = plainObject(copyValue, "consent interface copy");
  exactKeys(copy, ["locale", "title", "description", "purposeLabels", "acceptAll", "rejectOptional", "save"], "consent interface copy");
  const purposeLabels = plainObject(copy.purposeLabels, "purposeLabels");
  exactKeys(purposeLabels, CONSENT_PURPOSES, "purposeLabels");
  const labels = Object.fromEntries(CONSENT_PURPOSES.map((purpose) => [purpose, sanitizeText(purposeLabels[purpose], `purposeLabels.${purpose}`, 160)]));
  const normalizedLocale = locale(copy.locale);
  const choiceHtml = CONSENT_PURPOSES.map((purpose) => `<label><input type="checkbox" name="${purpose}" value="true"${purpose === "essential" ? " checked disabled aria-disabled=\"true\"" : ""}>${escapeHtml(labels[purpose])}</label>`).join("");
  return {
    schemaVersion: "ltm.regional-consent-interface.v1",
    policyId: policy.policyId,
    policyVersion: policy.version,
    region: policy.region,
    locale: normalizedLocale,
    html: `<section lang="${escapeHtml(normalizedLocale)}" aria-labelledby="consent-title" data-region="${escapeHtml(policy.region)}" data-policy-version="${escapeHtml(policy.version)}"><h2 id="consent-title">${escapeHtml(sanitizeText(copy.title, "title", 160))}</h2><p>${escapeHtml(sanitizeText(copy.description, "description", 1_000))}</p><form method="post" action="/privacy/consent">${choiceHtml}<button name="action" value="accept-all">${escapeHtml(sanitizeText(copy.acceptAll, "acceptAll", 100))}</button><button name="action" value="reject-optional">${escapeHtml(sanitizeText(copy.rejectOptional, "rejectOptional", 100))}</button><button name="action" value="save">${escapeHtml(sanitizeText(copy.save, "save", 100))}</button></form></section>`,
  };
}

export function scanTagExecution(policyValue, receipt, observations) {
  const policy = validateConsentPolicy(policyValue);
  if (!Array.isArray(observations) || observations.length > 10_000) fail("TAG_SCAN_INVALID", "tag observations must be a bounded array");
  const eligible = new Map(eligibleTags(policy, receipt).tags.map((tag) => [tag.tagId, tag]));
  const configured = new Map(policy.tags.map((tag) => [tag.tagId, tag]));
  const violations = [];
  const normalized = observations.map((value, index) => {
    const observation = plainObject(value, `observations[${index}]`);
    exactKeys(observation, ["tagId", "networkOrigin", "dataFields", "loaded"], `observations[${index}]`);
    const tagId = identifier(observation.tagId, `observations[${index}].tagId`);
    const loaded = boolean(observation.loaded, `observations[${index}].loaded`);
    const networkOrigin = httpsUrl(observation.networkOrigin, `observations[${index}].networkOrigin`).origin;
    const dataFields = stringArray(observation.dataFields, `observations[${index}].dataFields`, { maximum: 100, itemMaximum: 64 });
    const manifest = configured.get(tagId);
    if (manifest === undefined) violations.push({ tagId, code: "TAG_NOT_ENROLLED" });
    else if (loaded) {
      if (!eligible.has(tagId)) violations.push({ tagId, code: "CONSENT_NOT_GRANTED" });
      if (networkOrigin !== manifest.cspSource) violations.push({ tagId, code: "NETWORK_ORIGIN_NOT_ALLOWED" });
      for (const field of dataFields) if (!manifest.dataFields.includes(field)) violations.push({ tagId, code: "DATA_FIELD_NOT_DECLARED", field });
    }
    return { tagId, networkOrigin, dataFields, loaded };
  });
  return { schemaVersion: "ltm.tag-execution-scan.v1", status: violations.length === 0 ? "PASS" : "FAIL", observations: normalized, violations };
}

export function enforceTagExecution(policyValue, receipt, observations) {
  const report = scanTagExecution(policyValue, receipt, observations);
  if (report.status !== "PASS") fail("TAG_EXECUTION_BLOCKED", "tag execution violated consent or egress policy", report.violations);
  return report;
}

export function withdrawConsent(store, input, policyValue) {
  const policy = validateConsentPolicy(policyValue);
  const receiptId = identifier(input.receiptId, "receiptId");
  return store.transact({
    actorId: input.actorId,
    action: "consent.withdraw",
    subject: receiptId,
    idempotencyKey: input.idempotencyKey,
    input,
    at: input.at,
  }, (records) => {
    const receipt = records.consents[receiptId];
    if (receipt === undefined) fail("CONSENT_NOT_FOUND", "consent receipt does not exist");
    if (receipt.policyId !== policy.policyId) fail("CONSENT_POLICY_MISMATCH", "receipt belongs to another policy");
    if (receipt.state === "withdrawn") return receipt.withdrawal;
    const withdrawnAt = timestamp(input.at, "at");
    receipt.state = "withdrawn";
    receipt.withdrawnAt = withdrawnAt;
    receipt.choices = { essential: true, preferences: false, analytics: false, advertising: false };
    receipt.withdrawal = {
      collectionStoppedAt: withdrawnAt,
      clearIdentifiers: ["ltm_preferences", "ltm_analytics", "ltm_advertising", "ltm_attribution"],
      downstreamTasks: policy.downstreamProcessors.map((processorId) => ({ processorId, operation: "delete-marketing-identifiers", state: "pending", receiptId })),
      auditSha256: sha256({ receiptId, withdrawnAt, processors: policy.downstreamProcessors }),
    };
    return receipt.withdrawal;
  });
}

export function acknowledgeWithdrawal(store, input) {
  const receiptId = identifier(input.receiptId, "receiptId");
  const processorId = identifier(input.processorId, "processorId");
  return store.transact({
    actorId: input.actorId,
    action: "consent.withdrawal-acknowledge",
    subject: `${receiptId}:${processorId}`,
    idempotencyKey: input.idempotencyKey,
    input,
    at: input.at,
  }, (records) => {
    const task = records.consents[receiptId]?.withdrawal?.downstreamTasks?.find((candidate) => candidate.processorId === processorId);
    if (task === undefined) fail("WITHDRAWAL_TASK_NOT_FOUND", "downstream withdrawal task does not exist");
    task.state = enumValue(input.state, ["deleted", "not-found", "failed"], "state");
    task.acknowledgedAt = timestamp(input.at, "at");
    task.receiptSha256 = digest(input.receiptSha256, "receiptSha256");
    return task;
  });
}

export function validateAttributionEvent(value) {
  const event = plainObject(value, "attribution event");
  exactKeys(event, [
    "eventId", "eventType", "occurredAt", "anonymousIdSha256", "campaignId", "channel", "conversionId",
    "valueBucket", "consentReceiptId", "handoffId", "blockedClientSignal",
  ], "attribution event");
  return {
    eventId: identifier(event.eventId, "eventId"),
    eventType: enumValue(event.eventType, ["click", "arrival", "upload", "generation", "purchase", "share", "partner-lead"], "eventType"),
    occurredAt: timestamp(event.occurredAt, "occurredAt"),
    anonymousIdSha256: digest(event.anonymousIdSha256, "anonymousIdSha256"),
    campaignId: identifier(event.campaignId, "campaignId"),
    channel: identifier(event.channel, "channel"),
    conversionId: event.conversionId === null ? null : identifier(event.conversionId, "conversionId"),
    valueBucket: enumValue(event.valueBucket, ["none", "low", "medium", "high"], "valueBucket"),
    consentReceiptId: identifier(event.consentReceiptId, "consentReceiptId"),
    handoffId: event.handoffId === null ? null : identifier(event.handoffId, "handoffId"),
    blockedClientSignal: boolean(event.blockedClientSignal, "blockedClientSignal"),
  };
}

export function recordAttributionEvent(store, input, policyValue, now = new Date()) {
  const policy = validateConsentPolicy(policyValue);
  const event = validateAttributionEvent(input.event);
  return store.transact({
    actorId: input.actorId,
    action: "attribution.record",
    subject: event.eventId,
    idempotencyKey: input.idempotencyKey,
    input: event,
    at: input.at,
  }, (records) => {
    const consent = records.consents[event.consentReceiptId];
    if (consent?.state !== "active" || consent.choices.analytics !== true) fail("CONSENT_REQUIRED", "analytics consent is required for attribution collection");
    if (records.attribution[event.eventId] !== undefined) fail("ATTRIBUTION_DUPLICATE", "event already exists");
    if (event.conversionId !== null && Object.values(records.attribution).some((prior) => prior.conversionId === event.conversionId)) {
      fail("ATTRIBUTION_DUPLICATE", "conversion is already attributed");
    }
    const ageDays = (now.getTime() - new Date(event.occurredAt).getTime()) / 86_400_000;
    if (ageDays < 0 || ageDays > policy.attributionWindowDays) fail("ATTRIBUTION_WINDOW_EXPIRED", "event is outside the attribution window");
    const confidence = event.blockedClientSignal ? "low" : event.handoffId === null ? "medium" : "high";
    const stored = { ...event, confidence, serverRecordedAt: timestamp(input.at, "at"), dedupeKeySha256: sha256({ campaignId: event.campaignId, conversionId: event.conversionId, eventType: event.eventType }) };
    records.attribution[event.eventId] = stored;
    return stored;
  });
}

export function attributionHealth(store) {
  const events = Object.values(store.read().records.attribution);
  const byConfidence = { high: 0, medium: 0, low: 0 };
  for (const event of events) byConfidence[event.confidence] += 1;
  const duplicateConversions = events.filter((event) => event.conversionId !== null).length - new Set(events.map((event) => event.conversionId).filter(Boolean)).size;
  return {
    schemaVersion: "ltm.attribution-health.v1",
    eventCount: events.length,
    byConfidence,
    duplicateConversions,
    status: duplicateConversions === 0 ? "healthy" : "degraded",
  };
}
