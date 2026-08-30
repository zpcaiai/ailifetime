import { authorization, bool, digest, exact, escapeHtml, fail, id, integer, iso, list, locale, object, oneOf, safeText, sha256, signToken, text, verifyToken } from "./contracts.mjs";
import { NOTIFICATION_CHANNELS, NOTIFICATION_PURPOSES } from "./preferences.mjs";

export const TEMPLATE_EVENT_TYPES = Object.freeze(["generation-completed", "payment", "refund", "order", "shipment", "family-invitation", "security", "annual-update", "partner-event"]);
export const MANDATORY_AI_DISCLOSURE = "AI-generated artistic simulations are illustrative, not predictive.";
export const MANDATORY_UNSUBSCRIBE_TEXT = "Manage notification preferences or unsubscribe.";

function variableDefinition(value, index) {
  const variable = object(value, `variables[${index}]`);
  exact(variable, ["name", "type", "classification", "required", "maximumLength"], `variables[${index}]`);
  return { name: id(variable.name, `variables[${index}].name`), type: oneOf(variable.type, ["string", "integer", "money-minor", "timestamp", "controlled-link"], "variable type"), classification: oneOf(variable.classification, ["public", "account", "transaction", "confidential"], "classification"), required: bool(variable.required, "required"), maximumLength: integer(variable.maximumLength, "maximumLength", 1, 2000) };
}

function approval(value, index) {
  const item = object(value, `approvals[${index}]`); exact(item, ["approvalId", "role", "actorId", "evidenceSha256", "approvedAt"], `approvals[${index}]`);
  return { approvalId: id(item.approvalId, "approvalId"), role: oneOf(item.role, ["content", "compliance", "brand", "security"], "approval role"), actorId: id(item.actorId, "approval actor"), evidenceSha256: digest(item.evidenceSha256, "evidenceSha256"), approvedAt: iso(item.approvedAt, "approvedAt") };
}

export function validateNotificationTemplate(value) {
  const template = object(value, "notification template");
  exact(template, ["templateId", "version", "tenantId", "brandId", "locale", "region", "channel", "purpose", "eventType", "parentVersion", "subject", "body", "variables", "allowedLinkOrigins", "aiDisclosure", "unsubscribeText", "legalText", "state", "approvals", "scheduledAt", "expiresAt", "createdAt"], "notification template");
  const variables = list(template.variables, "variables", { minimum: 0, maximum: 100, item: variableDefinition });
  if (new Set(variables.map((item) => item.name)).size !== variables.length) fail("TEMPLATE_VARIABLE_DUPLICATE", "template variable names must be unique");
  const subject = safeText(template.subject, "subject", 500); const body = safeText(template.body, "body", 20_000);
  const referenced = new Set([...subject.matchAll(/\{\{([A-Za-z0-9._:-]+)\}\}/gu), ...body.matchAll(/\{\{([A-Za-z0-9._:-]+)\}\}/gu)].map((match) => match[1]));
  for (const name of referenced) if (!variables.some((item) => item.name === name)) fail("TEMPLATE_VARIABLE_UNDECLARED", `variable ${name} is undeclared`);
  if (/\{\{\{|<%|\beval\s*\(|\bimport\s*\(/u.test(`${subject}${body}`)) fail("TEMPLATE_CODE_FORBIDDEN", "template executable expressions are forbidden");
  const state = oneOf(template.state, ["draft", "review", "approved", "scheduled", "published", "withdrawn", "expired"], "state");
  const scheduledAt = template.scheduledAt === null ? null : iso(template.scheduledAt, "scheduledAt"); const expiresAt = iso(template.expiresAt, "expiresAt");
  if (scheduledAt !== null && new Date(expiresAt) <= new Date(scheduledAt)) fail("TEMPLATE_WINDOW_INVALID", "template expiry must follow schedule");
  if (template.aiDisclosure !== MANDATORY_AI_DISCLOSURE || template.unsubscribeText !== MANDATORY_UNSUBSCRIBE_TEXT) fail("MANDATORY_COPY_INVALID", "AI disclosure and unsubscribe copy cannot be overridden");
  const normalized = {
    schemaVersion: "ltm.notification-template.v1", templateId: id(template.templateId, "templateId"), version: id(template.version, "version"), tenantId: id(template.tenantId, "tenantId"), brandId: id(template.brandId, "brandId"), locale: locale(template.locale), region: id(template.region, "region"), channel: oneOf(template.channel, NOTIFICATION_CHANNELS, "channel"), purpose: oneOf(template.purpose, NOTIFICATION_PURPOSES, "purpose"), eventType: oneOf(template.eventType, TEMPLATE_EVENT_TYPES, "eventType"), parentVersion: template.parentVersion === null ? null : id(template.parentVersion, "parentVersion"), subject, body, variables,
    allowedLinkOrigins: list(template.allowedLinkOrigins, "allowedLinkOrigins", { minimum: 1, maximum: 20, item: (origin, label) => { let url; try { url = new URL(text(origin, label, 2048)); } catch { fail("TEMPLATE_LINK_ORIGIN_INVALID", "link origin is invalid"); } if (url.protocol !== "https:" || url.origin !== url.toString().replace(/\/$/u, "")) fail("TEMPLATE_LINK_ORIGIN_INVALID", "link origin must be canonical HTTPS origin"); return url.origin; } }),
    aiDisclosure: MANDATORY_AI_DISCLOSURE, unsubscribeText: MANDATORY_UNSUBSCRIBE_TEXT, legalText: safeText(template.legalText, "legalText", 2000), state,
    approvals: list(template.approvals, "approvals", { maximum: 10, item: approval }), scheduledAt, expiresAt, createdAt: iso(template.createdAt, "createdAt"),
  };
  if (normalized.purpose === "security" && normalized.eventType !== "security") fail("TEMPLATE_PURPOSE_MISMATCH", "security templates must use the security event type");
  if (normalized.channel !== "inapp" && variables.some((item) => item.classification === "confidential")) fail("TEMPLATE_CLASSIFICATION_FORBIDDEN", "confidential variables are allowed only in-app");
  return normalized;
}

export function saveTemplateVersion(store, input) {
  const template = validateNotificationTemplate(input.template);
  authorization(input.authorization, { tenantId: template.tenantId, roles: ["template-editor"], purpose: "template-management" });
  if (template.state !== "draft") fail("TEMPLATE_STATE_INVALID", "new template version must be draft");
  return store.transact({ authorization: input.authorization, tenantId: template.tenantId, purpose: "template-management", action: "template.save", subject: `${template.templateId}:${template.version}`, idempotencyKey: input.idempotencyKey, at: input.at, input: template }, (records) => {
    const key = `${template.tenantId}:${template.templateId}`; const aggregate = records.templates[key] ?? { versions: {}, currentVersion: null, history: [] };
    if (aggregate.versions[template.version] !== undefined) fail("TEMPLATE_VERSION_IMMUTABLE", "template version already exists");
    if (template.parentVersion !== null && aggregate.versions[template.parentVersion] === undefined) fail("TEMPLATE_PARENT_MISSING", "parent template version is unavailable");
    aggregate.versions[template.version] = template; aggregate.history.push({ operation: "saved", version: template.version, actorId: input.authorization.actorId, at: input.at }); records.templates[key] = aggregate;
    return { templateId: template.templateId, version: template.version, state: "draft" };
  });
}

function renderValue(definition, value) {
  if (value === undefined || value === null) { if (definition.required) fail("TEMPLATE_VARIABLE_REQUIRED", `${definition.name} is required`); return ""; }
  if (definition.type === "integer" || definition.type === "money-minor") { if (!Number.isSafeInteger(value)) fail("TEMPLATE_VARIABLE_TYPE", `${definition.name} must be integer`); return String(value); }
  if (definition.type === "timestamp") return iso(value, definition.name);
  if (definition.type === "controlled-link") { if (typeof value !== "string" || value.length > 2048) fail("TEMPLATE_VARIABLE_TYPE", `${definition.name} must be a controlled link token`); return value; }
  return escapeHtml(text(value, definition.name, definition.maximumLength));
}

export function renderTemplate(templateValue, variablesValue) {
  const template = validateNotificationTemplate(templateValue); const variables = object(variablesValue, "variables");
  const expected = template.variables.map((item) => item.name).sort(); const actual = Object.keys(variables).sort();
  if (actual.some((name) => !expected.includes(name))) fail("TEMPLATE_VARIABLE_UNDECLARED", "render variables contain undeclared fields");
  const rendered = Object.fromEntries(template.variables.map((definition) => [definition.name, renderValue(definition, variables[definition.name])]));
  const replace = (content) => content.replaceAll(/\{\{([A-Za-z0-9._:-]+)\}\}/gu, (_match, name) => rendered[name]);
  const subject = replace(template.subject); const body = `${replace(template.body)}\n\n${template.aiDisclosure}\n${template.legalText}\n${template.unsubscribeText}`;
  return { schemaVersion: "ltm.notification-render.v1", templateId: template.templateId, templateVersion: template.version, channel: template.channel, subject, body, contentSha256: sha256({ subject, body }), dimensions: { subjectCharacters: [...subject].length, bodyCharacters: [...body].length, estimatedSmsSegments: template.channel === "sms" ? Math.ceil([...body].length / 67) : null } };
}

export function createControlledLink({ origin, path, tenantId, contactId, purpose, ttlSeconds }, allowedOrigins, secret, now = new Date()) {
  let base; try { base = new URL(text(origin, "origin", 2048)); } catch { fail("CONTROLLED_LINK_INVALID", "origin is invalid"); }
  if (base.protocol !== "https:" || !allowedOrigins.includes(base.origin) || base.username !== "" || base.password !== "") fail("CONTROLLED_LINK_INVALID", "origin is not enrolled");
  const normalizedPath = text(path, "path", 512); if (!/^\/[A-Za-z0-9/_-]*$/u.test(normalizedPath) || normalizedPath.includes("..")) fail("CONTROLLED_LINK_INVALID", "path is unsafe");
  const iat = Math.floor(now.getTime() / 1000); const token = signToken({ schemaVersion: "ltm.notification-link.v1", audience: "notification-link", tenantId: id(tenantId, "tenantId"), contactId: id(contactId, "contactId"), purpose: oneOf(purpose, NOTIFICATION_PURPOSES, "purpose"), path: normalizedPath, iat, exp: iat + integer(ttlSeconds, "ttlSeconds", 60, 604800) }, secret);
  return `${base.origin}${normalizedPath}?token=${encodeURIComponent(token)}`;
}

export function resolveControlledLink(urlValue, allowedOrigins, secret, now = new Date()) {
  let url; try { url = new URL(text(urlValue, "url", 8192)); } catch { fail("CONTROLLED_LINK_INVALID", "URL is invalid"); }
  if (url.protocol !== "https:" || !allowedOrigins.includes(url.origin) || url.username !== "" || url.password !== "" || url.hash !== "") fail("CONTROLLED_LINK_INVALID", "URL origin is not enrolled");
  const token = url.searchParams.get("token"); if (token === null || [...url.searchParams.keys()].some((key) => key !== "token")) fail("CONTROLLED_LINK_INVALID", "URL query is invalid");
  const claims = verifyToken(token, secret, { schemaVersion: "ltm.notification-link.v1", audience: "notification-link" }, now);
  if (claims.path !== url.pathname) fail("TOKEN_BINDING_MISMATCH", "link path does not match token");
  return claims;
}

export function previewTemplate(templateValue, variables) {
  const rendered = renderTemplate(templateValue, variables);
  return { ...rendered, viewport: rendered.channel === "email" ? { width: 600, height: 800 } : rendered.channel === "push" ? { width: 390, height: 160 } : { width: 390, height: 844 }, testOnly: true };
}

export function approveAndPublishTemplate(store, input, now = new Date()) {
  const tenantId = id(input.tenantId, "tenantId"); const templateId = id(input.templateId, "templateId"); const version = id(input.version, "version");
  const auth = authorization(input.authorization, { tenantId, roles: ["template-publisher"], purpose: "template-management" }); if (!auth.stepUp) fail("STEP_UP_REQUIRED", "template publication requires step-up");
  const approvals = list(input.approvals, "approvals", { minimum: 1, maximum: 10, item: approval });
  if (!approvals.some((item) => item.role === "content") || !approvals.some((item) => item.role === "compliance") || new Set(approvals.map((item) => item.actorId)).size < 2) fail("TWO_PERSON_APPROVAL_REQUIRED", "content and compliance approval by distinct actors is required");
  return store.transact({ authorization: input.authorization, tenantId, purpose: "template-management", action: "template.publish", subject: `${templateId}:${version}`, idempotencyKey: input.idempotencyKey, at: input.at, input: { templateId, version, approvals } }, (records) => {
    const aggregate = records.templates[`${tenantId}:${templateId}`]; const template = aggregate?.versions[version];
    if (template === undefined) fail("TEMPLATE_NOT_FOUND", "template is unavailable");
    if (new Date(template.expiresAt) <= now) fail("TEMPLATE_EXPIRED", "template has expired");
    template.approvals = approvals; template.state = template.scheduledAt !== null && new Date(template.scheduledAt) > now ? "scheduled" : "published";
    aggregate.currentVersion = template.state === "published" ? version : aggregate.currentVersion; aggregate.history.push({ operation: template.state, version, actorId: auth.actorId, at: input.at });
    return { templateId, version, state: template.state, diffSha256: sha256({ parentVersion: template.parentVersion, content: template }) };
  });
}

export function resolveTemplate(store, query, now = new Date()) {
  const tenantId = id(query.tenantId, "tenantId"); const candidates = Object.values(store.read().records.templates).flatMap((aggregate) => Object.values(aggregate.versions)).filter((template) => template.tenantId === tenantId && template.templateId === query.templateId && template.brandId === query.brandId && template.locale === query.locale && template.region === query.region && template.channel === query.channel && template.purpose === query.purpose && template.state === "published" && new Date(template.expiresAt) > now);
  const exactVersion = candidates.find((item) => item.version === query.version);
  if (exactVersion === undefined) fail(query.purpose === "marketing" ? "TEMPLATE_NOT_FOUND" : "MANDATORY_TRANSACTION_TEMPLATE_MISSING", "an exact active template is required; marketing fallback is forbidden");
  return exactVersion;
}

export function rollbackTemplate(store, input) {
  const tenantId = id(input.tenantId, "tenantId"); const auth = authorization(input.authorization, { tenantId, roles: ["template-publisher"], purpose: "template-management" }); if (!auth.stepUp) fail("STEP_UP_REQUIRED", "template rollback requires step-up");
  return store.transact({ authorization: input.authorization, tenantId, purpose: "template-management", action: "template.rollback", subject: `${input.templateId}:${input.targetVersion}`, idempotencyKey: input.idempotencyKey, at: input.at, input: { templateId: input.templateId, targetVersion: input.targetVersion, reason: input.reason } }, (records) => {
    const aggregate = records.templates[`${tenantId}:${id(input.templateId, "templateId")}`]; const target = aggregate?.versions[id(input.targetVersion, "targetVersion")];
    if (target === undefined || target.state !== "published") fail("ROLLBACK_TARGET_INVALID", "rollback target must be a published immutable version");
    aggregate.currentVersion = target.version; aggregate.history.push({ operation: "rolled-back", version: target.version, actorId: auth.actorId, reason: text(input.reason, "reason", 1000), at: input.at });
    return { templateId: target.templateId, currentVersion: target.version, cacheInvalidationRequired: true };
  });
}

export function authorizeTestSend({ recipientReference, controlledRecipientReferences, production }) {
  const reference = text(recipientReference, "recipientReference", 512); const allowed = list(controlledRecipientReferences, "controlledRecipientReferences", { minimum: 1, maximum: 100 });
  if (bool(production, "production") && !allowed.includes(reference)) fail("TEST_RECIPIENT_DENIED", "production test sends require an enrolled recipient reference");
  return { allowed: true, recipientReference: reference };
}
