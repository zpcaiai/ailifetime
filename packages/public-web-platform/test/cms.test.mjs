import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import {
  assertMediaDeletable,
  CONTENT_TYPES,
  createContent,
  createPreviewToken,
  markSourceContentChanged,
  publicContentProjection,
  resolvePreview,
  rollbackContentVersion,
  sha256,
  transitionContent,
  validateContentDocument,
} from "../src/index.mjs";
import { AT, D, draftContent, editorialAuthorization, editorialAuthority, freshStore, NOW, SECRET } from "./fixtures.mjs";

function throwsCode(code, operation) { assert.throws(operation, (error) => error?.code === code); }

function create(store, document = draftContent()) {
  return createContent(store, { document, actorId: "editor-1", authorizationId: editorialAuthorization(), idempotencyKey: `create-${document.contentId}`, at: AT }, editorialAuthority);
}

function transition(store, toState, id, overrides = {}) {
  return transitionContent(store, {
    contentId: "article-1", expectedVersion: "v1", toState, approvals: [], reason: `move to ${toState}`,
    actorId: "editor-1", authorizationId: editorialAuthorization(), idempotencyKey: id, at: overrides.at ?? AT, ...overrides,
  }, editorialAuthority);
}

test("B58-R01 exposes all nine typed content models", () => {
  assert.deepEqual(CONTENT_TYPES, ["article", "faq", "case-study", "template", "channel-page", "policy", "announcement", "media-asset", "help-document"]);
  for (const type of CONTENT_TYPES) assert.equal(validateContentDocument(draftContent({ contentId: `content-${type}`, type })).type, type);
});

test("B58-R02/B58-R05 editorial state machine publishes through review and protects media", () => {
  const { root, store } = freshStore();
  try {
    create(store);
    transition(store, "review", "transition-review");
    transition(store, "approved", "transition-approved");
    transition(store, "published", "transition-published", { at: "2026-08-28T12:01:00.000Z" });
    const projection = publicContentProjection(store, "article-1", "en-US");
    assert.match(projection.etag, /^"sha256-[a-f0-9]{64}"$/u);
    assert.equal(projection.headers["cache-control"].includes("stale-while-revalidate"), true);
    throwsCode("MEDIA_DELETE_PROTECTED", () => assertMediaDeletable(store, "media-1"));
    assert.equal(store.read().audit.length, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B58-R02 scheduled publication cannot run before its approved time", () => {
  const { root, store } = freshStore();
  try {
    create(store);
    transition(store, "review", "schedule-review");
    transition(store, "approved", "schedule-approved");
    transition(store, "scheduled", "schedule-set", { scheduledAt: "2026-08-28T13:00:00.000Z" });
    throwsCode("EDITORIAL_SCHEDULE_INVALID", () => transition(store, "published", "schedule-too-early", { at: "2026-08-28T12:30:00.000Z" }));
    assert.equal(transition(store, "published", "schedule-on-time", { at: "2026-08-28T13:00:00.000Z" }).state, "published");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B58-R03 preview token is version/editor-bound and never publicly discoverable", () => {
  const { root, store } = freshStore();
  try {
    create(store);
    const token = createPreviewToken(store, { contentId: "article-1", version: "v1", editorId: "editor-1", ttlSeconds: 120, actorId: "editor-1", authorizationId: editorialAuthorization() }, SECRET, NOW, editorialAuthority);
    const preview = resolvePreview(store, { token, editorId: "editor-1" }, SECRET, new Date("2026-08-28T12:01:00.000Z"));
    assert.equal(preview.headers["x-robots-tag"], "noindex, nofollow");
    throwsCode("CONTENT_NOT_FOUND", () => publicContentProjection(store, "article-1", "en-US"));
    throwsCode("TOKEN_BINDING_MISMATCH", () => resolvePreview(store, { token, editorId: "editor-2" }, SECRET, NOW));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B58-R04 mandatory translation and source-version drift fail closed", () => {
  const body = "Policy source";
  const pending = draftContent({
    type: "policy", body, sourceSha256: sha256(body), state: "approved", approvals: ["legal", "security"], requiredLocales: ["en-US", "zh-CN"],
    translations: [{ locale: "zh-CN", body: "政策", sourceVersion: "v1", sourceSha256: sha256(body), status: "pending", reviewedBy: null }],
  });
  throwsCode("MANDATORY_TRANSLATION_MISSING", () => validateContentDocument(pending));
  const drift = structuredClone(pending);
  drift.state = "draft";
  drift.approvals = [];
  drift.translations[0].sourceSha256 = D.f;
  throwsCode("TRANSLATION_SOURCE_DRIFT", () => validateContentDocument(drift));
});

test("B58-R02/B58-R04 source changes invalidate translations and rollback requires reapproval", () => {
  const { root, store } = freshStore();
  try {
    create(store);
    markSourceContentChanged(store, { contentId: "article-1", newVersion: "v2", body: "Changed source", actorId: "editor-1", authorizationId: editorialAuthorization(), idempotencyKey: "source-v2", at: AT }, editorialAuthority);
    const result = rollbackContentVersion(store, { contentId: "article-1", targetVersion: "v1", newVersion: "v3", reason: "restore reviewed content", actorId: "editor-1", authorizationId: editorialAuthorization(), idempotencyKey: "rollback-v3", at: "2026-08-28T12:02:00.000Z" }, editorialAuthority);
    assert.equal(result.state, "review");
    assert.equal(result.publicationBlockedPendingReapproval, true);
    assert.equal(store.read().records.content["article-1"].currentVersion, "v3");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B58-R05 server-side editorial permissions reject claimed approvals", () => {
  const { root, store } = freshStore();
  try {
    create(store);
    throwsCode("EDITORIAL_FORBIDDEN", () => transitionContent(store, {
      contentId: "article-1", expectedVersion: "v1", toState: "legal-review", approvals: ["legal"], reason: "self approval",
      actorId: "author-1", authorizationId: editorialAuthorization("author-1", ["author"]), idempotencyKey: "forbidden-approval", at: AT,
    }, editorialAuthority));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
