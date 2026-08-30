import {
  digest,
  enumValue,
  exactKeys,
  fail,
  identifier,
  integer,
  locale,
  plainObject,
  requiredString,
  sanitizeText,
  sha256,
  signToken,
  stringArray,
  timestamp,
  verifyToken,
} from "./contracts.mjs";

export const CONTENT_TYPES = Object.freeze([
  "article",
  "faq",
  "case-study",
  "template",
  "channel-page",
  "policy",
  "announcement",
  "media-asset",
  "help-document",
]);

export const EDITORIAL_STATES = Object.freeze([
  "draft",
  "review",
  "legal-review",
  "security-review",
  "approved",
  "scheduled",
  "published",
  "archived",
  "withdrawn",
]);

const TRANSITIONS = Object.freeze({
  draft: ["review"],
  review: ["legal-review", "security-review", "approved", "withdrawn"],
  "legal-review": ["security-review", "approved", "withdrawn"],
  "security-review": ["legal-review", "approved", "withdrawn"],
  approved: ["scheduled", "published", "withdrawn"],
  scheduled: ["published", "withdrawn"],
  published: ["archived", "withdrawn"],
  archived: ["review"],
  withdrawn: ["review"],
});

const EDITORIAL_ROLES = Object.freeze(["author", "editor", "legal", "security", "incident-commander"]);

function authorizeEditorial(input, operation, allowedRoles, authority, now = new Date()) {
  if (authority === undefined || typeof authority.resolve !== "function") fail("EDITORIAL_AUTHORITY_REQUIRED", "editorial authorization must be resolved by a trusted server authority");
  const authorizationId = identifier(input.authorizationId, "authorizationId");
  const authorization = plainObject(authority.resolve(authorizationId), "resolved editorial authorization");
  exactKeys(authorization, ["authorizationId", "actorId", "roles", "purpose", "expiresAt", "revokedAt"], "resolved editorial authorization");
  if (authorization.authorizationId !== authorizationId || authorization.revokedAt !== null || new Date(timestamp(authorization.expiresAt, "authorization.expiresAt")) <= now) fail("EDITORIAL_FORBIDDEN", "editorial authorization is missing, expired, or revoked");
  const actorId = identifier(authorization.actorId, "authorization.actorId");
  if (actorId !== identifier(input.actorId, "actorId")) fail("EDITORIAL_FORBIDDEN", "authorization actor does not match the write actor");
  const roles = stringArray(authorization.roles, "authorization.roles", { minimum: 1, maximum: EDITORIAL_ROLES.length }).map((role) => enumValue(role, EDITORIAL_ROLES, "editorial role"));
  if (!roles.some((role) => allowedRoles.includes(role))) fail("EDITORIAL_FORBIDDEN", `${operation} requires one of: ${allowedRoles.join(", ")}`);
  if (authorization.purpose !== "marketing-content") fail("EDITORIAL_FORBIDDEN", "editorial authorization is not purpose-bound to marketing content");
  return { actorId, roles, purpose: "marketing-content" };
}

function validateTranslation(value, index) {
  const translation = plainObject(value, `translations[${index}]`);
  exactKeys(translation, ["locale", "body", "sourceVersion", "sourceSha256", "status", "reviewedBy"], `translations[${index}]`);
  const status = enumValue(translation.status, ["pending", "in-review", "approved", "stale"], `translations[${index}].status`);
  const reviewedBy = translation.reviewedBy === null ? null : identifier(translation.reviewedBy, `translations[${index}].reviewedBy`);
  if (status === "approved" && reviewedBy === null) fail("TRANSLATION_REVIEW_REQUIRED", "approved translation requires a reviewer");
  return {
    locale: locale(translation.locale, `translations[${index}].locale`),
    body: sanitizeText(translation.body, `translations[${index}].body`, 100_000),
    sourceVersion: identifier(translation.sourceVersion, `translations[${index}].sourceVersion`),
    sourceSha256: digest(translation.sourceSha256, `translations[${index}].sourceSha256`),
    status,
    reviewedBy,
  };
}

function validateMediaReference(value, index) {
  const reference = plainObject(value, `mediaReferences[${index}]`);
  exactKeys(reference, ["mediaId", "sha256", "state", "alt"], `mediaReferences[${index}]`);
  return {
    mediaId: identifier(reference.mediaId, `mediaReferences[${index}].mediaId`),
    sha256: digest(reference.sha256, `mediaReferences[${index}].sha256`),
    state: enumValue(reference.state, ["ready", "revoked", "deleted"], `mediaReferences[${index}].state`),
    alt: sanitizeText(reference.alt, `mediaReferences[${index}].alt`, 200),
  };
}

export function validateContentDocument(value) {
  const content = plainObject(value, "content document");
  exactKeys(content, [
    "contentId", "type", "version", "title", "body", "sourceLocale", "requiredLocales", "translations",
    "mediaReferences", "state", "approvals", "scheduledAt", "publishedAt", "sourceSha256",
  ], "content document");
  const body = sanitizeText(content.body, "body", 100_000);
  const sourceSha256 = digest(content.sourceSha256, "sourceSha256");
  if (sha256(body) !== sourceSha256) fail("SOURCE_DIGEST_MISMATCH", "sourceSha256 must bind the exact source body");
  const sourceLocale = locale(content.sourceLocale, "sourceLocale");
  const requiredLocales = stringArray(content.requiredLocales, "requiredLocales", { minimum: 1, maximum: 30, itemMaximum: 16 }).map((item) => locale(item));
  if (!requiredLocales.includes(sourceLocale)) fail("CONTENT_LOCALE_INVALID", "requiredLocales must include sourceLocale");
  if (!Array.isArray(content.translations) || content.translations.length > 30) fail("TRANSLATIONS_INVALID", "translations must be bounded");
  const translations = content.translations.map(validateTranslation);
  if (new Set(translations.map((translation) => translation.locale)).size !== translations.length) fail("TRANSLATIONS_INVALID", "translation locales must be unique");
  const version = identifier(content.version, "version");
  for (const translation of translations) {
    if (translation.sourceVersion !== version || translation.sourceSha256 !== sourceSha256) {
      fail("TRANSLATION_SOURCE_DRIFT", "translation must bind the current source version and digest");
    }
  }
  if (!Array.isArray(content.mediaReferences) || content.mediaReferences.length > 100) fail("MEDIA_REFERENCES_INVALID", "media references must be bounded");
  const mediaReferences = content.mediaReferences.map(validateMediaReference);
  if (new Set(mediaReferences.map((reference) => reference.mediaId)).size !== mediaReferences.length) fail("MEDIA_REFERENCES_INVALID", "media references must be unique");
  const state = enumValue(content.state, EDITORIAL_STATES, "state");
  const approvals = stringArray(content.approvals, "approvals", { maximum: 20, itemMaximum: 64 });
  const type = enumValue(content.type, CONTENT_TYPES, "type");
  if (["approved", "scheduled", "published"].includes(state)) {
    if (type === "policy" && !approvals.includes("legal")) fail("LEGAL_APPROVAL_REQUIRED", "policy content requires independent legal approval");
    if (["policy", "announcement"].includes(type) && !approvals.includes("security")) fail("SECURITY_APPROVAL_REQUIRED", "policy and announcement content require security approval");
    const completed = new Set([sourceLocale, ...translations.filter((translation) => translation.status === "approved").map((translation) => translation.locale)]);
    if (requiredLocales.some((required) => !completed.has(required))) fail("MANDATORY_TRANSLATION_MISSING", "mandatory translations must be approved before publication");
  }
  if (state === "published" && mediaReferences.some((reference) => reference.state !== "ready")) fail("MEDIA_REFERENCE_INVALID", "published content cannot reference revoked or deleted media");
  return {
    contentId: identifier(content.contentId, "contentId"),
    type,
    version,
    title: sanitizeText(content.title, "title", 240),
    body,
    sourceLocale,
    requiredLocales,
    translations,
    mediaReferences,
    state,
    approvals,
    scheduledAt: content.scheduledAt === null ? null : timestamp(content.scheduledAt, "scheduledAt"),
    publishedAt: content.publishedAt === null ? null : timestamp(content.publishedAt, "publishedAt"),
    sourceSha256,
  };
}

export function createContent(store, input, authority) {
  authorizeEditorial(input, "content creation", ["author", "editor"], authority, new Date(input.at));
  const document = validateContentDocument(input.document);
  if (document.state !== "draft") fail("EDITORIAL_STATE_INVALID", "new content starts in draft");
  return store.transact({
    actorId: input.actorId,
    action: "content.create",
    subject: document.contentId,
    idempotencyKey: input.idempotencyKey,
    input: document,
    at: input.at,
  }, (records) => {
    if (records.content[document.contentId] !== undefined) fail("CONTENT_EXISTS", "content already exists");
    records.content[document.contentId] = { versions: { [document.version]: document }, currentVersion: document.version, workflow: [{ state: "draft", at: input.at, actorId: input.actorId }] };
    return { contentId: document.contentId, version: document.version, state: "draft", etag: contentEtag(document) };
  });
}

export function transitionContent(store, input, authority) {
  const contentId = identifier(input.contentId, "contentId");
  const targetState = enumValue(input.toState, EDITORIAL_STATES, "toState");
  const rolesByState = {
    review: ["author", "editor", "legal", "security"],
    "legal-review": ["editor", "legal"],
    "security-review": ["editor", "security"],
    approved: ["editor", "legal", "security"],
    scheduled: ["editor"],
    published: ["editor"],
    archived: ["editor"],
    withdrawn: input.emergency === true ? ["incident-commander"] : ["editor"],
    draft: ["editor"],
  };
  const authorization = authorizeEditorial(input, `transition to ${targetState}`, rolesByState[targetState], authority, new Date(input.at));
  return store.transact({
    actorId: input.actorId,
    action: input.emergency === true ? "content.emergency-withdraw" : "content.transition",
    subject: contentId,
    idempotencyKey: input.idempotencyKey,
    input,
    at: input.at,
  }, (records) => {
    const aggregate = records.content[contentId];
    if (aggregate === undefined) fail("CONTENT_NOT_FOUND", "content does not exist");
    const prior = aggregate.versions[aggregate.currentVersion];
    if (prior.version !== input.expectedVersion) fail("VERSION_CONFLICT", "content version changed");
    if (!TRANSITIONS[prior.state]?.includes(targetState)) fail("EDITORIAL_TRANSITION_INVALID", `${prior.state} cannot transition to ${targetState}`);
    if (input.emergency === true && !(prior.state === "published" && targetState === "withdrawn")) fail("EDITORIAL_TRANSITION_INVALID", "emergency action is limited to published withdrawal");
    if (targetState === "scheduled" && new Date(timestamp(input.scheduledAt, "scheduledAt")) <= new Date(timestamp(input.at, "at"))) fail("EDITORIAL_SCHEDULE_INVALID", "scheduled publication must be in the future");
    if (prior.state === "scheduled" && targetState === "published" && new Date(timestamp(input.at, "at")) < new Date(prior.scheduledAt)) fail("EDITORIAL_SCHEDULE_INVALID", "scheduled content cannot publish before its scheduled time");
    const approvals = stringArray(input.approvals, "approvals", { maximum: 20, itemMaximum: 64 });
    for (const approval of approvals) {
      if (["legal", "security"].includes(approval) && !authorization.roles.includes(approval)) fail("EDITORIAL_FORBIDDEN", `${approval} approval requires the corresponding independent role`);
    }
    const next = validateContentDocument({
      ...prior,
      state: targetState,
      approvals: [...new Set([...prior.approvals, ...approvals])],
      scheduledAt: targetState === "scheduled" ? timestamp(input.scheduledAt, "scheduledAt") : prior.scheduledAt,
      publishedAt: targetState === "published" ? timestamp(input.at, "at") : prior.publishedAt,
    });
    aggregate.versions[prior.version] = next;
    aggregate.workflow.push({ state: targetState, priorState: prior.state, at: input.at, actorId: input.actorId, reason: sanitizeText(input.reason, "reason", 500), emergency: input.emergency === true });
    return {
      contentId,
      version: prior.version,
      state: targetState,
      etag: contentEtag(next),
      cacheInvalidations: [`content:${contentId}`, ...next.requiredLocales.map((item) => `locale:${item}`)],
    };
  });
}

export function createPreviewToken(store, input, secret, now = new Date(), authority) {
  authorizeEditorial(input, "preview creation", ["author", "editor", "legal", "security"], authority, now);
  const state = store.read();
  const aggregate = state.records.content[identifier(input.contentId, "contentId")];
  if (aggregate === undefined) fail("CONTENT_NOT_FOUND", "content does not exist");
  const document = aggregate.versions[aggregate.currentVersion];
  if (document.version !== input.version) fail("VERSION_CONFLICT", "preview version is not current");
  if (document.state === "published") fail("PREVIEW_NOT_REQUIRED", "published content uses the public API");
  const ttlSeconds = integer(input.ttlSeconds, "ttlSeconds", 60, 900);
  const issuedAt = Math.floor(now.getTime() / 1_000);
  return signToken({
    schemaVersion: "ltm.content-preview-token.v1",
    audience: "editorial-preview",
    contentId: document.contentId,
    version: document.version,
    editorId: identifier(input.editorId, "editorId"),
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  }, secret);
}

export function resolvePreview(store, input, secret, now = new Date()) {
  const claims = verifyToken(input.token, secret, {
    schemaVersion: "ltm.content-preview-token.v1",
    audience: "editorial-preview",
    editorId: identifier(input.editorId, "editorId"),
  }, now);
  const aggregate = store.read().records.content[claims.contentId];
  const document = aggregate?.versions?.[claims.version];
  if (document === undefined || aggregate.currentVersion !== claims.version || document.state === "published") fail("PREVIEW_NOT_AVAILABLE", "preview content is unavailable");
  return { document, headers: { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" } };
}

export function publicContentProjection(store, contentId, requestedLocale) {
  const aggregate = store.read().records.content[identifier(contentId, "contentId")];
  const document = aggregate?.versions?.[aggregate.currentVersion];
  if (document === undefined || document.state !== "published") fail("CONTENT_NOT_FOUND", "published content does not exist");
  const selectedLocale = locale(requestedLocale);
  let body;
  if (selectedLocale === document.sourceLocale) body = document.body;
  else body = document.translations.find((translation) => translation.locale === selectedLocale && translation.status === "approved")?.body;
  if (body === undefined) fail("MANDATORY_TRANSLATION_MISSING", "published locale is unavailable");
  if (document.mediaReferences.some((reference) => reference.state !== "ready")) fail("MEDIA_REFERENCE_INVALID", "public content contains unavailable media");
  return {
    schemaVersion: "ltm.public-content.v1",
    contentId: document.contentId,
    type: document.type,
    version: document.version,
    locale: selectedLocale,
    title: document.title,
    body,
    mediaReferences: document.mediaReferences,
    etag: contentEtag(document),
    headers: { "cache-control": "public, max-age=60, stale-while-revalidate=300" },
  };
}

export function markSourceContentChanged(store, input, authority) {
  authorizeEditorial(input, "source content change", ["author", "editor"], authority, new Date(input.at));
  const contentId = identifier(input.contentId, "contentId");
  return store.transact({
    actorId: input.actorId,
    action: "content.source-change",
    subject: contentId,
    idempotencyKey: input.idempotencyKey,
    input,
    at: input.at,
  }, (records) => {
    const aggregate = records.content[contentId];
    if (aggregate === undefined) fail("CONTENT_NOT_FOUND", "content does not exist");
    const prior = aggregate.versions[aggregate.currentVersion];
    const version = identifier(input.newVersion, "newVersion");
    if (aggregate.versions[version] !== undefined) fail("VERSION_IMMUTABLE", "new content version already exists");
    const body = sanitizeText(input.body, "body", 100_000);
    const next = validateContentDocument({
      ...prior,
      version,
      body,
      sourceSha256: sha256(body),
      state: "draft",
      approvals: [],
      scheduledAt: null,
      publishedAt: null,
      translations: prior.translations.map((translation) => ({ ...translation, sourceVersion: version, sourceSha256: sha256(body), status: "stale", reviewedBy: null })),
    });
    aggregate.versions[version] = next;
    aggregate.currentVersion = version;
    aggregate.workflow.push({ state: "draft", priorState: prior.state, at: input.at, actorId: input.actorId, reason: "source-content-changed" });
    return { contentId, version, staleLocales: next.translations.map((translation) => translation.locale), state: "draft" };
  });
}

export function rollbackContentVersion(store, input, authority) {
  authorizeEditorial(input, "content rollback", ["editor", "incident-commander"], authority, new Date(input.at));
  const contentId = identifier(input.contentId, "contentId");
  const targetVersion = identifier(input.targetVersion, "targetVersion");
  const newVersion = identifier(input.newVersion, "newVersion");
  return store.transact({
    actorId: input.actorId,
    action: "content.rollback",
    subject: contentId,
    idempotencyKey: input.idempotencyKey,
    input,
    at: input.at,
  }, (records) => {
    const aggregate = records.content[contentId];
    const target = aggregate?.versions?.[targetVersion];
    if (target === undefined) fail("VERSION_NOT_FOUND", "content rollback target does not exist");
    if (aggregate.versions[newVersion] !== undefined) fail("VERSION_IMMUTABLE", "content rollback version already exists");
    const next = validateContentDocument({
      ...target,
      version: newVersion,
      state: "review",
      approvals: [],
      scheduledAt: null,
      publishedAt: null,
      translations: target.translations.map((translation) => ({
        ...translation,
        sourceVersion: newVersion,
        status: "stale",
        reviewedBy: null,
      })),
    });
    const priorVersion = aggregate.currentVersion;
    aggregate.versions[newVersion] = next;
    aggregate.currentVersion = newVersion;
    aggregate.workflow.push({ state: "review", priorState: aggregate.versions[priorVersion].state, priorVersion, rollbackTargetVersion: targetVersion, at: input.at, actorId: input.actorId, reason: sanitizeText(input.reason, "reason", 500) });
    return { contentId, priorVersion, targetVersion, version: newVersion, state: "review", publicationBlockedPendingReapproval: true };
  });
}

export function assertMediaDeletable(store, mediaId) {
  const target = identifier(mediaId, "mediaId");
  const references = [];
  for (const [contentId, aggregate] of Object.entries(store.read().records.content)) {
    const document = aggregate.versions[aggregate.currentVersion];
    if (["published", "scheduled"].includes(document.state) && document.mediaReferences.some((reference) => reference.mediaId === target)) references.push(contentId);
  }
  if (references.length > 0) fail("MEDIA_DELETE_PROTECTED", "media remains referenced by published or scheduled content", { references });
  return { mediaId: target, deletable: true };
}

export function contentEtag(document) {
  return `"sha256-${sha256(document)}"`;
}
