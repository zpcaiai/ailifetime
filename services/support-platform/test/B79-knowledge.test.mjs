import assert from "node:assert/strict";
import test from "node:test";
import { contextualHelp, HELP_CATEGORIES, markArticlesForProductChange, publishHelpArticle, recordHelpFeedback, searchHelp, validateHelpArticle } from "../src/index.mjs";
import { article, AT, auth, D, NOW, store } from "./fixtures.mjs";

function throws(code, operation) { assert.throws(operation, (error) => error?.code === code); }
function publishedState(value = article()) { const state = store(); publishHelpArticle(state, { article: value, authorization: auth("knowledge-publisher", "knowledge-management", { stepUp: true }), idempotencyKey: `publish-${value.articleId}`, at: AT }, NOW); return state; }

test("B79-R01 models all required help categories in a versioned article contract", () => {
  assert.deepEqual(HELP_CATEGORIES, ["account", "photos", "generation", "family-authorization", "future-self", "payments", "refunds", "printing", "shipping", "privacy", "security", "partner-api"]);
  assert.equal(validateHelpArticle(article()).version, "v1");
});

test("B79-R02 search supports synonyms, typos, locale, role, product, region and tenant isolation", () => {
  const state = publishedState();
  assert.equal(searchHelp(state, { tenantId: "tenant-1", role: "account-owner", query: "rende", locale: "en-US", region: "us", productVersion: "web-v1", limit: 10, authorization: auth("help-reader", "help-search") }, NOW).results[0].articleId, "generation-help");
  throws("TENANT_SCOPE_DENIED", () => searchHelp(state, { tenantId: "tenant-2", role: "account-owner", query: "generation", locale: "en-US", region: "us", productVersion: "web-v1", limit: 10, authorization: auth("help-reader", "help-search") }, NOW));
});

test("B79-R03 contextual error help returns status, recovery and human escalation bound to article version", () => {
  const result = contextualHelp(publishedState(), { tenantId: "tenant-1", errorCode: "GENERATION_TIMEOUT", region: "us", productVersion: "web-v1", authorization: auth("help-reader", "help-search") }, NOW);
  assert.deepEqual({ found: result.found, version: result.version, route: result.escalationRoute }, { found: true, version: "v1", route: "support-technical" }); assert.equal(result.statusChecks.length, 1); assert.equal(result.recoverySteps.length, 2);
});

test("B79-R04 sensitive knowledge needs independent approvals and product drift makes it stale", () => {
  throws("ARTICLE_APPROVAL_REQUIRED", () => validateHelpArticle(article({ category: "privacy", articleId: "privacy", approvals: [{ role: "content", actorId: "editor", evidenceSha256: D.a, approvedAt: AT }] })));
  const state = publishedState(); const result = markArticlesForProductChange(state, { tenantId: "tenant-1", dependencies: [{ sourceId: "generation-api", versionSha256: D.c }], authorization: auth("knowledge-worker", "knowledge-management"), idempotencyKey: "product-drift", at: AT }); assert.equal(result.stale[0].articleId, "generation-help");
});

test("B79-R05 feedback captures no-result/helpfulness/handoff without raw media or conversations", () => {
  const state = store(); const feedback = { feedbackId: "feedback-1", tenantId: "tenant-1", articleId: null, articleVersion: null, helpful: null, noResultQuerySha256: D.a, handoffReason: "no-result", containsRawMedia: false, containsPrivateConversation: false, comment: "Contact me at customer@example.com", occurredAt: AT };
  assert.equal(recordHelpFeedback(state, { feedback, authorization: auth("help-feedback-writer", "help-feedback") }).recorded, true); assert.match(state.read().records.searchFeedback[0].comment, /\[email\]/u);
  throws("SENSITIVE_FEEDBACK_FORBIDDEN", () => recordHelpFeedback(state, { feedback: { ...feedback, feedbackId: "feedback-2", containsRawMedia: true }, authorization: auth("help-feedback-writer", "help-feedback") }));
});
